import * as vscode from 'vscode';
import { Repository } from './git';
import { assertUnchanged, draft, prepare, Snapshot } from './session';
import { setupModel } from './setup';
import { SetupNeeded } from './types';
import { t } from './i18n';

/**
 * Quick mode: no panel. Search with a progress notification, let the user confirm the issue
 * in a Quick Pick (only if there is a candidate), then write straight into the commit box.
 */
export async function quickGenerate(context: vscode.ExtensionContext, repo: Repository, output: vscode.OutputChannel): Promise<void> {
    const run = <T>(title: string, task: (signal: AbortSignal, report: (m: string) => void) => Promise<T>) =>
        vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl, title }, () =>
            vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
                const controller = new AbortController();
                const sub = token.onCancellationRequested(() => controller.abort());
                try { return await task(controller.signal, message => progress.report({ message })); }
                finally { sub.dispose(); }
            }));

    let found: Snapshot | undefined;
    try {
        found = await run(t('quick.title'), (signal, report) => prepare(context, repo, signal, report, {
            log: line => output.appendLine(line),
            confirmUnstaged: async () => {
                const use = t('unstaged.use');
                return await vscode.window.showWarningMessage(t('unstaged.ask'), { modal: true }, use) === use;
            }
        }));
    } catch (error) {
        if (error instanceof SetupNeeded) {
            const setup = t('setup.action');
            if (await vscode.window.showWarningMessage(error.message, setup) === setup && await setupModel(context, { fromFlow: true })) {
                return quickGenerate(context, repo, output);
            }
            return;
        }
        throw error;
    }
    if (!found) { return; }
    const snap = found;
    for (const w of snap.warnings) { output.appendLine(`[Issue Commit] ${w}`); }

    let id = '';
    if (snap.matches.length) {
        const label = { high: t('conf.high'), medium: t('conf.medium'), low: t('conf.low') };
        type Item = vscode.QuickPickItem & { id: string };
        const none: Item = { id: '', label: `$(circle-slash) ${t('ui.noIssue')}`, detail: t('ui.noIssue.detail') };
        const items: Item[] = snap.matches.map(m => ({
            id: m.issue.id, label: `#${m.issue.number} ${m.issue.title}`,
            description: `${label[m.confidence]}${m.hint === 'branch' ? ' · ' + t('ui.fromBranch') : ''} · ${m.issue.source.project}`,
            detail: m.reason
        }));
        const ordered = snap.selected ? [...items.filter(i => i.id === snap.selected), none, ...items.filter(i => i.id !== snap.selected)] : [none, ...items];
        const picker = vscode.window.createQuickPick<Item>();
        picker.title = t('quick.pick.title'); picker.placeholder = t('quick.pick.placeholder');
        picker.items = ordered; picker.matchOnDescription = true; picker.matchOnDetail = true;
        picker.activeItems = [ordered[0]];
        const chosen = await new Promise<Item | undefined>(resolve => {
            picker.onDidAccept(() => { resolve(picker.selectedItems[0] ?? picker.activeItems[0]); picker.hide(); });
            picker.onDidHide(() => resolve(undefined));
            picker.show();
        });
        picker.dispose();
        if (!chosen) { return; }
        id = chosen.id;
        if (id && snap.cfg.trailer === 'fixes') {
            const confirm = t('fixes.confirm');
            if (await vscode.window.showWarningMessage(t('fixes.ask'), { modal: true }, confirm) !== confirm) { return; }
        }
    }

    const text = await run(t('status.writing'), async signal => { await assertUnchanged(repo, snap, signal); return draft(snap, id, signal); });
    const box = repo.inputBox.value.trim();
    if (snap.mode === 'unstaged' || (box && box !== text.trim())) {
        const replace = t('apply.confirm');
        if (await vscode.window.showWarningMessage(snap.mode === 'unstaged' ? t('apply.unstaged') : t('apply.replace'), { modal: true }, replace) !== replace) { return; }
    }
    repo.inputBox.value = text;
    await vscode.commands.executeCommand('workbench.view.scm');
    const issue = snap.matches.find(m => m.issue.id === id)?.issue;
    void vscode.window.setStatusBarMessage(`$(check) ${issue ? t('quick.done.issue', issue.number) : t('quick.done')}`, 6000);
}
