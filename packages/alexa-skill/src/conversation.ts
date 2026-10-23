// One spoken turn, the way the simulator runs it (apps/simulator/simulator.js, personSays and familyAsks):
// the rules planner picks the MCP tool call, the skill makes it on the live server, and Alexa reads the
// server's `say` text exactly as returned. The planner runs in-process (it is a pure function), so the skill
// needs no console access code and makes no extra HTTP hop to /planner.

import { rulesPlanner, type PlannerRequest, type PlannerResponse } from '@closed-loop/api/src/planner';
import { CRISIS_REPLY, SELF_HARM_REPLY, applySafety, normalizeUtterance, spoken } from '@closed-loop/core';
import { sayOf, type SkillMcpClient, type ToolResult } from './mcp';

export type Speaker = 'person' | 'family';

/** A check-in question from get_due_checkins, kept for the rest of the conversation. */
export interface QueuedCheckin {
  occurrenceId: string;
  label: string;
  prompt: string;
}

/** Alexa session attributes. Lost when the session ends; the server holds everything that matters. */
export interface ConversationState {
  /** Due check-ins still to ask, in order. The first one is the question in progress. */
  queue?: QueuedCheckin[];
  /** The most recent check-in in this conversation, even after it was answered (distress after an answer). */
  recent?: { occurrenceId: string; label?: string } | null;
  /** A set_my_checkin preview waiting for the person's answer (one turn only). */
  pending?: { confirmToken: string } | null;
  /** The person's own check-ins as get_my_status last returned them. */
  mine?: Array<{ checkinId: string; occurrenceId: string; phrase: string }>;
}

export interface TurnResult {
  /** Plain text to speak (the skill turns it into SSML). Server lines are verbatim. */
  speech: string;
  /** Set when the skill keeps listening. */
  reprompt?: string;
  end: boolean;
  /**
   * A safety line was spoken (911, 988, calming words, a family note). The session then ends outright, even on a
   * screen, so the person's next words ("Alexa, call Dana") reach Alexa itself and not this skill.
   */
  urgent?: boolean;
  /** The tool result the Echo Show card mirrors, if a tool ran. */
  card?: { tool: string; result: ToolResult };
  state: ConversationState;
}

const current = (s: ConversationState): QueuedCheckin | null => s.queue?.[0] ?? null;

const mineFrom = (list: unknown): ConversationState['mine'] =>
  (Array.isArray(list) ? list : []).map((m: { checkinId: string; occurrenceId: string; phrase: string }) => ({
    checkinId: m.checkinId,
    occurrenceId: m.occurrenceId,
    phrase: m.phrase,
  }));

/** The planner's own reply invites an answer ("You can say ...", "Tell me ..."): keep listening once. */
const INVITES = /\?\s*$|\bTell me\b|\bYou can say\b/;
export const LISTENING_REPROMPT = 'What would you like to do? You can say: any check-ins, or how am I doing today.';
const SET_REPROMPT = 'Should I set that up? You can say yes or no.';

/**
 * The server could not be reached. Emergency and self-harm wording still get the fixed lines from core
 * (the same constants the server speaks); nothing here claims anything was recorded or that anyone was told.
 */
export function unreachableReply(text: string, state: ConversationState = {}): TurnResult {
  const s = applySafety('unsure', text);
  const done = (speech: string, urgent: boolean): TurnResult => ({ speech, end: true, urgent, state });
  if (s.branch === 'crisis') return done(s.selfHarm ? SELF_HARM_REPLY : CRISIS_REPLY, true);
  if (s.helpRequest) return done(`${CRISIS_REPLY} I couldn't reach Closed Loop just now.`, true);
  if (s.branch === 'distress') return done(`${spoken.calmNoContact} I couldn't reach Closed Loop just now.`, true);
  return done("Sorry, I couldn't reach Closed Loop just now, so I can't tell whether that was noted. Please try again in a minute.", false);
}

/**
 * Who is talking on this one device. A family member asks about the person by name or by what the family calls
 * them ("How is Mom doing today?"). Safety wording always stays with the person, never lost as a family question.
 */
export function speakerFor(text: string): Speaker {
  const t = normalizeUtterance(text);
  if (applySafety('unsure', text).branch !== 'none') return 'person';
  return /^(and |so )?(how|is|did|has)\b/.test(t) && /\b(mom|mum|mommy|mama|margaret|grandma|granny|nana)\b/.test(t) ? 'family' : 'person';
}

/**
 * Two transcription artifacts the planner would misread, put back before planning (the server still decides
 * everything, and the preview reads the time back before anything is set):
 * - "Alexa, ask Closed Loop if I haven't said ..." can reach the skill without its "if", which the planner needs
 *   to see a set-up request (Alexa treats "if" after the invocation name as a connecting word; unverified).
 * - Times as digits with a space or none: "by 9 30" or "by 930" for "by nine thirty".
 */
export function tidyTranscript(text: string): string {
  let t = text.trim();
  if (/^i(?:'m not| am not| haven'?t| have not| didn'?t| did not)\b.*\bby\b.*\b(?:let|tell|email|text)\b/i.test(t.replace(/\u2019/g, "'"))) t = `If ${t}`;
  return t.replace(/\bby (\d{1,2})(?: |)([0-5]\d)\b/gi, (_, h: string, m: string) => `by ${h}:${m}`);
}

function planFor(text: string, state: ConversationState, speaker: Speaker): PlannerResponse {
  if (speaker === 'family') return rulesPlanner({ userText: text, speaker: 'family', current: null, recent: null } satisfies PlannerRequest);
  const now = current(state);
  return rulesPlanner({
    userText: text,
    current: now && { occurrenceId: now.occurrenceId, label: now.label, prompt: now.prompt },
    recent: state.recent ?? null,
    pending: state.pending ?? null,
    ...(state.mine ? { mine: state.mine } : {}),
  } satisfies PlannerRequest);
}

/** "Alexa, open Closed Loop": what is due right now, like a household routine starting the add-on. */
export async function openSkill(mcp: SkillMcpClient, state: ConversationState): Promise<TurnResult> {
  return dueTurn(await mcp.callTool('get_due_checkins', {}), state);
}

/** "There are no check-ins right now." stays the server's line; the skill adds its own invitation after it. */
function dueTurn(r: ToolResult, state: ConversationState): TurnResult {
  if (r.isError) return { speech: sayOf(r) || 'Sorry, something went wrong.', end: true, state };
  const checkins = (r.structuredContent?.checkins as QueuedCheckin[] | undefined) ?? [];
  const next: ConversationState = { ...state, queue: checkins.map(({ occurrenceId, label, prompt }) => ({ occurrenceId, label, prompt })), pending: null };
  const first = current(next);
  if (first) next.recent = { occurrenceId: first.occurrenceId, label: first.label };
  const card = { tool: 'get_due_checkins', result: r };
  if (first) return { speech: sayOf(r), reprompt: first.prompt, end: false, card, state: next };
  return { speech: `${sayOf(r)} What would you like to do?`, reprompt: LISTENING_REPROMPT, end: false, card, state: next };
}

export async function converse(mcp: SkillMcpClient, rawText: string, speaker: Speaker, state: ConversationState): Promise<TurnResult> {
  const text = rawText.trim().slice(0, 200);
  let next: ConversationState = { ...state };

  if (speaker === 'family') {
    // A family member asking from this device: never recorded as the person's answer (simulator: familyAsks).
    const plan = planFor(text, next, 'family');
    if (!plan.toolCall) return { speech: plan.reply ?? '', end: true, urgent: plan.reply === CRISIS_REPLY || plan.reply === SELF_HARM_REPLY, state: next };
    const r = await mcp.callTool(plan.toolCall.name, plan.toolCall.arguments);
    return { speech: sayOf(r) || 'Sorry, something went wrong.', end: true, ...(r.isError ? {} : { card: { tool: plan.toolCall.name, result: r } }), state: next };
  }

  const urgent = applySafety('unsure', text).branch !== 'none';
  let plan = planFor(text, next, 'person');
  if (plan.replan && plan.toolCall) {
    // A lookup first (as a model would chain tools): learn the person's own check-ins, then plan again.
    const look = await mcp.callTool(plan.toolCall.name, plan.toolCall.arguments);
    if (look.isError) return { speech: sayOf(look) || 'Sorry, something went wrong.', end: true, state: next };
    next.mine = mineFrom(look.structuredContent?.mine);
    plan = planFor(text, next, 'person');
  }
  next.pending = null; // a preview waits for one answer only

  if (!plan.toolCall) {
    const reply = plan.reply ?? '';
    const ask = current(next);
    if (urgent) return { speech: reply, end: true, urgent, state: next };
    if (ask) return { speech: reply, reprompt: ask.prompt, end: false, state: next };
    if (INVITES.test(reply)) return { speech: reply, reprompt: LISTENING_REPROMPT, end: false, state: next };
    return { speech: reply, end: true, state: next };
  }

  const { name, arguments: args } = plan.toolCall;
  const r = await mcp.callTool(name, args);
  if (r.isError) {
    const ask = current(next);
    if (ask && !urgent) return { speech: sayOf(r), reprompt: ask.prompt, end: false, state: next };
    return { speech: sayOf(r) || 'Sorry, something went wrong.', end: true, urgent, state: next };
  }
  const sc = r.structuredContent ?? {};
  const say = sayOf(r);
  const card = { tool: name, result: r };
  const alarm = urgent || sc.recordedAs === 'needs_human_contact' || sc.nextStep === 'call_emergency_services';

  if (name === 'get_due_checkins') return dueTurn(r, next);

  if (name === 'set_my_checkin') {
    if (sc.status === 'confirm_needed' && typeof sc.confirmToken === 'string') {
      next.pending = { confirmToken: sc.confirmToken };
      return { speech: say, reprompt: SET_REPROMPT, end: false, card, state: next };
    }
    if (sc.status === 'set' && next.mine && sc.checkin) {
      const c = sc.checkin as { phrase: string };
      next.mine = [...next.mine.filter((m) => m.phrase !== c.phrase), ...(mineFrom([sc.checkin]) ?? [])];
    }
    return { speech: say, end: true, urgent: alarm, card, state: { ...next, queue: alarm ? [] : next.queue } };
  }
  if (name === 'cancel_my_checkin') return { speech: say, end: true, card, state: { ...next, mine: undefined } };
  if (name === 'get_my_status') return { speech: say, end: true, card, state: { ...next, mine: mineFrom(sc.mine) } };
  if (name === 'pause_checkins') return { speech: say, end: true, card, state: { ...next, queue: [] } };

  if (name === 'record_response' || name === 'defer_checkin') {
    // Distress or crisis: the server's line, unchanged, and no further questions in this conversation.
    if (alarm) return { speech: say, end: true, urgent: true, card, state: { ...next, queue: [] } };
    // Closing one of the person's own check-ins ("good night") leaves the question in progress, if any, alone.
    const answered = String(args.occurrenceId ?? '');
    if (name === 'record_response' && !next.queue?.some((c) => c.occurrenceId === answered)) return { speech: say, end: true, card, state: next };
    next = { ...next, queue: (next.queue ?? []).filter((c) => c.occurrenceId !== answered) };
    const ask = current(next);
    if (ask) {
      next.recent = { occurrenceId: ask.occurrenceId, label: ask.label };
      return { speech: `${say} ${ask.prompt}`, reprompt: ask.prompt, end: false, card, state: next };
    }
    return { speech: say, end: true, card, state: next };
  }

  return { speech: say, end: true, urgent: alarm, card, state: next };
}
