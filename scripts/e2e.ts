export {};

// End-to-end replay of the demo script against a running deployment, asserting the ledger at each beat.
// Usage: tsx scripts/e2e.ts [base_url] [access_code] [mcp_token]
//   local (default): tsx scripts/e2e.ts            (needs `npm run dev` running)
//   AWS:             tsx scripts/e2e.ts https://<id>.lambda-url.us-east-1.on.aws "$ADMIN_TOKEN" "$MCP_BEARER_TOKEN"
// Warning: it resets the demo household and moves the simulated clock.

const base = (process.argv[2] ?? 'http://localhost:5173').replace(/\/$/, '');
const code = process.argv[3] ?? 'local-dev';
const mcpToken = process.argv[4] ?? 'local-dev-mcp';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${code}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

let rpcId = 0;
async function tool(name: string, args: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${mcpToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  });
  const json = (await res.json()) as any;
  return json.result.structuredContent as any;
}

const ledger = async () => (await api('/api/households/demo/ledger?days=2')) as { today: string; items: any[]; events: any[] };
const item = async (checkinId: string, date?: string) => {
  const l = await ledger();
  return l.items.find((i) => i.checkinId === checkinId && i.date === (date ?? l.today));
};
const advance = (seconds: number) => api('/admin/clock', { advanceSeconds: seconds });

const start = await api('/admin/demo-start', {});
console.log(`Demo day starts ${start.localNow} (simulated)`);
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
const ack = await api(`/api/households/demo/acknowledge/${encodeURIComponent(y.occurrenceId)}`, { contactId: 'dana' });
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

// Honesty sweep (beats 1-4)
const beats = JSON.stringify(await ledger());
check('nothing in the ledger says "confirmed" or "taken"', !/\b(confirmed|taken)\b/i.test(beats));

// Beat 5, on a fresh day (so the daily email cap is clear): a check-in Margaret sets up herself, by voice.
// Two calls; it is never asked; it closes when she says the phrase, or Dana is told in Margaret's name.
await api('/admin/demo-start', {});
await advance(600); // 08:05
const morning2 = (await tool('get_due_checkins')).checkins[0];
await tool('record_response', { occurrenceId: morning2.occurrenceId, response: 'done', utterance: 'Yes, done.' });
const preview = await tool('set_my_checkin', { phrase: 'good night', by: '22:00', tell: 'Dana', utterance: "If I haven't said good night by ten, let Dana know." });
check('setting one up starts with a spoken preview, nothing stored', preview.status === 'confirm_needed' && /Should I set that up\?$/.test(preview.say), preview.say);
const unconfirmed = await tool('set_my_checkin', { confirmToken: preview.confirmToken, utterance: 'I guess' });
check('a hedged answer to the preview sets nothing', unconfirmed.status === 'not_set');
const preview2 = await tool('set_my_checkin', { phrase: 'good night', by: '22:00', tell: 'Dana' });
const own = await tool('set_my_checkin', { confirmToken: preview2.confirmToken, utterance: 'Yes, please.' });
check('the person’s yes sets it', own.status === 'set' && own.checkin?.tell === 'Dana', own.say);
check('the ledger shows it as set by Margaret', (await item(own.checkin.checkinId))?.setBy === 'Margaret');
check('it is never asked', !(await tool('get_due_checkins')).checkins.some((c: any) => c.occurrenceId === own.checkin.occurrenceId));
await advance(14 * 3600); // 22:05: the deadline passed with no "good night"
const missedOwn = await item(own.checkin.checkinId);
check('no good night by 10 pm: "no response (not reached)", Dana emailed', /^no response \(not reached\)/.test(missedOwn?.ledger ?? '') && ['sent', 'sending', 'failed'].includes(missedOwn?.alertStatus), `${missedOwn?.ledger} / ${missedOwn?.alertStatus}`);
const late = await tool('record_response', { occurrenceId: own.checkin.occurrenceId, response: 'done', utterance: 'Good night' });
check('a late good night is recorded as after the window', late.recordedWording === 'reported by the person' && (await item(own.checkin.checkinId))?.ledger === 'reported by the person (after the window closed)');

const all = JSON.stringify(await ledger());
check('nothing in the ledger says "confirmed" or "taken"', !/\b(confirmed|taken)\b/i.test(all));

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
