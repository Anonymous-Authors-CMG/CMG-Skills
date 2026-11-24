import * as vscode from 'vscode';
import { Repository } from './git';
import { evaluateMessage, truncate } from './pipeline';
import { assertUnchanged, draft, prepare, Snapshot } from './session';
import { setupModel } from './setup';
import { SetupNeeded, checkAbort, errorText } from './types';
import { createPanel } from './view';
import { t } from './i18n';

/** One review panel per repository; reopening reveals and refreshes it. */
export class Workbench implements vscode.Disposable {
    private static readonly open = new Map<string, Workbench>();

    static show(context: vscode.ExtensionContext, repo: Repository, output: vscode.OutputChannel): void {
        const key = repo.rootUri.toString();
        const existing = Workbench.open.get(key);
        if (existing) { existing.panel.reveal(); void existing.run(signal => existing.retrieve(signal, false)); return; }
        const bench = new Workbench(context, repo, output);
        Workbench.open.set(key, bench);
        context.subscriptions.push(bench);
    }

    private readonly panel: vscode.WebviewPanel;
    private controller?: AbortController;
    private disposed = false;
    private snap?: Snapshot;
    private generatedFor?: string;
    private readonly subscriptions: vscode.Disposable[] = [];

    private constructor(private readonly context: vscode.ExtensionContext, private readonly repo: Repository, private readonly output: vscode.OutputChannel) {
        const name = vscode.workspace.asRelativePath(repo.rootUri) || repo.rootUri.fsPath.split(/[\\/]/).pop() || '';
        this.panel = createPanel(context, `Issue Commit · ${name}`);
        this.subscriptions.push(this.panel.onDidDispose(() => this.dispose()));
        this.subscriptions.push(this.panel.webview.onDidReceiveMessage(message => { void this.handle(message); }));
    }

    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true; this.controller?.abort();
        Workbench.open.delete(this.repo.rootUri.toString());
        for (const subscription of this.subscriptions) { subscription.dispose(); }
        this.panel.dispose();
    }

    private post(data: object): void { if (!this.disposed) { void this.panel.webview.postMessage(data); } }
    private status(text: string): void { this.post({ type: 'status', text }); }

    private async run(action: (signal: AbortSignal) => Promise<void>): Promise<void> {
        if (this.controller || this.disposed) { return; }
        const controller = new AbortController(); this.controller = controller;
        this.post({ type: 'busy', value: true });
        try { await action(controller.signal); }
        catch (error) {
            if (controller.signal.aborted) { this.status(t('status.cancelled')); }
            else if (error instanceof SetupNeeded) {
                this.status(error.message);
                this.controller = undefined; this.post({ type: 'busy', value: false });
                const setup = t('setup.action');
                if (await vscode.window.showWarningMessage(error.message, setup) === setup && await setupModel(this.context, { fromFlow: true })) {
                    await this.run(signal => this.retrieve(signal, false));
                }
                return;
            } else {
                const message = errorText(error); this.status(t('status.failed', message));
                this.output.appendLine(`[Issue Commit] ${message}`);
                if (!this.disposed) { void vscode.window.showErrorMessage(`Issue Commit: ${message}`); }
            }
        } finally {
            if (this.controller === controller) { this.controller = undefined; this.post({ type: 'busy', value: false }); }
        }
    }

    private async retrieve(signal: AbortSignal, refresh: boolean): Promise<void> {
        const snap = await prepare(this.context, this.repo, signal, text => this.status(text), {
            refresh,
            log: line => this.output.appendLine(line),
            confirmUnstaged: async () => {
                const use = t('unstaged.use');
                const ok = await vscode.window.showWarningMessage(t('unstaged.ask'), { modal: true }, use) === use;
                if (!ok) { this.status(t('unstaged.declined')); }
                return ok;
            }
        });
        if (!snap) { return; }
        this.snap = snap; this.generatedFor = undefined;
        const cfg = snap.cfg;
        this.post({
            type: 'snapshot', repo: vscode.workspace.asRelativePath(this.repo.rootUri), mode: snap.mode, model: snap.modelLabel,
            branch: snap.branch, sources: snap.sources.map(s => s.project), poolCount: snap.poolCount, cached: snap.cached,
            diff: snap.diff, truncated: snap.truncated, warnings: snap.warnings, selected: snap.selected ?? '',
            examples: snap.examples.length,
            matches: snap.matches.map(m => ({ id: m.issue.id, number: m.issue.number, title: m.issue.title, body: truncate(m.issue.body, cfg.maxBodyChars),
                project: m.issue.source.project, confidence: m.confidence, reason: m.reason, branch: m.hint === 'branch' }))
        });
        if (cfg.autoGenerate) { await this.generate(signal, snap.selected ?? ''); }
        else { this.status(snap.matches.length ? t('status.pick', snap.matches.length) : t('status.noMatch')); }
    }

    private async generate(signal: AbortSignal, id: string, revise?: { previous: string; instruction: string }): Promise<void> {
        const snap = this.snap!;
        if (id && snap.cfg.trailer === 'fixes' && !revise) {
            const confirm = t('fixes.confirm');
            const ok = await vscode.window.showWarningMessage(t('fixes.ask'), { modal: true }, confirm);
            checkAbort(signal); if (!ok) { return; }
        }
        await assertUnchanged(this.repo, snap, signal);
        this.status(revise ? t('status.revising') : t('status.writing'));
        const text = await draft(snap, id, signal, revise); checkAbort(signal);
        this.generatedFor = id;
        this.post({ type: 'draft', text, id });
        this.status(t('status.drafted'));
    }

    private async handle(message: unknown): Promise<void> {
        if (!message || typeof message !== 'object') { return; }
        const m = message as { command?: unknown; id?: unknown; text?: unknown; instruction?: unknown };
        switch (m.command) {
            case 'cancel': this.controller?.abort(); return;
            case 'settings': await vscode.commands.executeCommand('issueCommit.settings'); return;
            case 'setup': if (await setupModel(this.context, { fromFlow: true })) { await this.run(s => this.retrieve(s, false)); } return;
            case 'openIssue': {
                const match = this.snap?.matches.find(item => item.issue.id === m.id);
                if (match) { await vscode.env.openExternal(vscode.Uri.parse(match.issue.url)); }
                return;
            }
            case 'ready': await this.run(s => this.retrieve(s, false)); return;
            case 'retrieve': await this.run(s => this.retrieve(s, true)); return;
        }
        await this.run(async signal => {
            if (!this.snap) { throw new Error(t('err.notReady')); }
            const id = typeof m.id === 'string' ? m.id : '';
            const text = typeof m.text === 'string' && m.text.length <= 50000 ? m.text : '';
            if (m.command === 'generate') { await this.generate(signal, id); return; }
            if (m.command === 'refine' && text.trim() && typeof m.instruction === 'string' && m.instruction.trim()) {
                await this.generate(signal, id, { previous: text, instruction: m.instruction.trim() }); return;
            }
            if (!text.trim()) { return; }
            if (m.command === 'copy') { await vscode.env.clipboard.writeText(text); this.status(t('status.copied')); return; }
            if (m.command === 'evaluate') {
                this.status(t('status.evaluating'));
                const linked = this.snap.matches.find(x => x.issue.id === this.generatedFor)?.issue;
                const score = await evaluateMessage(this.snap.change, text, this.snap.cfg.language, this.snap.chat, signal, linked); checkAbort(signal);
                this.post({ type: 'evaluation', ...score }); this.status(t('status.evaluated'));
                return;
            }
            if (m.command === 'apply') {
                if (id !== this.generatedFor) { throw new Error(t('err.selectionChanged')); }
                await assertUnchanged(this.repo, this.snap, signal);
                const box = this.repo.inputBox.value.trim();
                if (this.snap.mode === 'unstaged' || (box && box !== text.trim())) {
                    const replace = t('apply.confirm');
                    const ok = await vscode.window.showWarningMessage(this.snap.mode === 'unstaged' ? t('apply.unstaged') : t('apply.replace'), { modal: true }, replace);
                    checkAbort(signal); if (!ok) { return; }
                }
                this.repo.inputBox.value = text;
                await vscode.commands.executeCommand('workbench.view.scm');
                this.status(t('status.applied'));
                if (this.snap.cfg.closeAfterApply) { setTimeout(() => this.dispose(), 0); }
            }
        });
    }
}
