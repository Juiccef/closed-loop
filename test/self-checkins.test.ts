import { afterEach, describe, expect, it } from 'vitest';
import {
  CRISIS_REPLY,
  SELF_HARM_REPLY,
  acknowledge,
  cancelMyCheckin,
  getDueCheckins,
  getFamilySummary,
  getMyStatus,
  ledgerLine,
  recordResponse,
  setMyCheckin,
  setRealTimeSource,
  type Store,
} from '../packages/core/src';
import { H, demo, setLocal } from './helpers';

afterEach(() => setRealTimeSource(() => Date.now()));

const SECRET = 'test-confirm-secret';
const GOOD_NIGHT = { phrase: 'good night', by: '22:00', tell: 'Dana', utterance: "If I haven't said good night by ten, let Dana know." };

/** Preview, then the person's yes. Returns both results. */
async function setUp(store: Store, draft: Parameters<typeof setMyCheckin>[2] = GOOD_NIGHT, yes = 'Yes, please.') {
  const preview = await setMyCheckin(store, H, draft, { secret: SECRET });
  expect(preview.status, preview.say).toBe('confirm_needed');
  const set = await setMyCheckin(store, H, { confirmToken: preview.confirmToken!, utterance: yes }, { secret: SECRET });
  return { preview, set };
}

const own = async (store: Store) => (await store.listCheckins(H)).filter((d) => d.author === 'person');
const mineNow = async (store: Store) => (await getMyStatus(store, H)).mine;

describe('setting one up: two steps, nothing stored until the person says yes', () => {
  it('the first call is a spoken preview with a short-lived token, and stores nothing', async () => {
    const { store } = await demo();
    setLocal('2026-10-19 20:00');
    const r = await setMyCheckin(store, H, GOOD_NIGHT, { secret: SECRET });
    expect(r.status).toBe('confirm_needed');
    expect(r.say).toBe("If you haven't said good night by 10 pm tonight, I'll email Dana. Should I set that up?");
    expect(r.confirmToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(r.expiresInSeconds).toBe(300);
    expect(r.checkin).toMatchObject({ checkinId: '', phrase: 'good night', byLocal: '22:00', tell: 'Dana', repeat: 'tonight' });
    expect(await own(store)).toEqual([]);
    expect((await store.listEvents(H, 50)).filter((e) => e.type.startsWith('self_'))).toEqual([]);
  });

  it('the second call with the token and a clear yes creates it, logs it, and opens the window', async () => {
    const { store } = await demo();
    setLocal('2026-10-19 20:00');
    const { set } = await setUp(store);
    expect(set.status).toBe('set');
    expect(set.say).toBe("Okay, it's set. Say good night any time before 10 pm tonight. If I don't hear it, I'll email Dana.");
    const [def] = await own(store);
    expect(def).toMatchObject({ author: 'person', label: 'your “good night” by 10 pm', windows: [{ start: '16:00', end: '22:00' }], active: true });
    expect(def!.self).toMatchObject({ phrase: 'good night', by: '22:00', contactId: 'dana', repeat: 'tonight', date: '2026-10-19' });
    expect(set.checkin?.occurrenceId).toBe(`OCC#2026-10-19#${def!.id}#0`);
    expect((await store.getOccurrence(H, set.checkin!.occurrenceId))?.state).toBe('SCHEDULED');
    const events = (await store.listEvents(H, 50)).filter((e) => e.type === 'self_checkin_set');
    expect(events.map((e) => e.detail)).toEqual(['Margaret set a check-in by voice: email Dana if there is no “good night” by 10 pm tonight.']);
  });

  it('replaying the same confirm token cannot create a second one', async () => {
    const { store } = await demo();
    setLocal('2026-10-19 20:00');
    const { preview } = await setUp(store);
    const again = await setMyCheckin(store, H, { confirmToken: preview.confirmToken!, utterance: 'Yes' }, { secret: SECRET });
    expect(again.status).toBe('set');
    expect(await own(store)).toHaveLength(1);
    expect((await store.listEvents(H, 50)).filter((e) => e.type === 'self_checkin_set')).toHaveLength(1);
  });

  it('anything but a clear yes leaves nothing set; a missing answer is a tool input error', async () => {
    const { store } = await demo();
    setLocal('2026-10-19 20:00');
    const preview = await setMyCheckin(store, H, GOOD_NIGHT, { secret: SECRET });
    for (const utterance of ['No.', 'I think so', 'Maybe later', 'Wait, not yet', 'Sure, why not']) {
      const r = await setMyCheckin(store, H, { confirmToken: preview.confirmToken!, utterance }, { secret: SECRET });
      expect(r.status, utterance).toBe('not_set');
      expect(r.say).toBe("Okay, I haven't set it.");
    }
    await expect(setMyCheckin(store, H, { confirmToken: preview.confirmToken! }, { secret: SECRET })).rejects.toThrow(/Read the preview to the person first/);
    expect(await own(store)).toEqual([]);
  });

  it('a forged, tampered, foreign, or expired token sets nothing', async () => {
    const { store } = await demo();
    setLocal('2026-10-19 20:00');
    const preview = await setMyCheckin(store, H, GOOD_NIGHT, { secret: SECRET });
    const [body, sig] = preview.confirmToken!.split('.');
    const tampered = `${Buffer.from(Buffer.from(body!, 'base64url').toString().replace('22:00', '23:00')).toString('base64url')}.${sig}`;
    for (const confirmToken of ['made.up', tampered]) {
      expect((await setMyCheckin(store, H, { confirmToken, utterance: 'Yes' }, { secret: SECRET })).status).toBe('not_set');
    }
    expect((await setMyCheckin(store, H, { confirmToken: preview.confirmToken!, utterance: 'Yes' }, { secret: 'another-deployment' })).status).toBe('not_set');
    setLocal('2026-10-19 20:06'); // the token lasts five minutes
    const late = await setMyCheckin(store, H, { confirmToken: preview.confirmToken!, utterance: 'Yes' }, { secret: SECRET });
    expect(late.say).toBe("That took a little too long, so I haven't set it. You can ask me again.");
    expect(await own(store)).toEqual([]);
  });
});

describe('the existing rules still apply', () => {
  it('lint: medication words are turned away, in plain words', async () => {
    const { store } = await demo();
    setLocal('2026-10-19 08:00');
    const r = await setMyCheckin(store, H, { phrase: 'I took my pills', by: '09:00' }, { secret: SECRET });
    expect(r.status).toBe('not_set');
    expect(r.say).toBe('I can only set that up with everyday words, like good night or good morning.');
  });

  it('the contact must already be on the email ladder', async () => {
    const { store } = await demo();
    setLocal('2026-10-19 20:00');
    const r = await setMyCheckin(store, H, { ...GOOD_NIGHT, tell: 'Bob' }, { secret: SECRET });
    expect(r.say).toBe('I can only tell someone who already gets check-in emails: Dana or Sam.');
    const byRelation = await setMyCheckin(store, H, { ...GOOD_NIGHT, tell: 'my son' }, { secret: SECRET });
    expect(byRelation.checkin?.tell).toBe('Sam');
    const byDefault = await setMyCheckin(store, H, { phrase: 'good night', by: '22:00' }, { secret: SECRET });
    expect(byDefault.checkin?.tell).toBe('Dana');
  });

  it('consent: with consent revoked nothing can be set', async () => {
    const { store } = await demo();
    const [consent] = await store.listConsents(H);
    await store.putConsent(H, { ...consent!, revokedAt: new Date().toISOString() });
    setLocal('2026-10-19 20:00');
    const r = await setMyCheckin(store, H, GOOD_NIGHT, { secret: SECRET });
    expect(r).toMatchObject({ status: 'not_set', say: 'Check-ins are turned off right now.' });
  });

  it('at most three of the person’s own; the same phrase replaces the old one', async () => {
    const { store } = await demo();
    setLocal('2026-10-19 06:00');
    await setUp(store, { phrase: 'good night', by: '22:00' });
    await setUp(store, { phrase: 'good morning', by: '09:00', repeat: 'daily' });
    await setUp(store, { phrase: "I'm home", by: '16:00' });
    const fourth = await setMyCheckin(store, H, { phrase: 'hello', by: '12:00' }, { secret: SECRET });
    expect(fourth.say).toBe('You already have 3 check-ins of your own. Cancel one first, for example by saying: cancel my good night check.');

    const replace = await setMyCheckin(store, H, { phrase: 'Good night!', by: '23:00' }, { secret: SECRET });
    expect(replace.say).toBe("This replaces your good night by 10 pm. If you haven't said good night by 11 pm tonight, I'll email Dana. Should I set that up?");
    await setMyCheckin(store, H, { confirmToken: replace.confirmToken!, utterance: 'yes' }, { secret: SECRET });
    const live = (await own(store)).filter((d) => d.active);
    expect(live.map((d) => d.self!.by).sort()).toEqual(['09:00', '16:00', '23:00']);
  });

  it('quiet hours: the preview says the email waits, and it does (outside demo mode)', async () => {
    const { store, mailer, tick } = await demo('2026-10-19 07:00', { demoMode: false });
    setLocal('2026-10-19 20:00');
    const { preview, set } = await setUp(store);
    expect(preview.say).toContain('Emails wait until quiet hours end at 7 am.');
    setLocal('2026-10-19 22:01');
    await tick();
    expect(mailer.sent.filter((m) => m.occurrenceId === set.checkin!.occurrenceId)).toHaveLength(0);
    expect((await store.getOccurrence(H, set.checkin!.occurrenceId))?.alertStatus).toBe('waiting_quiet_hours');
    setLocal('2026-10-20 07:00');
    await tick();
    expect(mailer.sent.filter((m) => m.occurrenceId === set.checkin!.occurrenceId).map((m) => m.to)).toEqual(['dana@example.com']);
  });

  it('the daily email cap counts these emails too', async () => {
    const { store, mailer, tick } = await demo();
    await store.putLadder(H, { ...(await store.getLadder(H)), dailyAlertCap: 1 });
    setLocal('2026-10-19 20:00');
    const { set } = await setUp(store);
    setLocal('2026-10-19 22:01');
    const report = await tick(); // morning, lunch, evening, and the good-night loop all closed open today
    expect(mailer.sent.filter((m) => m.kind.startsWith('missed'))).toHaveLength(1);
    expect(report.alertsSuppressed).toBe(3);
    expect((await store.getOccurrence(H, set.checkin!.occurrenceId))?.state).toMatch(/MISSED|ESCALATED_L1/);
  });

  it('a pause from the console covers them: the window closes as paused, no email', async () => {
    const { store, mailer, tick } = await demo();
    setLocal('2026-10-19 20:00');
    const { set } = await setUp(store);
    const t = setLocal('2026-10-19 20:30');
    await store.updateHousehold(H, { pausedUntil: new Date(t.getTime() + 24 * 3_600_000).toISOString(), pausedAt: t.toISOString(), pausedBy: 'caregiver' });
    setLocal('2026-10-19 22:01');
    await tick();
    expect((await store.getOccurrence(H, set.checkin!.occurrenceId))?.state).toBe('PAUSED');
    expect(mailer.sent.filter((m) => m.occurrenceId === set.checkin!.occurrenceId)).toEqual([]);
  });
});

describe('closing the loop: the person speaks first', () => {
  it('is never asked by get_due_checkins', async () => {
    const { store } = await demo();
    setLocal('2026-10-19 18:30');
    await setUp(store);
    const due = await getDueCheckins(store, H);
    expect(due.checkins.map((c) => c.label)).toEqual(['your evening check-in']);
  });

  it('saying the phrase before the deadline closes it, and nobody is emailed', async () => {
    const { store, mailer, tick } = await demo();
    setLocal('2026-10-19 20:00');
    await setUp(store);
    setLocal('2026-10-19 21:40');
    const [mine] = await mineNow(store);
    expect(mine).toMatchObject({ phrase: 'good night', tell: 'Dana', recorded: 'not said yet' });
    const r = await recordResponse(store, H, { occurrenceId: mine!.occurrenceId, response: 'done', utterance: 'Good night!' });
    expect(r.recordedWording).toBe('reported by the person');
    expect(r.say).toBe("Good night. I've noted it, so Dana won't be emailed about it.");
    setLocal('2026-10-19 22:05');
    await tick();
    expect(mailer.sent.filter((m) => m.occurrenceId === mine!.occurrenceId)).toEqual([]);
    expect((await getMyStatus(store, H)).say).toContain("You asked me to email Dana if you haven't said good night by 10 pm; I heard it.");
  });

  it('said earlier that day counts too (before the window opens), and is not "late"', async () => {
    const { store } = await demo();
    setLocal('2026-10-19 09:00');
    await setUp(store);
    setLocal('2026-10-19 15:00');
    const [mine] = await mineNow(store);
    await recordResponse(store, H, { occurrenceId: mine!.occurrenceId, response: 'done', utterance: 'good night' });
    expect(ledgerLine((await store.getOccurrence(H, mine!.occurrenceId))!)).toBe('reported by the person');
  });

  it('a different phrase, no words, or a negated phrase fails closed', async () => {
    const { store } = await demo();
    setLocal('2026-10-19 20:00');
    await setUp(store);
    const [mine] = await mineNow(store);
    for (const [response, utterance] of [['done', 'Yes, done.'], ['done', "I haven't said good night"], ['done', "I'll say good night later"], ['done', undefined], ['later', 'Later']] as const) {
      const r = await recordResponse(store, H, { occurrenceId: mine!.occurrenceId, response, utterance });
      expect(r, String(utterance)).toMatchObject({ recordedAs: 'not_recorded', recordedWording: 'not said yet', nextStep: 'none', say: "Okay. I'll note it when you say good night." });
    }
    const occ = (await store.getOccurrence(H, mine!.occurrenceId))!;
    expect(occ.state).toBe('SCHEDULED'); // still waiting for the phrase; never promised a re-ask
    expect(ledgerLine(occ, undefined, { own: true })).toBe('not said yet');
  });

  it('no record by the deadline: "no response (not reached)", then one email to Dana in Margaret’s name', async () => {
    const { store, mailer, tick } = await demo();
    setLocal('2026-10-19 20:00');
    const { set } = await setUp(store);
    const occId = set.checkin!.occurrenceId;
    setLocal('2026-10-19 22:01');
    await tick();
    const emails = mailer.sent.filter((m) => m.occurrenceId === occId);
    expect(emails.map((m) => m.to)).toEqual(['dana@example.com']);
    expect(emails[0]!.subject).toBe('Margaret asked us to let you know: no "good night" by 10 pm (not an emergency alert)');
    expect(emails[0]!.text).toContain(
      'Margaret asked Closed Loop to let you know if Margaret hadn\'t said "good night" by 10 pm. Margaret hasn\'t yet. This is not an emergency alert.',
    );
    expect(emails[0]!.text).toContain('Margaret set this up by voice.');
    expect(emails[0]!.text).not.toMatch(/\b(she|her|he|him|his|confirmed)\b/i);
    expect(ledgerLine((await store.getOccurrence(H, occId))!)).toBe('no response (not reached) · family emailed');
    const r = await acknowledge(store, H, occId, 'dana', new Date());
    expect(r.ok).toBe(true);
    setLocal('2026-10-19 22:30');
    await tick();
    expect(mailer.sent.filter((m) => m.occurrenceId === occId)).toHaveLength(1);
  });

  it('tells the contact the person chose, even a second contact', async () => {
    const { store, mailer, tick } = await demo();
    setLocal('2026-10-19 20:00');
    const { set } = await setUp(store, { ...GOOD_NIGHT, tell: 'Sam' });
    setLocal('2026-10-19 22:01');
    await tick();
    expect(mailer.sent.filter((m) => m.occurrenceId === set.checkin!.occurrenceId).map((m) => m.to)).toEqual(['sam@example.com']);
  });

  it('a late good night is recorded as after the time, and says Dana may already know', async () => {
    const { store, tick } = await demo();
    setLocal('2026-10-19 20:00');
    await setUp(store);
    setLocal('2026-10-19 22:01');
    await tick();
    setLocal('2026-10-19 22:40');
    const [mine] = await mineNow(store);
    const r = await recordResponse(store, H, { occurrenceId: mine!.occurrenceId, response: 'done', utterance: 'Oh, good night' });
    expect(r.say).toBe("Good night. I've noted it. It was after 10 pm, so Dana may already have been emailed.");
    expect(ledgerLine((await store.getOccurrence(H, mine!.occurrenceId))!)).toBe('reported by the person (after the window closed)');
  });

  it('"tonight" runs once; "daily" runs again the next day', async () => {
    const { store, mailer, tick } = await demo();
    await store.putLadder(H, { ...(await store.getLadder(H)), dailyAlertCap: 10 });
    setLocal('2026-10-19 06:00');
    await setUp(store, { phrase: 'good night', by: '22:00' });
    await setUp(store, { phrase: 'good morning', by: '09:00', repeat: 'daily' });
    setLocal('2026-10-20 22:01');
    await tick();
    const ids = (await store.listOccurrences(H, '2026-10-20')).map((o) => o.id);
    const [night, morning] = [(await own(store)).find((d) => d.self!.phrase === 'good night')!, (await own(store)).find((d) => d.self!.phrase === 'good morning')!];
    expect(ids).toContain(`OCC#2026-10-20#${morning.id}#0`);
    expect(ids).not.toContain(`OCC#2026-10-20#${night.id}#0`);
    // Day two in a row with nobody acknowledging: the normal ladder adds the second contact.
    const day2 = mailer.sent.filter((m) => m.occurrenceId === `OCC#2026-10-20#${morning.id}#0`);
    expect(day2.map((m) => m.to).sort()).toEqual(['dana@example.com', 'sam@example.com']);
    expect(day2[0]!.subject).toBe(`Second notice: Margaret's "good morning" by 9 am (not an emergency alert)`);
    setLocal('2026-10-21 08:00');
    expect((await mineNow(store)).map((m) => m.phrase)).toEqual(['good morning']);
  });

  it('a deadline after midnight said late in the evening means tonight', async () => {
    const { store } = await demo();
    setLocal('2026-10-19 22:00');
    const { preview, set } = await setUp(store, { phrase: 'good night', by: '01:00' });
    expect(preview.say).toBe("If you haven't said good night by 1 am tonight, I'll email Dana. Should I set that up?");
    const occ = (await store.getOccurrence(H, set.checkin!.occurrenceId))!;
    expect(occ.date).toBe('2026-10-19');
    expect(new Date(occ.windowEnd).toISOString()).toBe('2026-10-20T05:00:00.000Z');
  });

  it('family hear it in the summary, in the same honest words', async () => {
    const { store } = await demo();
    setLocal('2026-10-19 20:00');
    await setUp(store);
    const s = await getFamilySummary(store, H);
    expect(s.items.find((i) => i.label.includes('good night'))).toMatchObject({ label: "Margaret's “good night” by 10 pm", window: '16:00–22:00', recorded: 'not said yet', kind: 'waiting' });
    expect(s.say).toContain("Margaret's “good night” by 10 pm: not said yet.");
  });
});

describe('cancelling', () => {
  it('cancels by phrase: the open window is marked cancelled, nobody is emailed, and it is logged', async () => {
    const { store, mailer, tick } = await demo();
    setLocal('2026-10-19 20:00');
    const { set } = await setUp(store);
    setLocal('2026-10-19 21:00');
    const r = await cancelMyCheckin(store, H, { phrase: 'good-night' });
    expect(r).toMatchObject({ status: 'cancelled', remaining: 0, say: "Okay, I've cancelled your good night by 10 pm. Dana won't be emailed about it." });
    expect(ledgerLine((await store.getOccurrence(H, set.checkin!.occurrenceId))!)).toBe('cancelled by the person');
    setLocal('2026-10-19 22:01');
    await tick();
    expect(mailer.sent.filter((m) => m.occurrenceId === set.checkin!.occurrenceId)).toEqual([]);
    expect((await store.listEvents(H, 50)).find((e) => e.type === 'self_checkin_cancelled')?.detail).toBe(
      'Margaret cancelled “good night” by 10 pm by voice. Dana will not be emailed about it.',
    );
    expect((await cancelMyCheckin(store, H, {})).say).toBe("You haven't set up any check-ins of your own.");
  });

  it('asks which one when the hint matches nothing or several', async () => {
    const { store } = await demo();
    setLocal('2026-10-19 06:00');
    await setUp(store, { phrase: 'good night', by: '22:00' });
    await setUp(store, { phrase: 'good morning', by: '09:00' });
    expect((await cancelMyCheckin(store, H, {})).say).toBe('Which one? You have good night by 10 pm and good morning by 9 am.');
    expect((await cancelMyCheckin(store, H, { phrase: 'walk' })).say).toBe("You don't have one like that. You have good night by 10 pm and good morning by 9 am.");
  });
});

describe('safety while setting one up', () => {
  it('a crisis said while setting a check-in still gets the 911 line, and nothing is set', async () => {
    const { store } = await demo();
    setLocal('2026-10-19 20:00');
    const r = await setMyCheckin(store, H, { ...GOOD_NIGHT, utterance: "If I haven't said good night by ten, tell Dana. I fell and I can't get up." }, { secret: SECRET });
    expect(r).toMatchObject({ status: 'not_set', nextStep: 'call_emergency_services', say: CRISIS_REPLY });
    const harm = await setMyCheckin(store, H, { ...GOOD_NIGHT, utterance: "I don't want to live anymore" }, { secret: SECRET });
    expect(harm.say).toBe(SELF_HARM_REPLY);
    const preview = await setMyCheckin(store, H, GOOD_NIGHT, { secret: SECRET });
    const atConfirm = await setMyCheckin(store, H, { confirmToken: preview.confirmToken!, utterance: 'Yes. My chest hurts.' }, { secret: SECRET });
    expect(atConfirm).toMatchObject({ status: 'not_set', nextStep: 'call_emergency_services', say: CRISIS_REPLY });
    expect(await own(store)).toEqual([]);
  });

  it('distress gets the family’s calming line and no question', async () => {
    const { store } = await demo();
    setLocal('2026-10-19 20:00');
    const r = await setMyCheckin(store, H, { ...GOOD_NIGHT, utterance: 'I want to go home. Where is everyone?' }, { secret: SECRET });
    expect(r.say).toBe("You're safe at home, Margaret. Dana will give you a call this evening.");
    expect(r.say).not.toContain('?');
  });

  it('crisis wording when saying the phrase still wins: needs human contact, 911 line', async () => {
    const { store } = await demo();
    setLocal('2026-10-19 20:00');
    await setUp(store);
    const [mine] = await mineNow(store);
    const r = await recordResponse(store, H, { occurrenceId: mine!.occurrenceId, response: 'done', utterance: "Good night. I fell and I can't get up." });
    expect(r).toMatchObject({ recordedAs: 'needs_human_contact', nextStep: 'call_emergency_services', say: CRISIS_REPLY });
  });
});
