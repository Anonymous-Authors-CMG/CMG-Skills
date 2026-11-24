const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSource, resolveSources, issueApi, fetchIssues, fetchIssue, collectIssues, clearIssueCache, branchIssueNumbers } = require('../out/issues');
const { modelEndpoint, modelsEndpoint, requestJson, createChat, listModels, networkErrorCodes } = require('../out/http');
const { truncate, validateIds, rankIssues, finalizeMessage, evaluateMessage, formatReference, preselect, stripNoise, pickExamples, generateMessage, stripReference } = require('../out/pipeline');
const i18n = require('../out/i18n');

const source = parseSource('https://github.com/org/repo/issues');
const issue = (number, src = source) => ({ id: `${src.key}#${number}`, number, source: src, url: `${src.url}/${number}`, title: `Issue ${number}`, body: `Details ${number}` });
const cfg = { topN: 3, chunkSize: 10, maxBodyChars: 1000, language: 'en' };
const signal = () => new AbortController().signal;
const jsonResponse = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const fineAll = (data, confidence = 'low') => JSON.stringify({ matches: data.candidates.map(i => ({ id: i.id, confidence, reason: 'r' })) });

// ---------------------------------------------------------------- sources and URLs

test('GitHub URL, SCP, SSH and .git origins normalize and deduplicate', () => {
    const inputs = ['git@github.com:Org/Repo.git', 'ssh://git@github.com/Org/Repo.git', 'https://github.com/org/repo/issues?q=is%3Aopen'];
    assert.equal(new Set(inputs.map(u => parseSource(u).key)).size, 1);
    assert.equal(resolveSources([{ provider: 'github', url: source.url }], inputs, true).sources.length, 1);
});
test('GitLab nested groups and self-hosted providers use the right API', () => {
    const gl = parseSource('https://gitlab.example.com/group/sub/repo/-/issues?state=opened', 'gitlab');
    assert.equal(gl.project, 'group/sub/repo');
    assert.match(issueApi(gl, 2), /projects\/group%2Fsub%2Frepo\/issues\?state=opened/);
    assert.match(issueApi(parseSource('https://git.example.com/org/repo/issues', 'github'), 1), /^https:\/\/git.example.com\/api\/v3\/repos/);
});
test('unknown remotes are ignored; explicit and remote sources combine', () => {
    assert.deepEqual(resolveSources([], ['git@gitee.com:org/repo.git', '/tmp/local.git'], true).sources, []);
    assert.equal(resolveSources([{ provider: 'github', url: source.url }], ['https://gitlab.com/a/b.git'], true).sources.length, 2);
    assert.equal(resolveSources([], ['https://github.com/a/b.git'], false).sources.length, 0);
});
test('unsafe URLs and credentials are rejected; endpoints normalize', () => {
    assert.throws(() => parseSource('http://github.com/a/b'), /HTTPS/);
    assert.throws(() => parseSource('https://token@github.com/a/b'), /credentials/);
    assert.throws(() => parseSource('https://github.com/a/b/pulls'), /GitHub source/);
    assert.throws(() => modelEndpoint('https://example.com/v1?token=secret'), /query/);
    assert.throws(() => modelEndpoint('http://example.com/v1'), /HTTPS/);
    assert.throws(() => modelEndpoint('not a url'), /valid URL/);
    assert.equal(modelEndpoint('http://localhost:8000/v1/'), 'http://localhost:8000/v1/chat/completions');
    assert.equal(modelEndpoint('https://example.com/v1/chat/completions'), 'https://example.com/v1/chat/completions');
    for (const base of ['https://api.deepseek.com', 'https://api.deepseek.com/', 'https://api.deepseek.com//']) {
        assert.equal(modelEndpoint(base), 'https://api.deepseek.com/chat/completions');
    }
    assert.equal(modelsEndpoint('https://example.com/v1/chat/completions'), 'https://example.com/v1/models');
});

// ---------------------------------------------------------------- issue fetching

test('pool excludes PRs and closed issues, and paginates past PR-heavy pages', async t => {
    let calls = 0;
    t.mock.method(global, 'fetch', async (url, options) => {
        calls++;
        assert.equal(new URL(url).searchParams.get('state'), 'open');
        assert.equal(options.headers.Authorization, 'Bearer test-token');
        assert.equal(options.redirect, 'error');
        return jsonResponse(calls === 1 ? Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: 'PR', state: 'open', pull_request: {} })) : [
            { number: 101, title: 'open', body: 'body', state: 'open' }, { number: 102, title: 'closed', state: 'closed' }]);
    });
    const result = await fetchIssues(source, 10, 'test-token', signal());
    assert.equal(calls, 2); assert.deepEqual(result.issues.map(i => i.number), [101]); assert.equal(result.limited, false);
});
test('GitLab uses opened state and a PRIVATE-TOKEN header', async t => {
    const gl = parseSource('https://gitlab.com/team/repo');
    t.mock.method(global, 'fetch', async (_url, options) => {
        assert.equal(options.headers['PRIVATE-TOKEN'], 'gl-token'); assert.equal(options.headers.Authorization, undefined);
        return jsonResponse([{ iid: 8, state: 'opened', title: 'T', description: 'D' }, { iid: 9, state: 'closed', title: 'C' }]);
    });
    const result = await fetchIssues(gl, 10, 'gl-token', signal());
    assert.equal(result.issues.length, 1); assert.equal(result.issues[0].url, 'https://gitlab.com/team/repo/-/issues/8');
});
test('a failing source is reported without leaking the response body', async t => {
    clearIssueCache();
    const other = parseSource('https://gitlab.com/a/b');
    t.mock.method(global, 'fetch', async url => String(url).includes('api.github.com') ? new Response('SECRET', { status: 403 }) : jsonResponse([{ iid: 1, state: 'opened', title: 'works' }]));
    const result = await collectIssues([source, other], 10, async () => undefined, signal(), () => {});
    assert.equal(result.issues.length, 1); assert.equal(result.warnings.length, 1); assert.doesNotMatch(result.warnings[0], /SECRET/);
});
test('GitHub rate limit gives an actionable hint', async t => {
    t.mock.method(global, 'fetch', async () => new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }));
    await assert.rejects(requestJson('https://api.github.com/x', {}, signal(), 1000), /Rate limit reached.*Token/);
});
test('issue list is cached for cacheMinutes and refetched when 0', async t => {
    clearIssueCache();
    let calls = 0;
    t.mock.method(global, 'fetch', async () => { calls++; return jsonResponse([{ number: 1, state: 'open', title: 'one' }]); });
    const run = minutes => collectIssues([source], 10, async () => undefined, signal(), () => {}, minutes);
    assert.equal((await run(5)).cached, false);
    const second = await run(5);
    assert.equal(second.cached, true); assert.equal(second.issues.length, 1); assert.equal(calls, 1);
    await run(0); assert.equal(calls, 2);
});
test('single-issue lookup returns open issues only', async t => {
    t.mock.method(global, 'fetch', async url => jsonResponse(String(url).endsWith('/7') ? { number: 7, state: 'open', title: 'seven' } : { number: 8, state: 'closed', title: 'eight' }));
    assert.equal((await fetchIssue(source, 7, undefined, signal())).title, 'seven');
    assert.equal(await fetchIssue(source, 8, undefined, signal()), undefined);
});

// ---------------------------------------------------------------- branch hints

test('branch names yield issue numbers; tracker keys are ignored', () => {
    assert.deepEqual(branchIssueNumbers('fix/123-crash-on-start'), [123]);
    assert.deepEqual(branchIssueNumbers('issue-45'), [45]);
    assert.deepEqual(branchIssueNumbers('gh-7'), [7]);
    assert.deepEqual(branchIssueNumbers('42-add-thing'), [42]);
    assert.deepEqual(branchIssueNumbers('feature/PROJ-123-login'), []);
    assert.deepEqual(branchIssueNumbers('main'), []);
    assert.deepEqual(branchIssueNumbers('release/v1.2'), []);
    assert.deepEqual(branchIssueNumbers(undefined), []);
});

// ---------------------------------------------------------------- ranking

test('empty pool never calls the model; a coarse [] means no association', async () => {
    assert.deepEqual(await rankIssues('diff', [], cfg, async () => { throw new Error('should not call'); }, signal(), () => {}), []);
    const pool = Array.from({ length: 5 }, (_, i) => issue(i + 1));
    assert.deepEqual(await rankIssues('diff', pool, cfg, async () => '[]', signal(), () => {}), []);
});
test('a pool no larger than topN skips the title pass', async () => {
    let coarse = 0, fine = 0;
    const chat = async (_s, data) => { if (data.topN) { coarse++; return '[]'; } fine++; return fineAll(data, 'high'); };
    const matches = await rankIssues('diff', [issue(1), issue(2)], cfg, chat, signal(), () => {});
    assert.equal(coarse, 0); assert.equal(fine, 1); assert.equal(matches.length, 2);
});
test('titles first, bodies only for survivors, parallel chunks, same numbers across repos kept apart', async () => {
    const other = parseSource('https://github.com/other/repo');
    const pool = [issue(1), issue(1, other), ...Array.from({ length: 38 }, (_, i) => issue(i + 2))];
    let fine = 0, coarse = 0, inFlight = 0, peak = 0;
    const chat = async (_system, data) => {
        if (data.topN) {
            coarse++; inFlight++; peak = Math.max(peak, inFlight);
            assert.ok(data.candidates.every(c => !('body' in c)));
            await new Promise(r => setTimeout(r, 10)); inFlight--;
            return JSON.stringify(data.candidates.slice(0, data.topN).map(i => i.id));
        }
        fine++; assert.equal(data.candidates.length, 3); assert.ok(data.candidates.every(c => c.body));
        return fineAll(data);
    };
    const matches = await rankIssues('diff', pool, cfg, chat, signal(), () => {});
    assert.equal(matches.length, 3); assert.notEqual(matches[0].issue.id, matches[1].issue.id);
    assert.ok(coarse >= 5); assert.equal(fine, 1); assert.ok(peak > 1, 'chunks should run in parallel');
});
test('a single chunk asks for topN directly (no merge pass)', async () => {
    const pool = Array.from({ length: 8 }, (_, i) => issue(i + 1));
    const asked = [];
    const chat = async (_s, data) => {
        if (data.topN) { asked.push(data.topN); return JSON.stringify(data.candidates.slice(0, data.topN).map(i => i.id)); }
        return fineAll(data);
    };
    await rankIssues('diff', pool, cfg, chat, signal(), () => {});
    assert.deepEqual(asked, [3]);
});
test('pinned (branch) issues always reach fine ranking and are marked', async () => {
    const pool = Array.from({ length: 8 }, (_, i) => issue(i + 1));
    const chat = async (_s, data) => data.topN ? '[]' : fineAll(data, 'medium');
    const matches = await rankIssues('diff', pool, cfg, chat, signal(), () => {}, { pinned: [issue(99)] });
    assert.equal(matches.length, 1); assert.equal(matches[0].issue.number, 99); assert.equal(matches[0].hint, 'branch');
});
test('lenient ID validation drops invented and duplicate IDs; non-arrays still fail', () => {
    assert.deepEqual(validateIds('["made-up"]', [issue(1)], 1), []);
    assert.deepEqual(validateIds(JSON.stringify([issue(1).id, issue(1).id]), [issue(1)], 3).map(i => i.number), [1]);
    assert.deepEqual(validateIds('Here you go: ["' + issue(1).id + '"]', [issue(1)], 1).map(i => i.number), [1]);
    assert.deepEqual(validateIds('```json\n[]\n```', [issue(1)], 1), []);
    assert.throws(() => validateIds('{"a":1}', [issue(1)], 1), /array/);
    assert.throws(() => validateIds('not JSON', [issue(1)], 1), /JSON/);
});
test('coarse failure retries once, then surfaces', async () => {
    const pool = Array.from({ length: 8 }, (_, i) => issue(i + 1));
    let n = 0;
    const flaky = async (_s, data) => data.topN ? (++n === 1 ? 'garbage' : JSON.stringify([pool[0].id])) : fineAll(data);
    assert.equal((await rankIssues('diff', pool, cfg, flaky, signal(), () => {})).length, 1);
    await assert.rejects(rankIssues('diff', pool, cfg, async () => 'garbage', signal(), () => {}), /JSON/);
});
test('fine ranking keeps candidates the model skipped, as weak matches', async () => {
    const matches = await rankIssues('diff', [issue(1)], cfg, async () => '{"matches":[]}', signal(), () => {});
    assert.equal(matches.length, 1); assert.equal(matches[0].confidence, 'low');
});
test('preselect follows the policy and honours branch hints', () => {
    const m = (confidence, hint) => ({ issue: issue(1), confidence, reason: '', ...(hint ? { hint } : {}) });
    assert.equal(preselect([m('high')], 'high').confidence, 'high');
    assert.equal(preselect([m('medium')], 'high'), undefined);
    assert.equal(preselect([m('medium')], 'medium').confidence, 'medium');
    assert.equal(preselect([m('low'), m('medium', 'branch')], 'high').hint, 'branch');
    assert.equal(preselect([m('high')], 'never'), undefined);
});

// ---------------------------------------------------------------- message

test('references are short in the home repo, qualified on the same host, URLs elsewhere', () => {
    const other = parseSource('https://github.com/other/repo');
    const gl = parseSource('https://gitlab.com/g/p');
    assert.equal(formatReference(issue(8), source, 'refs'), 'Refs #8');
    assert.equal(formatReference(issue(8), source, 'fixes'), 'Fixes #8');
    assert.equal(formatReference(issue(8, other), source, 'refs'), 'Refs other/repo#8');
    assert.equal(formatReference(issue(8, gl), source, 'refs'), 'Refs https://gitlab.com/g/p/-/issues/8');
    assert.equal(formatReference(issue(8), undefined, 'refs'), 'Refs https://github.com/org/repo/issues/8');
    assert.equal(formatReference(issue(8), source, 'none'), '');
});
test('finalize adds only our reference, strips model trailers, blocks inline closing refs', () => {
    const raw = JSON.stringify({ subject: 'fix: handle empty input', body: 'Reject empty input to avoid invalid state.\n\nFixes #999\nSigned-off-by: x' });
    const out = finalizeMessage(raw, 'Refs #8', 'conventional');
    assert.match(out, /\n\nRefs #8$/); assert.doesNotMatch(out, /#999|Signed-off/);
    assert.doesNotMatch(finalizeMessage(raw, '', 'conventional'), /Refs|Fixes/);
    assert.throws(() => finalizeMessage(JSON.stringify({ subject: 'fix: thing', body: 'This fixes #999 for good.' }), '', 'conventional'), /closing reference/);
    assert.equal(finalizeMessage(JSON.stringify({ subject: 'fix: tidy parser (#12).', body: '' }), '', 'conventional'), 'fix: tidy parser');
    assert.match(finalizeMessage(JSON.stringify({ subject: 'fix: x', body: 'Regression from #23242, see the issue.' }), '', 'conventional'), /#23242/);
});
test('subject rules depend on the format', () => {
    assert.throws(() => finalizeMessage('{"subject":"Something happened","body":"why"}', '', 'conventional'), /type: summary/);
    assert.equal(finalizeMessage('{"subject":"Handle empty input","body":""}', '', 'plain'), 'Handle empty input');
    assert.ok(finalizeMessage('{"subject":"feat(api)!: drop v1","body":""}', '', 'conventional'));
    assert.throws(() => finalizeMessage(JSON.stringify({ subject: 'fix: ' + 'x'.repeat(80), body: '' }), '', 'conventional'), /72/);
});
test('body wrapping keeps code blocks and indented lines, indents bullet continuations', () => {
    const long = 'word '.repeat(30).trim();
    const code = '    keras.ops.roll(x, tf.constant(1), axis=0)  # an indented code line that is long enough to exceed 72';
    const body = `${long}\n\n- ${long}\n\n${code}\n\n\`\`\`\n${long}\n\`\`\``;
    const lines = finalizeMessage(JSON.stringify({ subject: 'fix: x', body }), '', 'conventional').split('\n');
    assert.ok(lines.includes(code), 'indented code is untouched');
    assert.ok(lines.includes(long), 'fenced code is untouched');
    assert.ok(lines.some(l => /^  word/.test(l)), 'bullet continuation is indented');
    const prose = lines.slice(0, lines.indexOf(code));
    assert.ok(prose.every(l => [...l].length <= 72), 'prose wraps at 72');
});
test('CJK lines are not wrapped at spaces', () => {
    const zh = '把当前行当作字符串维护，追加单词时既要复制整行内容，又要在长度判断和拼接时反复调用 len()，行越长开销越大，所以改为用列表保存。';
    assert.ok(finalizeMessage(JSON.stringify({ subject: 'refactor: 重写 wrap', body: zh }), '', 'conventional').includes(zh));
});
test('generateMessage retries once with the validation error as feedback', async () => {
    const seen = [];
    const chat = async (_s, data) => {
        seen.push(data.previousAttemptRejected);
        return seen.length === 1 ? '{"subject":"Wrong format","body":""}' : '{"subject":"fix: right format","body":"Because."}';
    };
    const out = await generateMessage({ change: 'diff', reference: 'Refs #1' }, { format: 'conventional', language: 'en', instructions: '', maxBodyChars: 1000 }, chat, signal());
    assert.equal(out, 'fix: right format\n\nBecause.\n\nRefs #1');
    assert.equal(seen[0], undefined); assert.match(seen[1], /type: summary/);
});
test('revision sends the previous draft without our trailer, plus instructions and style examples', async () => {
    let data;
    const chat = async (_s, d) => { data = d; return '{"subject":"fix: shorter","body":""}'; };
    await generateMessage({ change: 'diff', reference: 'Refs #1', examples: ['feat: a\n\nbody'], previous: 'fix: long\n\nbody\n\nRefs #1', instruction: 'shorter' },
        { format: 'conventional', language: 'en', instructions: 'Use scope api', maxBodyChars: 1000 }, chat, signal());
    assert.equal(data.previousDraft, 'fix: long\n\nbody'); assert.equal(data.revisionRequest, 'shorter');
    assert.equal(data.customInstructions, 'Use scope api'); assert.deepEqual(data.styleExamples, ['feat: a\n\nbody']);
    assert.equal(stripReference('a\n\nFixes owner/repo#3'), 'a');
});
test('style examples skip merges and trailers and prefer messages with bodies', () => {
    const picked = pickExamples(['Merge branch x', 'fix: one\n\nBecause.\n\nRefs #2', 'chore: two', 'feat: three\n\nWhy.']);
    assert.deepEqual(picked, ['fix: one\n\nBecause.', 'feat: three\n\nWhy.']);
});
test('lock files and minified bundles are dropped, unless they are the whole change', () => {
    const d = (f, c = '+x') => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n${c}\n`;
    const mixed = stripNoise(d('src/a.ts') + d('package-lock.json') + d('web/app.min.js') + d('pnpm-lock.yaml'));
    assert.deepEqual(mixed.dropped, ['package-lock.json', 'web/app.min.js', 'pnpm-lock.yaml']);
    assert.match(mixed.diff, /src\/a.ts/); assert.doesNotMatch(mixed.diff, /lock|min\.js/);
    const only = stripNoise(d('yarn.lock'));
    assert.deepEqual(only.dropped, []); assert.match(only.diff, /yarn.lock/);
});
test('truncation stays within budget', () => {
    const result = truncate('A'.repeat(3000) + 'Z'.repeat(3000), 2000);
    assert.equal(result.length, 2000); assert.match(result, /TRUNCATED/); assert.ok(result.endsWith('ZZZ'));
});

// ---------------------------------------------------------------- HTTP and models

test('cancellation propagates and never silently becomes diff-only', async t => {
    clearIssueCache();
    const controller = new AbortController(); controller.abort();
    t.mock.method(global, 'fetch', () => { throw new Error('must not fetch'); });
    await assert.rejects(collectIssues([source], 10, async () => undefined, controller.signal, () => {}), { name: 'AbortError' });
});
test('Chat Completions payload, credential boundary and error redaction', async t => {
    t.mock.method(global, 'fetch', async (url, options) => {
        assert.equal(url, 'https://model.example/v1/chat/completions');
        assert.equal(options.headers.Authorization, 'Bearer model-token');
        const data = JSON.parse(options.body); assert.equal(data.model, 'model-id'); assert.equal(data.messages[0].role, 'system');
        assert.match(data.messages[0].content, /untrusted DATA/);
        return jsonResponse({ choices: [{ message: { content: 'hello' } }] });
    });
    assert.equal(await createChat('https://model.example/v1/chat/completions', 'model-id', 'model-token', 1000)('system', { diff: 'text' }, signal()), 'hello');
    t.mock.method(global, 'fetch', async () => new Response('model-token', { status: 401 }));
    await assert.rejects(requestJson('https://model.example', {}, signal(), 1000), e => /401/.test(e.message) && !/model-token/.test(e.message));
});
test('model list is read from /models and failures return an empty list', async t => {
    t.mock.method(global, 'fetch', async url => { assert.equal(url, 'https://api.example.com/v1/models'); return jsonResponse({ data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }] }); });
    assert.deepEqual(await listModels('https://api.example.com/v1', 'k', signal()), ['a', 'b']);
    t.mock.method(global, 'fetch', async () => new Response('', { status: 404 }));
    assert.deepEqual(await listModels('https://api.example.com/v1', 'k', signal()), []);
});
test('timeout and malformed responses are actionable', async t => {
    t.mock.method(global, 'fetch', async (_url, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
    await assert.rejects(requestJson('https://example.com', {}, signal(), 10), /timed out/);
    t.mock.method(global, 'fetch', async () => new Response('not json'));
    await assert.rejects(requestJson('https://example.com', {}, signal(), 1000), /JSON/);
});
test('self-review validates the score scale', async () => {
    await assert.rejects(evaluateMessage('diff', 'message', 'en', async () => '{"what":5,"why":4,"reason":"ok"}', signal()), /format/);
    assert.deepEqual(await evaluateMessage('diff', 'message', 'en', async () => '{"what":3,"why":2,"reason":"limited"}', signal()), { what: 3, why: 2, reason: 'limited' });
});
test('network diagnostics keep safe codes, never raw token-bearing messages', async t => {
    const cause = { errors: [{ code: 'ENOTFOUND', message: 'secret-token' }, { code: 'ECONNRESET' }, { code: 'secret-token' }] };
    assert.deepEqual(networkErrorCodes({ cause }), ['ENOTFOUND', 'ECONNRESET']);
    t.mock.method(global, 'fetch', async () => { throw new TypeError('secret-token', { cause }); });
    await assert.rejects(requestJson('https://example.com', {}, signal(), 1000), e => e.message.includes('ENOTFOUND') && !e.message.includes('secret-token'));
});
test('Chinese strings are used when VS Code runs in Chinese', () => {
    i18n.setLanguage('zh-cn');
    try { assert.throws(() => modelEndpoint('http://example.com/v1'), /HTTPS/); assert.match(i18n.t('ui.apply'), /使用/); }
    finally { i18n.setLanguage('en'); }
    assert.equal(i18n.t('ui.apply'), 'Use this message');
});
