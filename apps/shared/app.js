// Shared browser helpers for the console and the simulator. No framework, no build step.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const CODE_KEY = 'closed-loop-access-code';

function storedCode() {
  try {
    return sessionStorage.getItem(CODE_KEY) || '';
  } catch {
    return '';
  }
}
function storeCode(code) {
  try {
    sessionStorage.setItem(CODE_KEY, code);
  } catch {
    /* private mode: keep in memory only */
  }
  memoryCode = code;
}
let memoryCode = '';

export async function getConfig() {
  const res = await fetch('/config.json', { cache: 'no-store' });
  return res.json();
}

/** Shows an accessible dialog asking for the demo access code. Resolves once a code works. */
function askForCode(message) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'access-dialog';
    dlg.setAttribute('aria-labelledby', 'access-title');
    dlg.innerHTML = `
      <form method="dialog">
        <h2 id="access-title">Demo access code</h2>
        <p>${esc(message)}</p>
        <label for="access-code">Access code</label>
        <input id="access-code" name="code" type="password" autocomplete="off" required>
        <p class="access-error" role="alert"></p>
        <button class="btn" type="submit">Continue</button>
      </form>`;
    document.body.append(dlg);
    const input = dlg.querySelector('input');
    const error = dlg.querySelector('.access-error');
    dlg.addEventListener('cancel', (e) => e.preventDefault());
    dlg.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = input.value.trim();
      const ok = await fetch('/admin/clock', { headers: { authorization: `Bearer ${code}` } }).then((r) => r.ok).catch(() => false);
      if (!ok) {
        error.textContent = 'That code did not work. Please check it and try again.';
        input.focus();
        return;
      }
      storeCode(code);
      dlg.close();
      dlg.remove();
      resolve(code);
    });
    dlg.showModal();
    input.focus();
  });
}

export async function ensureAccess(config) {
  if (config.localAccessCode && !storedCode()) storeCode(config.localAccessCode);
  let code = storedCode() || memoryCode;
  if (code) {
    const ok = await fetch('/admin/clock', { headers: { authorization: `Bearer ${code}` } }).then((r) => r.ok).catch(() => false);
    if (ok) return code;
  }
  code = await askForCode('This demo is protected. Enter the access code from the project README or the person who shared the link.');
  return code;
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${storedCode() || memoryCode}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ---- This visitor's own demo household ----
// Each visitor gets a copy of the demo household of their own (its own clock, ledger, and email), so two people
// using the demo at once never affect each other. The id lives in this tab's sessionStorage, rides along in links
// between the pages (?household=), and is shared with this visitor's other open tabs over a BroadcastChannel.

const HOUSEHOLD_KEY = 'closed-loop-household';
const VISITOR_ID = /^demo-[a-z0-9]{10}$/;
const tabs = typeof BroadcastChannel === 'function' ? new BroadcastChannel('closed-loop-household') : null;
let currentHousehold = null;

function sessionHousehold() {
  try {
    return sessionStorage.getItem(HOUSEHOLD_KEY);
  } catch {
    return null;
  }
}

function adopt(id) {
  currentHousehold = id;
  try {
    sessionStorage.setItem(HOUSEHOLD_KEY, id);
  } catch {
    /* private mode: this page still has it in memory */
  }
  // Links to the other page carry the id, so it opens on the same household in a new tab too.
  for (const a of $$('a[href^="/console/"], a[href^="/simulator/"]')) {
    const u = new URL(a.getAttribute('href'), location.origin);
    u.searchParams.set('household', id);
    a.setAttribute('href', u.pathname + u.search + u.hash);
  }
  const here = new URL(location.href);
  if (here.searchParams.has('household')) {
    here.searchParams.delete('household');
    history.replaceState(history.state, '', here.pathname + here.search + here.hash);
  }
  return id;
}

async function householdExists(id) {
  try {
    await api(`/api/households/${id}`);
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
}

/** Asks this visitor's other open tabs which household they are on (for a page opened by typing its address). */
function askOtherTabs(ms = 250) {
  if (!tabs) return Promise.resolve(null);
  return new Promise((resolve) => {
    const onMessage = (e) => e.data?.type === 'here' && VISITOR_ID.test(e.data.household) && done(e.data.household);
    const timer = setTimeout(() => done(null), ms);
    function done(id) {
      clearTimeout(timer);
      tabs.removeEventListener('message', onMessage);
      resolve(id);
    }
    tabs.addEventListener('message', onMessage);
    tabs.postMessage({ type: 'where' });
  });
}

tabs?.addEventListener('message', (e) => {
  if (e.data?.type === 'where' && currentHousehold) tabs.postMessage({ type: 'here', household: currentHousehold });
});

/** This visitor's demo household: from the link, this tab, another open tab, or a fresh one. Call after ensureAccess. */
export async function visitorHousehold() {
  const fromLink = new URL(location.href).searchParams.get('household');
  for (const id of [fromLink, sessionHousehold()]) if (VISITOR_ID.test(id || '') && (await householdExists(id))) return adopt(id);
  const sibling = await askOtherTabs();
  if (sibling && (await householdExists(sibling))) return adopt(sibling);
  return adopt((await startDemoDay()).householdId);
}

/** A fresh demo household for this visitor: 7:55 am tomorrow on its own clock. The one it replaces is deleted. */
export async function startDemoDay() {
  const previous = currentHousehold;
  const r = await api('/admin/demo-start', { method: 'POST', body: previous ? { previous } : {} });
  adopt(r.householdId);
  if (previous) tabs?.postMessage({ type: 'replaced', from: previous, household: r.householdId });
  return r;
}

/** Calls `fn` when another of this visitor's tabs replaces the household this tab is on. */
export function onHouseholdReplaced(fn) {
  tabs?.addEventListener('message', (e) => {
    if (e.data?.type !== 'replaced' || !currentHousehold || e.data.from !== currentHousehold || !VISITOR_ID.test(e.data.household)) return;
    fn(adopt(e.data.household));
  });
}

// ---- Loop glyph ----

const KIND_BY_STATE = {
  SCHEDULED: 'waiting',
  PROMPTED: 'open',
  DEFERRED: 'open',
  UNSURE: 'open',
  DECLINED: 'open',
  REPORTED_DONE: 'closed',
  NEEDS_HUMAN: 'human',
  MISSED: 'alert',
  ESCALATED_L1: 'alert',
  ESCALATED_L2: 'alert',
  ACKNOWLEDGED: 'acked',
  PAUSED: 'paused',
  CANCELLED: 'paused',
};

export function loopKind(state) {
  return KIND_BY_STATE[state] || 'waiting';
}

/** Decorative: always paired with visible text, so hidden from assistive tech. */
export function loopGlyph(state) {
  const kind = loopKind(state);
  const inner =
    kind === 'closed' || kind === 'acked'
      ? '<circle class="dot" cx="16" cy="16" r="4.5"/>'
      : kind === 'human'
        ? '<line class="mark" x1="16" y1="10" x2="16" y2="17"/><circle class="dot" cx="16" cy="22" r="1.8"/>'
        : '';
  return `<svg class="loop" data-kind="${kind}" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><circle class="ring" cx="16" cy="16" r="12" pathLength="100" transform="rotate(-90 16 16)"/>${inner}</svg>`;
}

// ---- MCP client (Streamable HTTP, JSON responses, stateless) ----

export class McpClient {
  constructor(url, token, onTraffic) {
    this.url = url;
    this.token = token;
    this.onTraffic = onTraffic;
    this.protocolVersion = '2025-11-25';
    this.negotiated = null;
    this.nextId = 1;
    this.tools = [];
  }

  async send(message, { notification = false } = {}) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${this.token}`,
    };
    if (this.negotiated) headers['mcp-protocol-version'] = this.negotiated;
    const started = performance.now();
    const entry = { kind: 'mcp', method: message.method, request: message, at: new Date() };
    this.onTraffic?.({ ...entry, phase: 'request' });
    let res;
    try {
      res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(message) });
    } catch (err) {
      this.onTraffic?.({ ...entry, phase: 'error', error: String(err), ms: performance.now() - started });
      throw err;
    }
    const ms = performance.now() - started;
    const body = notification || res.status === 202 ? null : await res.json().catch(() => null);
    this.onTraffic?.({ ...entry, phase: 'response', status: res.status, response: body, ms });
    if (!res.ok && res.status !== 202) throw new Error(`MCP HTTP ${res.status}`);
    if (body?.error) throw new Error(body.error.message);
    return body?.result;
  }

  async initialize() {
    const result = await this.send({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: this.protocolVersion,
        // MCP Apps extension (SEP-1865): this client can render ui:// cards.
        capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } },
        clientInfo: { name: 'closed-loop-simulated-client', version: '0.1.0' },
      },
    });
    this.negotiated = result.protocolVersion;
    this.serverInfo = result.serverInfo;
    await this.send({ jsonrpc: '2.0', method: 'notifications/initialized' }, { notification: true });
    return result;
  }

  async listTools() {
    const result = await this.send({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/list' });
    this.tools = result.tools;
    return result.tools;
  }

  async readResource(uri) {
    return this.send({ jsonrpc: '2.0', id: this.nextId++, method: 'resources/read', params: { uri } });
  }

  async callTool(name, args = {}) {
    return this.send({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params: { name, arguments: args } });
  }
}

export const SCOPE_NOTICE = 'Reminders and check-ins only. Not an emergency alert system. No answer does not mean an emergency.';
export const SIMULATED_NOTICE =
  'Simulated Alexa+ client. Not Amazon software. Alexa+ add-on tooling is partner-only, so this project implements the MCP server side and demonstrates it through a self-built MCP client, as the hackathon FAQ allows.';
export const VOICE_TURNS_NOTICE =
  'Check-in conversations are started by the person, a household routine, or the simulator. MCP add-ons have no documented way to speak first.';
