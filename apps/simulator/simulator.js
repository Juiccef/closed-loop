// Simulated Alexa+ client. The browser is a real MCP client: initialize, tools/list, tools/call over
// Streamable HTTP. A planner (Bedrock, or rules) stands in for Alexa+'s LLM and picks the tool call.

import { $, $$, McpClient, SCOPE_NOTICE, SIMULATED_NOTICE, VOICE_TURNS_NOTICE, api, ensureAccess, esc, getConfig, loopGlyph } from '/shared/app.js';

const state = { queue: [], current: null, recent: null, household: 'demo', mcp: null, speak: false, plannerKind: 'rules', loops: new Map(), seenMail: new Set(), cards: new Map() };

$('#simulated-notice').textContent = SIMULATED_NOTICE;
$('#scope-notice').textContent = SCOPE_NOTICE;
$('#voice-notice').textContent = VOICE_TURNS_NOTICE;

// ---- Captions ----

function caption(who, text, extra = '') {
  const li = document.createElement('li');
  const label = who === 'assistant' ? 'Assistant (simulated)' : who === 'person' ? 'Margaret' : 'Simulation';
  li.className = `cap ${who}`;
  li.innerHTML = `<span class="who">${label}</span><span class="text">${esc(text)}</span>${typeof extra === 'string' ? extra : ''}`;
  if (extra instanceof Node) li.append(extra);
  $('#captions').append(li);
  li.scrollIntoView({ block: 'end', behavior: 'smooth' });
  return li;
}

function orb(s, label) {
  $('#orb').dataset.state = s;
  if (label) $('#orb-label').textContent = label;
}

function say(text, extra = '') {
  caption('assistant', text, extra);
  orb('speaking', 'Speaking');
  const done = () => orb('idle', state.current ? 'Listening for Margaret’s answer' : 'Waiting for someone to start a check-in');
  if (state.speak && 'speechSynthesis' in window) {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.95;
    u.onend = done;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } else {
    setTimeout(done, 900);
  }
}

function resultCard(sc, name) {
  if (name === 'record_response') {
    const st = { reported_by_person: 'REPORTED_DONE', needs_human_contact: 'NEEDS_HUMAN', declined: 'DECLINED', not_recorded: 'PAUSED' }[sc.recordedAs] || 'PROMPTED';
    const next = { none: '', will_ask_again_later: 'Will ask again later', family_will_be_told: 'Family will get a note', call_emergency_services: 'Told to call 911' }[sc.nextStep];
    return `<div class="card">${loopGlyph(st)}<span>Recorded: <strong>${esc(sc.recordedWording)}</strong>${next ? ` <span class="next">· ${esc(next)}</span>` : ''}</span></div>`;
  }
  if (name === 'defer_checkin' && sc.deferredUntilLocal) {
    return `<div class="card">${loopGlyph('DEFERRED')}<span>Recorded: <strong>said later</strong> <span class="next">· ask again at ${esc(sc.deferredUntilLocal)}</span></span></div>`;
  }
  if (name === 'pause_checkins') return `<div class="card">${loopGlyph('PAUSED')}<span><strong>Paused</strong> <span class="next">until ${esc(sc.pausedUntilLocal)}</span></span></div>`;
  return '';
}

// ---- MCP App cards (SEP-1865) ----
// The card is the server's ui:// resource, rendered in a sandboxed iframe (opaque origin, restrictive CSP).
// Simplification: one sandboxed frame instead of the spec's two-level sandbox proxy on a separate origin.

const CARD_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

function hostTheme() {
  const forced = document.documentElement.dataset.theme;
  if (forced) return forced;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function mountCard(toolName, args, result) {
  const uri = result?._meta?.ui?.resourceUri || state.mcp.tools.find((t) => t.name === toolName)?._meta?.ui?.resourceUri;
  const html = uri && state.cards.get(uri);
  if (!html) return null;
  const wrap = document.createElement('div');
  wrap.className = 'app-card';
  const frame = document.createElement('iframe');
  frame.title = `Check-in card from the MCP server (${toolName})`;
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.srcdoc = html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${CARD_CSP}">`);
  const label = document.createElement('span');
  label.className = 'app-label';
  label.textContent = `MCP App · ${uri}${result?._meta?.ui?.invoked ? ` · ${result._meta.ui.invoked}` : ''}`;
  wrap.append(frame, label);
  const post = (msg) => frame.contentWindow?.postMessage(msg, '*');
  const onMessage = (e) => {
    if (e.source !== frame.contentWindow) return;
    const m = e.data;
    if (!m || m.jsonrpc !== '2.0') return;
    if (m.method === 'ui/initialize') {
      post({
        jsonrpc: '2.0',
        id: m.id,
        result: {
          protocolVersion: m.params?.protocolVersion ?? '2025-06-18',
          hostCapabilities: {},
          hostInfo: { name: 'closed-loop-simulated-client', version: '0.1.0' },
          hostContext: { theme: hostTheme(), displayMode: 'inline', availableDisplayModes: ['inline'], locale: 'en-US', platform: 'web', containerDimensions: { width: frame.clientWidth, maxHeight: 320 } },
        },
      });
    } else if (m.method === 'ui/notifications/initialized') {
      post({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: args } });
      post({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result });
      traffic({ kind: 'app', tag: 'MCP App', title: `${uri} ← tool-result`, meta: 'sandboxed iframe', line: 'ui/initialize → initialized → tool-input → tool-result', body: { uri, tool: toolName, delivered: result } });
    } else if (m.method === 'ui/notifications/size-changed') {
      frame.style.height = `${Math.min(320, Math.max(60, m.params?.height ?? 120))}px`;
    } else if (m.id != null && m.method) {
      post({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not supported by this host' } });
    }
  };
  window.addEventListener('message', onMessage);
  return wrap;
}

async function loadCards() {
  const uris = new Set(state.mcp.tools.map((t) => t._meta?.ui?.resourceUri).filter(Boolean));
  for (const uri of uris) {
    const r = await state.mcp.readResource(uri);
    const c = r?.contents?.find((x) => x.mimeType === 'text/html;profile=mcp-app');
    if (c?.text) state.cards.set(uri, c.text);
  }
}

// ---- Traffic pane ----

function highlight(obj) {
  const json = esc(JSON.stringify(obj, null, 2));
  return json.replace(/(&quot;(?:\\.|[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|-?\b\d+(\.\d+)?\b/g, (m, str, colon, lit) => {
    if (str) return colon ? `<span class="j-key">${str}</span>${colon}` : `<span class="j-str">${str}</span>`;
    if (lit) return `<span class="j-lit">${m}</span>`;
    return `<span class="j-num">${m}</span>`;
  });
}

const pending = new Map();
function traffic(entry) {
  const list = $('#traffic');
  if (entry.kind === 'mcp') {
    if (entry.phase === 'request') {
      const li = document.createElement('li');
      const name = entry.request.params?.name ? ` ${entry.request.params.name}` : '';
      li.innerHTML = `<details><summary><span class="t-kind">MCP</span><span class="t-method">${esc(entry.method)}${esc(name)}</span><span class="t-meta">sending…</span></summary><pre tabindex="0"><span class="lbl">→ request</span>\n${highlight(entry.request)}</pre></details>`;
      list.prepend(li);
      pending.set(entry.request, li);
      return;
    }
    const li = pending.get(entry.request);
    if (!li) return;
    pending.delete(entry.request);
    const meta = entry.phase === 'error' ? 'network error' : `HTTP ${entry.status} · ${Math.round(entry.ms)} ms`;
    li.querySelector('.t-meta').textContent = meta;
    if (entry.phase === 'error' || entry.status >= 400) li.querySelector('.t-kind').classList.add('err');
    const sc = entry.response?.result?.structuredContent;
    if (sc?.say) li.querySelector('summary').insertAdjacentHTML('beforeend', `<span class="t-line">“${esc(sc.say)}”</span>`);
    li.querySelector('pre').insertAdjacentHTML('beforeend', `\n\n<span class="lbl">← response</span>\n${entry.response ? highlight(entry.response) : '(202 Accepted, no body)'}`);
    return;
  }
  const li = document.createElement('li');
  const cls = entry.kind === 'planner' ? 'planner' : entry.kind === 'tick' ? 'tick' : entry.kind === 'app' ? 'app' : 'err';
  li.innerHTML = `<details><summary><span class="t-kind ${cls}">${esc(entry.tag)}</span><span class="t-method">${esc(entry.title)}</span><span class="t-meta">${esc(entry.meta || '')}</span>${entry.line ? `<span class="t-line">${esc(entry.line)}</span>` : ''}</summary><pre tabindex="0">${highlight(entry.body)}</pre></details>`;
  list.prepend(li);
}

// ---- Conversation ----

function askNext() {
  state.current = state.queue[0] || null;
  if (state.current) state.recent = { occurrenceId: state.current.occurrenceId, label: state.current.label };
  if (state.current) setTimeout(() => say(state.current.prompt), 700);
  else orb('closed', 'Nothing else due right now');
}

function handleDue(sc, r) {
  state.queue = sc.checkins || [];
  state.current = state.queue[0] || null;
  if (state.current) state.recent = { occurrenceId: state.current.occurrenceId, label: state.current.label };
  say(sc.say, (r && mountCard('get_due_checkins', {}, r)) || '');
  if (!state.current) orb('closed', 'Nothing due right now');
}

async function callTool(name, args) {
  let r;
  try {
    r = await state.mcp.callTool(name, args);
  } catch (err) {
    if (!/MCP HTTP 401/.test(err.message) || !(await refreshAccess())) throw err;
    r = await state.mcp.callTool(name, args);
  }
  refreshSoon();
  return r;
}

async function routineStart() {
  const label = $('#routine-label').textContent.replace(/^Simulate /, '');
  caption('system', `Household routine started (${label}). The routine opens the check-in add-on.`);
  orb('thinking', 'Asking the add-on what is due');
  const r = await callTool('get_due_checkins', {});
  handleDue(r.structuredContent, r);
}

async function personSays(text) {
  const t = text.trim().slice(0, 200);
  if (!t) return;
  caption('person', t);
  orb('thinking', `Planner (${state.plannerKind}) choosing a tool`);
  const started = performance.now();
  const plan = await api('/planner', {
    method: 'POST',
    body: {
      userText: t,
      current: state.current && { occurrenceId: state.current.occurrenceId, label: state.current.label, prompt: state.current.prompt },
      recent: state.recent,
      tools: state.mcp.tools,
    },
  });
  traffic({
    kind: 'planner',
    tag: `planner: ${plan.planner}`,
    title: plan.toolCall ? `→ ${plan.toolCall.name}` : '→ reply only',
    meta: `${Math.round(performance.now() - started)} ms`,
    line: plan.rationale,
    body: plan,
  });
  if (!plan.toolCall) return say(plan.reply);

  const { name, arguments: args } = plan.toolCall;
  const r = await callTool(name, args);
  if (r.isError) return say(r.content?.[0]?.text || 'Sorry, something went wrong.');
  const sc = r.structuredContent;
  if (name === 'get_due_checkins') return handleDue(sc, r);
  say(sc.say, mountCard(name, args, r) || resultCard(sc, name));

  if (name === 'record_response' || name === 'defer_checkin') {
    // Distress or crisis: no further questions in this conversation.
    if (sc.recordedAs === 'needs_human_contact' || sc.nextStep === 'call_emergency_services') {
      state.queue = [];
      state.current = null;
      return;
    }
    state.queue = state.queue.filter((c) => c.occurrenceId !== args.occurrenceId);
    askNext();
  }
  if (name === 'pause_checkins') {
    state.queue = [];
    state.current = null;
  }
}

// ---- Clock ----

function routineLabelFor(hour) {
  if (hour < 11) return 'Simulate morning routine start';
  if (hour < 16) return 'Simulate lunchtime routine start';
  return 'Simulate evening routine start';
}

function renderClock(c) {
  const [date] = c.localNow.split(' ');
  const pretty = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
  $('#clock-day').textContent = `${c.weekday}, ${pretty}`;
  $('#clock-time').textContent = c.spoken;
  const h = Math.round(c.offsetSeconds / 3600);
  $('#clock-offset').textContent = c.offsetSeconds ? `real time ${h >= 0 ? '+' : ''}${h} h` : 'real time';
  $('#routine-label').textContent = routineLabelFor(Number(c.localNow.slice(11, 13)));
}

async function loadClock() {
  renderClock(await api('/admin/clock'));
}

async function moveClock(body, label) {
  $$('.clock-buttons button').forEach((b) => (b.disabled = true));
  try {
    const r = await api('/admin/clock', { method: 'POST', body });
    const t = r.tick;
    const parts = [];
    if (t.closed) parts.push(`closed ${t.closed} window${t.closed > 1 ? 's' : ''}`);
    if (t.alertsSent) parts.push(`emailed family ×${t.alertsSent}`);
    if (t.notesSent) parts.push(`needs-human note ×${t.notesSent}`);
    if (t.alertsSuppressed) parts.push(`capped ×${t.alertsSuppressed}`);
    traffic({ kind: 'tick', tag: 'tick', title: `clock ${label} → tick`, meta: parts.join(' · ') || 'nothing to close', body: r });
    state.queue = [];
    state.current = null;
    state.recent = null;
    await loadClock();
    $('#clock-time').classList.remove('flash');
    void $('#clock-time').offsetWidth;
    $('#clock-time').classList.add('flash');
    orb('idle', 'Waiting for someone to start a check-in');
    await refresh();
  } finally {
    $$('.clock-buttons button').forEach((b) => (b.disabled = false));
  }
}

// ---- Loops and mail (polling) ----

async function refresh() {
  const ledger = await api(`/api/households/${state.household}/ledger?days=1`);
  const items = ledger.items.filter((i) => i.date === ledger.today);
  const ul = $('#loops');
  if (!items.length) ul.innerHTML = '<li class="empty">No check-ins today.</li>';
  else {
    ul.innerHTML = items
      .map((i) => {
        const changed = state.loops.has(i.occurrenceId) && state.loops.get(i.occurrenceId) !== i.ledger;
        state.loops.set(i.occurrenceId, i.ledger);
        const detail = [i.askedAt && `asked ${i.askedAt}`, i.answeredAt && `answered ${i.answeredAt}`, i.deferredUntil && `ask again ${i.deferredUntil}`].filter(Boolean).join(' · ');
        return `<li class="${changed ? 'changed' : ''}">${loopGlyph(i.state)}<span class="label">${esc(i.label)}<span class="window">${esc(i.window)}</span></span><span class="status">${esc(i.ledger)}${detail ? ` <span class="window">${esc(detail)}</span>` : ''}</span></li>`;
      })
      .join('');
  }

  const mailEvents = ledger.events.filter((e) => ['alert_sent', 'needs_human_note_sent', 'alert_suppressed', 'alert_failed'].includes(e.type)).slice(0, 6);
  let emails = [];
  try {
    emails = await api('/admin/emails');
  } catch {
    emails = [];
  }
  const mail = $('#mail');
  if (emails.length) {
    mail.innerHTML = emails
      .slice(0, 4)
      .map(
        (m) =>
          `<li><span class="subj">${esc(m.subject)}</span><span class="meta">to ${esc(m.toName)} · sent with ${esc(m.via)} · ${new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} real time</span><p class="body">${esc(m.preview)}</p></li>`,
      )
      .join('');
  } else if (mailEvents.length) {
    mail.innerHTML = mailEvents
      .map((e) => `<li><span class="subj">${esc(e.detail)}</span><span class="meta">${esc(e.local)} · sent with Amazon SES</span></li>`)
      .join('');
  } else {
    mail.innerHTML = '<li class="empty">No email yet. Family is only emailed when a loop stays open.</li>';
  }
}

let refreshTimer;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh().catch(() => {}), 250);
}

// ---- OAuth 2.1 account linking (the simulator as a public client with PKCE) ----

const oauth = { verifier: null, state: null, refreshToken: null };
const PENDING_KEY = 'closed-loop-oauth-pending';
const RESULT_KEY = 'closed-loop-oauth-result';
const session = {
  get: (k) => {
    try {
      return JSON.parse(sessionStorage.getItem(k) || 'null');
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      sessionStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
  del: (k) => {
    try {
      sessionStorage.removeItem(k);
    } catch {}
  },
};
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const redact = (t) => (t ? `${t.slice(0, 10)}…(${t.length} chars)` : t);

async function oauthToken(form) {
  const t0 = performance.now();
  const res = await fetch('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
  const body = await res.json();
  const shown = { ...body, access_token: redact(body.access_token), refresh_token: redact(body.refresh_token) };
  traffic({ kind: 'app', tag: 'OAuth', title: `POST /oauth/token (${form.grant_type})`, meta: `HTTP ${res.status} · ${Math.round(performance.now() - t0)} ms`, line: res.ok ? `scope ${body.scope} · expires in ${body.expires_in} s` : body.error, body: { request: { ...form, code: redact(form.code), code_verifier: redact(form.code_verifier), refresh_token: redact(form.refresh_token) }, response: shown } });
  if (!res.ok) throw new Error(`OAuth: ${body.error_description || body.error}`);
  return body;
}

function useTokens(tokens) {
  state.mcp.token = tokens.access_token;
  oauth.refreshToken = tokens.refresh_token;
  $('#auth-chip').textContent = `auth: OAuth 2.1 user token · ${tokens.scope} · ${Math.round(tokens.expires_in / 60)} min`;
  $('#link-oauth').textContent = 'Linked';
  $('#link-oauth').disabled = true;
}

async function refreshAccess() {
  if (!oauth.refreshToken) return false;
  useTokens(await oauthToken({ grant_type: 'refresh_token', refresh_token: oauth.refreshToken, client_id: 'simulator' }));
  return true;
}

async function startLinking() {
  const link = await api(`/api/households/${state.household}/link-code`, { method: 'POST', body: {} });
  const box = document.createElement('div');
  box.className = 'card link-card';
  box.innerHTML = `<span>Link code from the caregiver console: <strong class="code">${esc(link.code)}</strong> (works once, 10 minutes)</span>`;
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'btn small';
  go.textContent = 'Open sign-in page';
  go.addEventListener('click', guard(() => openSignIn()));
  box.append(go);
  caption('system', 'Account linking with OAuth 2.1 (authorization code + PKCE), the way the Alexa app links an add-on.', box);
}

async function openSignIn() {
  oauth.verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  oauth.state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(oauth.verifier)));
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: 'simulator',
    redirect_uri: `${location.origin}/simulator/linked.html`,
    scope: 'mcp:tools',
    state: oauth.state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${location.origin}/mcp`,
  });
  traffic({ kind: 'app', tag: 'OAuth', title: 'GET /oauth/authorize', meta: 'sign-in page', line: 'authorization code + PKCE (S256), resource = /mcp', body: Object.fromEntries(p) });
  session.set(PENDING_KEY, { verifier: oauth.verifier, state: oauth.state });
  const popup = window.open(`/oauth/authorize?${p}`, 'closed-loop-link', 'width=560,height=760');
  if (!popup) location.assign(`/oauth/authorize?${p}`); // popup blocked: same-tab flow
}

async function finishLinking(result) {
  const pending = session.get(PENDING_KEY);
  session.del(PENDING_KEY);
  if (result.error) throw new Error(`Linking ${result.error === 'access_denied' ? 'cancelled' : `failed: ${result.error}`}`);
  if (!pending || result.state !== pending.state) throw new Error('OAuth: state mismatch');
  const tokens = await oauthToken({ grant_type: 'authorization_code', code: result.code, code_verifier: pending.verifier, client_id: 'simulator', resource: `${location.origin}/mcp` });
  useTokens(tokens);
  caption('system', 'Linked. MCP calls now use the OAuth access token instead of the demo token.');
  await state.mcp.initialize();
  await state.mcp.listTools();
}

window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.data?.type !== 'closed-loop-oauth') return;
  guard(finishLinking)(e.data);
});

// ---- Wiring ----

async function main() {
  const config = await getConfig();
  await ensureAccess(config);
  const demo = await api('/admin/demo-config');
  state.household = demo.householdId;
  state.plannerKind = demo.planner;
  $('#traffic-sub').textContent = `POST ${new URL(demo.mcpUrl).pathname} · Streamable HTTP · stateless · planner: ${demo.planner}`;
  state.mcp = new McpClient(demo.mcpUrl, demo.mcpToken, traffic);
  await state.mcp.initialize();
  await state.mcp.listTools();
  await loadCards();
  $('#traffic-sub').textContent += ` · protocol ${state.mcp.negotiated}${state.cards.size ? ' · MCP Apps' : ''}`;
  await Promise.all([loadClock(), refresh()]);
  const returned = session.get(RESULT_KEY);
  if (returned) {
    session.del(RESULT_KEY);
    await finishLinking(returned);
  }
  setInterval(() => {
    refresh().catch(() => {});
    loadClock().catch(() => {});
  }, 5000);
}

const guard = (fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (err) {
    console.error(err);
    traffic({ kind: 'error', tag: 'error', title: err.message || String(err), body: { error: String(err) } });
    orb('idle', 'Something went wrong; see the traffic pane');
  }
};

$('#routine').addEventListener('click', guard(routineStart));
$('#link-oauth').addEventListener('click', guard(startLinking));
$('#say-form').addEventListener(
  'submit',
  guard(async (e) => {
    e.preventDefault();
    const input = $('#say-input');
    const text = input.value;
    input.value = '';
    await personSays(text);
  }),
);
$$('.chip').forEach((b) => b.addEventListener('click', guard(() => personSays(b.dataset.say))));
$$('[data-adv]').forEach((b) => b.addEventListener('click', guard(() => moveClock({ advanceSeconds: Number(b.dataset.adv) }, b.textContent.trim()))));
$('[data-reset]').addEventListener('click', guard(() => moveClock({ reset: true }, 'reset')));
$('#demo-start').addEventListener(
  'click',
  guard(async () => {
    const r = await api('/admin/demo-start', { method: 'POST', body: {} });
    traffic({ kind: 'tick', tag: 'demo', title: 'fresh demo day', meta: r.localNow, body: r });
    state.queue = [];
    state.current = null;
    state.loops.clear();
    $('#captions').innerHTML = '';
    caption('system', 'New demo day. The plan, consent, and ledger were reset.');
    await Promise.all([loadClock(), refresh()]);
  }),
);
$('#speak-toggle').addEventListener('change', (e) => {
  state.speak = e.target.checked;
  if (!state.speak && 'speechSynthesis' in window) speechSynthesis.cancel();
});

// Optional microphone (Web Speech API), only where the browser supports it.
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (Recognition) {
  const mic = $('#mic');
  mic.hidden = false;
  let rec = null;
  mic.addEventListener('click', () => {
    if (rec) return rec.stop();
    rec = new Recognition();
    rec.lang = 'en-US';
    rec.interimResults = false;
    mic.setAttribute('aria-pressed', 'true');
    orb('thinking', 'Listening (browser speech recognition)');
    rec.onresult = (e) => guard(personSays)(e.results[0][0].transcript);
    rec.onend = () => {
      rec = null;
      mic.setAttribute('aria-pressed', 'false');
    };
    rec.start();
  });
}

guard(main)();
