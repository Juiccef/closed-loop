// The classic Alexa skill (packages/alexa-skill) against the real MCP server, in process: sample Alexa request
// envelopes in, the skill's responses out. The Alexa Reminders API is a fake ApiClient.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RequestEnvelope, ResponseEnvelope, services } from 'ask-sdk-model';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CARD_FOOTER,
  PERMISSION_SPEECH,
  REMINDERS_PERMISSION,
  SkillIdError,
  SkillMcpClient,
  cardFor,
  createSkill,
  durationSeconds,
  reminderAsk,
  ringPath,
  speakerFor,
  tidyTranscript,
  type ToolResult,
} from '../packages/alexa-skill/src';
import { CRISIS_REPLY, SELF_HARM_REPLY, setRealTimeSource } from '../packages/core/src';
import { coreBackend, createMcpHttpHandler } from '../packages/mcp-server/src';
import { H, demo, setLocal } from './helpers';

const TOKEN = 'skill-test-token';
const SKILL_ID = 'amzn1.ask.skill.00000000-test-closed-loop';
const ROOT = join(import.meta.dirname, '..');

/** Stands in for api.amazonalexa.com: records each call, answers with `reply`. */
class FakeAlexaApi implements services.ApiClient {
  calls: Array<{ method: string; url: string; auth?: string; body?: any }> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  reminders: unknown[] = [];
  reply: (method: string, url: string) => { statusCode: number; body?: unknown } = (method) =>
    method === 'GET' ? { statusCode: 200, body: { totalCount: String(this.reminders.length), alerts: this.reminders } } : { statusCode: 201, body: { alertToken: `t${this.calls.length}`, status: 'ON' } };
  async invoke(req: services.ApiClientRequest): Promise<services.ApiClientResponse> {
    const body = req.body ? JSON.parse(req.body) : undefined;
    this.calls.push({ method: req.method, url: req.url, auth: req.headers?.find((h) => h.key.toLowerCase() === 'authorization')?.value, body });
    const r = this.reply(req.method, req.url);
    if (req.method === 'POST' && r.statusCode < 300) this.reminders.push({ ...body, status: 'ON' });
    return { statusCode: r.statusCode, headers: [{ key: 'content-type', value: 'application/json' }], body: r.body === undefined ? '' : JSON.stringify(r.body) };
  }
}

interface Opts {
  apl?: boolean;
  skillId?: string;
  attributes?: Record<string, unknown>;
}

function envelope(request: Record<string, unknown>, opts: Opts = {}): RequestEnvelope {
  const skillId = opts.skillId ?? SKILL_ID;
  return {
    version: '1.0',
    session: {
      new: !opts.attributes,
      sessionId: 'amzn1.echo-api.session.test',
      application: { applicationId: skillId },
      attributes: opts.attributes ?? {},
      user: { userId: 'amzn1.ask.account.test' },
    },
    context: {
      System: {
        application: { applicationId: skillId },
        user: { userId: 'amzn1.ask.account.test' },
        device: {
          deviceId: 'amzn1.ask.device.test',
          supportedInterfaces: opts.apl === false ? {} : { 'Alexa.Presentation.APL': { runtime: { maxVersion: '2023.3' } } },
        },
        apiEndpoint: 'https://api.amazonalexa.com',
        apiAccessToken: 'test-api-access-token',
      },
    },
    request: { requestId: 'amzn1.echo-api.request.test', timestamp: '2026-10-19T12:00:00Z', locale: 'en-US', ...request },
  } as unknown as RequestEnvelope;
}

const launch = () => ({ type: 'LaunchRequest' });
const intent = (name: string, slots: Record<string, string> = {}) => ({
  type: 'IntentRequest',
  dialogState: 'COMPLETED',
  intent: { name, confirmationStatus: 'NONE', slots: Object.fromEntries(Object.entries(slots).map(([k, v]) => [k, { name: k, value: v, confirmationStatus: 'NONE' }])) },
});
const said = (utterance: string) => intent('SayIntent', { utterance });

const speech = (r: ResponseEnvelope) =>
  ((r.response.outputSpeech as { ssml?: string })?.ssml ?? '').replace(/^<speak>|<\/speak>$/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const apl = (r: ResponseEnvelope) => r.response.directives?.find((d) => d.type === 'Alexa.Presentation.APL.RenderDocument') as { datasources: { card: Record<string, string> } } | undefined;

async function setup(start = '2026-10-19 07:55', opts: { skillId?: string; failMcp?: boolean } = {}) {
  const d = await demo(start);
  const handle = createMcpHttpHandler({ bearerTokens: { [TOKEN]: H }, allowedOrigins: [], resourceUrl: '', includeWwwAuthenticate: false }, coreBackend(d.store, { confirmSecret: 'skill-test-confirm' }));
  /** Every tools/call result the server returned, in order: what Alexa should read out, word for word. */
  const results: ToolResult[] = [];
  const mcp = new SkillMcpClient({
    url: 'http://localhost/mcp',
    token: TOKEN,
    fetch: async (url, init) => {
      if (opts.failMcp) throw new Error('connect ECONNREFUSED');
      const res = await handle(new Request(String(url), init));
      const copy = res.clone();
      const body = res.status === 200 ? await copy.json().catch(() => null) : null;
      if (body?.result?.content) results.push(body.result);
      return res;
    },
  });
  const alexa = new FakeAlexaApi();
  const skill = createSkill({ skillId: opts.skillId ?? SKILL_ID, mcp, timezone: 'America/New_York', apiClient: alexa });
  // One Alexa session: session attributes carry over from each response to the next request.
  let attributes: Record<string, unknown> | undefined;
  const ask = async (request: Record<string, unknown>, o: Opts = {}) => {
    const r = await skill.invoke(envelope(request, { attributes, ...o }));
    attributes = r.response.shouldEndSession === false ? (r.sessionAttributes ?? {}) : undefined;
    return r;
  };
  const lastSay = () => results.at(-1)?.structuredContent?.say as string;
  return { ...d, skill, ask, alexa, results, lastSay, newSession: () => (attributes = undefined) };
}

afterEach(() => setRealTimeSource(() => Date.now()));

describe('Alexa skill: conversation through the planner and the live tools', () => {
  it('LaunchRequest with nothing due: the server line, then keeps listening; the card mirrors it', async () => {
    const s = await setup('2026-10-19 07:55');
    const r = await s.ask(launch());
    expect(speech(r)).toBe('There are no check-ins right now. What would you like to do?');
    expect(r.response.shouldEndSession).toBe(false);
    expect(apl(r)?.datasources.card).toMatchObject({ kind: 'closed', title: 'Nothing due right now', footer: CARD_FOOTER });
  });

  it('LaunchRequest asks the due check-in in the family’s words; "I think so, maybe after lunch" is said later, not done', async () => {
    const s = await setup('2026-10-19 08:00');
    const opened = await s.ask(launch());
    expect(speech(opened)).toBe('Good morning, Margaret. Have you done your morning routine yet?');
    expect(opened.response.shouldEndSession).toBe(false);
    expect(opened.response.reprompt).toBeDefined();

    const r = await s.ask(said('I think so, maybe after lunch'));
    expect(speech(r)).toBe(s.lastSay());
    expect(speech(r)).toBe("Okay. I'll ask again around 1 pm.");
    expect(apl(r)?.datasources.card).toMatchObject({ kind: 'later', kicker: 'Said later' });
    const morning = (await s.store.listOccurrences(H, '2026-10-19')).find((o) => o.checkinId === 'morning');
    expect(morning?.state).toBe('DEFERRED');
  });

  it('"If I haven\'t said good night by nine thirty, let Dana know": preview, then Yes sets it; "good night" later closes it', async () => {
    const s = await setup('2026-10-19 09:00');
    const preview = await s.ask(said("If I haven't said good night by nine thirty, let Dana know"));
    expect(speech(preview)).toBe(s.lastSay());
    expect(speech(preview)).toMatch(/9:30 pm.*Dana.*Should I set that up\?$/);
    expect(preview.response.shouldEndSession).toBe(false);
    expect((preview.sessionAttributes as { pending?: { confirmToken?: string } }).pending?.confirmToken).toBeTruthy();
    expect(apl(preview)?.datasources.card).toMatchObject({ kind: 'later', kicker: 'Your own check-in · not set yet' });

    const yes = await s.ask(intent('AMAZON.YesIntent'));
    expect(speech(yes)).toBe(s.lastSay());
    expect(apl(yes)?.datasources.card).toMatchObject({ kicker: 'Set by you', title: 'Tell Dana if there’s no “good night” by 9:30 pm' });
    expect((await s.store.listCheckins(H)).some((c) => c.author === 'person')).toBe(true);

    // A new session in the evening: "Alexa, tell Closed Loop good night".
    s.newSession();
    setLocal('2026-10-19 21:05');
    const night = await s.ask(said('Good night'));
    expect(speech(night)).toBe(s.lastSay());
    expect(speech(night)).toMatch(/^Good night\. .*Dana won't be emailed/);
    expect(s.results.at(-2)?.structuredContent?.mine).toBeDefined(); // the get_my_status lookup hop came first
  });

  it('No after a preview: nothing is set', async () => {
    const s = await setup('2026-10-19 09:00');
    await s.ask(said("If I haven't said good night by nine thirty, let Dana know"));
    const no = await s.ask(intent('AMAZON.NoIntent'));
    expect(speech(no)).toBe(s.lastSay());
    expect((await s.store.listCheckins(H)).some((c) => c.author === 'person')).toBe(false);
  });

  it('family speaker: "Alexa, ask Closed Loop how Mom is doing" reads the summary as recorded, never answers for the person', async () => {
    const s = await setup('2026-10-19 09:00');
    const r = await s.ask(intent('FamilyIntent', { name: 'Mom' }));
    expect(speech(r)).toBe(s.lastSay());
    expect(speech(r)).toMatch(/^Here is what Margaret's check-ins recorded today\./);
    expect(apl(r)?.datasources.card).toMatchObject({ title: 'Margaret’s check-ins today' });

    s.newSession();
    const viaCatchAll = await s.ask(said('How is Mom doing today?'));
    expect(speech(viaCatchAll)).toMatch(/^Here is what Margaret's check-ins recorded today\./);
    const occs = await s.store.listOccurrences(H, '2026-10-19');
    expect(occs.every((o) => o.state !== 'REPORTED_DONE')).toBe(true);
  });

  it('emergency wording: the server’s fixed 911 line, spoken unchanged, and the session ends even on a screen', async () => {
    const s = await setup('2026-10-19 08:00');
    await s.ask(launch());
    const r = await s.ask(said("I've fallen and I can't get up"));
    expect(speech(r)).toBe(s.lastSay());
    expect(speech(r)).toContain(CRISIS_REPLY);
    expect(r.response.shouldEndSession).toBe(true);
    expect(apl(r)?.datasources.card).toMatchObject({ kind: 'human' });
  });

  it('self-harm wording adds the 988 line; distress gets the family’s calming line and a note, unchanged', async () => {
    const s = await setup('2026-10-19 08:00');
    const selfHarm = await s.ask(said('I want to kill myself'));
    expect(speech(selfHarm)).toBe(s.lastSay());
    expect(speech(selfHarm)).toContain(SELF_HARM_REPLY);
    expect(selfHarm.response.shouldEndSession).toBe(true);

    const t = await setup('2026-10-19 08:00');
    await t.ask(launch());
    const scared = await t.ask(said("I'm scared"));
    expect(speech(scared)).toBe(t.lastSay());
    expect(speech(scared)).toContain("You're safe at home, Margaret. Dana will give you a call this evening.");
    expect(scared.response.shouldEndSession).toBe(true);
    const morning = (await t.store.listOccurrences(H, '2026-10-19')).find((o) => o.checkinId === 'morning');
    expect(morning?.state).toBe('NEEDS_HUMAN');
  });

  it('server unreachable: emergency wording still gets the fixed line; nothing else claims it was noted', async () => {
    const s = await setup('2026-10-19 08:00', { failMcp: true });
    const crisis = await s.ask(said("I've fallen"));
    expect(speech(crisis)).toBe(CRISIS_REPLY);
    expect(crisis.response.shouldEndSession).toBe(true);
    const plain = await s.ask(said('Any check-ins?'));
    expect(speech(plain)).toMatch(/couldn't reach Closed Loop.*can't tell whether that was noted/);
  });

  it('no screen: no APL directive, and the session ends', async () => {
    const s = await setup('2026-10-19 09:00');
    const r = await s.ask(intent('FamilyIntent', { name: 'Mom' }), { apl: false });
    expect(r.response.directives ?? []).toHaveLength(0);
    expect(r.response.shouldEndSession).toBe(true);
  });
});

describe('Alexa skill: reminders (Reminders API, faked)', () => {
  it('permission missing: the API refuses, so the AskForPermissionsConsent card goes to the Alexa app', async () => {
    const s = await setup('2026-10-19 09:00');
    s.alexa.reply = () => ({ statusCode: 401, body: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
    const r = await s.ask(intent('RemindMeIntent', { duration: 'PT1M' }));
    expect(r.response.card).toEqual({ type: 'AskForPermissionsConsent', permissions: [REMINDERS_PERMISSION] });
    expect(speech(r)).toBe(PERMISSION_SPEECH);
    expect(r.response.shouldEndSession).toBe(true);
  });

  it('"remind me to check in in one minute": one SCHEDULED_RELATIVE reminder, in Margaret’s name', async () => {
    const s = await setup('2026-10-19 09:00');
    const r = await s.ask(intent('RemindMeIntent', { duration: 'PT1M' }));
    expect(speech(r)).toBe("Okay. In 1 minute, I'll remind you to check in.");
    const post = s.alexa.calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('https://api.amazonalexa.com/v1/alerts/reminders');
    expect(post.auth).toBe('Bearer test-api-access-token');
    expect(post.body).toMatchObject({
      trigger: { type: 'SCHEDULED_RELATIVE', offsetInSeconds: 60 },
      alertInfo: { spokenInfo: { content: [{ locale: 'en-US', text: "Margaret, it's time for your check-in. Say: Alexa, open Closed Loop." }] } },
      pushNotification: { status: 'ENABLED' },
    });
  });

  it('the catch-all also takes "remind me to check in in two minutes"', async () => {
    const s = await setup('2026-10-19 09:00');
    await s.ask(said('remind me to check in in two minutes'));
    expect(s.alexa.calls.find((c) => c.method === 'POST')?.body.trigger.offsetInSeconds).toBe(120);
  });

  it('daily reminders: one per family check-in window start, household time zone; the person’s own check-in is left out; asking again adds none', async () => {
    const s = await setup('2026-10-19 09:00');
    await s.ask(said("If I haven't said good night by nine thirty, let Dana know"));
    await s.ask(intent('AMAZON.YesIntent'));
    s.newSession();

    const r = await s.ask(intent('DailyRemindersIntent'));
    expect(speech(r)).toBe("Okay. I've set daily reminders at 8 am, noon, and 6 pm. Each one will ask you to open Closed Loop.");
    const posts = s.alexa.calls.filter((c) => c.method === 'POST').map((c) => c.body);
    expect(posts).toHaveLength(3);
    expect(posts.map((b) => b.trigger.recurrence.recurrenceRules[0])).toEqual([
      'FREQ=DAILY;BYHOUR=8;BYMINUTE=0;BYSECOND=0;INTERVAL=1;',
      'FREQ=DAILY;BYHOUR=12;BYMINUTE=0;BYSECOND=0;INTERVAL=1;',
      'FREQ=DAILY;BYHOUR=18;BYMINUTE=0;BYSECOND=0;INTERVAL=1;',
    ]);
    for (const b of posts) expect(b.trigger).toMatchObject({ type: 'SCHEDULED_ABSOLUTE', timeZoneId: 'America/New_York', recurrence: { startDateTime: '2026-10-19T09:00:00.000' } });
    expect(posts.map((b) => b.alertInfo.spokenInfo.content[0].text)).toEqual([
      "Margaret, it's time for your morning routine. Say: Alexa, open Closed Loop.",
      "Margaret, it's time for your lunchtime check. Say: Alexa, open Closed Loop.",
      "Margaret, it's time for your evening check-in. Say: Alexa, open Closed Loop.",
    ]);

    s.newSession();
    const again = await s.ask(intent('DailyRemindersIntent'));
    expect(speech(again)).toBe('Your daily check-in reminders are already set, at 8 am, noon, and 6 pm.');
    expect(s.alexa.calls.filter((c) => c.method === 'POST')).toHaveLength(3);
  });
});

describe('Alexa skill: request checks and helpers', () => {
  it('rejects a request for another skill, and every request when no skill ID is configured', async () => {
    const s = await setup();
    await expect(s.skill.invoke(envelope(launch(), { skillId: 'amzn1.ask.skill.someone-else' }))).rejects.toBeInstanceOf(SkillIdError);
    const unset = await setup('2026-10-19 07:55', { skillId: '' });
    await expect(unset.skill.invoke(envelope(launch()))).rejects.toBeInstanceOf(SkillIdError);
  });

  it('picks the family speaker only for a question about Mom; safety wording always stays with the person', () => {
    expect(speakerFor('How is Mom doing today?')).toBe('family');
    expect(speakerFor('is mom okay')).toBe('family');
    expect(speakerFor('How am I doing today?')).toBe('person');
    expect(speakerFor('Where is my mother?')).toBe('person');
    expect(speakerFor('How is Mom? I think I fell')).toBe('person');
  });

  it('puts back a dropped "if" and spoken times as digits, nothing else', () => {
    expect(tidyTranscript("I haven't said good night by nine thirty let Dana know")).toBe("If I haven't said good night by nine thirty let Dana know");
    expect(tidyTranscript("I'm not home by six, let Sam know")).toBe("If I'm not home by six, let Sam know");
    expect(tidyTranscript("if I haven't said good night by 9 30 let Dana know")).toBe("if I haven't said good night by 9:30 let Dana know");
    expect(tidyTranscript("If I haven't said good night by 930 let Dana know")).toBe("If I haven't said good night by 9:30 let Dana know");
    expect(tidyTranscript('I think so, maybe after lunch')).toBe('I think so, maybe after lunch');
    expect(tidyTranscript("I haven't had lunch yet")).toBe("I haven't had lunch yet");
  });

  it('the set-up sentence still works when Alexa drops the "if" and hears "9 30"', async () => {
    const s = await setup('2026-10-19 09:00');
    const r = await s.ask(said("I haven't said good night by 9 30 let Dana know"));
    expect(speech(r)).toMatch(/^If you haven't said good night by 9:30 pm tonight, I'll email Dana\. Should I set that up\?$/);
  });

  it('reads durations and reminder requests', () => {
    expect(durationSeconds('PT1M')).toBe(60);
    expect(durationSeconds('PT1H30M')).toBe(5400);
    expect(durationSeconds('P1D')).toBe(86400);
    expect(durationSeconds('PT')).toBeUndefined();
    expect(durationSeconds(undefined)).toBeUndefined();
    expect(reminderAsk('remind me to check in in one minute')).toEqual({ daily: false, seconds: 60 });
    expect(reminderAsk('remind me every day')).toEqual({ daily: true });
    expect(reminderAsk('good night')).toBeNull();
  });

  it('the APL ring has a different shape for each status', () => {
    const shapes = new Set((['open', 'later', 'closed', 'paused'] as const).map(ringPath));
    expect(shapes.size).toBe(4);
    expect(cardFor({ structuredContent: { recordedAs: 'needs_human_contact', recordedWording: 'needs human contact', nextStep: 'call_emergency_services', say: '' } })).toEqual({
      kind: 'human',
      kicker: 'Recorded',
      title: 'Needs human contact',
      sub: 'Told to call 911 if it is an emergency.',
    });
  });

  it('skill package: invocation name, every handled intent, the reminders permission, and APL', () => {
    const model = JSON.parse(readFileSync(join(ROOT, 'packages/alexa-skill/skill-package/interactionModels/custom/en-US.json'), 'utf8')).interactionModel.languageModel;
    expect(model.invocationName).toBe('closed loop');
    const names = model.intents.map((i: { name: string }) => i.name);
    for (const n of ['SayIntent', 'FamilyIntent', 'RemindMeIntent', 'DailyRemindersIntent', 'AMAZON.YesIntent', 'AMAZON.NoIntent', 'AMAZON.HelpIntent', 'AMAZON.StopIntent', 'AMAZON.CancelIntent', 'AMAZON.FallbackIntent']) {
      expect(names).toContain(n);
    }
    expect(model.intents.find((i: { name: string }) => i.name === 'SayIntent').samples).toEqual(['{utterance}']);
    const manifest = JSON.parse(readFileSync(join(ROOT, 'packages/alexa-skill/skill-package/skill.json'), 'utf8')).manifest;
    expect(manifest.permissions).toEqual([{ name: REMINDERS_PERMISSION }]);
    expect(manifest.apis.custom.interfaces[0].type).toBe('ALEXA_PRESENTATION_APL');
    expect(JSON.stringify({ model, manifest }).toLowerCase()).not.toMatch(/\bconfirmed\b|\btaken\b/);
  });
});
