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
        ? '<line class="mark" x1="16" y1="10" x2="16" y2="17"/><circle class="dot" cx="16" cy="22" r="1.8" style="fill:var(--terra)"/>'
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
      params: { protocolVersion: this.protocolVersion, capabilities: {}, clientInfo: { name: 'closed-loop-simulated-client', version: '0.1.0' } },
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

  async callTool(name, args = {}) {
    return this.send({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params: { name, arguments: args } });
  }
}

export const SCOPE_NOTICE = 'Reminders and check-ins only. Not an emergency alert system. No answer does not mean an emergency.';
export const SIMULATED_NOTICE =
  'Simulated Alexa+ client. Not Amazon software. Alexa+ add-on tooling is partner-only, so this project implements the MCP server side and demonstrates it through a self-built MCP client, as the hackathon FAQ allows.';
export const VOICE_TURNS_NOTICE =
  'Check-in conversations are started by the person, a household routine, or the simulator. MCP add-ons have no documented way to speak first.';
