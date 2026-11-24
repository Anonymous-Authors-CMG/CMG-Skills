/* End-to-end panel workflow against a real Git repository and a mocked VS Code API. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const noop = { dispose() {} };

function harness(t, extraSettings = {}, { remote, branch, model } = {}) {
    const root = mkdtempSync(path.join(tmpdir(), 'issue-commit-test-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    writeFileSync(path.join(root, 'file.txt'), 'before\n'); git('add', '.'); git('commit', '-qm', 'chore: initial\n\nSet up the project.');
    writeFileSync(path.join(root, 'file.txt'), 'after\n'); git('add', '.');
    const uri = p => ({ fsPath: p, toString: () => `file://${p}` });
    const repo = { rootUri: uri(root), inputBox: { value: '' }, state: { remotes: remote ? [{ name: 'origin', fetchUrl: remote }] : [], HEAD: { name: branch ?? 'main' } } };
    const commands = new Map(), messages = [], errors = [], confirmations = [], requests = [];
    let callback, disposed = false;
    const settings = { 'model.baseUrl': 'https://model.example/v1', 'model.name': 'test-model', 'workflow.closeAfterApply': false, ...extraSettings };
    const webview = { cspSource: 'vscode-webview:', asWebviewUri: u => u.toString(), postMessage: async m => { messages.push(m); return true; }, onDidReceiveMessage: cb => { callback = cb; return noop; } };
    const vscode = {
        extensions: { getExtension: () => ({ activate: async () => ({ getAPI: () => ({ repositories: [repo], git: { path: 'git' } }) }) }) },
        Uri: { joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)), parse: str => ({ toString: () => str }) },
        workspace: { isTrusted: true, asRelativePath: u => u.fsPath, getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }), onDidChangeConfiguration: () => noop },
        window: {
            activeTextEditor: undefined,
            createOutputChannel: () => ({ ...noop, appendLine() {}, show() {} }),
            createWebviewPanel: () => ({ webview, onDidDispose: () => noop, reveal() {}, dispose() { disposed = true; } }),
            showInformationMessage: async (text, _opts, option) => { confirmations.push(text); return option; },
            showWarningMessage: async (text, opts, option) => { confirmations.push(text); return typeof opts === 'string' ? opts : option; },
            showErrorMessage: text => { errors.push(text); },
            showQuickPick: async () => undefined, showInputBox: async () => undefined
        },
        commands: { registerCommand: (id, cb) => { commands.set(id, cb); return noop; }, executeCommand: async () => {} },
        env: { clipboard: { writeText: async () => {} }, openExternal: async () => {}, language: 'en' },
        ViewColumn: { Active: 1 }, ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
        ProgressLocation: { Notification: 15, SourceControl: 1 }, QuickPickItemKind: { Separator: -1 }
    };
    const originalLoad = Module._load;
    Module._load = function (id, ...args) { return id === 'vscode' ? vscode : originalLoad.call(this, id, ...args); };
    for (const name of ['extension', 'git', 'config', 'view', 'workbench', 'session', 'models', 'setup', 'quick']) delete require.cache[require.resolve(`../out/${name}`)];
    const { activate } = require('../out/extension');
    const gitModule = require('../out/git');
    require('../out/issues').clearIssueCache();
    Module._load = originalLoad;
    const context = { extensionUri: uri(path.resolve(__dirname, '..')), subscriptions: [], secrets: { get: async () => undefined }, extension: { id: 'cmg-skills.issue-commit', packageJSON: { version: 'test' } } };
    activate(context);
    t.after(() => context.subscriptions.forEach(d => d.dispose()));
    // One fetch mock for both the model and the issue API.
    t.mock.method(global, 'fetch', async (url, options) => {
        const u = String(url);
        if (u.includes('/chat/completions')) {
            const body = JSON.parse(options.body); requests.push(body);
            const data = JSON.parse(body.messages[1].content);
            const content = model ? model(body.messages[0].content, data)
                : JSON.stringify({ subject: 'fix: update file content', body: 'Use the revised content to reflect the intended value.' });
            return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
        }
        if (u.includes('api.github.com')) {
            return new Response(JSON.stringify([{ number: 7, state: 'open', title: 'File content is wrong', body: 'file.txt says before, should say after' },
                { number: 9, state: 'open', title: 'Add dark mode', body: 'unrelated' }]), { headers: { 'Content-Type': 'application/json' } });
        }
        throw new Error('unexpected fetch ' + u);
    });
    async function send(message) {
        const before = messages.length;
        callback(message);
        for (let n = 0; n < 400; n++) {
            await new Promise(r => setTimeout(r, 5));
            if (messages.slice(before).some(m => m.type === 'busy' && m.value === false)) return;
        }
        throw new Error('workflow did not finish');
    }
    return { root, git, repo, gitModule, settings, vscode, messages, errors, confirmations, requests, send, commands,
        disposed: () => disposed, start: () => commands.get('issueCommit.generate')() };
}

test('real Git reads staged-only diff, no untracked contents, and fingerprints change', async t => {
    const h = harness(t);
    writeFileSync(path.join(h.root, 'file.txt'), 'unstaged\n');
    writeFileSync(path.join(h.root, 'new.txt'), 'private untracked\n');
    const staged = await h.gitModule.readDiff(h.repo, 'staged');
    const unstaged = await h.gitModule.readDiff(h.repo, 'unstaged');
    assert.match(staged, /\+after/); assert.doesNotMatch(staged, /unstaged|private untracked/);
    assert.match(unstaged, /\+unstaged/); assert.doesNotMatch(unstaged, /private untracked/);
    assert.notEqual(h.gitModule.fingerprint(staged), h.gitModule.fingerprint(unstaged));
    assert.deepEqual(await h.gitModule.readHistory(h.repo), ['chore: initial\n\nSet up the project.']);
});

test('one click: search, auto-draft, apply; never commits or stages', async t => {
    const h = harness(t);
    const head = h.git('rev-parse', 'HEAD'); const index = h.git('diff', '--cached');
    await h.start(); await h.send({ command: 'ready' });
    const draft = h.messages.find(m => m.type === 'draft');
    assert.ok(draft, 'a draft is generated automatically'); assert.ok(draft.text.startsWith('fix:')); assert.equal(draft.id, '');
    assert.equal(h.requests.length, 1, 'no issue tracker means one model call');
    assert.deepEqual(JSON.parse(h.requests[0].messages[1].content).styleExamples, ['chore: initial\n\nSet up the project.']);
    await h.send({ command: 'apply', id: '', text: draft.text });
    assert.equal(h.repo.inputBox.value, draft.text);
    assert.equal(h.git('rev-parse', 'HEAD'), head); assert.equal(h.git('diff', '--cached'), index);
    assert.equal(h.errors.length, 0);
});

test('with an issue tracker: the strong match is pre-selected and referenced as #N', async t => {
    const h = harness(t, {}, {
        remote: 'git@github.com:org/repo.git',
        model: (system, data) => {
            if (data.topN) return JSON.stringify(data.candidates.map(c => c.id));
            if (data.candidates) return JSON.stringify({ matches: data.candidates.map(c => ({ id: c.id, confidence: c.title.includes('content') ? 'high' : 'low', reason: 'file.txt' })) });
            return JSON.stringify({ subject: 'fix: correct file content', body: 'The file said before.' });
        }
    });
    await h.start(); await h.send({ command: 'ready' });
    const snap = h.messages.find(m => m.type === 'snapshot');
    assert.equal(snap.matches[0].number, 7); assert.equal(snap.selected, snap.matches[0].id);
    const draft = h.messages.find(m => m.type === 'draft');
    assert.equal(draft.id, snap.matches[0].id); assert.match(draft.text, /\n\nRefs #7$/);
    assert.equal(h.requests.filter(r => r.messages[0].content.includes('Re-rank')).length, 1);
});

test('branch name pins its issue; revise keeps the reference; Fixes asks first', async t => {
    const h = harness(t, { 'message.trailer': 'fixes', 'workflow.autoGenerate': false }, {
        remote: 'https://github.com/org/repo.git', branch: 'fix/9-dark',
        model: (system, data) => {
            if (data.topN) return '[]';
            if (data.candidates) return JSON.stringify({ matches: data.candidates.map(c => ({ id: c.id, confidence: 'medium', reason: 'branch' })) });
            return JSON.stringify({ subject: data.revisionRequest ? 'fix: shorter' : 'fix: longer subject', body: '' });
        }
    });
    await h.start(); await h.send({ command: 'ready' });
    const snap = h.messages.find(m => m.type === 'snapshot');
    const nine = snap.matches.find(m => m.number === 9);
    assert.ok(nine.branch); assert.ok(!snap.matches.find(m => m.number === 7).branch);
    assert.equal(snap.selected, nine.id, 'a branch-named issue with medium confidence is pre-selected');
    assert.ok(!h.messages.some(m => m.type === 'draft'), 'autoGenerate off');
    await h.send({ command: 'generate', id: snap.selected });
    assert.ok(h.confirmations.some(c => c.includes('closes the issue')));
    const first = h.messages.filter(m => m.type === 'draft').pop();
    assert.equal(first.text, 'fix: longer subject\n\nFixes #9');
    await h.send({ command: 'refine', id: snap.selected, text: first.text, instruction: 'shorter' });
    assert.equal(h.messages.filter(m => m.type === 'draft').pop().text, 'fix: shorter\n\nFixes #9');
    assert.equal(JSON.parse(h.requests.pop().messages[1].content).previousDraft, 'fix: longer subject');
});

test('overwrite asks first, stale diffs are refused, the panel closes after apply when configured', async t => {
    const h = harness(t);
    await h.start(); await h.send({ command: 'ready' });
    h.repo.inputBox.value = 'existing user draft';
    await h.send({ command: 'apply', id: '', text: 'edited draft' });
    assert.ok(h.confirmations.some(s => s.includes('Replace it?'))); assert.equal(h.repo.inputBox.value, 'edited draft');
    writeFileSync(path.join(h.root, 'file.txt'), 'newer staged content\n'); h.git('add', '.');
    await h.send({ command: 'apply', id: '', text: 'stale draft' });
    assert.equal(h.repo.inputBox.value, 'edited draft'); assert.ok(h.errors.some(e => e.includes('diff changed')));

    const h2 = harness(t, { 'workflow.closeAfterApply': true });
    await h2.start(); await h2.send({ command: 'ready' });
    await h2.send({ command: 'apply', id: '', text: h2.messages.find(m => m.type === 'draft').text });
    await new Promise(r => setTimeout(r, 10));
    assert.ok(h2.disposed());
});

test('changed selection and invented candidate IDs are refused', async t => {
    const h = harness(t, { 'workflow.autoGenerate': false });
    await h.start(); await h.send({ command: 'ready' });
    await h.send({ command: 'generate', id: 'made-up' }); assert.equal(h.requests.length, 0);
    await h.send({ command: 'generate', id: '' });
    await h.send({ command: 'apply', id: 'changed', text: 'draft' }); assert.equal(h.repo.inputBox.value, '');
    assert.ok(h.errors.some(e => e.includes('not among the current candidates'))); assert.ok(h.errors.some(e => e.includes('issue changed')));
});

test('unstaged fallback needs consent and is shown in the snapshot', async t => {
    const h = harness(t); h.git('reset', '-q', 'HEAD');
    await h.start(); await h.send({ command: 'ready' });
    assert.ok(h.confirmations.some(s => s.includes('Nothing is staged')));
    assert.equal(h.messages.find(m => m.type === 'snapshot').mode, 'unstaged');
});

test('no model configured offers setup instead of failing', async t => {
    const h = harness(t, { 'model.baseUrl': '', 'model.name': '' });
    h.vscode.window.showWarningMessage = async text => { h.confirmations.push(text); return undefined; };
    await h.start(); await h.send({ command: 'ready' });
    assert.ok(h.confirmations.some(s => s.includes('No model is set up yet')));
    assert.equal(h.errors.length, 0); assert.equal(h.requests.length, 0);
});

test('reopening the panel for the same repository reuses it', async t => {
    const h = harness(t);
    let created = 0; const original = h.vscode.window.createWebviewPanel;
    h.vscode.window.createWebviewPanel = (...a) => { created++; return original(...a); };
    await h.start(); await h.send({ command: 'ready' });
    await h.start();
    assert.equal(created, 1);
});
