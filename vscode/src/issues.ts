import { Issue, Provider, Source, checkAbort, errorText } from './types';
import { requestJson, safeUrl } from './http';
import { t } from './i18n';

export function parseSource(raw: string, provider?: Provider): Source | undefined {
    let value = raw.trim();
    const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(value);
    if (!value.includes('://') && scp) { value = `https://${scp[1]}/${scp[2]}`; }
    if (value.startsWith('ssh://')) {
        const ssh = new URL(value); value = `https://${ssh.hostname}${ssh.pathname}`;
    }
    let url: URL;
    try { url = new URL(value); } catch { return undefined; }
    provider ??= url.hostname === 'github.com' ? 'github' : url.hostname === 'gitlab.com' ? 'gitlab' : undefined;
    if (!provider) { return undefined; }
    // Issue-board query/fragment filters do not override the open-only policy.
    url.search = ''; url.hash = '';
    safeUrl(url.toString());
    let project = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
    if (provider === 'github') {
        const parts = project.split('/');
        if (parts.length > 2 && parts[2] !== 'issues') { throw new Error(t('err.source.github')); }
        project = parts.slice(0, 2).join('/');
    } else { project = project.split('/-/')[0]; }
    project = project.replace(/\.git$/, '');
    const parts = project.split('/');
    if (parts.length < 2 || parts.some(p => !/^[\w.-]+$/.test(p) || p === '.' || p === '..')) {
        throw new Error(t('err.source.path'));
    }
    const canonical = provider === 'github' ? project.toLowerCase() : project;
    return { provider, origin: url.origin, project, key: `${provider}:${url.origin}/${canonical}`,
        url: `${url.origin}/${project}/${provider === 'github' ? 'issues' : '-/issues'}` };
}

export function resolveSources(configured: { url: string; provider: Provider }[], remotes: string[], autoDetect: boolean): { sources: Source[]; warnings: string[] } {
    const found = new Map<string, Source>(); const warnings: string[] = [];
    for (const entry of configured) {
        const source = parseSource(entry.url, entry.provider);
        if (!source) { throw new Error(t('err.source.invalid')); }
        found.set(source.key, source);
    }
    if (autoDetect) {
        for (const remote of remotes) {
            try { const source = parseSource(remote); if (source) { found.set(source.key, source); } }
            catch { warnings.push(t('warn.remoteSkipped')); }
        }
    }
    if (found.size > 10) { throw new Error(t('err.source.tooMany')); }
    return { sources: [...found.values()], warnings };
}

function apiBase(source: Source): string {
    return source.provider === 'github'
        ? `${source.origin === 'https://github.com' ? 'https://api.github.com' : source.origin + '/api/v3'}/repos/${source.project}/issues`
        : `${source.origin}/api/v4/projects/${encodeURIComponent(source.project)}/issues`;
}
export function issueApi(source: Source, page: number): string {
    const url = new URL(apiBase(source));
    url.search = new URLSearchParams(source.provider === 'github'
        ? { state: 'open', sort: 'updated', direction: 'desc', per_page: '100', page: String(page) }
        : { state: 'opened', scope: 'all', order_by: 'updated_at', sort: 'desc', per_page: '100', page: String(page) }).toString();
    return url.toString();
}
function headers(source: Source, token: string | undefined): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'issue-commit-vscode' };
    if (token) { h[source.provider === 'github' ? 'Authorization' : 'PRIVATE-TOKEN'] = source.provider === 'github' ? `Bearer ${token}` : token; }
    return h;
}
function toIssue(source: Source, item: any): Issue | undefined {
    if (!item || typeof item !== 'object' || item.pull_request) { return undefined; }
    if (item.state !== (source.provider === 'github' ? 'open' : 'opened')) { return undefined; }
    const number: unknown = source.provider === 'github' ? item.number : item.iid;
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0 || typeof item.title !== 'string') { return undefined; }
    return { id: `${source.key}#${number}`, number, title: item.title.slice(0, 1000),
        body: String((source.provider === 'github' ? item.body : item.description) ?? '').slice(0, 100000),
        url: `${source.url}/${number}`, source };
}

export async function fetchIssues(source: Source, limit: number, token: string | undefined, signal: AbortSignal): Promise<{ issues: Issue[]; limited: boolean }> {
    const issues = new Map<string, Issue>();
    // Bound API use even if a repository has thousands of PRs but few issues.
    for (let page = 1; page <= 30; page++) {
        checkAbort(signal);
        const rows = await requestJson(issueApi(source, page), { headers: headers(source, token) }, signal, 30000);
        if (!Array.isArray(rows)) { throw new Error(t('err.issues.notList')); }
        for (const item of rows) {
            const issue = toIssue(source, item);
            if (!issue) { continue; }
            issues.set(issue.id, issue);
            if (issues.size >= limit) { return { issues: [...issues.values()], limited: true }; }
        }
        if (rows.length < 100) { return { issues: [...issues.values()], limited: false }; }
    }
    return { issues: [...issues.values()], limited: true };
}

/** One open issue by number, or undefined if it is closed, a PR, or missing. */
export async function fetchIssue(source: Source, number: number, token: string | undefined, signal: AbortSignal): Promise<Issue | undefined> {
    try {
        const item = await requestJson(`${apiBase(source)}/${number}`, { headers: headers(source, token) }, signal, 30000);
        return toIssue(source, item);
    } catch { checkAbort(signal); return undefined; }
}

// ---- short-lived cache so re-running on the same repo doesn't refetch everything

const cache = new Map<string, { at: number; issues: Issue[]; limited: boolean }>();
export function clearIssueCache(): void { cache.clear(); }

export async function collectIssues(sources: Source[], limit: number, getToken: (source: Source) => Promise<string | undefined>,
    signal: AbortSignal, progress: (message: string) => void, cacheMinutes = 0): Promise<{ issues: Issue[]; warnings: string[]; cached: boolean }> {
    const issues: Issue[] = []; const warnings: string[] = [];
    let cached = sources.length > 0;
    for (const source of sources) {
        checkAbort(signal);
        const key = `${source.key}|${limit}`;
        const hit = cache.get(key);
        let result: { issues: Issue[]; limited: boolean };
        if (hit && cacheMinutes > 0 && Date.now() - hit.at < cacheMinutes * 60000) { result = hit; }
        else {
            cached = false;
            progress(t('status.fetchIssues', source.project));
            try {
                result = await fetchIssues(source, limit, await getToken(source), signal);
                cache.set(key, { at: Date.now(), ...result });
            } catch (error) { checkAbort(signal); warnings.push(t('warn.sourceFailed', source.project, errorText(error))); continue; }
        }
        issues.push(...result.issues);
        if (result.limited) { warnings.push(t('warn.poolLimited', source.project, result.issues.length)); }
    }
    return { issues, warnings, cached };
}

/**
 * Issue numbers suggested by a branch name, e.g. `fix/123-crash`, `issue-45`, `gh-7`.
 * Tracker keys such as `PROJ-123` are ignored: their numbers belong to another system.
 */
export function branchIssueNumbers(branch: string | undefined): number[] {
    if (!branch) { return []; }
    const found: number[] = [];
    const re = /(^|[\/_#-])(?:(?:issues?|gh|bug|fix|feat(?:ure)?)[-_#]?)?(\d{1,6})(?=$|[\/_-])/gi;
    for (const m of branch.matchAll(re)) {
        const before = branch.slice(0, m.index! + m[1].length);
        if (/[A-Z][A-Z0-9]+-$/.test(before)) { continue; }
        const n = Number(m[2]);
        if (n > 0 && !found.includes(n)) { found.push(n); }
        if (found.length >= 2) { break; }
    }
    return found;
}
