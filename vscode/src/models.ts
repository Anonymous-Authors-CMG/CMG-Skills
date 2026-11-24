import * as vscode from 'vscode';
import { Chat, DATA_GUARD, Settings, SetupNeeded } from './types';
import { createChat, modelEndpoint } from './http';
import { getModelToken } from './config';
import { t } from './i18n';

export interface ResolvedModel { chat: Chat; label: string; kind: 'openai-compatible' | 'vscode-lm' }

function lmAvailable(): boolean {
    return typeof (vscode as { lm?: unknown }).lm === 'object' && typeof vscode.lm?.selectChatModels === 'function';
}

/** VS Code language models (e.g. GitHub Copilot). Empty if the editor has none. */
export async function listLmModels(): Promise<vscode.LanguageModelChat[]> {
    if (!lmAvailable()) { return []; }
    try { return await vscode.lm.selectChatModels(); } catch { return []; }
}

async function pickLmModel(selector: string): Promise<vscode.LanguageModelChat | undefined> {
    if (!lmAvailable()) { return undefined; }
    const all = await listLmModels();
    if (!all.length) { return undefined; }
    if (selector) {
        const s = selector.toLowerCase();
        return all.find(m => m.id.toLowerCase() === s)
            ?? all.find(m => `${m.vendor}/${m.family}`.toLowerCase() === s)
            ?? all.find(m => m.family.toLowerCase() === s || m.name.toLowerCase() === s);
    }
    return all.find(m => m.vendor === 'copilot') ?? all[0];
}

export function createLmChat(model: vscode.LanguageModelChat): Chat {
    return async (system, data, signal) => {
        const cts = new vscode.CancellationTokenSource();
        const cancel = () => cts.cancel();
        signal.addEventListener('abort', cancel, { once: true });
        try {
            const prompt = `${system}\n${DATA_GUARD}\n\nDATA (JSON):\n${JSON.stringify(data)}`;
            const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)],
                { justification: t('lm.justification') }, cts.token);
            let text = '';
            for await (const part of response.text) { text += part; }
            signal.throwIfAborted();
            if (!text.trim()) { throw new Error(t('err.model.noText')); }
            return text.trim();
        } catch (error) {
            signal.throwIfAborted();
            if (error instanceof vscode.LanguageModelError) {
                const reason = error.code === vscode.LanguageModelError.NoPermissions.name ? t('err.lm.permission')
                    : error.code === vscode.LanguageModelError.Blocked.name ? t('err.lm.blocked')
                    : error.code === vscode.LanguageModelError.NotFound.name ? t('err.lm.notFound') : error.message;
                throw new Error(`${model.name}: ${reason}`);
            }
            throw error;
        } finally { signal.removeEventListener('abort', cancel); cts.dispose(); }
    };
}

/**
 * Pick the model to use. `auto` prefers an explicitly configured API, then a VS Code language model.
 * Throws SetupNeeded when nothing usable is configured.
 */
export async function resolveModel(context: vscode.ExtensionContext, uri: vscode.Uri, cfg: Settings): Promise<ResolvedModel> {
    const useApi = cfg.provider === 'openai-compatible' || (cfg.provider === 'auto' && !!cfg.baseUrl);
    if (useApi) {
        if (!cfg.baseUrl || !cfg.model) { throw new SetupNeeded(t('err.setup.api')); }
        const endpoint = modelEndpoint(cfg.baseUrl);
        const token = await getModelToken(context, uri, cfg.baseUrl);
        return { chat: createChat(endpoint, cfg.model, token, cfg.timeoutMs), label: `${cfg.model} · ${new URL(endpoint).host}`, kind: 'openai-compatible' };
    }
    const model = await pickLmModel(cfg.lmModel);
    if (!model) {
        throw new SetupNeeded(cfg.provider === 'vscode-lm'
            ? (cfg.lmModel ? t('err.setup.lmMissing', cfg.lmModel) : t('err.setup.lmNone'))
            : t('err.setup.none'));
    }
    return { chat: createLmChat(model), label: `${model.name} · ${model.vendor}`, kind: 'vscode-lm' };
}
