export {};

// End-to-end replay of the demo script against a running deployment, asserting the ledger at each beat.
// Usage: tsx scripts/e2e.ts [base_url] [access_code] [mcp_token]
//   local (default): tsx scripts/e2e.ts            (needs `npm run dev` running)
//   AWS:             tsx scripts/e2e.ts https://<id>.lambda-url.us-east-1.on.aws "$ADMIN_TOKEN" "$MCP_BEARER_TOKEN"
// It starts two visitor demo households of its own (deleted at the end) and checks they never affect each other;
// the shared 'demo' household and the deployment-wide clock are left alone.

const base = (process.argv[2] ?? 'http://localhost:5173').replace(/\/$/, '');
const code = process.argv[3] ?? 'local-dev';
const mcpToken = process.argv[4] ?? 'local-dev-mcp';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

async function api<T = any>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${code}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

// Two visitors start a demo day at the same moment. The script plays visitor A; visitor B must not notice.
const sharedBefore = await api('/admin/clock');
const [start, other] = await Promise.all([api('/admin/demo-start', {}), api('/admin/demo-start', {})]);
const H: string = start.householdId;
check('each visitor gets a household of their own', /^demo-[a-z0-9]{10}$/.test(H) && /^demo-[a-z0-9]{10}$/.test(other.householdId) && H !== other.householdId, `${H}, ${other.householdId}`);

let rpcId = 0;
async function tool(name: string, args: Record<string, unknown> = {}, token: string = start.mcpToken) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  });
  const json = (await res.json()) as any;
  return json.result.structuredContent as any;
}

const ledger = async (id = H) => (await api(`/api/households/${id}/ledger?days=2`)) as { today: string; items: any[]; events: any[] };
const item = async (checkinId: string, date?: string) => {
  const l = await ledger();
  return l.items.find((i) => i.checkinId === checkinId && i.date === (date ?? l.today));
};
const advance = (seconds: number) => api(`/admin/clock?household=${H}`, { advanceSeconds: seconds });

console.log(`Demo day starts ${start.localNow} (simulated), household ${H}`);
await advance(600); // 08:05
const day1 = (await ledger()).today;

// Beat 1: routine start, hedged answer, deferral
const due = await tool('get_due_checkins');
const morning = due.checkins.find((c: any) => c.label === 'your morning routine');
check('routine start asks the morning check-in in the family’s words', morning?.prompt === 'Good morning, Margaret. Have you done your morning routine yet?');
const hedged = await tool('record_response', { occurrenceId: morning.occurrenceId, response: 'done', utterance: 'I think so, maybe after lunch' });
check('a hedged "done" is recorded as "said they would, not sure"', hedged.recordedWording === 'said they would, not sure', hedged.recordedWording);
const deferred = await tool('defer_checkin', { occurrenceId: morning.occurrenceId, until: 'after_lunch' });
check('"after lunch" defers to 13:00', deferred.deferredUntilLocal === '13:00', deferred.deferredUntilLocal);
check('ledger shows "said later"', (await item('morning'))?.ledger === 'said later');

// Beat 2: +5 hours, follow-up, clear yes
await advance(5 * 3600); // 13:05
const follow = await tool('get_due_checkins');
check('the requested follow-up is asked first', follow.checkins[0]?.occurrenceId === morning.occurrenceId && follow.checkins[0]?.isFollowUp === true);
const yes = await tool('record_response', { occurrenceId: morning.occurrenceId, response: 'done', utterance: 'Yes, done.' });
check('a clear yes is "reported by the person"', yes.recordedWording === 'reported by the person');

// Beat 3: +1 day, nothing answered, window closes, email, acknowledge
await advance(24 * 3600); // next day 13:05 (yesterday's lunch and evening closed; today's morning still open until 14:00)
const y = await item('lunch', day1);
check("yesterday's unanswered lunch check closed as no response", !!y && y.state !== 'PROMPTED' && /no response/.test(y.ledger), y?.ledger);
check('the family was emailed (or the attempt is on record)', !!y && ['sent', 'failed', 'sending'].includes(y.alertStatus), y?.alertStatus);
const ack = await api(`/api/households/${H}/acknowledge/${encodeURIComponent(y.occurrenceId)}`, { contactId: 'dana' });
check('acknowledging stops the ladder', ack.ok === true && (await item('lunch', day1))?.ledger === 'acknowledged by Dana');

// Beat 4: distress and crisis
const now = await tool('get_due_checkins');
const today = now.checkins[0];
const distress = await tool('record_response', { occurrenceId: today.occurrenceId, response: 'unsure', utterance: 'I want to go home. Where is everyone?' });
check('distress gets the calming line and no question', distress.say.startsWith("You're safe at home") && !distress.say.includes('?'), distress.say);
check('distress is recorded as needs human contact', distress.recordedWording === 'needs human contact');
check('no re-quiz right after distress', (await tool('get_due_checkins')).checkins.length === 0);
const crisis = await tool('record_response', { occurrenceId: today.occurrenceId, response: 'done', utterance: "I fell and I can't get up" });
check('crisis wording gets the fixed 911 line', crisis.say === 'If this is an emergency, please call 911 now.');

// Honesty sweep
const all = JSON.stringify(await ledger());
check('nothing in the ledger says "confirmed" or "taken"', !/\b(confirmed|taken)\b/i.test(all));

// Isolation: a day and a half of visitor A's demo changed nothing for visitor B or the shared household.
const otherClock = await api(`/admin/clock?household=${other.householdId}`);
check("visitor B's clock did not move", otherClock.localNow.slice(0, 10) === other.localNow.slice(0, 10) && otherClock.localNow.slice(11, 13) === '07', otherClock.localNow);
const otherLedger = await ledger(other.householdId);
check("visitor B's ledger is untouched", otherLedger.items.length > 0 && otherLedger.items.every((i) => i.state === 'SCHEDULED' && !i.askedAt), otherLedger.items.map((i) => i.state).join(','));
check('visitor B received no email', (await api(`/admin/emails?household=${other.householdId}`)).length === 0);
const emailsA = await api(`/admin/emails?household=${H}`);
check("visitor A's email panel has A's email", emailsA.length > 0 && emailsA.every((m: any) => m.householdId === H), String(emailsA.length));
const sharedAfter = await api('/admin/clock');
check("the shared 'demo' household's clock did not move", sharedAfter.offsetSeconds === sharedBefore.offsetSeconds, `${sharedBefore.offsetSeconds} -> ${sharedAfter.offsetSeconds}`);
const statusB = await tool('get_my_status', {}, other.mcpToken);
check("visitor B's token acts for B's household, on B's own clock", statusB?.date === other.localNow.slice(0, 10) && statusB.date !== (await ledger()).today, statusB?.date);
const shared = await tool('get_my_status', {}, mcpToken);
check("the static demo token still acts for the shared 'demo' household", typeof shared?.date === 'string', shared?.date);

for (const id of [H, other.householdId]) await api(`/api/households/${id}/data`, undefined, 'DELETE');

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
