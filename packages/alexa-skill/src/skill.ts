// Closed Loop as a classic Alexa custom skill: a thin MCP client of the live server, so a real Echo Show can run
// the same check-ins. Not an Alexa+ add-on (that tooling is partner-only). What the person says goes through the
// same rules planner as the simulator; Alexa reads the server's `say` text exactly as returned.

import {
  DefaultApiClient,
  SkillBuilders,
  getIntentName,
  getRequestType,
  getSlotValue,
  getSupportedInterfaces,
  type HandlerInput,
  type RequestHandler,
} from 'ask-sdk-core';
import type { RequestEnvelope, Response, ResponseEnvelope, services } from 'ask-sdk-model';
import { realNow } from '@closed-loop/core';
import { cardFor, renderDirective } from './card';
import { converse, openSkill, speakerFor, tidyTranscript, unreachableReply, type ConversationState, type Speaker, type TurnResult } from './conversation';
import { SkillMcpClient } from './mcp';
import {
  REMINDERS_PERMISSION,
  dailyReminder,
  durationSeconds,
  familyCheckins,
  reminderAsk,
  reminderErrorSpeech,
  reminderText,
  relativeReminder,
  spokenDuration,
  spokenTimes,
} from './reminders';

export interface SkillDeps {
  /** This skill's ID from the developer console. Requests for any other skill, or with none configured, are refused. */
  skillId: string;
  mcp: SkillMcpClient;
  /** The household's time zone, for daily reminders. The MCP tools don't return it; the demo household uses America/New_York. */
  timezone: string;
  /** Reaches the Alexa APIs (Reminders). Tests pass a fake. */
  apiClient?: services.ApiClient;
  /** Real time, for reminder requests (the server's demo clock may be moved; reminders ring in real time). */
  now?: () => Date;
}

export const HELP_SPEECH =
  'You can answer today’s check-ins, or set up one of your own. For example: if I haven’t said good night by nine thirty, let Dana know. ' +
  'Later, just say good night. You can also say: remind me to check in in one minute. Family can ask: how is Mom doing today?';
const NOT_HEARD = 'Sorry, I didn’t catch that. Could you say it again?';
/** Reminders: at least a minute, at most a day (the Reminders API states no limit; this keeps filming takes sane). */
const MIN_OFFSET = 60;
const MAX_OFFSET = 24 * 3600;

const escapeSsml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function supportsApl(h: HandlerInput): boolean {
  return !!getSupportedInterfaces(h.requestEnvelope)?.['Alexa.Presentation.APL'];
}

const stateOf = (h: HandlerInput) => (h.attributesManager.getSessionAttributes() ?? {}) as ConversationState;

function respond(h: HandlerInput, turn: TurnResult): Response {
  h.attributesManager.setSessionAttributes(turn.state);
  const rb = h.responseBuilder.speak(escapeSsml(turn.speech));
  const screen = supportsApl(h);
  if (turn.card && screen) rb.addDirective(renderDirective(cardFor(turn.card.result)));
  if (!turn.end) rb.reprompt(escapeSsml(turn.reprompt ?? turn.speech));
  // Done: end the session. On a screen, leave shouldEndSession unset instead, so the card stays up (up to 30 s,
  // microphone closed), per the response reference. Never after a safety line: Alexa itself should hear what's next.
  else if (!screen || turn.urgent) rb.withShouldEndSession(true);
  return rb.getResponse();
}

/** Runs one turn against the server; if it can't be reached, the fixed safety lines still go out. */
async function turn(h: HandlerInput, text: string, speaker: Speaker, deps: SkillDeps): Promise<Response> {
  const state = stateOf(h);
  try {
    return respond(h, await converse(deps.mcp, text, speaker, state));
  } catch (err) {
    console.error('turn failed', (err as Error).message);
    return respond(h, unreachableReply(text, state));
  }
}

const isIntent = (h: HandlerInput, ...names: string[]) => getRequestType(h.requestEnvelope) === 'IntentRequest' && names.includes(getIntentName(h.requestEnvelope));

function handlers(deps: SkillDeps): RequestHandler[] {
  const now = () => deps.now?.() ?? new Date(realNow());

  const launch: RequestHandler = {
    canHandle: (h) => getRequestType(h.requestEnvelope) === 'LaunchRequest',
    async handle(h) {
      try {
        return respond(h, await openSkill(deps.mcp, {}));
      } catch (err) {
        console.error('launch failed', (err as Error).message);
        return respond(h, { speech: "Sorry, I couldn't reach Closed Loop just now. Please try again in a minute.", end: true, state: {} });
      }
    },
  };

  /** The catch-all: whatever was said, as Alexa heard it. */
  const say: RequestHandler = {
    canHandle: (h) => isIntent(h, 'SayIntent'),
    handle(h) {
      const text = tidyTranscript(getSlotValue(h.requestEnvelope, 'utterance') ?? '');
      if (!text.trim()) return respond(h, { speech: NOT_HEARD, reprompt: NOT_HEARD, end: false, state: stateOf(h) });
      // If the catch-all took a reminder request instead of RemindMeIntent or DailyRemindersIntent.
      const reminder = reminderAsk(text);
      if (reminder) return reminder.daily ? remindDaily(h) : remindIn(h, reminder.seconds);
      return turn(h, text, speakerFor(text), deps);
    },
  };

  /** "Alexa, ask Closed Loop how Mom is doing": the family speaker, read-only. */
  const family: RequestHandler = {
    canHandle: (h) => isIntent(h, 'FamilyIntent'),
    handle(h) {
      const who = getSlotValue(h.requestEnvelope, 'name') || 'Mom';
      return turn(h, `How is ${who} doing today?`, 'family', deps);
    },
  };

  const yesNo: RequestHandler = {
    canHandle: (h) => isIntent(h, 'AMAZON.YesIntent', 'AMAZON.NoIntent'),
    handle: (h) => turn(h, getIntentName(h.requestEnvelope) === 'AMAZON.YesIntent' ? 'yes' : 'no', 'person', deps),
  };

  /** Every reminder call goes through here: a refused permission sends the consent card. */
  async function withReminders(h: HandlerInput, run: (client: services.reminderManagement.ReminderManagementServiceClient) => Promise<string>): Promise<Response> {
    const state = stateOf(h);
    try {
      const client = h.serviceClientFactory!.getReminderManagementServiceClient();
      return respond(h, { speech: await run(client), end: true, state });
    } catch (err) {
      const e = err as { statusCode?: number; response?: unknown; message?: string };
      console.error('reminders failed', e.statusCode, JSON.stringify(e.response ?? e.message));
      const { speech, askPermission } = reminderErrorSpeech(err);
      h.attributesManager.setSessionAttributes(state);
      const rb = h.responseBuilder.speak(escapeSsml(speech)).withShouldEndSession(true);
      if (askPermission) rb.withAskForPermissionsConsentCard([REMINDERS_PERMISSION]);
      return rb.getResponse();
    }
  }

  /** The household as get_family_summary reads it; null when the server can't be reached. */
  async function household() {
    try {
      return familyCheckins(await deps.mcp.callTool('get_family_summary', {}));
    } catch (err) {
      console.error('family summary failed', (err as Error).message);
      return null;
    }
  }

  /** "Remind me to check in in one minute": one reminder, SCHEDULED_RELATIVE (for filming). */
  const remindIn = (h: HandlerInput, asked: number | undefined) =>
    withReminders(h, async (client) => {
      const seconds = Math.min(MAX_OFFSET, Math.max(MIN_OFFSET, asked ?? MIN_OFFSET));
      const name = (await household())?.name ?? '';
      await client.createReminder(relativeReminder(reminderText(name, 'your check-in'), seconds, now()));
      return `Okay. In ${spokenDuration(seconds)}, I'll remind you to check in.`;
    });

  /** A daily reminder at the start of each family check-in window, in the household's time zone. */
  const remindDaily = (h: HandlerInput) =>
    withReminders(h, async (client) => {
      const home = await household();
      if (!home) return "Sorry, I couldn't reach Closed Loop just now, so no reminders were set.";
      if (!home.checkins.length) return 'I couldn\u2019t find any daily check-ins to set reminders for.';
      // Asking twice (another filming take) doesn't stack duplicates: skip reminders this skill already set with the same words.
      const existing = new Set(((await client.getReminders()).alerts ?? []).filter((a) => a.status === 'ON').map((a) => a.alertInfo?.spokenInfo?.content?.[0]?.text));
      const added: string[] = [];
      for (const c of home.checkins) {
        const text = reminderText(home.name, c.label);
        if (existing.has(text)) continue;
        try {
          await client.createReminder(dailyReminder(text, c.start, deps.timezone, now()));
        } catch (err) {
          if (!added.length) throw err;
          console.error('daily reminder failed after some were set', (err as { statusCode?: number }).statusCode);
          return `I set daily reminders at ${spokenTimes(added)}, but couldn\u2019t set the rest.`;
        }
        added.push(c.start);
      }
      if (!added.length) return `Your daily check-in reminders are already set, at ${spokenTimes(home.checkins.map((c) => c.start))}.`;
      return `Okay. I've set daily reminders at ${spokenTimes(added)}. Each one will ask you to open Closed Loop.`;
    });

  const remindSoon: RequestHandler = {
    canHandle: (h) => isIntent(h, 'RemindMeIntent'),
    handle: (h) => remindIn(h, durationSeconds(getSlotValue(h.requestEnvelope, 'duration'))),
  };

  const daily: RequestHandler = {
    canHandle: (h) => isIntent(h, 'DailyRemindersIntent'),
    handle: (h) => remindDaily(h),
  };

  const help: RequestHandler = {
    canHandle: (h) => isIntent(h, 'AMAZON.HelpIntent'),
    handle: (h) => respond(h, { speech: HELP_SPEECH, reprompt: 'What would you like to do?', end: false, state: stateOf(h) }),
  };

  const stop: RequestHandler = {
    canHandle: (h) => isIntent(h, 'AMAZON.StopIntent', 'AMAZON.CancelIntent', 'AMAZON.NavigateHomeIntent'),
    // A preview is only stored once the person says yes, so nothing was set.
    handle: (h) => h.responseBuilder.speak(stateOf(h).pending ? 'Okay. Nothing was set.' : 'Okay.').withShouldEndSession(true).getResponse(),
  };

  const fallback: RequestHandler = {
    canHandle: (h) => isIntent(h, 'AMAZON.FallbackIntent'),
    handle(h) {
      const s = stateOf(h);
      return respond(h, { speech: NOT_HEARD, reprompt: s.queue?.[0]?.prompt ?? NOT_HEARD, end: false, state: s });
    },
  };

  const ended: RequestHandler = {
    canHandle: (h) => getRequestType(h.requestEnvelope) === 'SessionEndedRequest',
    handle: (h) => h.responseBuilder.getResponse(),
  };

  /** Anything else (an APL user event, an intent this code doesn't know): end quietly. */
  const other: RequestHandler = {
    canHandle: () => true,
    handle: (h) => h.responseBuilder.withShouldEndSession(true).getResponse(),
  };

  return [launch, say, family, yesNo, remindSoon, daily, help, stop, fallback, ended, other];
}

export class SkillIdError extends Error {
  constructor() {
    super('Skill ID verification failed');
    this.name = 'SkillIdError';
  }
}

/** The skill ID a request is for: context.System.application.applicationId (or the session's, which matches it). */
export function requestSkillId(event: RequestEnvelope): string | undefined {
  return event?.context?.System?.application?.applicationId ?? event?.session?.application?.applicationId;
}

export function createSkill(deps: SkillDeps) {
  const skill = SkillBuilders.custom()
    .addRequestHandlers(...handlers(deps))
    .addErrorHandlers({
      canHandle: () => true,
      handle(h, err) {
        console.error('unhandled', err.message);
        return h.responseBuilder.speak('Sorry, something went wrong.').withShouldEndSession(true).getResponse();
      },
    })
    .withApiClient(deps.apiClient ?? new DefaultApiClient())
    .withSkillId(deps.skillId)
    .create();
  return {
    /** Checks the skill ID before anything else; ask-sdk's own check is skipped when no ID is set, this one is not. */
    async invoke(event: RequestEnvelope, context?: unknown): Promise<ResponseEnvelope> {
      if (!deps.skillId || requestSkillId(event) !== deps.skillId) throw new SkillIdError();
      return skill.invoke(event, context);
    },
  };
}
