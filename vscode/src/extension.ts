import * as vscode from 'vscode';
import { editSecret, getIssueToken, issueSecretKey, modelSecretKey, readSettings } from './config';
import { chooseRepo, remoteUrls } from './git';
import { modelEndpoint, safeUrl } from './http';
import { clearIssueCache, fetchIssues, parseSource, resolveSources } from './issues';
import { resolveModel } from './models';
import { quickGenerate } from './quick';
import { setupModel } from './setup';
import { Source, SetupNeeded, checkAbort, errorText } from './types';
import { Workbench } from './workbench';
import { setLanguage, t } from './i18n';

async function configureProject(): Promise<void> {
    const repo = await chooseRepo(); if (!repo) { return; }
    const config = vscode.workspace.getConfiguration('issueCommit', repo.rootUri);
    const current = readSettings(repo.rootUri);
    const detected = resolveSources([], remoteUrls(repo), true).sources.map(s => s.project);
    const mode = await vscode.window.showQuickPick([
        { label: t('project.auto'), description: detected.length ? detected.join(', ') : t('project.autoNone'), value: 'auto' },
        { label: t('project.explicit'), value: 'explicit' },
        { label: t('project.off'), value: 'off' }
    ], { title: t('project.title') });
    if (!mode) { return; }
    const sources = [...current.sources];
    let topN = current.topN;
    if (mode.value !== 'off') {
        const action = await vscode.window.showQuickPick([
            { label: t('project.keep', sources.length), value: 'keep' },
            { label: t('project.add'), value: 'add' },
            { label: t('project.clear'), value: 'clear' }
        ], { title: t('project.sourcesTitle') });
        if (!action) { return; }
        if (action.value === 'clear') { sources.length = 0; }
        if (action.value === 'add') {
            const provider = await vscode.window.showQuickPick(['github', 'gitlab'], { title: t('project.platform') });
            if (!provider) { return; }
            const url = await vscode.window.showInputBox({ title: t('project.url'), placeHolder: provider === 'github' ? 'https://github.com/owner/repo' : 'https://gitlab.example.com/group/project',
                validateInput: value => { try { return parseSource(value, provider as Source['provider']) ? undefined : t('project.urlInvalid'); } catch (e) { return errorText(e); } } });
            if (url === undefined) { return; }
            sources.push({ url, provider: provider as Source['provider'] });
        }
        const n = await vscode.window.showInputBox({ title: t('project.topN'), value: String(topN), validateInput: value => /^([1-9]|10)$/.test(value) ? undefined : t('project.topNInvalid') });
        if (!n) { return; } topN = Number(n);
    }
    const target = vscode.workspace.getWorkspaceFolder(repo.rootUri) ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace;
    for (const [key, value] of Object.entries({ 'issues.enabled': mode.value !== 'off', 'issues.autoDetect': mode.value === 'auto', 'issues.sources': sources, 'issues.topN': topN })) {
        await config.update(key, value, target);
    }
    clearIssueCache();
    vscode.window.showInformationMessage(t('project.saved'));
}

async function diagnose(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
    const repo = await chooseRepo(); if (!repo) { return; }
    const cfg = readSettings(repo.rootUri);
    output.show(true);
    const http = vscode.workspace.getConfiguration('http');
    const line = (s: string) => output.appendLine(`[${t('diag.tag')}] ${s}`);
    line(`${new Date().toISOString()} · ${vscode.env.appName} ${vscode.version} · Node ${process.version} · ${context.extension.id} ${context.extension.packageJSON.version}`);
    line(`${t('diag.repo')} ${repo.rootUri.fsPath} · ${t('diag.branch')} ${repo.state.HEAD?.name ?? '-'}`);
    line(`proxySupport=${http.get('proxySupport')} · electronFetch=${http.get('electronFetch')} · systemCertificates=${http.get('systemCertificates')}`);
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('diag.title'), cancellable: true }, async (_progress, cancellation) => {
        const controller = new AbortController();
        const sub = cancellation.onCancellationRequested(() => controller.abort());
        try {
            const { sources } = cfg.enabled ? resolveSources(cfg.sources, remoteUrls(repo), cfg.autoDetect) : { sources: [] };
            if (!sources.length) { line(t('diag.noSources')); }
            for (const source of sources) {
                checkAbort(controller.signal);
                const token = await getIssueToken(context, repo.rootUri, source);
                try {
                    const result = await fetchIssues(source, 1, token, controller.signal);
                    line(`✓ ${source.project} · ${t('diag.issuesOk')} · ${token ? t('diag.tokenSet') : t('diag.tokenUnset')}${result.issues.length ? '' : ' · ' + t('diag.noOpen')}`);
                } catch (e) { checkAbort(controller.signal); line(`✗ ${source.project} · ${errorText(e)}`); }
            }
            checkAbort(controller.signal);
            try {
                const model = await resolveModel(context, repo.rootUri, cfg);
                line(`${t('diag.model')} ${model.label} (${model.kind})`);
                await model.chat('Reply with the single word READY.', { task: 'connectivity check' }, controller.signal);
                line(`✓ ${t('diag.modelOk')}`);
            } catch (e) {
                checkAbort(controller.signal);
                line(`✗ ${t('diag.model')} ${errorText(e)}`);
                if (e instanceof SetupNeeded) { line(t('diag.runSetup')); }
            }
        } finally { sub.dispose(); }
    });
}

export function activate(context: vscode.ExtensionContext): void {
    setLanguage(vscode.env.language);
    const output = vscode.window.createOutputChannel('Issue Commit'); context.subscriptions.push(output);
    const register = (id: string, callback: (...args: any[]) => Promise<unknown>) => context.subscriptions.push(vscode.commands.registerCommand(id, async (...args: any[]) => {
        try {
            if (!vscode.workspace.isTrusted) { throw new Error(t('err.untrusted')); }
            return await callback(...args);
        } catch (error) {
            output.appendLine(`[Issue Commit] ${errorText(error)}`);
            void vscode.window.showErrorMessage(`Issue Commit: ${errorText(error)}`);
        }
    }));
    register('issueCommit.generate', async (arg?: { rootUri?: vscode.Uri }) => { const repo = await chooseRepo(arg); if (repo) { Workbench.show(context, repo, output); } });
    register('issueCommit.quickGenerate', async (arg?: { rootUri?: vscode.Uri }) => { const repo = await chooseRepo(arg); if (repo) { await quickGenerate(context, repo, output); } });
    register('issueCommit.setupModel', () => setupModel(context));
    register('issueCommit.settings', async () => { await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`); });
    register('issueCommit.diagnose', () => diagnose(context, output));
    register('issueCommit.configureProject', configureProject);
    register('issueCommit.openWalkthrough', async () => {
        await vscode.commands.executeCommand('workbench.action.openWalkthrough', `${context.extension.id}#issueCommit.start`, false);
    });
    register('issueCommit.setModelToken', async () => {
        const repo = await chooseRepo(); if (!repo) { return; }
        const cfg = readSettings(repo.rootUri);
        if (!cfg.baseUrl) { throw new Error(t('err.token.noBase')); }
        await editSecret(context, modelSecretKey(cfg.baseUrl), t('token.model.title', modelEndpoint(cfg.baseUrl)));
    });
    register('issueCommit.setIssueToken', async () => {
        const provider = await vscode.window.showQuickPick([
            { label: 'GitHub', description: t('token.github.desc'), value: 'github' as const },
            { label: 'GitLab', description: t('token.gitlab.desc'), value: 'gitlab' as const }
        ], { title: t('token.issue.pick') });
        if (!provider) { return; }
        const origin = await vscode.window.showInputBox({ title: t('token.issue.origin'), value: provider.value === 'github' ? 'https://github.com' : 'https://gitlab.com', validateInput: value => {
            try { const url = safeUrl(value); return url.pathname !== '/' ? t('token.issue.originOnly') : undefined; } catch (e) { return errorText(e); }
        } });
        if (!origin) { return; }
        await editSecret(context, issueSecretKey({ provider: provider.value, origin: new URL(origin).origin }), t('token.issue.title', new URL(origin).origin));
        clearIssueCache();
    });
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('issueCommit.issues')) { clearIssueCache(); } }));
}

export function deactivate(): void { /* nothing to clean up */ }
