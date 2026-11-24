import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { t } from './i18n';

export interface Repository {
    rootUri: vscode.Uri; inputBox: { value: string };
    state: { remotes: { name: string; fetchUrl?: string; pushUrl?: string }[]; HEAD?: { name?: string } };
}
interface GitApi { repositories: Repository[]; git: { path: string } }

export async function gitApi(): Promise<GitApi> {
    const extension = vscode.extensions.getExtension<{ getAPI(version: number): GitApi }>('vscode.git');
    if (!extension) { throw new Error(t('err.git.ext')); }
    return (await extension.activate()).getAPI(1);
}

export async function chooseRepo(context?: { rootUri?: vscode.Uri }): Promise<Repository | undefined> {
    const api = await gitApi();
    if (!api.repositories.length) { throw new Error(t('err.git.noRepo')); }
    if (context?.rootUri) {
        const found = api.repositories.find(repo => repo.rootUri.toString() === context.rootUri!.toString());
        if (found) { return found; }
    }
    if (api.repositories.length === 1) { return api.repositories[0]; }
    // Prefer the repository of the active editor before asking.
    const active = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (active) {
        const owner = api.repositories.filter(r => active.startsWith(r.rootUri.fsPath)).sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
        if (owner) { return owner; }
    }
    const items = api.repositories.map(repo => ({ label: vscode.workspace.asRelativePath(repo.rootUri), description: repo.rootUri.fsPath, repo }));
    return (await vscode.window.showQuickPick(items, { title: t('pick.repo') }))?.repo;
}

async function runGit(repo: Repository, args: string[], signal?: AbortSignal, maxBuffer = 20 * 1024 * 1024): Promise<string> {
    const api = await gitApi();
    return new Promise((resolve, reject) => {
        execFile(api.git.path, args, { cwd: repo.rootUri.fsPath, encoding: 'utf8', maxBuffer, timeout: 30000, signal }, (error, stdout) => {
            if (error) { reject(error); } else { resolve(stdout); }
        });
    });
}

export async function readDiff(repo: Repository, mode: 'staged' | 'unstaged', signal?: AbortSignal): Promise<string> {
    try {
        return await runGit(repo, ['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', ...(mode === 'staged' ? ['--cached'] : []), '--'], signal);
    } catch { throw new Error(t('err.git.diff')); }
}

/** Recent non-merge commit messages, newest first. Empty on any failure (e.g. no commits yet). */
export async function readHistory(repo: Repository, count = 30, signal?: AbortSignal): Promise<string[]> {
    try {
        const out = await runGit(repo, ['log', `-n${count}`, '--no-merges', '--format=%B%x1e'], signal, 2 * 1024 * 1024);
        return out.split('\x1e').map(s => s.trim()).filter(Boolean);
    } catch { return []; }
}

export function remoteUrls(repo: Repository): string[] {
    // origin first, so it is treated as the home repository.
    const remotes = [...repo.state.remotes].sort((a, b) => (a.name === 'origin' ? -1 : 0) - (b.name === 'origin' ? -1 : 0));
    return remotes.flatMap(r => [r.fetchUrl, r.pushUrl].filter((u): u is string => !!u));
}

export function fingerprint(diff: string): string { return createHash('sha256').update(diff).digest('hex'); }
