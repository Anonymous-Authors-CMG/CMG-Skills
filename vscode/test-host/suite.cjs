/* Executed inside the extension host. Exports run(): Promise<void>. */
const vscode = require('vscode');
const assert = require('node:assert/strict');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[suite]', ...a);

async function step(name, fn) {
    const t0 = Date.now();
    try { await fn(); log(`PASS ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); }
    catch (e) { log(`FAIL ${name}: ${e && e.stack || e}`); throw e; }
}

exports.run = async function () {
    const ext = vscode.extensions.getExtension('cmg-skills.issue-commit');
    await step('extension is found and activates', async () => {
        assert.ok(ext, 'extension present'); await ext.activate(); assert.ok(ext.isActive);
    });
    await step('all commands are registered', async () => {
        const all = await vscode.commands.getCommands(true);
        for (const id of ['generate', 'quickGenerate', 'setupModel', 'configureProject', 'setIssueToken', 'setModelToken', 'diagnose', 'settings', 'openWalkthrough']) {
            assert.ok(all.includes('issueCommit.' + id), 'missing issueCommit.' + id);
        }
    });
    await step('settings schema and defaults are live', async () => {
        const c = vscode.workspace.getConfiguration('issueCommit');
        assert.equal(c.get('workflow.autoGenerate'), true); assert.equal(c.get('message.format'), 'conventional');
        assert.equal(c.get('issues.autoSelect'), 'high'); assert.equal(c.get('workflow.scmButton'), 'panel');
        assert.ok(c.inspect('model.provider').defaultValue === 'auto');
        assert.ok(ext.packageJSON.contributes.walkthroughs[0].steps.length === 4);
    });
    const git = vscode.extensions.getExtension('vscode.git'); await git.activate();
    const api = git.exports.getAPI(1);
    let repo;
    await step('git repository is detected', async () => {
        for (let i = 0; i < 100 && !api.repositories.length; i++) await sleep(200);
        repo = api.repositories[0]; assert.ok(repo, 'no repository');
        log('repo', repo.rootUri.fsPath, 'branch', repo.state.HEAD && repo.state.HEAD.name);
    });
    await step('Check Connection reaches the issue API and the model', async () => {
        await vscode.commands.executeCommand('issueCommit.diagnose');
    });
    await step('panel opens as a webview tab', async () => {
        await vscode.commands.executeCommand('issueCommit.generate', { rootUri: repo.rootUri });
        await sleep(1500);
        const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
        const tab = tabs.find(t => t.label.startsWith('Issue Commit'));
        assert.ok(tab, 'tab not found: ' + tabs.map(t => t.label).join(', '));
        assert.ok(tab.input instanceof vscode.TabInputWebview);
        await sleep(25000);   // let the auto search + draft finish in the background
    });
    await step('quick mode: search, accept the suggested issue, write the commit box', async () => {
        repo.inputBox.value = '';
        const done = vscode.commands.executeCommand('issueCommit.quickGenerate', { rootUri: repo.rootUri });
        // Accept the first Quick Pick item (the suggestion) once it appears.
        let accepted = false;
        const poll = (async () => {
            for (let i = 0; i < 300 && !accepted; i++) {
                await sleep(500);
                if (repo.inputBox.value) return;
                await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
            }
        })();
        await Promise.race([done, sleep(150000)]); accepted = true; await poll;
        log('commit box:\n' + repo.inputBox.value);
        assert.match(repo.inputBox.value, /^(feat|fix|perf|style|refactor|docs|test|ci|build|chore)(\(.+\))?!?: /);
        assert.match(repo.inputBox.value, /\n\nRefs #4$/, 'expected the branch-named issue #4 to be linked');
    });
};
