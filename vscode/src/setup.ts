import * as vscode from 'vscode';
import { modelSecretKey } from './config';
import { createChat, listModels, modelEndpoint, safeUrl } from './http';
import { createLmChat, listLmModels } from './models';
import { errorText } from './types';
import { t } from './i18n';

interface Preset { id: string; label: string; baseUrl?: string; keyUrl?: string; local?: boolean; suggest?: string[] }

const PRESETS: Preset[] = [
    { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys', suggest: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini'] },
    { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', keyUrl: 'https://platform.deepseek.com/api_keys', suggest: ['deepseek-chat'] },
    { id: 'qwen', label: 'Qwen · Alibaba Cloud Model Studio', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyUrl: 'https://bailian.console.aliyun.com/', suggest: ['qwen-plus', 'qwen-turbo'] },
    { id: 'moonshot', label: 'Kimi · Moonshot AI', baseUrl: 'https://api.moonshot.cn/v1', keyUrl: 'https://platform.moonshot.cn/console/api-keys' },
    { id: 'zhipu', label: 'GLM · Zhipu AI', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
    { id: 'siliconflow', label: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', keyUrl: 'https://cloud.siliconflow.cn/account/ak' },
    { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys' },
    { id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', local: true },
    { id: 'lmstudio', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', local: true },
    { id: 'custom', label: '' }
];

/**
 * Guided model setup: choose a provider, paste a key, pick a model from the provider's list,
 * then a one-line connection test. Settings go to User settings; the key goes to SecretStorage.
 */
export async function setupModel(context: vscode.ExtensionContext, options: { fromFlow?: boolean } = {}): Promise<boolean> {
    for (;;) {
        const result = await setupOnce(context, options);
        if (result !== 'retry') { return result === 'ok'; }
    }
}

async function setupOnce(context: vscode.ExtensionContext, options: { fromFlow?: boolean }): Promise<'ok' | 'retry' | 'cancel'> {
    const lmModels = await listLmModels();
    type Item = vscode.QuickPickItem & { preset?: Preset; lm?: boolean };
    const items: Item[] = [];
    if (lmModels.length) {
        items.push({ label: t('setup.lm.label'), description: t('setup.lm.desc', lmModels.length), detail: t('setup.lm.detail'), lm: true });
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    }
    for (const p of PRESETS) {
        if (p.id === 'custom') { items.push({ label: t('setup.custom.label'), detail: t('setup.custom.detail'), preset: p }); continue; }
        items.push({ label: p.label, description: p.baseUrl, detail: p.local ? t('setup.local.detail') : undefined, preset: p });
    }
    const choice = await vscode.window.showQuickPick(items, { title: t('setup.title', 1, 3), placeHolder: t('setup.pickProvider'), ignoreFocusOut: true, matchOnDescription: true });
    if (!choice) { return 'cancel'; }
    const config = vscode.workspace.getConfiguration('issueCommit');

    if (choice.lm) {
        const pick = await vscode.window.showQuickPick(lmModels.map(m => ({ label: m.name, description: `${m.vendor} · ${m.family}`, detail: m.id, model: m })),
            { title: t('setup.title', 2, 3), placeHolder: t('setup.pickModel'), ignoreFocusOut: true });
        if (!pick) { return 'cancel'; }
        await config.update('model.provider', 'vscode-lm', vscode.ConfigurationTarget.Global);
        await config.update('model.vscodeLm', pick.model.id, vscode.ConfigurationTarget.Global);
        return test(createLmChat(pick.model), pick.model.name, options);
    }

    const preset = choice.preset!;
    let baseUrl = preset.baseUrl ?? '';
    if (preset.id === 'custom') {
        const input = await vscode.window.showInputBox({
            title: t('setup.title', 1, 3), prompt: t('setup.baseUrl.prompt'), placeHolder: 'https://api.example.com/v1', ignoreFocusOut: true,
            value: config.get<string>('model.baseUrl', ''),
            validateInput: v => { try { modelEndpoint(v); return undefined; } catch (e) { return errorText(e); } }
        });
        if (!input) { return 'cancel'; }
        baseUrl = input.trim();
    }
    safeUrl(baseUrl, true);

    let key: string | undefined = '';
    if (!preset.local) {
        const getKey = preset.keyUrl ? t('setup.key.where', preset.keyUrl) : '';
        key = await vscode.window.showInputBox({
            title: t('setup.title', 2, 3), prompt: t('setup.key.prompt', preset.label || new URL(baseUrl).host) + getKey,
            password: true, ignoreFocusOut: true, placeHolder: 'sk-…',
            value: await context.secrets.get(modelSecretKey(baseUrl)) ?? ''
        });
        if (key === undefined) { return 'cancel'; }
        key = key.trim();
    }

    const models = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('setup.listing') },
        () => listModels(baseUrl, key || undefined, new AbortController().signal));
    const current = config.get<string>('model.name', '');
    let model: string | undefined;
    const manual = t('setup.model.manual');
    if (models.length) {
        const ordered = [...(preset.suggest ?? []).filter(s => models.includes(s)), ...models.filter(m => !(preset.suggest ?? []).includes(m))];
        const pick = await vscode.window.showQuickPick([...ordered.map(m => ({ label: m, description: m === current ? t('setup.model.current') : preset.suggest?.includes(m) ? t('setup.model.suggested') : undefined })), { label: manual }],
            { title: t('setup.title', 3, 3), placeHolder: t('setup.pickModel'), ignoreFocusOut: true });
        if (!pick) { return 'cancel'; }
        model = pick.label === manual ? undefined : pick.label;
    }
    if (!model) {
        model = await vscode.window.showInputBox({ title: t('setup.title', 3, 3), prompt: t('setup.model.prompt'), ignoreFocusOut: true,
            value: current || preset.suggest?.[0] || '', validateInput: v => v.trim() ? undefined : t('setup.model.required') });
        if (!model) { return 'cancel'; }
        model = model.trim();
    }

    await config.update('model.provider', 'openai-compatible', vscode.ConfigurationTarget.Global);
    await config.update('model.baseUrl', baseUrl, vscode.ConfigurationTarget.Global);
    await config.update('model.name', model, vscode.ConfigurationTarget.Global);
    if (key) { await context.secrets.store(modelSecretKey(baseUrl), key); }
    // A plain-text token in settings would override the stored key; remove it.
    let clearedPlain = false;
    if (config.inspect<string>('model.token')?.globalValue) { await config.update('model.token', undefined, vscode.ConfigurationTarget.Global); clearedPlain = true; }
    if (clearedPlain) { void vscode.window.showInformationMessage(t('setup.plainCleared')); }
    return test(createChat(modelEndpoint(baseUrl), model, key || undefined, 60000), `${model} · ${new URL(baseUrl).host}`, options);
}

async function test(chat: ReturnType<typeof createChat>, label: string, options: { fromFlow?: boolean }): Promise<'ok' | 'retry' | 'cancel'> {
    try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('setup.testing', label), cancellable: true }, async (_p, token) => {
            const controller = new AbortController(); token.onCancellationRequested(() => controller.abort());
            await chat('Reply with the single word READY.', { task: 'connectivity check' }, controller.signal);
        });
    } catch (error) {
        const retry = t('setup.retry');
        const pick = await vscode.window.showErrorMessage(t('setup.failed', label, errorText(error)), retry);
        return pick === retry ? 'retry' : 'cancel';
    }
    if (options.fromFlow) { void vscode.window.showInformationMessage(t('setup.ok', label)); return 'ok'; }
    const go = t('setup.generateNow');
    void vscode.window.showInformationMessage(t('setup.ok', label), go).then(pick => {
        if (pick === go) { void vscode.commands.executeCommand('issueCommit.generate'); }
    });
    return 'ok';
}
