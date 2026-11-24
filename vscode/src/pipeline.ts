import { Chat, Confidence, Issue, Match, Progress, Settings, Source, checkAbort } from './types';
import { t } from './i18n';

export function parseJson(text: string): unknown {
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { return JSON.parse(cleaned); }
    catch {
        // Some models wrap JSON in prose; take the outermost array/object.
        const m = /[\[{][\s\S]*[\]}]/.exec(cleaned);
        if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
        throw new Error(t('err.model.json'));
    }
}

const NOISE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|uv\.lock|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock|packages\.lock\.json|flake\.lock)$|\.min\.(js|css)$|\.map$/;

/** Drop lock files, minified bundles and source maps: they carry no rationale and eat the budget. */
export function stripNoise(diff: string): { diff: string; dropped: string[] } {
    const sections = diff.split(/(?=^diff --git )/m);
    const dropped: string[] = [];
    const kept = sections.filter(section => {
        const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(section);
        if (m && NOISE.test(m[2])) { dropped.push(m[2]); return false; }
        return true;
    });
    // Never drop everything: a lock-file-only commit still needs a message.
    return kept.some(s => s.trim()) ? { diff: kept.join(''), dropped } : { diff, dropped: [] };
}

export function truncate(text: string, limit: number): string {
    if (text.length <= limit) { return text; }
    const marker = '\n\n[TRUNCATED]\n\n';
    const remaining = limit - marker.length;
    return text.slice(0, Math.floor(remaining * .7)) + marker + text.slice(-Math.ceil(remaining * .3));
}

/** Keep only known, unique IDs, best first, at most `limit`. Throws if the reply is not an array. */
export function validateIds(raw: string, issues: Issue[], limit: number): Issue[] {
    const result = parseJson(raw);
    if (!Array.isArray(result)) { throw new Error(t('err.rank.notArray')); }
    const map = new Map(issues.map(i => [i.id, i]));
    const out: Issue[] = [];
    for (const id of result) {
        const issue = typeof id === 'string' ? map.get(id) : undefined;
        if (issue && !out.includes(issue)) { out.push(issue); }
        if (out.length >= limit) { break; }
    }
    return out;
}

/** Run `fn` over items with bounded concurrency; the first failure aborts the rest. */
async function mapLimit<T, R>(items: T[], limit: number, signal: AbortSignal, fn: (item: T, index: number, signal: AbortSignal) => Promise<R>): Promise<R[]> {
    const inner = new AbortController();
    const relay = () => inner.abort();
    signal.addEventListener('abort', relay, { once: true });
    const out: R[] = new Array(items.length);
    let next = 0;
    try {
        await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
            while (next < items.length) {
                const index = next++;
                try { out[index] = await fn(items[index], index, inner.signal); }
                catch (error) { inner.abort(); throw error; }
            }
        }));
        return out;
    } finally { signal.removeEventListener('abort', relay); }
}

const COARSE = 'Rank issue TITLES by whether this code change addresses the problem or request each describes. Return ONLY a JSON array of at most topN exact supplied string IDs, best first. Return [] if none is plausible. Do not invent IDs. Only titles are shown on purpose; bodies are read later for the survivors.';
const FINE = 'Re-rank these issues using their title and body against the code change. Return ONLY JSON: {"matches":[{"id":"exact supplied ID","confidence":"high|medium|low","reason":"concrete evidence and limitations"}]}. Include every supplied ID exactly once, best first. "high" only when you can point to a specific shared function, error, symptom or behaviour. Mark weak links low; never claim a fix just because vocabulary overlaps. Write each reason in one or two sentences in the requested language.';

export interface RankOptions { pinned?: Issue[]; concurrency?: number }

/**
 * Two-stage progressive-disclosure retrieval.
 * Stage 1 reads titles only, in parallel chunks; Stage 2 reads the bodies of the few survivors.
 * `pinned` issues (e.g. from the branch name) always reach Stage 2.
 */
export async function rankIssues(change: string, issues: Issue[], cfg: Pick<Settings, 'topN' | 'chunkSize' | 'maxBodyChars' | 'language'>,
    chat: Chat, signal: AbortSignal, progress: Progress, options: RankOptions = {}): Promise<Match[]> {
    const pinned = (options.pinned ?? []).filter((p, i, all) => all.findIndex(q => q.id === p.id) === i);
    if (!issues.length && !pinned.length) { return []; }
    const titles = (pool: Issue[]) => pool.map(i => ({ id: i.id, title: i.title }));
    const coarse = async (pool: Issue[], n: number, s: AbortSignal): Promise<Issue[]> => {
        let lastError: unknown;
        for (let attempt = 0; attempt < 2; attempt++) {
            checkAbort(s);
            try { return validateIds(await chat(COARSE, { change, topN: n, candidates: titles(pool) }, s), pool, n); }
            catch (error) { checkAbort(s); lastError = error; }
        }
        throw lastError;
    };

    let merged: Issue[];
    if (issues.length <= cfg.topN) {
        merged = [...issues];                       // nothing to filter
    } else {
        const chunks: Issue[][] = [];
        for (let start = 0; start < issues.length; start += cfg.chunkSize) { chunks.push(issues.slice(start, start + cfg.chunkSize)); }
        // With one chunk, ask for topN directly; otherwise over-select and merge.
        const keep = chunks.length === 1 ? cfg.topN : Math.max(cfg.topN, Math.ceil(cfg.topN * 1.5));
        let done = 0;
        progress(t('status.scanTitles', 0, chunks.length));
        const picked = await mapLimit(chunks, options.concurrency ?? 4, signal, async (chunk, _i, s) => {
            const result = await coarse(chunk, Math.min(keep, chunk.length), s);
            progress(t('status.scanTitles', ++done, chunks.length));
            return result;
        });
        merged = picked.flat();
        // Bounded hierarchical merges: no giant cross-chunk prompt.
        while (merged.length > Math.max(cfg.chunkSize, cfg.topN)) {
            progress(t('status.merge'));
            const groups: Issue[][] = [];
            const width = Math.max(cfg.chunkSize, cfg.topN * 2);
            for (let start = 0; start < merged.length; start += width) { groups.push(merged.slice(start, start + width)); }
            merged = (await mapLimit(groups, options.concurrency ?? 4, signal, (g, _i, s) => coarse(g, cfg.topN, s))).flat();
        }
        if (merged.length > cfg.topN) { progress(t('status.merge')); merged = await coarse(merged, cfg.topN, signal); }
    }
    for (const p of pinned) { if (!merged.some(m => m.id === p.id)) { merged.push(p); } }
    if (!merged.length) { return []; }

    progress(t('status.fine', merged.length));
    const raw = parseJson(await chat(FINE, {
        change, language: cfg.language === 'zh-CN' ? 'Simplified Chinese' : 'English',
        candidates: merged.map(i => ({ id: i.id, title: i.title, body: truncate(i.body, cfg.maxBodyChars) }))
    }, signal)) as { matches?: unknown };
    if (!raw || !Array.isArray(raw.matches)) { throw new Error(t('err.rank.noMatches')); }
    const byId = new Map(merged.map(i => [i.id, i]));
    const pinnedIds = new Set(pinned.map(p => p.id));
    const matches: Match[] = [];
    for (const item of raw.matches as any[]) {
        const issue = item && typeof item.id === 'string' ? byId.get(item.id) : undefined;
        if (!issue || matches.some(m => m.issue.id === issue.id)) { continue; }
        const confidence: Confidence = ['high', 'medium', 'low'].includes(item.confidence) ? item.confidence : 'low';
        matches.push({ issue, confidence, reason: String(item.reason ?? '').slice(0, 2000),
            ...(pinnedIds.has(issue.id) ? { hint: 'branch' as const } : {}) });
    }
    // Anything the model skipped is kept, ranked last and marked weak.
    for (const issue of merged) {
        if (!matches.some(m => m.issue.id === issue.id)) {
            matches.push({ issue, confidence: 'low', reason: t('reason.unranked'), ...(pinnedIds.has(issue.id) ? { hint: 'branch' as const } : {}) });
        }
    }
    return matches;
}

/** Which candidate to pre-select, if any. */
export function preselect(matches: Match[], policy: Settings['autoSelect']): Match | undefined {
    if (policy === 'never' || !matches.length) { return undefined; }
    const ok = (m: Match) => m.confidence === 'high' || (policy === 'medium' && m.confidence === 'medium');
    if (ok(matches[0])) { return matches[0]; }
    // A branch named after an issue is a strong extra signal.
    return matches.find(m => m.hint === 'branch' && m.confidence !== 'low');
}

/** `Fixes #12`, `Refs owner/repo#12`, or a full URL across instances. */
export function formatReference(issue: Issue, home: Source | undefined, trailer: Settings['trailer']): string {
    if (trailer === 'none') { return ''; }
    const keyword = trailer === 'fixes' ? 'Fixes' : 'Refs';
    const ref = home?.key === issue.source.key ? `#${issue.number}`
        : home?.origin === issue.source.origin && home.provider === issue.source.provider ? `${issue.source.project}#${issue.number}`
        : issue.url;
    return `${keyword} ${ref}`;
}

const CLOSING = /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\b\s*:?\s*(?:[\w.-]+\/[\w.-]+)?#\d+/i;
const TRAILER_LINE = /^\s*(?:(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?|refs?|see|related(?: to)?)\s*:?\s+(?:[\w.\/-]*#\d+|https?:\/\/\S+)[\s,.]*)+$|^\s*(?:signed-off-by|co-authored-by|change-id)\s*:/i;
const CONVENTIONAL = /^(feat|fix|perf|style|refactor|docs|test|ci|build|chore)(\([\w./-]+\))?!?: \S/;

function wrapBody(body: string): string {
    let fenced = false;
    return body.split('\n').map(line => {
        if (/^\s*```/.test(line)) { fenced = !fenced; return line; }
        // Code, indented lines and CJK text (which has no word spaces) are left as written.
        if (fenced || /^\s{2,}\S/.test(line) || [...line].length <= 72 || !/\s/.test(line.trim()) || /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(line)) { return line; }
        const bullet = /^(\s*(?:[-*+]|\d+[.)])\s+)/.exec(line)?.[1] ?? '';
        const indent = ' '.repeat(bullet.length);
        const out: string[] = []; let current = '';
        for (const word of line.slice(bullet.length).split(/\s+/).filter(Boolean)) {
            const prefix = out.length ? indent : bullet;
            if (current && [...prefix + current + ' ' + word].length > 72) { out.push(prefix + current); current = word; }
            else { current += (current ? ' ' : '') + word; }
        }
        if (current) { out.push((out.length ? indent : bullet) + current); }
        return out.join('\n');
    }).join('\n');
}

/** Validate and normalise a model reply into the final message, adding our own reference. */
export function finalizeMessage(raw: string, reference: string, format: Settings['format']): string {
    const value = parseJson(raw) as { subject?: unknown; body?: unknown };
    if (!value || typeof value.subject !== 'string' || typeof value.body !== 'string') { throw new Error(t('err.msg.fields')); }
    let subject = value.subject.trim().replace(/[.。]+$/, '').replace(/\s*\((?:#\d+(?:,\s*)?)+\)\s*$/, '').replace(/[.。]+$/, '').trim();
    if (format === 'conventional' && !CONVENTIONAL.test(subject)) { throw new Error(t('err.msg.conventional')); }
    if (!subject || /[\r\n]/.test(subject)) { throw new Error(t('err.msg.subject')); }
    if ([...subject].length > 72) { throw new Error(t('err.msg.long', [...subject].length)); }
    // The extension, not the model, owns closing references: drop trailer lines the model added.
    let body = value.body.replace(/\r\n/g, '\n').split('\n').filter(line => !TRAILER_LINE.test(line)).join('\n').trim();
    if (CLOSING.test(subject + '\n' + body)) { throw new Error(t('err.msg.closing')); }
    body = wrapBody(body);
    return subject + (body ? '\n\n' + body : '') + (reference ? '\n\n' + reference : '');
}

/** Remove our own trailer so a draft can be revised without duplicating it. */
export function stripReference(message: string): string {
    return message.split('\n').filter(line => !TRAILER_LINE.test(line)).join('\n').trim();
}

export interface DraftInput {
    change: string; issue?: Issue; reference: string; examples?: string[];
    previous?: string; instruction?: string;
}

function messagePrompt(cfg: Pick<Settings, 'format' | 'language'>): string {
    const subject = cfg.format === 'conventional'
        ? 'Subject: "type: imperative summary" (an optional scope like "fix(parser): ..." is fine). type is one of feat, fix, perf, style, refactor, docs, test, ci, build, chore and stays in English.'
        : 'Subject: a short imperative summary with no type prefix, starting with a capital letter.';
    return [
        'Write a git commit message that explains both WHAT changed and WHY.',
        'Return ONLY JSON {"subject": "...", "body": "..."}.',
        `${subject} At most 72 characters, no trailing period.`,
        'Body: the concrete symptom or need, the root cause, and why this change is the right fix. Do not narrate the diff line by line. Never invent motivation, test results or code you cannot see. If no issue is supplied, keep the rationale cautious and grounded in the diff. Claims taken from the issue must agree with the diff.',
        'Do not write Fixes/Closes/Refs lines or issue numbers in the subject; the application adds confirmed references itself.',
        `Write the summary and body in ${cfg.language === 'zh-CN' ? 'Simplified Chinese' : 'English'}.`,
        'If styleExamples are supplied, match their tone, length and layout, not their content.',
        'If customInstructions are supplied, follow them unless they conflict with the rules above.',
        'If previousDraft and revisionRequest are supplied, revise previousDraft as requested while keeping every claim accurate.'
    ].join('\n');
}

export async function generateMessage(input: DraftInput, cfg: Pick<Settings, 'format' | 'language' | 'instructions' | 'maxBodyChars'>,
    chat: Chat, signal: AbortSignal): Promise<string> {
    const data: Record<string, unknown> = {
        change: input.change,
        issue: input.issue ? { title: input.issue.title, body: truncate(input.issue.body, cfg.maxBodyChars) } : null
    };
    if (input.examples?.length) { data.styleExamples = input.examples; }
    if (cfg.instructions.trim()) { data.customInstructions = cfg.instructions.trim().slice(0, 2000); }
    if (input.previous && input.instruction) { data.previousDraft = stripReference(input.previous); data.revisionRequest = input.instruction.slice(0, 1000); }
    let feedback: string | undefined;
    let lastError: unknown;
    // One automatic retry with the validation error as feedback.
    for (let attempt = 0; attempt < 2; attempt++) {
        checkAbort(signal);
        const raw = await chat(messagePrompt(cfg), feedback ? { ...data, previousAttemptRejected: feedback } : data, signal);
        try { return finalizeMessage(raw, input.reference, cfg.format); }
        catch (error) { lastError = error; feedback = error instanceof Error ? error.message : String(error); }
    }
    throw lastError;
}

export async function evaluateMessage(change: string, message: string, language: Settings['language'], chat: Chat, signal: AbortSignal,
    issue?: Pick<Issue, 'title' | 'body'>): Promise<{ what: number; why: number; reason: string }> {
    const result = parseJson(await chat(`Evaluate this commit message against its code change${issue ? ' and the linked issue' : ''}. Return ONLY JSON {"what":0,"why":0,"reason":"..."}. What = accurate, specific summary of the change. Why = clear rationale that is supported by the diff${issue ? ' or the linked issue' : ''}, not invented motivation. Integer scale: 0 absent/incorrect, 1 vague, 2 acceptable, 3 good, 4 excellent. Do not reward verbosity or invented details. Write the reason in ${language === 'zh-CN' ? 'Simplified Chinese' : 'English'}, two sentences at most, and say what would raise a low score.`,
        issue ? { change, linkedIssue: { title: issue.title, body: truncate(issue.body, 4000) }, message } : { change, message }, signal)) as { what: number; why: number; reason: string };
    if (!result || ![result.what, result.why].every(n => Number.isInteger(n) && n >= 0 && n <= 4) || typeof result.reason !== 'string') { throw new Error(t('err.eval')); }
    return { what: result.what, why: result.why, reason: result.reason.slice(0, 3000) };
}

/** Commit messages from history, cleaned for use as style examples. */
export function pickExamples(messages: string[], max = 4): string[] {
    const clean = messages
        .map(m => m.replace(/\r\n/g, '\n').split('\n').filter(l => !TRAILER_LINE.test(l)).join('\n').trim())
        .filter(m => m && !/^(?:merge|revert)\b/i.test(m) && [...m.split('\n')[0]].length <= 100);
    const withBody = clean.filter(m => m.includes('\n\n'));
    const chosen = (withBody.length >= 2 ? withBody : clean).slice(0, max);
    return chosen.map(m => m.length > 700 ? m.slice(0, 700) + '…' : m);
}
