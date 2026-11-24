import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { t, uiLanguage, webviewStrings } from './i18n';

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function createPanel(context: vscode.ExtensionContext, title: string): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel('issueCommit.review', title, vscode.ViewColumn.Active,
        { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')], retainContextWhenHidden: true });
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
    const nonce = randomBytes(24).toString('base64');
    const css = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'workbench.css'));
    const js = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'workbench.js'));
    // JSON in a non-executed script tag; `<` is escaped so it cannot close the tag.
    const strings = JSON.stringify(webviewStrings()).replace(/</g, '\\u003c');
    const mac = process.platform === 'darwin';
    panel.webview.html = `<!doctype html>
<html lang="${uiLanguage() === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${panel.webview.cspSource};">
<link rel="stylesheet" href="${css}"><title>Issue Commit</title></head>
<body><main>
<header>
  <div><div class="eyebrow">ISSUE COMMIT</div><h1>${esc(t('ui.headline'))}</h1><p id="meta">${esc(t('ui.loading'))}</p></div>
  <div class="header-actions"><button id="setup" class="secondary">${esc(t('ui.model'))}</button><button id="settings" class="secondary">${esc(t('ui.settings'))}</button></div>
</header>
<div class="statusbar" role="status" aria-live="polite"><span class="spinner" id="spinner" aria-hidden="true"></span><span id="status">${esc(t('ui.loading'))}</span><button id="cancel" class="secondary" hidden>${esc(t('ui.cancel'))}</button></div>
<div id="warnings" role="alert" hidden></div>
<div class="columns">
<section class="card">
  <div class="section-heading"><span class="step">1</span><div><h2>${esc(t('ui.issue.title'))}</h2><p>${esc(t('ui.issue.sub'))}</p></div></div>
  <div id="sources" class="muted"></div>
  <div id="candidates"><p class="empty">${esc(t('ui.issue.searching'))}</p></div>
  <div class="actions"><button id="generate" disabled>${esc(t('ui.generate'))}</button><button id="retry" class="secondary" disabled>${esc(t('ui.retry'))}</button></div>
  <p class="hint">${esc(t('ui.issue.hint'))}</p>
</section>
<section class="card">
  <div class="section-heading"><span class="step">2</span><div><h2>${esc(t('ui.draft.title'))}</h2><p id="draftContext">${esc(t('ui.draft.none'))}</p></div></div>
  <label for="message" class="sr-only">${esc(t('ui.draft.title'))}</label>
  <textarea id="message" spellcheck="false" placeholder="${esc(t('ui.draft.placeholder'))}"></textarea>
  <div class="editor-footer"><span id="subjectCount"></span><span>${esc(mac ? '⌘ Enter' : 'Ctrl+Enter')} · ${esc(t('ui.apply'))}</span></div>
  <div class="actions">
    <button id="apply" disabled>${esc(t('ui.apply'))}</button>
    <button id="copy" class="secondary" disabled>${esc(t('ui.copy'))}</button>
    <button id="evaluate" class="secondary" disabled>${esc(t('ui.evaluate'))}</button>
  </div>
  <form id="refineForm" class="refine"><input id="refine" type="text" placeholder="${esc(t('ui.refine.placeholder'))}" aria-label="${esc(t('ui.refine.label'))}"><button id="refineBtn" class="secondary" type="submit" disabled>${esc(t('ui.refine.button'))}</button></form>
  <div id="evaluation" hidden></div>
  <p class="hint">${esc(t('ui.draft.hint'))}</p>
</section>
</div>
<details class="diff"><summary>${esc(t('ui.diff.summary'))} <span id="diffLabel"></span></summary><pre id="diff"></pre></details>
<footer>${esc(t('ui.footer'))}</footer>
</main>
<script id="l10n" type="application/json">${strings}</script>
<script nonce="${nonce}" src="${js}"></script></body></html>`;
    return panel;
}
