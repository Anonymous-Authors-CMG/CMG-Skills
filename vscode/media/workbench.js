/* Webview UI. No remote resources, no HTML interpolation, no network access. */
(() => {
    const vscode = acquireVsCodeApi();
    const $ = id => document.getElementById(id);
    const L = JSON.parse($('l10n').textContent);
    const fmt = (key, ...args) => (L[key] || key).replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? ''));
    const send = (command, extra = {}) => vscode.postMessage({ command, ...extra });

    let busy = true, initialized = false, selected = '', matches = [], generatedFor;

    function update() {
        const text = $('message').value;
        $('subjectCount').textContent = fmt('ui.subjectCount', [...(text.split('\n')[0] || '')].length);
        $('subjectCount').classList.toggle('over', [...(text.split('\n')[0] || '')].length > 72);
        const hasDraft = !!text.trim();
        $('generate').disabled = busy || !initialized;
        $('generate').textContent = hasDraft && generatedFor === selected ? fmt('ui.regenerate') : fmt('ui.generate');
        $('generate').classList.toggle('secondary', hasDraft && generatedFor === selected);
        $('retry').disabled = busy;
        $('apply').disabled = busy || !hasDraft || generatedFor !== selected;
        $('copy').disabled = busy || !hasDraft;
        $('evaluate').disabled = busy || !hasDraft;
        $('refineBtn').disabled = busy || !hasDraft || !$('refine').value.trim();
        $('refine').disabled = busy || !hasDraft;
        $('cancel').hidden = !busy;
        $('spinner').hidden = !busy;
        $('message').readOnly = busy;
        for (const input of document.querySelectorAll('input[type=radio]')) input.disabled = busy;
    }

    function choice(match, index) {
        const label = document.createElement('label'); label.className = 'candidate';
        const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'issue';
        radio.value = match ? match.id : ''; radio.checked = radio.value === selected;
        radio.addEventListener('change', () => {
            selected = radio.value;
            if ($('message').value && generatedFor !== selected) $('draftContext').textContent = fmt('ui.stale');
            update();
        });
        const content = document.createElement('div'); content.className = 'candidate-content';
        const title = document.createElement('strong');
        title.textContent = match ? `#${match.number} ${match.title}` : fmt('ui.noIssue');
        content.append(title);
        const meta = document.createElement('p'); meta.className = 'meta';
        if (match) {
            const badge = document.createElement('span'); badge.className = `badge ${match.confidence}`; badge.textContent = fmt(`conf.${match.confidence}`);
            meta.append(badge);
            if (match.branch) { const b = document.createElement('span'); b.className = 'badge branch'; b.textContent = fmt('ui.fromBranch'); meta.append(b); }
            if (index === 0 && match.id === selected) { const s = document.createElement('span'); s.className = 'badge suggested'; s.textContent = fmt('ui.suggested'); meta.append(s); }
            meta.append(document.createTextNode(match.project));
        } else { meta.textContent = fmt('ui.noIssue.detail'); }
        content.append(meta);
        if (match) {
            const reason = document.createElement('p'); reason.className = 'reason'; reason.textContent = match.reason; content.append(reason);
            const row = document.createElement('div'); row.className = 'links';
            const open = document.createElement('button'); open.type = 'button'; open.className = 'text-button'; open.textContent = fmt('ui.viewIssue');
            open.addEventListener('click', event => { event.preventDefault(); send('openIssue', { id: match.id }); });
            row.append(open); content.append(row);
            const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = fmt('ui.issueBody');
            const body = document.createElement('pre'); body.textContent = match.body || fmt('ui.noBody');
            details.append(summary, body); content.append(details);
        }
        label.append(radio, content);
        $('candidates').append(label);
    }

    function render() {
        $('candidates').replaceChildren();
        // The suggestion (if any) first, then "No issue", then the rest.
        const top = matches.find(m => m.id === selected);
        if (top) choice(top, 0);
        choice(null, -1);
        matches.filter(m => m !== top).forEach((m, i) => choice(m, i + 1));
    }

    $('settings').onclick = () => send('settings');
    $('setup').onclick = () => send('setup');
    $('cancel').onclick = () => send('cancel');
    $('retry').onclick = () => send('retrieve');
    $('generate').onclick = () => send('generate', { id: selected });
    $('apply').onclick = () => send('apply', { text: $('message').value, id: selected });
    $('copy').onclick = () => send('copy', { text: $('message').value });
    $('evaluate').onclick = () => send('evaluate', { text: $('message').value });
    $('refineForm').addEventListener('submit', event => {
        event.preventDefault();
        if ($('refineBtn').disabled) return;
        send('refine', { text: $('message').value, id: selected, instruction: $('refine').value });
    });
    $('refine').addEventListener('input', update);
    $('message').addEventListener('input', () => { $('evaluation').hidden = true; update(); });
    $('message').addEventListener('keydown', event => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !$('apply').disabled) { event.preventDefault(); $('apply').click(); }
    });

    window.addEventListener('message', event => {
        const msg = event.data;
        if (msg.type === 'busy') { busy = msg.value; update(); }
        if (msg.type === 'status') $('status').textContent = msg.text;
        if (msg.type === 'snapshot') {
            initialized = true;
            const parts = [msg.repo, msg.mode === 'staged' ? fmt('ui.staged') : fmt('ui.unstaged')];
            if (msg.branch) parts.push(msg.branch);
            parts.push(msg.model);
            $('meta').textContent = parts.join(' · ');
            $('sources').textContent = (msg.sources.length ? fmt('ui.sources', msg.sources.join(', '), msg.poolCount) + (msg.cached ? fmt('ui.cached') : '') : fmt('ui.noSources'))
                + (msg.examples ? fmt('ui.history', msg.examples) : '');
            $('diff').textContent = msg.diff;
            $('diffLabel').textContent = msg.truncated ? fmt('ui.diffTruncated') : fmt('ui.diffChars', msg.diff.length);
            $('warnings').textContent = msg.warnings.join('\n'); $('warnings').hidden = !msg.warnings.length;
            matches = msg.matches; selected = msg.selected || ''; generatedFor = undefined; render();
            if ($('message').value) $('draftContext').textContent = fmt('ui.refreshed');
            update();
        }
        if (msg.type === 'draft') {
            $('message').value = msg.text; generatedFor = msg.id; $('evaluation').hidden = true; $('refine').value = '';
            const m = matches.find(x => x.id === msg.id);
            $('draftContext').textContent = m ? fmt('ui.linked', m.number, m.title) : fmt('ui.diffOnly');
            update(); $('message').focus();
        }
        if (msg.type === 'evaluation') {
            $('evaluation').hidden = false;
            $('evaluation').textContent = `${fmt('ui.score', msg.what, msg.why)}\n${msg.reason}\n${fmt('ui.scoreNote')}`;
        }
    });
    update();
    send('ready');
})();
