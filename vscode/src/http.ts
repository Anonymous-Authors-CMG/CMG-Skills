import { Chat, DATA_GUARD, checkAbort } from './types';
import { t } from './i18n';

export function safeUrl(value: string, allowLocalHttp = false): URL {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error(t('err.badUrl')); }
    if (url.username || url.password || url.search || url.hash) { throw new Error(t('err.urlParts')); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(allowLocalHttp && local && url.protocol === 'http:')) { throw new Error(t('err.https')); }
    return url;
}

function apiPath(base: string, suffix: '/chat/completions' | '/models'): string {
    const url = safeUrl(base.trim(), true);
    const root = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    url.pathname = root + suffix;
    return url.toString();
}
export function modelEndpoint(base: string): string { return apiPath(base, '/chat/completions'); }
export function modelsEndpoint(base: string): string { return apiPath(base, '/models'); }

/** Extract only allowlisted codes, never raw error messages that may echo secrets. */
export function networkErrorCodes(error: unknown): string[] {
    const codes = new Set<string>();
    const visit = (value: unknown, depth: number): void => {
        if (!value || typeof value !== 'object' || depth > 4) { return; }
        const e = value as { code?: unknown; cause?: unknown; errors?: unknown };
        if (typeof e.code === 'string' && /^(?:E[A-Z0-9_]+|UND_ERR_[A-Z_]+|CERT_[A-Z_]+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_[A-Z_]+)$/.test(e.code)) { codes.add(e.code); }
        visit(e.cause, depth + 1);
        if (Array.isArray(e.errors)) { for (const child of e.errors.slice(0, 10)) { visit(child, depth + 1); } }
    };
    visit(error, 0); return [...codes];
}

export async function requestJson(url: string, init: RequestInit, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    checkAbort(signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    const host = new URL(url).host;
    try {
        const response = await fetch(url, { ...init, redirect: 'error', signal: controller.signal });
        if (!response.ok) {
            await response.body?.cancel();
            const rateLimited = response.headers.get('x-ratelimit-remaining') === '0'
                || (response.status === 429 && /github|gitlab/.test(host));
            const hint = rateLimited ? t('err.http.rateLimit')
                : response.status === 401 || response.status === 403 ? t('err.http.auth')
                : response.status === 404 ? t('err.http.notFound')
                : response.status === 429 ? t('err.http.429') : '';
            // Never surface response bodies: proxies may echo credentials or prompts.
            throw new Error(t('err.http.status', host, response.status) + (hint ? ' ' + hint : ''));
        }
        const reader = response.body?.getReader();
        if (!reader) { throw new Error(t('err.http.empty')); }
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
            const { value, done } = await reader.read();
            if (done) { break; }
            size += value.byteLength;
            if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new Error(t('err.http.tooLarge')); }
            chunks.push(value);
        }
        try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw new Error(t('err.http.json')); }
    } catch (error) {
        checkAbort(signal);
        if (controller.signal.aborted) { throw new Error(t('err.http.timeout')); }
        if (error instanceof TypeError) {
            const codes = networkErrorCodes(error);
            const hint = codes.some(c => /CERT|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(c)) ? t('err.net.cert')
                : codes.some(c => /ENOTFOUND|EAI_AGAIN/.test(c)) ? t('err.net.dns')
                : codes.some(c => /ECONN|ETIMEDOUT|UND_ERR_CONNECT|UND_ERR_SOCKET/.test(c)) ? t('err.net.conn')
                : t('err.net.other');
            throw new Error(t('err.net', host, codes.join(', ') || 'FETCH_FAILED', hint));
        }
        throw error;
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}

export function createChat(endpoint: string, model: string, token: string | undefined, timeoutMs: number): Chat {
    return async (system, data, signal) => {
        const result = await requestJson(endpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify({ model, stream: false, messages: [
                { role: 'system', content: `${system}\n${DATA_GUARD}` },
                { role: 'user', content: JSON.stringify(data) }
            ] })
        }, signal, timeoutMs) as { choices?: { message?: { content?: unknown } }[] };
        const content = result?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) { throw new Error(t('err.model.noText')); }
        return content.trim();
    };
}

/** List model IDs from an OpenAI-compatible `/models` endpoint. Empty if unsupported. */
export async function listModels(baseUrl: string, token: string | undefined, signal: AbortSignal): Promise<string[]> {
    try {
        const result = await requestJson(modelsEndpoint(baseUrl), { headers: token ? { Authorization: `Bearer ${token}` } : {} }, signal, 15000) as { data?: { id?: unknown }[] };
        const ids = (result?.data ?? []).map(m => m?.id).filter((id): id is string => typeof id === 'string' && !!id);
        return [...new Set(ids)].sort();
    } catch { checkAbort(signal); return []; }
}
