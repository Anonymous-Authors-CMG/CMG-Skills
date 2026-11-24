const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { parseSource } = require('../out/issues');

function load(settings) {
    const old = Module._load;
    Module._load = function (id, ...args) {
        return id === 'vscode' ? { workspace: { getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }) } } : old.call(this, id, ...args);
    };
    delete require.cache[require.resolve('../out/config')];
    const config = require('../out/config'); Module._load = old;
    return config;
}
const context = { secrets: { get: async () => 'legacy-secret' } };

test('plain-text model token wins over the stored secret; empty falls back to the secret', async () => {
    assert.equal(await load({ 'model.token': ' settings-token ' }).getModelToken(context, {}, 'https://model.example/v1'), 'settings-token');
    assert.equal(await load({}).getModelToken(context, {}, 'https://model.example/v1'), 'legacy-secret');
});
test('a GitHub token is never sent to GitLab or enterprise origins', async () => {
    const c = load({ 'github.token': 'github-only' });
    assert.equal(await c.getIssueToken(context, {}, parseSource('https://github.com/o/r')), 'github-only');
    assert.equal(await c.getIssueToken(context, {}, parseSource('https://gitlab.com/o/r')), 'legacy-secret');
    assert.equal(await c.getIssueToken(context, {}, parseSource('https://enterprise.example/o/r', 'github')), 'legacy-secret');
});
test('origin tokens take precedence and match exactly', async () => {
    const c = load({ 'github.token': 'public', 'issues.tokensByOrigin': { 'https://github.com': 'override', 'https://git.example': 'private' } });
    assert.equal(await c.getIssueToken(context, {}, parseSource('https://github.com/o/r')), 'override');
    assert.equal(await c.getIssueToken(context, {}, parseSource('https://git.example/o/r', 'gitlab')), 'private');
    assert.equal(await c.getIssueToken(context, {}, parseSource('https://other.example/o/r', 'gitlab')), 'legacy-secret');
});
test('tokens never appear in Settings; token settings are machine-scoped and not synced', () => {
    const c = load({ 'model.token': 'secret-a', 'github.token': 'secret-b' });
    assert.doesNotMatch(JSON.stringify(c.readSettings({})), /secret-a|secret-b/);
    const props = Object.assign({}, ...require('../package.json').contributes.configuration.map(g => g.properties));
    for (const key of ['model.token', 'github.token', 'gitlab.token', 'issues.tokensByOrigin']) {
        assert.equal(props['issueCommit.' + key].scope, 'machine'); assert.equal(props['issueCommit.' + key].ignoreSync, true);
    }
});
test('malformed token settings are rejected without echoing the value', async () => {
    await assert.rejects(load({ 'model.token': { private: 'not-a-string' } }).getModelToken(context, {}, 'https://example.com/v1'), e => !e.message.includes('not-a-string'));
});
test('defaults are sensible and "auto" language follows the UI', () => {
    const s = load({}).readSettings({});
    assert.equal(s.provider, 'auto'); assert.equal(s.format, 'conventional'); assert.equal(s.trailer, 'refs');
    assert.equal(s.autoSelect, 'high'); assert.equal(s.autoGenerate, true); assert.equal(s.useHistory, true);
    assert.equal(s.language, 'en');
    assert.throws(() => load({ 'message.format': 'emoji' }).readSettings({}), /message.format/);
    assert.throws(() => load({ 'issues.topN': 0 }).readSettings({}), /issues.topN/);
});
test('every setting in code is declared in package.json, with English and Chinese text', () => {
    const pkg = require('../package.json');
    const props = Object.assign({}, ...pkg.contributes.configuration.map(g => g.properties));
    const src = require('node:fs').readFileSync(require.resolve('../out/config.js'), 'utf8');
    const used = new Set([...src.matchAll(/\.get\(\s*'([\w.]+)'/g)].map(m => m[1]));
    for (const key of used) assert.ok(props['issueCommit.' + key], `issueCommit.${key} missing from package.json`);
    const en = require('../package.nls.json'), zh = require('../package.nls.zh-cn.json');
    const placeholders = [...JSON.stringify(pkg).matchAll(/%([\w.]+)%/g)].map(m => m[1]);
    for (const p of placeholders) { assert.ok(en[p], `missing en ${p}`); assert.ok(zh[p], `missing zh ${p}`); }
});
