// Caregiver console API, acknowledge links, and demo admin endpoints. Web Request -> Response,
// so the same code runs in the local dev server and behind a Lambda Function URL.

import { timingSafeEqual } from 'node:crypto';
import {
  CHECKIN_KINDS,
  LEDGER_WORDING,
  SCOPE_NOTICE,
  acknowledge,
  addDays,
  advanceClock,
  isValidHHMM,
  ledgerLine,
  lintCheckinText,
  LINK_CODE_MINUTES,
  generateLinkCode,
  hashSecret,
  isOwnCheckin,
  liveOwnCheckins,
  loadPlan,
  runsOn,
  spokenClock,
  localDate,
  newOccurrence,
  zonedInstant,
  localDateTime,
  localTime,
  now as clockNow,
  resetClock,
  spokenTime,
  verifyAck,
  type CheckinDefinition,
  type Contact,
  type LadderConfig,
  type Store,
  type TickReport,
} from '@closed-loop/core';

export { ackUrlBuilder } from '@closed-loop/core';

export interface ApiConfig {
  store: Store;
  /** Bearer token for the console and admin endpoints (demo protection, not user accounts). */
  adminToken: string;
  ackSecret: string;
  /** Runs one tick immediately (used after advancing the simulated clock). `origin` is this deployment's base URL, for ack links. */
  runTick: (origin: string) => Promise<TickReport>;
  /** Re-creates the demo household. */
  seed: () => Promise<void>;
  /** Static files (console and simulator pages). */
  staticFile?: (path: string) => Promise<{ body: string; type: string } | undefined>;
  /** Public configuration the pages read at startup (no secrets). */
  publicConfig: (origin: string) => Record<string, unknown>;
  /** Configuration for the simulator, behind the access code (includes the MCP bearer token). */
  demoConfig: (origin: string) => Record<string, unknown>;
  /** Optional: recent emails (local run mode shows them in the simulator). */
  recentEmails?: () => unknown[];
  /** Optional planner (Phase 6). */
  planner?: (body: unknown) => Promise<unknown>;
}

const MAX_JSON_BYTES = 32 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

const html = (status: number, body: string) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' } });

function bearerOk(req: Request, token: string): boolean {
  const m = req.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i);
  if (!m?.[1]) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson<T>(req: Request): Promise<T> {
  const text = await req.text();
  if (text.length > MAX_JSON_BYTES) throw new HttpError(413, 'Request too large.');
  try {
    return JSON.parse(text || '{}') as T;
  } catch {
    throw new HttpError(400, 'Body must be JSON.');
  }
}

const str = (v: unknown, max: number, field: string): string => {
  if (typeof v !== 'string') throw new HttpError(400, `${field} is required.`);
  const t = v.trim();
  if (t.length > max) throw new HttpError(400, `${field} is too long (max ${max}).`);
  return t;
};
const int = (v: unknown, min: number, max: number, field: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${field} must be a whole number from ${min} to ${max}.`);
  return n;
};
const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const EMAIL = /^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[A-Za-z]{2,}$/;

export function createApiHandler(cfg: ApiConfig) {
  const { store } = cfg;

  async function householdView(id: string) {
    const ctx = await loadPlan(store, id);
    if (!ctx.plan) throw new HttpError(404, 'Household not found.');
    const { plan, now, today } = ctx;
    const tz = plan.household.timezone;
    const [allCheckins, consents, alertsToday] = await Promise.all([store.listCheckins(id), store.listConsents(id), store.getAlertCount(id, today)]);
    const live = new Set(liveOwnCheckins(plan, now).map((d) => d.id));
    const contactName = (cid: string) => plan.household.contacts.find((c) => c.id === cid)?.name ?? cid;
    return {
      status: ctx.status,
      now: now.toISOString(),
      localNow: localDateTime(now, tz),
      today,
      household: plan.household,
      consent: plan.consent ?? null,
      consents,
      checkins: allCheckins,
      // Check-ins the person set up by voice. Family can see them (and pause everything) but not edit them.
      ownCheckins: allCheckins
        .filter((d) => isOwnCheckin(d) && live.has(d.id))
        .map((d) => ({
          id: d.id,
          label: d.label,
          phrase: d.self!.phrase,
          byLocal: d.self!.by,
          bySpoken: spokenClock(d.self!.by),
          tell: contactName(d.self!.contactId),
          repeat: d.self!.repeat,
          setBy: plan.household.recipientName,
          createdLocal: localDateTime(new Date(d.createdAt), tz),
        })),
      ladder: plan.ladder,
      alertsToday,
      scopeNotice: SCOPE_NOTICE,
      ledgerWording: LEDGER_WORDING,
      pausedUntilLocal: plan.household.pausedUntil ? localDateTime(new Date(plan.household.pausedUntil), tz) : null,
    };
  }

  async function ledgerView(id: string, days: number) {
    const ctx = await loadPlan(store, id);
    if (!ctx.plan) throw new HttpError(404, 'Household not found.');
    const { plan, today, now } = ctx;
    const tz = plan.household.timezone;
    const from = addDays(today, -(days - 1));
    const [occs, events, defs, utterances] = await Promise.all([
      store.listOccurrences(id, from, today),
      store.listEvents(id, 100),
      store.listCheckins(id),
      store.listUtterances(id),
    ]);
    const defById = new Map(defs.map((d) => [d.id, d]));
    // Today's windows that nothing has touched yet still belong in the ledger, as "not asked yet".
    const have = new Set(occs.map((o) => o.id));
    for (const def of plan.checkins) {
      if (!runsOn(def, today)) continue;
      def.windows.forEach((_, idx) => {
        const v = newOccurrence(id, def, today, idx, tz, now);
        if (!have.has(v.id) && new Date(v.windowEnd) > new Date(def.createdAt)) occs.push(v);
      });
    }
    const contactName = (cid: string) => plan.household.contacts.find((c) => c.id === cid)?.name;
    const items = occs
      .sort((a, b) => b.date.localeCompare(a.date) || a.windowStart.localeCompare(b.windowStart))
      .map((o) => {
        const def = defById.get(o.checkinId);
        const own = !!def && isOwnCheckin(def);
        const last = utterances.filter((u) => u.occurrenceId === o.id).sort((a, b) => b.at.localeCompare(a.at))[0];
        return {
          occurrenceId: o.id,
          date: o.date,
          checkinId: o.checkinId,
          label: def?.label ?? o.checkinId,
          author: own ? 'person' : 'family',
          setBy: own ? plan.household.recipientName : null,
          tell: own ? (contactName(def!.self!.contactId) ?? null) : null,
          window: `${localTime(new Date(o.windowStart), tz)}–${localTime(new Date(o.windowEnd), tz)}`,
          windowOpen: new Date(o.windowStart) <= now && now < new Date(o.windowEnd),
          state: o.state,
          ledger: ledgerLine(o, contactName, { own }),
          askedAt: o.promptedAt ? localTime(new Date(o.promptedAt), tz) : null,
          answeredAt: o.lastResponseAt ? localTime(new Date(o.lastResponseAt), tz) : null,
          followUps: o.reasks,
          deferredUntil: o.deferUntil ? localTime(new Date(o.deferUntil), tz) : null,
          safetyNote: o.safetyNote ?? null,
          reviewFlag: o.reviewFlag ?? null,
          alertStatus: o.alertStatus,
          escalationLevel: o.escalationLevel,
          needsHumanNote: o.needsHumanNoteStatus ?? null,
          canAcknowledge: ['MISSED', 'ESCALATED_L1', 'ESCALATED_L2', 'NEEDS_HUMAN'].includes(o.state),
          lastWords: last ? { text: last.text, at: localTime(new Date(last.at), tz) } : null,
        };
      });
    return {
      today,
      localNow: localDateTime(now, tz),
      items,
      events: events.map((e) => ({ ...e, local: localDateTime(new Date(e.at), tz) })),
    };
  }

  function parseCheckin(body: Record<string, unknown>, id: string, existing?: CheckinDefinition): CheckinDefinition {
    const label = str(body.label, 200, 'Label');
    const prompt = str(body.prompt, 200, 'Question');
    const calmingLine = str(body.calmingLine, 400, 'Calming line');
    const issues = lintCheckinText({ label, prompt, calmingLine });
    if (issues.length) throw new HttpError(422, 'Please adjust the wording.', { issues });
    const kind = String(body.kind ?? 'routine');
    if (!(CHECKIN_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, 'Unknown kind.');
    const windows = Array.isArray(body.windows) ? body.windows : [];
    if (windows.length < 1 || windows.length > 3) throw new HttpError(400, 'Add one to three time windows.');
    const parsedWindows = windows.map((w: unknown, i: number) => {
      const o = (w ?? {}) as Record<string, unknown>;
      const start = String(o.start ?? '');
      const end = String(o.end ?? '');
      if (!isValidHHMM(start) || !isValidHHMM(end) || start === end) throw new HttpError(400, `Window ${i + 1} needs a start and end time (HH:MM).`);
      return { start, end };
    });
    return {
      id,
      label,
      prompt,
      calmingLine,
      kind: kind as CheckinDefinition['kind'],
      windows: parsedWindows,
      reaskMinutes: int(body.reaskMinutes ?? 60, 15, 240, 'Minutes before asking again'),
      maxReasks: int(body.maxReasks ?? 2, 0, 3, 'Follow-ups'),
      active: body.active !== false,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
  }

  function parseLadder(body: Record<string, unknown>, contacts: Contact[]): LadderConfig {
    const ids = new Set(contacts.map((c) => c.id));
    const list = (v: unknown, field: string) => {
      if (!Array.isArray(v)) throw new HttpError(400, `${field} must be a list.`);
      const out = v.map(String);
      for (const id of out) if (!ids.has(id)) throw new HttpError(400, `${field}: unknown contact "${id}".`);
      return out;
    };
    const quiet = body.quietHours as { start?: string; end?: string } | null | undefined;
    if (quiet && (!isValidHHMM(String(quiet.start)) || !isValidHHMM(String(quiet.end)))) throw new HttpError(400, 'Quiet hours need HH:MM times.');
    return {
      l1ContactIds: list(body.l1ContactIds, 'First contacts'),
      l2ContactIds: list(body.l2ContactIds ?? [], 'Second contacts'),
      l2AfterMissedDays: int(body.l2AfterMissedDays ?? 2, 1, 7, 'Days before second contact'),
      dailyAlertCap: int(body.dailyAlertCap ?? 3, 1, 10, 'Daily email limit'),
      quietHours: quiet ? { start: String(quiet.start), end: String(quiet.end) } : null,
      planExpiryDays: int(body.planExpiryDays ?? 14, 1, 30, 'Plan length in days'),
    };
  }

  async function ackPage(req: Request): Promise<Response> {
    const url = new URL(req.url);
    let token = url.searchParams.get('t') ?? '';
    if (req.method === 'POST') token = new URLSearchParams(await req.text()).get('t') ?? '';
    const now = await clockNow(store);
    // Link expiry is a security property, so it uses real time, not the simulated clock.
    const payload = verifyAck(cfg.ackSecret, token, Math.floor(Date.now() / 1000));
    const page = (title: string, body: string) =>
      html(
        200,
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>
:root{--bg:#f2f3f5;--surface:#fff;--text:#0f141a;--text2:#5b6573;--sep:#e3e6ea;--blue:#0972d3;--blue-h:#065bb0;--on-blue:#fff;--green:#037f0c;--track:#eceef1;--focus:#0972d3;--shadow:0 1px 2px rgba(15,20,26,.05),0 2px 12px -2px rgba(15,20,26,.08);color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0e1013;--surface:#1a1d22;--text:#f2f3f5;--text2:#a9b2be;--sep:#2e333b;--blue:#5aa7f0;--blue-h:#7ab8f3;--on-blue:#0f141a;--green:#4cc35a;--track:#2a2f36;--focus:#7ab8f3;--shadow:0 0 0 1px #2a2f36;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;font:17px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue","Segoe UI",Roboto,Arial,sans-serif;background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased}
main{max-width:34rem;margin:5rem auto;padding:0 1rem}
.card{background:var(--surface);border-radius:16px;box-shadow:var(--shadow);padding:2rem 1.75rem 1.75rem;text-align:center}
h1{font-size:1.75rem;line-height:1.2;letter-spacing:-.02em;margin:0 0 .6rem}
p{margin:0 0 .75rem}strong{font-weight:600}
.ring{width:48px;height:48px;display:block;margin:0 auto 1rem}.ring circle{fill:none;stroke-width:4.5;stroke-linecap:round}.ring .t{stroke:var(--track)}.ring .a{stroke:var(--green)}.ring .a.open{stroke:var(--blue);stroke-dasharray:72 100}
form{margin-top:1.25rem}
button{font:inherit;font-weight:700;font-size:16px;padding:.6rem 1.3rem;border-radius:999px;border:2px solid var(--blue);background:var(--blue);color:var(--on-blue);min-height:44px;width:100%;cursor:pointer}
button:hover{background:var(--blue-h);border-color:var(--blue-h)}
button:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.note{font-size:13px;color:var(--text2);text-align:center;margin-top:1.25rem}
</style></head>
<body><main><div class="card"><svg class="ring" viewBox="0 0 40 40" aria-hidden="true"><circle class="t" cx="20" cy="20" r="15"/><circle class="a${/acknowledged/i.test(title) ? '' : ' open'}" cx="20" cy="20" r="15" pathLength="100" transform="rotate(-90 20 20)"/></svg><h1>${title}</h1>${body}</div><p class="note">${SCOPE_NOTICE}</p></main></body></html>`,
      );
    if (!payload) return page('Link expired', '<p>This acknowledge link is invalid or has expired. Open the caregiver console to see the latest status.</p>');
    const occ = await store.getOccurrence(payload.householdId, payload.occurrenceId);
    const h = await store.getHousehold(payload.householdId);
    if (!occ || !h) return page('Not found', '<p>This check-in no longer exists. The data may have been deleted.</p>');
    const defs = await store.listCheckins(payload.householdId);
    const label = defs.find((d) => d.id === occ.checkinId)?.label ?? 'a check-in';
    const what = `${h.recipientName}: ${label}, ${occ.date}`;
    // GET only shows a button: email link scanners prefetch GET links and must not acknowledge for you.
    if (req.method === 'GET') {
      if (occ.state === 'ACKNOWLEDGED') return page('Already acknowledged', `<p>${what} was already acknowledged. No further emails will be sent about it.</p>`);
      const safe = token.replace(/[^A-Za-z0-9._-]/g, '');
      return page(
        'Acknowledge this check-in?',
        `<p>${what}</p><p>Status: <strong>${ledgerLine(occ)}</strong></p><form method="post" action="?"><input type="hidden" name="t" value="${safe}"><button type="submit">Yes, I've been in touch</button></form>`,
      );
    }
    const r = await acknowledge(store, payload.householdId, payload.occurrenceId, payload.contactId, now);
    if (!r.ok) return page('Nothing to acknowledge', `<p>${what} is currently "${ledgerLine(occ)}", so there is nothing to acknowledge.</p>`);
    return page('Acknowledged', `<p>Thank you. ${what} is acknowledged. No further emails will be sent about it.</p>`);
  }

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const origin = `${url.protocol}//${url.host}`;
    try {
      if (path === '/health') return json(200, { ok: true });
      if (path === '/config.json') return json(200, cfg.publicConfig(origin));
      if (path === '/ack') return ackPage(req);

      if (path.startsWith('/api/') || path.startsWith('/admin/') || path === '/planner') {
        if (!bearerOk(req, cfg.adminToken)) return json(401, { error: 'Demo access code required.' });
      }

      if (path === '/planner' && req.method === 'POST') {
        if (!cfg.planner) return json(503, { error: 'Planner not configured.' });
        return json(200, await cfg.planner(await readJson(req)));
      }

      // ---- Admin (demo only) ----
      if (path === '/admin/clock') {
        if (req.method === 'POST') {
          const body = await readJson<{ advanceSeconds?: number; reset?: boolean }>(req);
          if (body.reset) await resetClock(store);
          else await advanceClock(store, int(body.advanceSeconds, 60, 7 * 86_400, 'advanceSeconds'));
          const tick = await cfg.runTick(origin);
          const now = await clockNow(store);
          return json(200, { offsetSeconds: await store.getClockOffsetSeconds(), now: now.toISOString(), tick });
        }
        const now = await clockNow(store);
        const h = await store.getHousehold(url.searchParams.get('household') ?? 'demo');
        const tz = h?.timezone ?? 'America/New_York';
        return json(200, {
          offsetSeconds: await store.getClockOffsetSeconds(),
          now: now.toISOString(),
          localNow: localDateTime(now, tz),
          localDate: localDate(now, tz),
          spoken: spokenTime(now, tz),
          weekday: new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(now),
          timezone: tz,
        });
      }
      if (path === '/admin/tick' && req.method === 'POST') return json(200, await cfg.runTick(origin));
      if (path === '/admin/demo-start' && req.method === 'POST') {
        // Moves the simulated clock to 7:55 am tomorrow (household time) and re-creates the demo household.
        const tz = (await store.getHousehold('demo'))?.timezone ?? 'America/New_York';
        const target = zonedInstant(addDays(localDate(new Date(), tz), 1), '07:55', tz);
        await store.setClockOffsetSeconds(Math.round((target.getTime() - Date.now()) / 1000));
        await cfg.seed();
        return json(200, { now: (await clockNow(store)).toISOString(), localNow: localDateTime(await clockNow(store), tz) });
      }
      if (path === '/admin/seed' && req.method === 'POST') {
        await cfg.seed();
        return json(200, { ok: true });
      }
      if (path === '/admin/emails') return json(200, await store.listMailLog(url.searchParams.get('household') ?? 'demo', 10));
      if (path === '/admin/demo-config') return json(200, cfg.demoConfig(origin));

      // ---- Console API ----
      const m = path.match(/^\/api\/households\/([a-z0-9_-]{1,32})(\/.*)?$/);
      if (m) {
        const id = m[1]!;
        const rest = m[2] ?? '';
        if (rest === '' && req.method === 'GET') return json(200, await householdView(id));
        if (rest === '/ledger' && req.method === 'GET') return json(200, await ledgerView(id, int(url.searchParams.get('days') ?? 3, 1, 14, 'days')));

        const chk = rest.match(/^\/checkins\/([a-z0-9][a-z0-9_-]{0,31})$/);
        if (chk) {
          const chkId = chk[1]!;
          if (!ID.test(chkId)) throw new HttpError(400, 'Invalid check-in id.');
          const existing = (await store.listCheckins(id)).find((c) => c.id === chkId);
          // The person's own check-ins belong to the person: the console can see them and pause everything, never edit them.
          if (existing && isOwnCheckin(existing) && (req.method === 'PUT' || req.method === 'DELETE')) {
            const name = (await store.getHousehold(id))?.recipientName ?? 'The person';
            throw new HttpError(403, `${name} set this check-in by voice. Only ${name} can change or cancel it. You can still pause all check-ins.`);
          }
          if (req.method === 'PUT') {
            const def = parseCheckin(await readJson(req), chkId, existing);
            await store.putCheckin(id, def);
            const now = await clockNow(store);
            await store.appendEvent({ householdId: id, at: now.toISOString(), type: existing ? 'checkin_updated' : 'checkin_defined', detail: `Check-in "${def.label}" ${existing ? 'updated' : 'added'}.` });
            return json(200, def);
          }
          if (req.method === 'DELETE') {
            await store.deleteCheckin(id, chkId);
            return json(200, { ok: true });
          }
        }
        if (rest === '/lint' && req.method === 'POST') {
          const b = await readJson<{ label?: string; prompt?: string; calmingLine?: string }>(req);
          return json(200, { issues: lintCheckinText({ label: b.label ?? '', prompt: b.prompt ?? '', calmingLine: b.calmingLine ?? '' }) });
        }
        if (rest === '/contacts' && req.method === 'PUT') {
          const body = await readJson<{ contacts?: unknown[] }>(req);
          const contacts = (body.contacts ?? []).slice(0, 5).map((c, i) => {
            const o = (c ?? {}) as Record<string, unknown>;
            const email = str(o.email, 254, `Contact ${i + 1} email`);
            if (!EMAIL.test(email)) throw new HttpError(400, `Contact ${i + 1}: enter a valid email.`);
            const cid = String(o.id ?? `c${i + 1}`);
            if (!ID.test(cid)) throw new HttpError(400, 'Invalid contact id.');
            return { id: cid, name: str(o.name, 40, `Contact ${i + 1} name`), relation: str(o.relation ?? '', 30, 'Relation'), email };
          });
          await store.updateHousehold(id, { contacts });
          return json(200, { contacts });
        }
        if (rest === '/ladder' && req.method === 'PUT') {
          const h = await store.getHousehold(id);
          if (!h) throw new HttpError(404, 'Household not found.');
          const ladder = parseLadder(await readJson(req), h.contacts);
          await store.putLadder(id, ladder);
          const now = await clockNow(store);
          await store.appendEvent({ householdId: id, at: now.toISOString(), type: 'ladder_updated', detail: 'Who gets emailed, and when, was updated.' });
          return json(200, ladder);
        }
        if (rest === '/consent' && req.method === 'POST') {
          const body = await readJson<{ recipientName?: string; recordedBy?: string }>(req);
          const now = await clockNow(store);
          const ladder = await store.getLadder(id);
          const consent = {
            id: `consent-${now.getTime()}`,
            recipientName: str(body.recipientName, 40, 'Name of the person'),
            recordedBy: str(body.recordedBy, 60, 'Recorded by'),
            recordedAt: now.toISOString(),
            planExpiresAt: new Date(now.getTime() + ladder.planExpiryDays * 86_400_000).toISOString(),
          };
          if (!consent.recipientName || !consent.recordedBy) throw new HttpError(400, 'Both names are required.');
          await store.putConsent(id, consent);
          await store.appendEvent({ householdId: id, at: consent.recordedAt, type: 'consent_recorded', detail: `${consent.recordedBy} recorded ${consent.recipientName}'s consent for ${ladder.planExpiryDays} days.` });
          return json(200, consent);
        }
        if (rest === '/consent/revoke' && req.method === 'POST') {
          const [latest] = await store.listConsents(id);
          if (!latest) throw new HttpError(404, 'No consent on record.');
          const now = await clockNow(store);
          await store.putConsent(id, { ...latest, revokedAt: now.toISOString() });
          await store.appendEvent({ householdId: id, at: now.toISOString(), type: 'consent_revoked', detail: 'Consent revoked. Check-ins and emails stopped immediately.' });
          return json(200, { ok: true });
        }
        const ack = rest.match(/^\/acknowledge\/(OCC#[0-9-]{10}#[a-z0-9_-]{1,32}#\d)$/i) ?? rest.match(/^\/acknowledge\/(.+)$/);
        if (ack && req.method === 'POST') {
          const occId = decodeURIComponent(ack[1]!);
          const body = await readJson<{ contactId?: string }>(req);
          const r = await acknowledge(store, id, occId, String(body.contactId ?? 'console'), await clockNow(store));
          if (!r.ok) throw new HttpError(409, 'Nothing to acknowledge for this check-in.');
          return json(200, r);
        }
        if (rest === '/pause' && req.method === 'POST') {
          const body = await readJson<{ hours?: number }>(req);
          const now = await clockNow(store);
          const hours = int(body.hours ?? 24, 1, 168, 'hours');
          await store.updateHousehold(id, { pausedUntil: new Date(now.getTime() + hours * 3_600_000).toISOString(), pausedAt: now.toISOString(), pausedBy: 'caregiver' });
          await store.appendEvent({ householdId: id, at: now.toISOString(), type: 'paused', detail: `Paused from the console for ${hours} hours.` });
          return json(200, { ok: true });
        }
        if (rest === '/resume' && req.method === 'POST') {
          const h = await store.getHousehold(id);
          if (h?.pausedBy === 'person' && h.pausedUntil && new Date(h.pausedUntil) > (await clockNow(store))) {
            throw new HttpError(409, `${h.recipientName} paused check-ins themselves; the pause ends on its own.`);
          }
          await store.updateHousehold(id, { pausedUntil: undefined, pausedAt: undefined, pausedBy: undefined });
          await store.appendEvent({ householdId: id, at: (await clockNow(store)).toISOString(), type: 'resumed', detail: 'Check-ins resumed from the console.' });
          return json(200, { ok: true });
        }
        if (rest === '/link-code' && req.method === 'POST') {
          // One-time code for linking a voice assistant account (OAuth authorize page). Expires in 10 minutes.
          const h = await store.getHousehold(id);
          if (!h) throw new HttpError(404, 'Household not found.');
          const body = (await req.json().catch(() => ({}))) as { role?: unknown };
          const role = body.role === 'family' ? 'family' : 'person';
          const code = generateLinkCode();
          const expiresAt = new Date(Date.now() + LINK_CODE_MINUTES * 60_000);
          await store.putLinkCode(hashSecret(code), id, expiresAt.toISOString(), role);
          return json(200, { code, role, expiresAt: expiresAt.toISOString(), minutes: LINK_CODE_MINUTES });
        }
        if (rest === '/links' && req.method === 'GET') {
          return json(200, { links: await store.listRefreshTokens(id) });
        }
        if (rest === '/links' && req.method === 'DELETE') {
          const removed = await store.deleteRefreshTokens(id);
          await store.appendEvent({ householdId: id, at: (await clockNow(store)).toISOString(), type: 'account_unlinked', detail: `Unlinked ${removed} voice assistant sign-in${removed === 1 ? '' : 's'}. Access ends within an hour.` });
          return json(200, { removed });
        }
        if (rest === '/data' && req.method === 'DELETE') {
          const removed = await store.deleteHousehold(id);
          return json(200, { removed });
        }
        return json(404, { error: 'Not found.' });
      }

      if (req.method === 'GET' && cfg.staticFile) {
        const file = await cfg.staticFile(path);
        if (file) return new Response(file.body, { status: 200, headers: { 'content-type': file.type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' } });
      }
      return json(404, { error: 'Not found.' });
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message, ...err.extra });
      console.error(err);
      return json(500, { error: 'Something went wrong.' });
    }
  };
}
