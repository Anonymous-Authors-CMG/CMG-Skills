/* Runs suite.cjs inside a real VS Code extension host.
   Env: VSCODE_PATH (optional), CMG_TEST_REPO (a git repo with staged changes),
        CM_API_KEY / CM_BASE_URL / CM_LLM_MODEL for a real model, GH_TOKEN optional. */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { runTests } = require('@vscode/test-electron');

(async () => {
    const ext = process.env.CMG_EXT_PATH || path.resolve(__dirname, '..');
    const repo = process.env.CMG_TEST_REPO;
    if (!repo) throw new Error('set CMG_TEST_REPO');
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cmg-vsc-user-'));
    const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmg-vsc-ext-'));
    fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
    fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
        'issueCommit.model.baseUrl': process.env.CM_BASE_URL,
        'issueCommit.model.name': process.env.CM_LLM_MODEL,
        'issueCommit.model.token': process.env.CM_API_KEY,
        'issueCommit.github.token': process.env.GH_TOKEN || '',
        'issueCommit.workflow.closeAfterApply': false,
        'git.openRepositoryInParentFolders': 'always',
        'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false
    }, null, 2));
    try {
        await runTests({
            vscodeExecutablePath: process.env.VSCODE_PATH || '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
            extensionDevelopmentPath: ext,
            extensionTestsPath: path.join(__dirname, 'suite.cjs'),
            launchArgs: [repo, `--user-data-dir=${userData}`, `--extensions-dir=${extDir}`, '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
            extensionTestsEnv: { CMG_TEST_REPO: repo }
        });
    } finally {
        fs.rmSync(userData, { recursive: true, force: true }); fs.rmSync(extDir, { recursive: true, force: true });
    }
})().catch(err => { console.error(err); process.exit(1); });
