// MCP App card (MCP Apps extension, SEP-1865): one self-contained ui:// resource that renders any of the
// five tool results. Tools reference it from their definition (_meta.ui.resourceUri, per the MCP Apps spec)
// and from their results (Alexa+'s documented placement). Clients without UI support get the text result.
// The card runs under the spec's restrictive default CSP: inline script and style only, no network.

export const CARD_URI = 'ui://closed-loop/checkin-card';
export const CARD_MIME = 'text/html;profile=mcp-app';

export const CARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Check-in card</title>
<style>
  :root { --paper:#fffaf0; --ink:#1f2a2c; --ink2:#4a5557; --rule:#d8ccb4; --sage:#3f6b4f; --ochre:#8a5a12; --terra:#b2441f; --slate:#3d5a80; color-scheme: light; }
  :root[data-theme="dark"] { --paper:#1e2829; --ink:#efe8da; --ink2:#b9b2a4; --rule:#34403f; --sage:#8fc29f; --ochre:#e2b25c; --terra:#f08a66; --slate:#9db7da; color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: transparent; }
  body { font: 16px/1.4 "Atkinson Hyperlegible", "Segoe UI", system-ui, sans-serif; color: var(--ink); }
  .card { background: var(--paper); border: 1.5px solid var(--rule); border-radius: 16px; padding: 14px 16px; display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; align-items: center; }
  .ring { width: 56px; height: 56px; grid-row: span 3; }
  .ring circle { fill: none; stroke-width: 6; stroke-linecap: round; }
  .ring .track { stroke: var(--rule); opacity: .5; }
  .ring .arc { stroke: var(--ochre); stroke-dasharray: 72 100; transform: rotate(-90deg); transform-origin: 28px 28px; transition: stroke-dasharray .9s cubic-bezier(.5,0,.2,1), stroke .4s; }
  .ring[data-kind="closed"] .arc { stroke: var(--sage); stroke-dasharray: 100 0; }
  .ring[data-kind="human"] .arc { stroke: var(--terra); stroke-dasharray: 100 0; }
  .ring[data-kind="paused"] .arc { stroke: var(--ink2); stroke-dasharray: 2 6; }
  .ring[data-kind="later"] .arc { stroke: var(--ochre); stroke-dasharray: 60 100; }
  .ring .dot { fill: var(--sage); opacity: 0; transition: opacity .4s .7s; }
  .ring[data-kind="closed"] .dot { opacity: 1; }
  .kicker { font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--ink2); }
  .title { font-family: Georgia, "Times New Roman", serif; font-size: 20px; font-weight: 600; line-height: 1.2; }
  .sub { font-size: 14px; color: var(--ink2); }
  ul { list-style: none; margin: 6px 0 0; padding: 0; grid-column: 1 / -1; }
  li { display: flex; gap: 10px; align-items: center; padding: 6px 0; border-top: 1px dashed var(--rule); font-size: 15px; }
  li svg { width: 22px; height: 22px; flex: none; }
  .foot { grid-column: 1 / -1; margin-top: 6px; font-size: 11px; color: var(--ink2); }
</style>
</head>
<body>
<div class="card" id="card" role="group" aria-label="Check-in card">
  <svg class="ring" id="ring" data-kind="open" viewBox="0 0 56 56" aria-hidden="true"><circle class="track" cx="28" cy="28" r="22"/><circle class="arc" cx="28" cy="28" r="22" pathLength="100"/><circle class="dot" cx="28" cy="28" r="6"/></svg>
  <div class="kicker" id="kicker">Check-in</div>
  <div class="title" id="title">Waiting for the result…</div>
  <div class="sub" id="sub"></div>
  <ul id="list" hidden></ul>
  <div class="foot">Closed Loop · reminders and check-ins only, not an emergency alert system</div>
</div>
<script>
(function () {
  var nextId = 1, pending = {}, toolName = null;
  function send(msg) { window.parent.postMessage(msg, '*'); }
  function request(method, params) {
    var id = nextId++;
    send({ jsonrpc: '2.0', id: id, method: method, params: params });
    return new Promise(function (resolve) { pending[id] = resolve; });
  }
  function $(id) { return document.getElementById(id); }
  function text(id, v) { $(id).textContent = v || ''; }
  function mini(kind) {
    var dash = kind === 'closed' ? '100 0' : kind === 'paused' ? '2 6' : '70 100';
    var color = kind === 'closed' ? 'var(--sage)' : kind === 'human' ? 'var(--terra)' : 'var(--ochre)';
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="' + color + '" stroke-width="3" stroke-linecap="round" pathLength="100" stroke-dasharray="' + dash + '" transform="rotate(-90 12 12)"/></svg>';
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function setKind(kind) { requestAnimationFrame(function () { $('ring').setAttribute('data-kind', kind); }); }
  function resize() { var r = document.documentElement.getBoundingClientRect(); send({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { width: Math.ceil(r.width), height: Math.ceil(r.height) } }); }

  function render(result) {
    var sc = (result && result.structuredContent) || {};
    var list = $('list');
    list.hidden = true;
    if (sc.checkins) {
      text('kicker', sc.checkins.length ? 'Open check-ins' : 'Check-ins');
      text('title', sc.checkins.length ? sc.checkins.length + (sc.checkins.length === 1 ? ' loop open' : ' loops open') : (sc.paused ? 'Paused' : 'Nothing due right now'));
      text('sub', sc.checkins.length ? 'Asked one at a time, in the family\\u2019s own words.' : '');
      list.innerHTML = sc.checkins.map(function (c) { return '<li>' + mini('open') + '<span>' + esc(c.label) + (c.isFollowUp ? ' \\u00b7 follow-up' : '') + '</span></li>'; }).join('');
      list.hidden = !sc.checkins.length;
      setKind(sc.checkins.length ? 'open' : (sc.paused ? 'paused' : 'closed'));
    } else if (sc.recordedWording) {
      var kind = sc.recordedAs === 'reported_by_person' ? 'closed' : sc.recordedAs === 'needs_human_contact' ? 'human' : sc.recordedAs === 'not_recorded' ? 'paused' : 'later';
      var next = { none: '', will_ask_again_later: 'Will ask again later.', family_will_be_told: 'Family will get a note.', call_emergency_services: 'Told to call 911 if it is an emergency.' }[sc.nextStep] || '';
      text('kicker', 'Recorded');
      text('title', sc.recordedWording.charAt(0).toUpperCase() + sc.recordedWording.slice(1));
      text('sub', next);
      setKind(kind);
    } else if ('deferredUntilLocal' in sc) {
      text('kicker', 'Said later');
      text('title', sc.deferredUntilLocal ? 'Ask again at ' + sc.deferredUntilLocal : 'Noted for later');
      text('sub', 'The loop stays open until then.');
      setKind('later');
    } else if ('reported' in sc) {
      text('kicker', 'Today');
      text('title', sc.reported + ' reported \\u00b7 ' + sc.open + ' open');
      text('sub', sc.sharedWith && sc.sharedWith.length ? 'Shared with ' + sc.sharedWith.join(', ') + ' only if a loop stays open.' : 'Not shared with anyone.');
      setKind(sc.open ? 'open' : 'closed');
    } else if ('pausedUntilLocal' in sc) {
      text('kicker', 'Paused');
      text('title', 'No check-ins until ' + (sc.pausedUntilLocal || 'later'));
      text('sub', 'The family sees the pause in the console.');
      setKind('paused');
    } else {
      text('title', (result && result.content && result.content[0] && result.content[0].text) || 'Done');
    }
    setTimeout(resize, 50);
  }

  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return;
    var m = e.data;
    if (!m || m.jsonrpc !== '2.0') return;
    if (m.id != null && pending[m.id] && !m.method) { pending[m.id](m.result || {}); delete pending[m.id]; return; }
    if (m.method === 'ui/notifications/tool-input') toolName = (m.params && m.params.toolName) || toolName;
    else if (m.method === 'ui/notifications/tool-result') render(m.params);
    else if (m.method === 'ui/notifications/host-context-changed' && m.params && m.params.theme) document.documentElement.setAttribute('data-theme', m.params.theme);
    else if (m.method === 'ui/resource-teardown') send({ jsonrpc: '2.0', id: m.id, result: {} });
  });

  request('ui/initialize', { protocolVersion: '2025-06-18', appInfo: { name: 'closed-loop-checkin-card', version: '0.1.0' }, appCapabilities: { availableDisplayModes: ['inline'] } }).then(function (init) {
    var ctx = (init && init.hostContext) || {};
    if (ctx.theme) document.documentElement.setAttribute('data-theme', ctx.theme);
    send({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
    resize();
  });
})();
</script>
</body>
</html>`;
