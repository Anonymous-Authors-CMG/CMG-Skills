import * as vscode from 'vscode';
import { Settings, Source } from './types';
import { modelEndpoint } from './http';
import { t, uiLanguage } from './i18n';

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], key: string): T => {
    if (!allowed.includes(value as T)) { throw new Error(t('err.config.enum', key, allowed.join(' / '))); }
    return value as T;
};

export function readSettings(uri: vscode.Uri): Settings {
    const c = vscode.workspace.getConfiguration('issueCommit', uri);
    const integer = (key: string, fallback: number, min: number, max: number) => {
        const value = c.get<number>(key, fallback);
        if (!Number.isInteger(value) || value < min || value > max) { throw new Error(t('err.config.int', key, min, max)); }
        return value;
    };
    const sources = c.get<Settings['sources']>('issues.sources', []);
    if (!Array.isArray(sources) || sources.some(s => !s || typeof s.url !== 'string' || !['github', 'gitlab'].includes(s.provider))) { throw new Error(t('err.config.sources')); }
    const language = oneOf(c.get('message.language', 'auto'), ['auto', 'en', 'zh-CN'] as const, 'message.language');
    return {
        provider: oneOf(c.get('model.provider', 'auto'), ['auto', 'openai-compatible', 'vscode-lm'] as const, 'model.provider'),
        baseUrl: c.get<string>('model.baseUrl', '').trim(), model: c.get<string>('model.name', '').trim(),
        lmModel: c.get<string>('model.vscodeLm', '').trim(),
        timeoutMs: integer('model.timeoutSeconds', 120, 10, 600) * 1000,
        enabled: c.get<boolean>('issues.enabled', true), autoDetect: c.get<boolean>('issues.autoDetect', true), sources,
        topN: integer('issues.topN', 3, 1, 10), poolSize: integer('issues.poolSize', 120, 10, 1000),
        chunkSize: integer('issues.chunkSize', 40, 10, 100), maxBodyChars: integer('issues.maxBodyChars', 8000, 1000, 30000),
        autoSelect: oneOf(c.get('issues.autoSelect', 'high'), ['high', 'medium', 'never'] as const, 'issues.autoSelect'),
        useBranchName: c.get<boolean>('issues.useBranchName', true),
        cacheMinutes: integer('issues.cacheMinutes', 5, 0, 120),
        maxDiffChars: integer('diff.maxChars', 24000, 2000, 100000),
        language: language === 'auto' ? (uiLanguage() === 'zh' ? 'zh-CN' : 'en') : language,
        format: oneOf(c.get('message.format', 'conventional'), ['conventional', 'plain'] as const, 'message.format'),
        trailer: oneOf(c.get('message.trailer', 'refs'), ['refs', 'fixes', 'none'] as const, 'message.trailer'),
        instructions: String(c.get<string>('message.instructions', '') ?? ''),
        useHistory: c.get<boolean>('message.useHistory', true),
        autoGenerate: c.get<boolean>('workflow.autoGenerate', true),
        closeAfterApply: c.get<boolean>('workflow.closeAfterApply', true)
    };
}

export const modelSecretKey = (baseUrl: string) => `issueCommit.model:${modelEndpoint(baseUrl)}`;
export const issueSecretKey = (source: Pick<Source, 'provider' | 'origin'>) => `issueCommit.issue:${source.provider}:${source.origin}`;

export async function editSecret(context: vscode.ExtensionContext, key: string, title: string): Promise<void> {
    const value = await vscode.window.showInputBox({ title, prompt: t('secret.prompt'), password: true, ignoreFocusOut: true });
    if (value === undefined) { return; }
    if (value.trim()) { await context.secrets.store(key, value.trim()); }
    else { await context.secrets.delete(key); }
    vscode.window.showInformationMessage(value.trim() ? t('secret.saved') : t('secret.cleared'));
}

/** Keep credentials out of Settings so snapshots never serialize them. */
function configuredToken(uri: vscode.Uri, key: string): string | undefined {
    const value = vscode.workspace.getConfiguration('issueCommit', uri).get<unknown>(key, '');
    if (typeof value !== 'string') { throw new Error(t('err.config.string', key)); }
    return value.trim() || undefined;
}
export async function getModelToken(context: vscode.ExtensionContext, uri: vscode.Uri, baseUrl: string): Promise<string | undefined> {
    return configuredToken(uri, 'model.token') ?? await context.secrets.get(modelSecretKey(baseUrl));
}
export async function getIssueToken(context: vscode.ExtensionContext, uri: vscode.Uri, source: Source): Promise<string | undefined> {
    const map = vscode.workspace.getConfiguration('issueCommit', uri).get<unknown>('issues.tokensByOrigin', {});
    if (!map || typeof map !== 'object' || Array.isArray(map)) { throw new Error(t('err.config.tokensByOrigin')); }
    const value = Object.prototype.hasOwnProperty.call(map, source.origin) ? (map as Record<string, unknown>)[source.origin] : undefined;
    if (value !== undefined && typeof value !== 'string') { throw new Error(t('err.config.tokensByOrigin')); }
    const scoped = typeof value === 'string' ? value.trim() : '';
    if (scoped) { return scoped; }
    if (source.provider === 'github' && source.origin === 'https://github.com') {
        const token = configuredToken(uri, 'github.token'); if (token) { return token; }
    }
    if (source.provider === 'gitlab' && source.origin === 'https://gitlab.com') {
        const token = configuredToken(uri, 'gitlab.token'); if (token) { return token; }
    }
    return await context.secrets.get(issueSecretKey(source));
}
