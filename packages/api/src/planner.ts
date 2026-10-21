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
}

export interface PlannerResponse {
  planner: 'rules' | 'bedrock';
  toolCall: { name: string; arguments: Record<string, unknown> } | null;
  /** What the planner would say if no tool is called. */
  reply?: string;
  rationale: string;
  model?: string;
  latencyMs?: number;
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

  if (any(t, PAUSE)) {
    const scope = /\b24 hours\b|\btomorrow\b|\ba day\b/.test(t) ? '24_hours' : 'today';
    return { planner: 'rules', toolCall: { name: 'pause_checkins', arguments: { scope } }, rationale: 'pause request' };
  }
  if (any(t, STATUS)) return { planner: 'rules', toolCall: { name: 'get_my_status', arguments: {} }, rationale: 'status question' };
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
