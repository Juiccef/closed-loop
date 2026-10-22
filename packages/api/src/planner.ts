// The planner stands in for Alexa+'s own LLM: given what the person said, pick the next MCP tool call.
// The browser executes the call against the MCP server, so the traffic stays real and visible.
// Rules planner: deterministic fallback (and the default until Bedrock is available).

import { CRISIS_REPLY, SELF_HARM_REPLY, applySafety, normalizeUtterance, type CheckinResponse, type DeferUntil } from '@closed-loop/core';

export interface PlannerRequest {
  userText: string;
  /** The check-in the person is answering, if any. */
  current?: { occurrenceId: string; label: string; prompt: string } | null;
  /** The most recent check-in in this conversation, even if no longer being asked (e.g. after distress). */
  recent?: { occurrenceId: string; label?: string } | null;
  history?: Array<{ role: 'user' | 'assistant'; text: string }>;
  /** MCP tools/list result, passed through so an LLM planner can use the real tool schemas. */
  tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  /** Who is talking: the person (default), or a family member asking from their own assistant. */
  speaker?: 'person' | 'family';
  /** A set_my_checkin preview waiting for the person's answer. */
  pending?: { confirmToken: string } | null;
  /** The person's own check-ins as the last get_my_status (or set_my_checkin) returned them; absent when not known yet. */
  mine?: Array<{ checkinId: string; occurrenceId: string; phrase: string }> | null;
}

export interface PlannerResponse {
  planner: 'rules' | 'bedrock';
  toolCall: { name: string; arguments: Record<string, unknown> } | null;
  /** What the planner would say if no tool is called. */
  reply?: string;
  rationale: string;
  model?: string;
  latencyMs?: number;
  /** The call only looks something up: run the planner once more with its result (as a model would chain tools). */
  replan?: boolean;
}

const any = (text: string, patterns: RegExp[]) => patterns.some((p) => p.test(text));

const PAUSE = [/\bpause\b/, /\bstop (asking|the check ?ins|checking)\b/, /\bleave me alone\b/, /\bno more (questions|check ?ins)\b/, /\bnot today\b.*\bquestions\b/];
const STATUS = [/\bhow am i doing\b/, /\bmy status\b/, /\bwho (can see|gets|is told|knows)\b/, /\bwhat do you (share|tell)\b/, /\bwhat('?s| is) shared\b/, /\btoday'?s summary\b/];
const FAMILY_EMERGENCY = [/\bfell\b|\bfallen\b|\bhas had a fall\b/, /\bhurt\b|\binjured\b|\bbleeding\b/, /\bcan'?t breathe\b|\bnot breathing\b/, /\bchest pain\b/, /\bunconscious\b|\bnot (responding|waking)\b/, /\bemergency\b/];
const FAMILY_ANSWER = [/^(yes|yeah|yep|done)\b/, /\b(she|he|they|mom|mum|dad) (did|has|took|already)\b/, /\bmark (it|that)\b/];
const DUE = [/\bany check ?ins\b/, /\bwhat do i (need|have) to do\b/, /\bwhat'?s (next|due)\b/, /\bcheck ?in\b.*\bnow\b/];

const DEFER_HINTS: Array<[RegExp, DeferUntil]> = [
  [/\bafter lunch\b/, 'after_lunch'],
  [/\bthis afternoon\b|\bin the afternoon\b/, 'this_afternoon'],
  [/\bthis evening\b|\btonight\b|\bafter dinner\b/, 'this_evening'],
  [/\bin (an|one) hour\b/, 'in_1_hour'],
  [/\bin (30|thirty) minutes\b|\bhalf an hour\b|\bin a (bit|little while|minute)\b/, 'in_30_min'],
];

const HELP = [/\bhelp\b/, /\bscared\b/, /\bfrightened\b/, /\bconfused\b/, /\bwhere is every/, /\bwant to go home\b/, /\bwho are you\b/, /\bfell\b/, /\bhurt\b/, /\bcan'?t breathe\b/, /\bchest\b/, /\bdie\b/, /\blive anymore\b/];
const LATER = [/\blater\b/, /\bin a (bit|while)\b/, /\bsoon\b/];
const NOT_YET = [/\bnot yet\b/, /\bhaven'?t yet\b/, /\bstill need to\b/];
const NO = [/^no\b/, /\bnope\b/, /\bdon'?t want to\b/, /\bwon'?t\b/, /\bdidn'?t\b/, /\bnot going to\b/];
const HEDGE = [/\bi think\b/, /\bmaybe\b/, /\bprobably\b/, /\bnot sure\b/, /\bi guess\b/, /\bdon'?t remember\b/, /\bkind of\b/, /\bsort of\b/];
const YES = [/^(yes|yeah|yep|yup|done|sure|of course|i did|i have|already)\b/, /\ball done\b/, /\bfinished\b/, /\bi did\b/, /\bdid it\b/];

// ---- Check-ins the person sets up by voice ----

const GREETING = /\bgood ?night\b|\bgood ?morning\b|\bnight night\b|\bi'?m (home|back)\b/;
const SET_HINT = /\bif i\b.*\bby\b|\bby\b.*\bif i\b/;
const NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const NOT_A_CONTACT = new Set(['me', 'you', 'someone', 'somebody', 'anyone', 'them', 'him', 'her', 'family', 'people', 'everyone', 'it', 'know']);
const compact = (s: string) => normalizeUtterance(s).replace(/[^a-z0-9]/g, '');

/** "by ten" -> "22:00" for an evening phrase. am/pm wins; then "night"/"morning" in the phrase; then 1-6 reads as pm. */
export function parseBy(raw: string, phrase: string): string | undefined {
  const t = raw.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\./g, '');
  const m = t.match(
    /\bby\s+(midnight|noon|\d{1,2}(?::\d{2})?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:\s+(thirty|fifteen|forty[- ]five|o'?clock))?(?:\s*(am|pm|a m|p m|in the morning|in the evening|at night|tonight))?/,
  );
  if (!m) return undefined;
  if (m[1] === 'midnight') return '00:00';
  if (m[1] === 'noon') return '12:00';
  const [h0, m0] = m[1]!.includes(':') ? m[1]!.split(':') : [m[1]!, undefined];
  let hour = NUMBERS[h0!] ?? Number(h0);
  const minute = m0 ? Number(m0) : m[2] === 'thirty' ? 30 : m[2] === 'fifteen' ? 15 : m[2]?.startsWith('forty') ? 45 : 0;
  if (!Number.isInteger(hour) || hour > 23 || minute > 59) return undefined;
  if (hour <= 12) {
    const suffix = m[3] ?? '';
    const am = /^(am|a m|in the morning)$/.test(suffix);
    const night = /^(in the evening|at night|tonight)$/.test(suffix) || (!suffix && /night|evening|bed/.test(phrase));
    const pm = /^(pm|p m)$/.test(suffix) || night || (!suffix && !/morning/.test(phrase) && hour >= 1 && hour <= 6);
    if (hour === 12) hour = am || night ? 0 : 12; // "twelve at night" is midnight, "12 pm" is noon
    else if (pm) hour += 12;
  }
  return `${String(hour % 24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** "If I haven't said good night by ten, let Dana know" -> the parts of a set_my_checkin call. */
export function parseOwnCheckin(raw: string): { phrase?: string; by?: string; tell?: string; repeat: 'tonight' | 'daily' } {
  const t = raw.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d"]/g, '');
  const said = t.match(/\b(?:haven'?t|have not|hasn'?t|didn'?t|did not|don'?t|do not|not)\s+(?:said|say|told you|tell you)\s+(.+?)\s+by\b/);
  const away = t.match(/\b(?:i'?m|i am) not (back|home)\b.*\bby\b/);
  const phrase = said ? said[1]!.replace(/[,.!?]+$/, '').trim() : away ? `I'm ${away[1]}` : undefined;
  let tell: string | undefined;
  for (const m of t.matchAll(/\b(?:let|tell|email|text|message|notify)\s+(?:my\s+)?([a-z]+)\b/g)) {
    if (!NOT_A_CONTACT.has(m[1]!)) {
      tell = m[1];
      break;
    }
  }
  const repeat = /\b(every|each) (night|day|evening|morning)\b|\bnightly\b|\bdaily\b/.test(t) ? 'daily' : 'tonight';
  const by = phrase ? parseBy(t, phrase.toLowerCase()) : undefined;
  return { phrase: phrase && /^[a-z][a-z' ,!?-]*$/i.test(phrase) && phrase.length <= 40 ? phrase : undefined, by, ...(tell ? { tell } : {}), repeat };
}

/** Setting up, cancelling, or answering the preview of a check-in of the person's own. Runs before pause and status. */
function ownCommand(req: PlannerRequest, raw: string, t: string): PlannerResponse | null {
  const mine = req.mine;
  // A new request to set one up, even while a preview is waiting.
  if (SET_HINT.test(t) && /\b(said|say|told you|not back|not home)\b/.test(t)) {
    const p = parseOwnCheckin(raw);
    if (!p.phrase || !p.by) {
      return {
        planner: 'rules',
        toolCall: null,
        reply: "I can set that up. Tell me what you'll say and by when. For example: if I haven't said good night by 10, let Dana know.",
        rationale: 'own check-in: could not read the phrase or the time',
      };
    }
    return {
      planner: 'rules',
      toolCall: { name: 'set_my_checkin', arguments: { phrase: p.phrase, by: p.by, ...(p.tell ? { tell: p.tell } : {}), repeat: p.repeat, utterance: raw } },
      rationale: 'the person is setting up a check-in of their own (step 1: preview)',
    };
  }
  // "Cancel my good night check". ("Stop the check-ins" is a pause, below.)
  const known = mine?.find((m) => compact(t).includes(compact(m.phrase)));
  const named = t.match(/\b(?:cancel|remove|delete|turn off|stop)\s+(?:my|the)\s+(?:own\s+)?(.+?)\s+(?:check ?ins?|checks?|loops?|reminders?)\b/)?.[1];
  if (/\b(?:cancel|remove|delete|turn off|stop)\s+(?:my|the)\b/.test(t) && (known || named)) {
    const hint = known?.phrase ?? named;
    return { planner: 'rules', toolCall: { name: 'cancel_my_checkin', arguments: hint ? { phrase: hint } : {} }, rationale: 'cancel one of the person’s own check-ins' };
  }
  if (req.pending?.confirmToken && !any(t, PAUSE) && !any(t, STATUS)) {
    // The server decides whether this is a clear yes; anything else leaves nothing set.
    return {
      planner: 'rules',
      toolCall: { name: 'set_my_checkin', arguments: { confirmToken: req.pending.confirmToken, utterance: raw } },
      rationale: 'answer to the set_my_checkin preview (step 2: the person’s own words decide)',
    };
  }
  return null;
}

/** Saying the phrase of one of the person's own check-ins ("good night") closes it. Runs after pause and status. */
function ownClose(req: PlannerRequest, raw: string, t: string): PlannerResponse | null {
  const mine = req.mine;
  if (mine) {
    const hit = mine.find((m) => m.occurrenceId && compact(t).includes(compact(m.phrase)));
    // With a check-in question in progress, extra words are an answer to it ("Good morning! Yes, done.").
    const rest = hit ? compact(t).replace(compact(hit.phrase), '') : '';
    if (hit && (!req.current || !rest)) {
      return {
        planner: 'rules',
        toolCall: { name: 'record_response', arguments: { occurrenceId: hit.occurrenceId, response: 'done', utterance: raw } },
        rationale: `said the phrase of their own check-in (“${hit.phrase}”)`,
      };
    }
    if (!hit && GREETING.test(t) && !req.current) {
      const hello = t.match(GREETING)![0];
      return { planner: 'rules', toolCall: null, reply: /^good/.test(hello) ? `${hello.charAt(0).toUpperCase()}${hello.slice(1)}.` : 'Okay.', rationale: 'a greeting; no check-in of their own uses it' };
    }
    return null;
  }
  if (GREETING.test(t) && !req.current) {
    return { planner: 'rules', toolCall: { name: 'get_my_status', arguments: {} }, replan: true, rationale: 'a greeting: first look up the person’s own check-ins' };
  }
  return null;
}

export function classifyReply(text: string): CheckinResponse {
  const t = normalizeUtterance(text);
  if (any(t, HELP)) return 'needs_help';
  if (any(t, NOT_YET)) return 'not_yet';
  if (any(t, NO)) return 'no';
  if (any(t, LATER)) return 'later';
  if (any(t, HEDGE)) return 'unsure';
  if (any(t, YES)) return 'done';
  return 'unsure'; // fail closed
}

/**
 * Safety first, before any rules or model: emergency or distress wording always reaches the server's safety
 * layer (which answers with the 911 line or the family's calming words and queues the family note), even when
 * no check-in is being asked. With no check-in at all, the fixed emergency line is returned directly.
 */
export function safetyPlan(req: PlannerRequest): PlannerResponse | null {
  const raw = String(req.userText ?? '').slice(0, 200);
  const s = applySafety('unsure', raw);
  if (s.branch === 'none') return null;
  const target = req.current ?? req.recent ?? null;
  if (target) {
    return {
      planner: 'rules',
      toolCall: { name: 'record_response', arguments: { occurrenceId: target.occurrenceId, response: 'needs_help', utterance: raw } },
      rationale: `${s.branch} wording: safety rule runs before any model`,
    };
  }
  if (s.branch === 'crisis') {
    return { planner: 'rules', toolCall: null, reply: s.selfHarm ? SELF_HARM_REPLY : CRISIS_REPLY, rationale: 'emergency wording with no check-in: fixed reply' };
  }
  return null;
}

/** A family member asks from their own assistant: they can hear what was recorded, never answer for the person. */
function familyPlan(raw: string): PlannerResponse {
  const t = normalizeUtterance(raw);
  if (any(t, FAMILY_ANSWER) && !raw.includes('?')) {
    return {
      planner: 'rules',
      toolCall: null,
      reply: 'Only the person can answer their own check-ins, on their own device. I can tell you what was recorded today.',
      rationale: 'family cannot answer for the person',
    };
  }
  return { planner: 'rules', toolCall: { name: 'get_family_summary', arguments: {} }, rationale: 'family asked how the day went' };
}

export function rulesPlanner(body: unknown): PlannerResponse {
  const req = (body ?? {}) as PlannerRequest;
  if (req.speaker === 'family') {
    // Family words are never recorded as the person's answer; emergency wording still gets the fixed line.
    const raw = String(req.userText ?? '').slice(0, 200);
    const crisis = safetyPlan({ ...req, current: null, recent: null });
    if (crisis) return crisis;
    if (any(normalizeUtterance(raw), FAMILY_EMERGENCY)) return { planner: 'rules', toolCall: null, reply: CRISIS_REPLY, rationale: 'emergency wording from family: fixed reply' };
    return familyPlan(raw);
  }
  const safety = safetyPlan(req);
  if (safety) return safety;
  const raw = String(req.userText ?? '').slice(0, 200);
  const t = normalizeUtterance(raw);
  const current = req.current ?? null;

  const command = ownCommand(req, raw, t);
  if (command) return command;

  if (any(t, PAUSE)) {
    const scope = /\b24 hours\b|\btomorrow\b|\ba day\b/.test(t) ? '24_hours' : 'today';
    return { planner: 'rules', toolCall: { name: 'pause_checkins', arguments: { scope } }, rationale: 'pause request' };
  }
  if (any(t, STATUS)) return { planner: 'rules', toolCall: { name: 'get_my_status', arguments: {} }, rationale: 'status question' };
  const close = ownClose(req, raw, t);
  if (close) return close;
  if (!current) {
    if (any(t, DUE) || !t) return { planner: 'rules', toolCall: { name: 'get_due_checkins', arguments: {} }, rationale: 'asked what is due' };
    return { planner: 'rules', toolCall: null, reply: "I can help with today's check-ins. You can say \"any check-ins?\" or \"how am I doing today?\"", rationale: 'no check-in in progress' };
  }

  const response = classifyReply(raw);
  if (response !== 'needs_help') {
    const hint = DEFER_HINTS.find(([p]) => p.test(t));
    if (hint && response !== 'done' && response !== 'no') {
      return { planner: 'rules', toolCall: { name: 'defer_checkin', arguments: { occurrenceId: current.occurrenceId, until: hint[1] } }, rationale: `stated a time: ${hint[1]}` };
    }
  }
  return {
    planner: 'rules',
    toolCall: { name: 'record_response', arguments: { occurrenceId: current.occurrenceId, response, ...(raw ? { utterance: raw } : {}) } },
    rationale: `classified as ${response}`,
  };
}
