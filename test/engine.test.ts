import { afterEach, describe, expect, it } from 'vitest';
import {
  CRISIS_REPLY,
  SELF_HARM_REPLY,
  acknowledge,
  deferCheckin,
  getDueCheckins,
  getFamilySummary,
  getMyStatus,
  ledgerLine,
  pauseCheckins,
  recordResponse,
  setRealTimeSource,
  spoken,
  verifyAck,
} from '../packages/core/src';
import { H, demo, setLocal } from './helpers';

const MORNING = 'OCC#2026-10-19#morning#0';
const LUNCH = 'OCC#2026-10-19#lunch#0';
const EVENING = 'OCC#2026-10-19#evening#0';

afterEach(() => setRealTimeSource(() => Date.now()));

describe('asking: get_due_checkins', () => {
  it('returns nothing before the window opens', async () => {
    const { store } = await demo('2026-10-19 07:30');
    const r = await getDueCheckins(store, H);
    expect(r.checkins).toEqual([]);
    expect(r.say).toMatch(/no check-ins/i);
  });

  it("asks once with the caregiver's own wording and never repeats inside a turn", async () => {
    const { store } = await demo();
    setLocal('2026-10-19 08:05');
    const first = await getDueCheckins(store, H);
    expect(first.checkins.map((c) => c.occurrenceId)).toEqual([MORNING]);
    expect(first.say).toBe('Good morning, Margaret. Have you done your morning routine yet?');
    expect((await getDueCheckins(store, H)).checkins).toEqual([]);
    const occ = await store.getOccurrence(H, MORNING);
    expect(occ?.state).toBe('PROMPTED');
    expect(occ?.promptedAt).toBeDefined();
  });

  it('re-asks after reaskMinutes, at most maxReasks times', async () => {
    const { store } = await demo();
    setLocal('2026-10-19 08:00');
    await getDueCheckins(store, H);
    setLocal('2026-10-19 08:59');
    expect((await getDueCheckins(store, H)).checkins).toEqual([]);
    setLocal('2026-10-19 09:00');
    const again = await getDueCheckins(store, H);
    expect(again.checkins[0]?.isFollowUp).toBe(true);
    expect(again.say).toBe('Just checking again about your morning routine. Is that done now?');
    setLocal('2026-10-19 10:00');
    expect((await getDueCheckins(store, H)).checkins).toHaveLength(1);
    setLocal('2026-10-19 11:00');
    expect((await getDueCheckins(store, H)).checkins).toEqual([]); // maxReasks = 2 reached
  });
});

describe('recording: honest wording and the safety layer', () => {
  it('turns a hedged "done" into "said they would, not sure"', async () => {
    const { store } = await demo();
    setLocal('2026-10-19 08:05');
    await getDueCheckins(store, H);
    const r = await recordResponse(store, H, { occurrenceId: MORNING, response: 'done', utterance: 'I think so, maybe after lunch' });
    expect(r.recordedAs).toBe('not_sure');
    expect(r.recordedWording).toBe('said they would, not sure');
    const occ = await store.getOccurrence(H, MORNING);
    expect(occ?.state).toBe('UNSURE');
    expect(occ?.safetyNote).toBeDefined();
    const events = await store.listEvents(H, 20);
    expect(events.some((e) => e.type === 'response_downgraded')).toBe(true);
  });

  it('records a clear yes as "reported by the person"', async () => {
    const { store } = await demo();
    setLocal('2026-10-19 08:05');
    await getDueCheckins(store, H);
    const r = await recordResponse(store, H, { occurrenceId: MORNING, response: 'done', utterance: 'Yes, all done.' });
    expect(r.recordedWording).toBe('reported by the person');
    expect((await store.getOccurrence(H, MORNING))?.state).toBe('REPORTED_DONE');
  });

  it('demo beat: "after lunch" defers to 13:00, follow-up at 13:00, then "yes, done"', async () => {
    const { store } = await demo();
    setLocal('2026-10-19 08:00');
    await getDueCheckins(store, H);
    const d = await deferCheckin(store, H, { occurrenceId: MORNING, until: 'after_lunch' });
    expect(d.deferredUntilLocal).toBe('13:00');
    expect(d.say).toBe("Okay. I'll ask again around 1 pm.");
    setLocal('2026-10-19 12:30');
    expect((await getDueCheckins(store, H)).checkins.map((c) => c.occurrenceId)).toEqual([LUNCH]);
    setLocal('2026-10-19 13:00');
    const follow = await getDueCheckins(store, H);
    expect(follow.checkins.map((c) => c.occurrenceId)).toEqual([MORNING]);
    expect(follow.say).toBe('Just checking again about your morning routine. Is that done now?');
    expect(follow.checkins[0]?.isFollowUp).toBe(true);
    const r = await recordResponse(store, H, { occurrenceId: MORNING, response: 'done', utterance: 'Yes, done.' });
    expect(r.recordedWording).toBe('reported by the person');
  });

  it('distress: calming line, no re-quiz for an hour, needs-human note on the next tick', async () => {
    const { store, mailer, tick } = await demo();
    setLocal('2026-10-19 08:05');
    await getDueCheckins(store, H);
    const r = await recordResponse(store, H, { occurrenceId: MORNING, response: 'unsure', utterance: 'I want to go home. Where is everyone?' });
    expect(r.say).toBe("You're safe at home, Margaret. Dana will give you a call this evening.");
    expect(r.recordedWording).toBe('needs human contact');
    expect(r.nextStep).toBe('family_will_be_told');
    setLocal('2026-10-19 12:30');
    expect((await getDueCheckins(store, H)).checkins.map((c) => c.occurrenceId)).toEqual([LUNCH]);
    setLocal('2026-10-19 12:31');
    await tick();
    const note = mailer.sent.find((m) => m.kind === 'needs_human');
    expect(note?.to).toBe('dana@example.com');
    expect(note?.text).toContain('Margaret seemed confused or upset during a check-in. A call may help.');
  });

  it('a requested follow-up is asked before a newly opened check-in', async () => {
    const { store } = await demo();
    setLocal('2026-10-19 08:00');
    await getDueCheckins(store, H);
    await deferCheckin(store, H, { occurrenceId: MORNING, until: 'after_lunch' });
    setLocal('2026-10-19 13:30');
    expect((await getDueCheckins(store, H)).checkins.map((c) => c.occurrenceId)).toEqual([MORNING, LUNCH]);
  });

  it('distress: no check-ins are asked for 60 minutes afterwards', async () => {
    const { store } = await demo();
    setLocal('2026-10-19 12:05');
    await getDueCheckins(store, H);
    await recordResponse(store, H, { occurrenceId: MORNING, response: 'unsure', utterance: "Who are you? I'm scared." });
    setLocal('2026-10-19 12:30');
    expect((await getDueCheckins(store, H)).checkins).toEqual([]);
    setLocal('2026-10-19 13:06');
    expect((await getDueCheckins(store, H)).checkins.length).toBeGreaterThan(0);
  });

  it('crisis wording gets the fixed 911 line; self-harm wording adds 988', async () => {
    const { store } = await demo();
    setLocal('2026-10-19 12:05');
    await getDueCheckins(store, H);
    const a = await recordResponse(store, H, { occurrenceId: MORNING, response: 'done', utterance: "I fell and I can't get up" });
    expect(a.say).toBe(CRISIS_REPLY);
    expect(a.nextStep).toBe('call_emergency_services');
    const b = await recordResponse(store, H, { occurrenceId: LUNCH, response: 'no', utterance: "I don't want to live anymore" });
    expect(b.say).toBe(SELF_HARM_REPLY);
    expect((await store.getOccurrence(H, MORNING))?.needsHumanCrisis).toBe(true);
  });

  it('needs-human stays set even if the person later says done', async () => {
    const { store } = await demo();
    setLocal('2026-10-19 08:05');
    await getDueCheckins(store, H);
    await recordResponse(store, H, { occurrenceId: MORNING, response: 'needs_help' });
    await recordResponse(store, H, { occurrenceId: MORNING, response: 'done', utterance: 'yes all done' });
    expect((await store.getOccurrence(H, MORNING))?.state).toBe('NEEDS_HUMAN');
  });

  it('rejects unknown occurrence ids as a tool input error', async () => {
    const { store } = await demo();
    setLocal('2026-10-19 08:05');
    await expect(recordResponse(store, H, { occurrenceId: 'OCC#2026-10-19#nope#0', response: 'done' })).rejects.toThrow(/couldn't find/);
    await expect(recordResponse(store, H, { occurrenceId: 'garbage', response: 'done' })).rejects.toThrow(/couldn't find/);
  });
});

describe('upset with no check-in in progress: the family is still told, and the reply says only what happened', () => {
  const CALM = "You're safe at home, Margaret. Dana will give you a call this evening.";
  const notes = <T extends { kind: string }>(sent: T[]) => sent.filter((m) => m.kind === 'needs_human');

  it('before any check-in has started: a record of its own, exactly one family note, and the morning check-in is still asked later', async () => {
    const { store, mailer, tick } = await demo();
    setLocal('2026-10-19 07:30');
    const r = await recordResponse(store, H, { response: 'needs_help', utterance: "I'm scared. Where is everyone?" });
    expect(r).toMatchObject({ occurrenceId: 'OCC#2026-10-19#OUTSIDE#0', recordedWording: 'needs human contact', nextStep: 'family_will_be_told', say: CALM });

    // Said again before anyone called: the same record, still one note.
    setLocal('2026-10-19 07:40');
    expect((await recordResponse(store, H, { response: 'unsure', utterance: 'I want to go home.' })).say).toBe(CALM);
    await tick();
    setLocal('2026-10-19 07:45');
    expect((await recordResponse(store, H, { response: 'needs_help', utterance: 'Who are you?' })).say).toBe(CALM);
    await tick();
    expect(notes(mailer.sent)).toHaveLength(1);
    expect(notes(mailer.sent)[0]).toMatchObject({ to: 'dana@example.com' });
    expect(notes(mailer.sent)[0]!.text).toContain('Margaret seemed confused or upset while talking with the assistant, outside a check-in. A call may help.');

    const events = await store.listEvents(H, 50);
    expect(events.some((e) => e.type === 'distress_branch' && e.detail.startsWith('Outside a check-in. Calming line given'))).toBe(true);
    expect((await getFamilySummary(store, H)).say).toContain('Outside a check-in: needs human contact.');

    // The family's check-ins are untouched: quiet for an hour, then the morning one is asked as usual.
    setLocal('2026-10-19 08:05');
    expect((await getDueCheckins(store, H)).checkins).toEqual([]);
    setLocal('2026-10-19 08:46');
    expect((await getDueCheckins(store, H)).checkins.map((c) => c.occurrenceId)).toEqual([MORNING]);
  });

  it('during an open check-in, after the conversation about it ended: noted on it, one note, and the email says it was outside a check-in', async () => {
    const { store, mailer, tick } = await demo();
    setLocal('2026-10-19 09:00');
    await getDueCheckins(store, H);
    setLocal('2026-10-19 09:20');
    const r = await recordResponse(store, H, { response: 'needs_help', utterance: 'Help!' });
    expect(r).toMatchObject({ occurrenceId: MORNING, nextStep: 'family_will_be_told', say: `${CALM} ${CRISIS_REPLY}` });
    expect((await store.getOccurrence(H, MORNING))?.state).toBe('NEEDS_HUMAN');
    const events = await store.listEvents(H, 50);
    expect(events.some((e) => e.detail.startsWith('Outside a check-in, noted on your morning routine. Asked for help'))).toBe(true);
    await tick();
    expect(notes(mailer.sent)).toHaveLength(1);
    expect(notes(mailer.sent)[0]!.text).toContain('outside a check-in');
  });

  it('never rewrites a check-in the person already reported done', async () => {
    const { store, mailer, tick } = await demo();
    setLocal('2026-10-19 08:05');
    await getDueCheckins(store, H);
    await recordResponse(store, H, { occurrenceId: MORNING, response: 'done', utterance: 'Yes, all done.' });
    setLocal('2026-10-19 10:00');
    const r = await recordResponse(store, H, { response: 'needs_help', utterance: "I fell and I can't get up." });
    expect(r).toMatchObject({ occurrenceId: 'OCC#2026-10-19#OUTSIDE#0', nextStep: 'call_emergency_services', say: CRISIS_REPLY });
    expect((await store.getOccurrence(H, MORNING))?.state).toBe('REPORTED_DONE');
    await tick();
    expect(notes(mailer.sent)).toHaveLength(1);
  });

  it('with no one set up to be told, the reply promises no call and no email goes out', async () => {
    const { store, mailer, tick } = await demo();
    await store.putLadder(H, { ...(await store.getLadder(H)), l1ContactIds: [], l2ContactIds: [] });
    setLocal('2026-10-19 07:30');
    const r = await recordResponse(store, H, { response: 'needs_help', utterance: "I'm scared." });
    expect(r).toMatchObject({ nextStep: 'none', say: spoken.calmNoContact });
    expect(r.say).not.toMatch(/call you|give you a call|will call/i);
    expect(r.calmingLine).toBeUndefined();
    await tick();
    expect(notes(mailer.sent)).toHaveLength(0);
  });

  it('only words that need a person can be recorded without a check-in', async () => {
    const { store } = await demo();
    setLocal('2026-10-19 07:30');
    await expect(recordResponse(store, H, { response: 'done', utterance: 'Yes, all done.' })).rejects.toThrow(/no check-in to answer/);
  });
});

describe('closing the loop: tick, ladder, email', () => {
  it('window close with no answer: MISSED, then one plain-wording email to L1', async () => {
    const { store, mailer, tick } = await demo();
    setLocal('2026-10-19 08:05');
    await getDueCheckins(store, H);
    setLocal('2026-10-19 14:01');
    const report = await tick();
    expect(report.closed).toBe(1);
    expect(mailer.sent).toHaveLength(1);
    const email = mailer.sent[0]!;
    expect(email.to).toBe('dana@example.com');
    expect(email.subject).toBe('Check-in update: your morning routine (not an emergency alert)');
    expect(email.text).toContain('We did not hear back about your morning routine today. This is not an emergency alert.');
    expect(email.text).toContain('Margaret was asked at 8:05 am');
    const occ = await store.getOccurrence(H, MORNING);
    expect(occ?.state).toBe('ESCALATED_L1');
    expect(ledgerLine(occ!)).toBe('no response (asked, no answer) · family emailed');
  });

  it('logs what was sent by contact name, never by address', async () => {
    const { store, tick } = await demo();
    setLocal('2026-10-19 14:01');
    await tick();
    const [log] = await store.listMailLog(H, 5);
    expect(log).toMatchObject({ toName: 'Dana (daughter)', via: 'test mailer', kind: 'missed_l1' });
    expect(log!.preview).toContain('We did not hear back about your morning routine today.');
    expect(JSON.stringify(log)).not.toContain('@');
  });

  it('never claims the person was asked when nobody reached them', async () => {
    const { store, mailer, tick } = await demo();
    setLocal('2026-10-19 14:01');
    await tick();
    const email = mailer.sent.find((m) => m.occurrenceId === MORNING)!;
    expect(email.text).toContain('Margaret was not asked');
    expect(email.text).not.toContain('was asked at');
    expect(ledgerLine((await store.getOccurrence(H, MORNING))!)).toBe('no response (not reached) · family emailed');
  });

  it('two ticks at the same moment send exactly one email per occurrence', async () => {
    const { mailer, tick } = await demo();
    setLocal('2026-10-19 14:01');
    await Promise.all([tick(), tick(), tick()]);
    expect(mailer.sent.filter((m) => m.occurrenceId === MORNING)).toHaveLength(1);
  });

  it('acknowledge stops the ladder for that occurrence', async () => {
    const { store, mailer, tick } = await demo();
    setLocal('2026-10-19 14:01');
    await tick();
    const link = mailer.sent[0]!.text.match(/https:\/\/example\.test\/ack\?t=(\S+)/)![1]!;
    const payload = verifyAck('test-secret', link, 0)!;
    expect(payload.occurrenceId).toBe(MORNING);
    const r = await acknowledge(store, H, MORNING, payload.contactId, new Date());
    expect(r.ok).toBe(true);
    expect(ledgerLine((await store.getOccurrence(H, MORNING))!, (id) => (id === 'dana' ? 'Dana' : undefined))).toBe('acknowledged by Dana');
    setLocal('2026-10-19 14:30');
    await tick();
    expect(mailer.sent.filter((m) => m.occurrenceId === MORNING)).toHaveLength(1);
  });

  it('a second unacknowledged day escalates to L2; acknowledging day one prevents it', async () => {
    const { store, mailer, tick } = await demo();
    setLocal('2026-10-19 14:01');
    await tick();
    setLocal('2026-10-20 14:01');
    await tick();
    const day2 = mailer.sent.filter((m) => m.occurrenceId === 'OCC#2026-10-20#morning#0');
    expect(day2.map((m) => m.to).sort()).toEqual(['dana@example.com', 'sam@example.com']);
    expect(day2[0]!.subject).toMatch(/^Second notice/);
    expect(day2[0]!.text).toContain('day 2 in a row');

    const b = await demo();
    setLocal('2026-10-19 14:01');
    await b.tick();
    await acknowledge(b.store, H, MORNING, 'dana', new Date());
    setLocal('2026-10-20 14:01');
    await b.tick();
    expect(b.mailer.sent.filter((m) => m.occurrenceId === 'OCC#2026-10-20#morning#0').map((m) => m.to)).toEqual(['dana@example.com']);
  });

  it('daily cap: at most 3 alerts per household per day; the rest are shown in the console only', async () => {
    const { store, mailer, tick } = await demo();
    for (const id of ['extra1', 'extra2']) {
      await store.putCheckin(H, { ...(await store.listCheckins(H))[0]!, id, label: `check ${id}` });
    }
    setLocal('2026-10-19 21:01');
    const report = await tick();
    expect(mailer.sent.filter((m) => m.kind === 'missed_l1')).toHaveLength(3);
    expect(report.alertsSuppressed).toBe(2);
    expect((await store.listEvents(H, 50)).filter((e) => e.type === 'alert_suppressed')).toHaveLength(2);
  });

  it('quiet hours hold an alert until they end (not in demo mode)', async () => {
    const { store, mailer, tick } = await demo('2026-10-19 07:00', { demoMode: false });
    setLocal('2026-10-19 21:05');
    await tick();
    expect(mailer.sent.filter((m) => m.occurrenceId === EVENING)).toHaveLength(0);
    expect((await store.getOccurrence(H, EVENING))?.alertStatus).toBe('waiting_quiet_hours');
    setLocal('2026-10-20 07:00');
    await tick();
    expect(mailer.sent.filter((m) => m.occurrenceId === EVENING)).toHaveLength(1);
  });

  it('a failed send is retried on the next tick', async () => {
    const { mailer, tick } = await demo();
    mailer.failNext = 1;
    setLocal('2026-10-19 14:01');
    await tick();
    expect(mailer.sent.filter((m) => m.occurrenceId === MORNING)).toHaveLength(0);
    setLocal('2026-10-19 14:02');
    await tick();
    expect(mailer.sent.filter((m) => m.occurrenceId === MORNING)).toHaveLength(1);
  });

  it('a failing family note is retried, but not forever', async () => {
    const { store, mailer, tick } = await demo();
    setLocal('2026-10-19 08:05');
    await getDueCheckins(store, H);
    await recordResponse(store, H, { occurrenceId: MORNING, response: 'needs_help' });
    mailer.failNext = 100;
    for (let m = 6; m < 16; m++) {
      setLocal(`2026-10-19 08:${String(m).padStart(2, '0')}`);
      await tick();
    }
    const occ = (await store.getOccurrence(H, MORNING))!;
    expect(occ.needsHumanNoteStatus).toBe('failed');
    expect(occ.needsHumanAttempts).toBe(3);
  });

  it('a late "done" after the email marks it reported late and stops further emails', async () => {
    const { store, mailer, tick } = await demo();
    setLocal('2026-10-19 14:01');
    await tick();
    setLocal('2026-10-19 15:00');
    await recordResponse(store, H, { occurrenceId: MORNING, response: 'done', utterance: 'Oh yes, I did it hours ago' });
    const occ = (await store.getOccurrence(H, MORNING))!;
    expect(occ.state).toBe('REPORTED_DONE');
    expect(ledgerLine(occ)).toBe('reported by the person (after the window closed)');
    setLocal('2026-10-20 14:01');
    await tick();
    expect(mailer.sent.filter((m) => m.occurrenceId === 'OCC#2026-10-20#morning#0').map((m) => m.to)).toEqual(['dana@example.com']);
  });

  it('a clock jump of one day catches up on every window that closed', async () => {
    const { store, mailer, tick } = await demo();
    setLocal('2026-10-20 09:00');
    const report = await tick();
    expect(report.closed).toBe(3);
    expect(new Set(mailer.sent.map((m) => m.occurrenceId))).toEqual(new Set([MORNING, LUNCH, EVENING]));
    expect((await store.getOccurrence(H, 'OCC#2026-10-20#morning#0'))?.state).toBe('SCHEDULED');
  });
});

describe('consent, pause, expiry: off means off', () => {
  it('revoked consent: no prompts, nothing stored, no email; crisis reply still given', async () => {
    const { store, mailer, tick } = await demo();
    const [consent] = await store.listConsents(H);
    await store.putConsent(H, { ...consent!, revokedAt: new Date().toISOString() });
    setLocal('2026-10-19 08:05');
    expect((await getDueCheckins(store, H)).checkins).toEqual([]);
    const r = await recordResponse(store, H, { occurrenceId: MORNING, response: 'done', utterance: 'chest pain' });
    expect(r.recordedAs).toBe('not_recorded');
    expect(r.say).toBe(CRISIS_REPLY);
    expect(await store.listUtterances(H)).toEqual([]);
    setLocal('2026-10-19 22:00');
    await tick();
    expect(mailer.sent).toEqual([]);
  });

  it('expired plan: nothing is asked or sent, and the expiry is logged once', async () => {
    const { store, mailer, tick } = await demo();
    setLocal('2026-11-03 09:00');
    expect((await getDueCheckins(store, H)).checkins).toEqual([]);
    await tick();
    await tick();
    expect(mailer.sent).toEqual([]);
    expect((await store.listEvents(H, 50)).filter((e) => e.type === 'plan_expired')).toHaveLength(1);
  });

  it('pause for today: no prompts, windows close as paused, no email; resumes tomorrow', async () => {
    const { store, mailer, tick } = await demo();
    setLocal('2026-10-19 08:05');
    const p = await pauseCheckins(store, H, { scope: 'today' });
    expect(p.say).toMatch(/paused for the rest of today/);
    expect(p.pausedUntilLocal).toBe('2026-10-20 00:00');
    expect((await getDueCheckins(store, H)).checkins).toEqual([]);
    setLocal('2026-10-19 23:00');
    await tick();
    expect(mailer.sent).toEqual([]);
    expect((await store.getOccurrence(H, MORNING))?.state).toBe('PAUSED');
    setLocal('2026-10-20 08:05');
    expect((await getDueCheckins(store, H)).checkins).toHaveLength(1);
  });

  it('get_my_status says what is shared and with whom, in plain words', async () => {
    const { store } = await demo();
    setLocal('2026-10-19 12:10');
    await getDueCheckins(store, H);
    await recordResponse(store, H, { occurrenceId: MORNING, response: 'done', utterance: 'yes' });
    const s = await getMyStatus(store, H);
    expect(s.reported).toBe(1);
    expect(s.open).toBe(2);
    expect(s.sharedWith).toEqual(['Dana (daughter)']);
    expect(s.say).toBe('Today: 1 reported, 2 still open. Dana gets an email if a check-in stays open.');
  });
});

describe('get_family_summary: family hears what was recorded, nothing more', () => {
  it('reads each check-in in the exact ledger wording, by name, in window order', async () => {
    const { store } = await demo();
    setLocal('2026-10-19 08:05');
    await getDueCheckins(store, H);
    await recordResponse(store, H, { occurrenceId: MORNING, response: 'done', utterance: 'I think so' });
    setLocal('2026-10-19 12:10');
    const s = await getFamilySummary(store, H);
    expect(s.recipientName).toBe('Margaret');
    expect(s.items.map((i) => [i.label, i.recorded, i.kind])).toEqual([
      ["Margaret's morning routine", 'said they would, not sure', 'open'],
      ["Margaret's lunchtime check", 'not asked yet', 'waiting'],
      ["Margaret's evening check-in", 'not asked yet', 'waiting'],
    ]);
    expect(s.say).toBe(
      "Here is what Margaret's check-ins recorded today. Margaret's morning routine: said they would, not sure. " +
        "Margaret's lunchtime check: not asked yet. Margaret's evening check-in: not asked yet. These are Margaret's own answers, recorded as said.",
    );
  });

  it('is read-only: asking about the day stores nothing and asks nothing', async () => {
    const { store } = await demo();
    setLocal('2026-10-19 08:05');
    await getFamilySummary(store, H);
    expect(await store.listOccurrences(H, '2026-10-19')).toHaveLength(0);
  });

  it('says when a call may help', async () => {
    const { store } = await demo();
    setLocal('2026-10-19 08:05');
    await getDueCheckins(store, H);
    await recordResponse(store, H, { occurrenceId: MORNING, response: 'needs_help', utterance: 'I want to go home' });
    const s = await getFamilySummary(store, H);
    expect(s.needsHumanContact).toBe(1);
    expect(s.items[0]!.kind).toBe('human');
    expect(s.say).toContain('needs human contact');
    expect(s.say).toContain('A call may help.');
  });
});

describe('wording rules', () => {
  it('never says "confirmed" or "taken" anywhere the person or family can see', async () => {
    const { store, mailer, tick } = await demo();
    const texts: string[] = [];
    setLocal('2026-10-19 08:05');
    texts.push((await getDueCheckins(store, H)).say);
    texts.push((await recordResponse(store, H, { occurrenceId: MORNING, response: 'done', utterance: 'maybe' })).say);
    texts.push((await deferCheckin(store, H, { occurrenceId: MORNING, until: 'in_1_hour' })).say);
    texts.push((await getMyStatus(store, H)).say);
    texts.push((await getFamilySummary(store, H)).say);
    setLocal('2026-10-20 09:00');
    await tick();
    texts.push(...mailer.sent.flatMap((m) => [m.subject, m.text, m.html]));
    texts.push(...(await store.listEvents(H, 100)).map((e) => e.detail));
    for (const o of await store.listOccurrences(H, '2026-10-19')) texts.push(ledgerLine(o));
    for (const t of texts) expect(t).not.toMatch(/\b(confirmed|taken)\b/i);
  });
});
