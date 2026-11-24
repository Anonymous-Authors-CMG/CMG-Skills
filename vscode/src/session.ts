import * as vscode from 'vscode';
import { getIssueToken, readSettings } from './config';
import { fingerprint, readDiff, readHistory, remoteUrls, Repository } from './git';
import { branchIssueNumbers, collectIssues, fetchIssue, parseSource, resolveSources } from './issues';
import { resolveModel } from './models';
import { formatReference, generateMessage, pickExamples, preselect, rankIssues, stripNoise, truncate } from './pipeline';
import { Chat, Issue, Match, Progress, Settings, Source, checkAbort, errorText } from './types';
import { t } from './i18n';

/** Everything retrieved for one diff; drafts are generated from this. */
export interface Snapshot {
    cfg: Settings; chat: Chat; modelLabel: string;
    mode: 'staged' | 'unstaged'; hash: string;
    change: string; diff: string; truncated: boolean;
    matches: Match[]; selected?: string;
    sources: Source[]; home?: Source; poolCount: number; cached: boolean;
    examples: string[]; branch?: string; warnings: string[];
}

export interface PrepareOptions {
    refresh?: boolean;
    /** Ask whether to fall back to the unstaged diff; return false to stop. */
    confirmUnstaged: () => Promise<boolean>;
    log?: (line: string) => void;
}

export async function prepare(context: vscode.ExtensionContext, repo: Repository, signal: AbortSignal, progress: Progress, options: PrepareOptions): Promise<Snapshot | undefined> {
    const cfg = readSettings(repo.rootUri);
    const model = await resolveModel(context, repo.rootUri, cfg);

    progress(t('status.readDiff'));
    let mode: 'staged' | 'unstaged' = 'staged';
    let fullDiff = await readDiff(repo, mode, signal); checkAbort(signal);
    if (!fullDiff.trim()) {
        if (!await options.confirmUnstaged()) { return undefined; }
        checkAbort(signal);
        mode = 'unstaged'; fullDiff = await readDiff(repo, mode, signal);
    }
    checkAbort(signal);
    if (!fullDiff.trim()) { throw new Error(t('err.noDiff')); }
    const cleaned = stripNoise(fullDiff);
    const diff = truncate(cleaned.diff, cfg.maxDiffChars);

    const remotes = remoteUrls(repo);
    const resolved = cfg.enabled ? resolveSources(cfg.sources, remotes, cfg.autoDetect) : { sources: [], warnings: [] };
    // The "home" repository decides whether a reference can be written as a short `#12`.
    let home: Source | undefined;
    const same = (url: string, s: Source) => { try { return parseSource(url, s.provider)?.key === s.key; } catch { return false; } };
    for (const url of remotes) {
        home = resolved.sources.find(s => same(url, s));
        if (!home) { try { home = parseSource(url); } catch { /* skip */ } }
        if (home) { break; }
    }
    const branch = repo.state.HEAD?.name;
    const warnings = [...resolved.warnings];

    // The branch name and description are useful context for the model too.
    const change = (branch ? `Branch: ${branch}\n\n` : '') + diff;

    const [pool, history] = await Promise.all([
        collectIssues(resolved.sources, cfg.poolSize, s => getIssueToken(context, repo.rootUri, s), signal, progress, options.refresh ? 0 : cfg.cacheMinutes),
        cfg.useHistory ? readHistory(repo, 30, signal) : Promise.resolve([])
    ]);
    warnings.push(...pool.warnings);
    checkAbort(signal);

    // Issues named by the branch always reach the fine-ranking stage.
    const pinned: Issue[] = [];
    if (cfg.enabled && cfg.useBranchName && resolved.sources.length) {
        const primary = resolved.sources.find(s => s.key === home?.key) ?? resolved.sources[0];
        for (const n of branchIssueNumbers(branch)) {
            const inPool = pool.issues.find(i => i.number === n && i.source.key === primary.key);
            const issue = inPool ?? await fetchIssue(primary, n, await getIssueToken(context, repo.rootUri, primary), signal);
            if (issue) { pinned.push(issue); }
        }
    }

    let matches: Match[] = [];
    try {
        matches = await rankIssues(change, pool.issues, cfg, model.chat, signal, progress, { pinned });
    } catch (error) {
        checkAbort(signal);
        warnings.push(t('warn.rankFailed', errorText(error)));
    }
    checkAbort(signal);
    if (cleaned.dropped.length) { warnings.push(t('warn.dropped', cleaned.dropped.join(', '))); }
    if (cleaned.diff.length > cfg.maxDiffChars) { warnings.push(t('warn.truncated', cleaned.diff.length, diff.length)); }
    if (resolved.sources.length && !pool.issues.length && !pinned.length) { warnings.push(t('warn.noIssues')); }
    for (const w of warnings) { options.log?.(`[Issue Commit] ${w}`); }

    return {
        cfg, chat: model.chat, modelLabel: model.label, mode, hash: fingerprint(fullDiff),
        change, diff, truncated: cleaned.diff.length > cfg.maxDiffChars,
        matches, selected: preselect(matches, cfg.autoSelect)?.issue.id,
        sources: resolved.sources, home, poolCount: pool.issues.length, cached: pool.cached,
        examples: pickExamples(history), branch, warnings
    };
}

/** Throws if the diff changed since the snapshot was taken. */
export async function assertUnchanged(repo: Repository, snap: Snapshot, signal: AbortSignal): Promise<void> {
    const current = await readDiff(repo, snap.mode, signal); checkAbort(signal);
    if (fingerprint(current) !== snap.hash) { throw new Error(t('err.diffChanged')); }
}

export async function draft(snap: Snapshot, issueId: string, signal: AbortSignal, revise?: { previous: string; instruction: string }): Promise<string> {
    const issue = issueId ? snap.matches.find(m => m.issue.id === issueId)?.issue : undefined;
    if (issueId && !issue) { throw new Error(t('err.notCandidate')); }
    return generateMessage({
        change: snap.change, issue,
        reference: issue ? formatReference(issue, snap.home, snap.cfg.trailer) : '',
        examples: snap.examples, previous: revise?.previous, instruction: revise?.instruction
    }, snap.cfg, snap.chat, signal);
}
