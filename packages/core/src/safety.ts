// Rule-based safety layer. Runs on the MCP hot path: pure, synchronous, no network.
// Principle: the model's choice of response is a claim, not ground truth. Fail closed.

export const RESPONSES = ['done', 'later', 'not_yet', 'no', 'unsure', 'needs_help'] as const;
export type CheckinResponse = (typeof RESPONSES)[number];

export type SafetyBranch = 'none' | 'distress' | 'crisis';

export interface SafetyResult {
  /** The response that will be stored. Never more positive than what was claimed. */
  response: CheckinResponse;
  branch: SafetyBranch;
  /** True when the crisis wording looked like self-harm, so the reply includes a crisis line. */
  selfHarm: boolean;
  /** True for a bare request for help ("Help!", "I need help"): the distress branch, with the 911 line added to the reply. */
  helpRequest?: boolean;
  /** True when a claimed `done` was downgraded. */
  downgraded: boolean;
  reason: string;
}

export const CRISIS_REPLY = 'If this is an emergency, please call 911 now.';
export const SELF_HARM_REPLY = 'If this is an emergency, please call 911 now. You can also call or text 988 to reach the Suicide and Crisis Lifeline.';

const SELF_HARM = [
  /\bkill(ing)? my ?self\b/,
  /\bend(ing)? (my|it) (life|all)\b/,
  /\b(thinking (of|about)|want to|going to) end(ing)? it\b/,
  /\bwant(ed)? to die\b/,
  /\bwish i (was|were) dead\b/,
  /\bdon'?t want to (live|be here|wake up)\b/,
  /\bsleep and (not|never) wake up\b/,
  /\bsuicid/,
  /\bhurt(ing)? my ?self\b/,
  /\bbetter off (dead|without me)\b/,
  /\bno point (in )?(going on|living|carrying on)\b/,
];

// The 911 line is for explicit emergencies only. A bare "help" is handled below as a request for a person.
const FALLS = [/\bi (just )?fell\b/, /\bi( have|'?ve)( just)? fallen\b/, /\bfallen (down|over)\b/, /\bi('?ve| have)? had an? (bit of a |bad |little |nasty )?fall\b/];

const EMERGENCY = [
  /\b(i'?m|i am) on the floor\b/,
  /\bcan'?t get up\b/,
  /\bcannot get up\b/,
  /\bcan'?t move( my (arms?|legs?|hands?|feet|foot|body|side|face))?( at all)?$/,
  /\bcan'?t move my (arms?|legs?|hands?|feet|foot|body|side|face)\b/,
  /\b(can'?t|cannot) breathe?\b/,
  /\btrouble breathing\b/,
  /\bcan'?t catch my breath\b/,
  /\bchest (pain|hurts|is tight|feels tight)\b/,
  /\bcall (911|an ambulance|for help)\b/,
  /\bnine one one\b/,
  /\bambulance\b/,
  /\bbleeding\b/,
  /\bheart attack\b/,
  /\bstroke\b/,
  /\b(i'?m|i am) (hurt|injured)\b/,
];

/** "I'm not hurt", "I didn't fall": negated words raise no alarm. */
const NEGATED = /\b(not|never|didn'?t|did not|haven'?t|have not|wasn'?t|was not)( been)? (hurt|injured|bleeding|fallen|fall|fell|scared|frightened|afraid|lost|confused)\b/g;
/** A fall long ago ("I fell last year") is not an emergency now, unless something says it is recent. */
const LONG_AGO = /\b(last (year|month)|(years|months) ago|a long time ago|when i was (young|younger|little|a child))\b/;
const RECENT = /\b(today|this (morning|afternoon|evening)|tonight|last night|yesterday|just|again)\b/;

const DISTRESS = [
  /\bwhere(?: is|'s| are) every(one|body)\b/,
  /\bi want to go home\b/,
  /\bwho are you\b/,
  /\b(i'?m|i am|i feel)( so| really| very| all| a bit| a little| quite)? (scared|frightened|afraid|lost|confused)\b(?! for words)/,
  /\bwhere am i\b/,
  /\bi don'?t know where i am\b/,
  /\b(no ?one|nobody) is here\b/,
  /\bwhy is no ?one here\b/,
  /\bwhere (are|is) my (children|kids|husband|wife|mother|mom|mum|father|dad|family)\b/,
  /\b(this|it) (isn'?t|is not) my (house|home|room)\b/,
];

/** "Help" that is not a plea: thanks for help, no need for help, help with something. */
const NOT_A_PLEA = /\b(don'?t|do not|doesn'?t|won'?t) need (any |some )?help\b|\b(the|your|for|of|no) help\b/g;
/** After "help" or "help me", these keep it a bare plea ("Help!", "help me please", "help me, I'm scared"). */
const PLEA_NEXT = new Set(['please', 'now', 'quick', 'quickly', 'someone', 'somebody', 'anyone', 'anybody', 'help', 'up', 'i', "i'm", 'im', "i've", 'ive', 'my', "it's"]);

function bareHelpRequest(text: string): boolean {
  const words = text.replace(NOT_A_PLEA, ' ').split(' ').filter(Boolean);
  return words.some((w, i) => {
    if (w !== 'help') return false;
    const next = words[i + 1] === 'me' ? words[i + 2] : words[i + 1];
    return next === undefined || PLEA_NEXT.has(next);
  });
}

const NEGATION = [
  /\bnot yet\b/,
  /\bhaven'?t\b/,
  /\bhave not\b/,
  /\bdidn'?t\b/,
  /\bdid not\b/,
  /^no\b/,
  /\bnope\b/,
  /\bnot really\b/,
  /\bwon'?t\b/,
  /\bnever\b/,
  /\bnot (done|finished|had)\b/,
  /\bi'?ve not\b/,
];

const HEDGE = [
  /\bi think\b/,
  /\bi believe\b/,
  /\bmaybe\b/,
  /\bmay be\b/,
  /\bprobably\b/,
  /\bnot sure\b/,
  /\bi guess\b/,
  /\bi suppose\b/,
  /\babout to\b/,
  /\bgoing to\b/,
  /\bgonna\b/,
  /\bin a (minute|second|bit|while)\b/,
  /\bsoon\b/,
  /\bkind of\b/,
  /\bsort of\b/,
  /\bmore or less\b/,
  /\bpretty much\b/,
  /\balmost\b/,
  /\bnearly\b/,
  /\bmostly\b/,
  /\bhalf (done|finished|way)\b/,
  /\bpart(ly|ially)\b/,
  /\b(i'?m|i am) (doing|in the middle of) (it|that|them)\b/,
  /\bmight\b/,
  /\bdon'?t (remember|recall|know)\b/,
  /\bcan'?t (remember|recall)\b/,
  /\bi forg[eo]t\b/,
  /\bi hope\b/,
];

const DEFERRAL = [/\blater\b/, /\bafter (lunch|dinner|breakfast)\b/, /\bthis (afternoon|evening)\b/, /\btonight\b/, /\bin an? (hour|few minutes)\b/];
/** "When I've had lunch", "once I get up": not yet, whatever the tense. */
const CONDITIONAL = /\b(when|once|as soon as) i('?ve| have| get| finish| am|'?m)\b/;
/** Past tense and nothing about the future: "I did it after breakfast" says when it happened. */
const PAST_DONE = /\b(i did|did it|i'?ve done|done it|i (finished|had)|finished it|had it)\b/;
const WILL = /\b(i'?ll|will|going to|gonna|later)\b/;

const AFFIRMATIVE = [
  /\byes\b/,
  /\byeah\b/,
  /\byep\b/,
  /\byup\b/,
  /\bdone\b/,
  /\bi did\b/,
  /\bdid it\b/,
  /\bi have\b/,
  /\bi'?ve (done|finished|had)\b/,
  /\bfinished\b/,
  /\ball set\b/,
  /\btook care\b/,
  /\bsure did\b/,
  /\bof course\b/,
  /^already\b/,
  /\balready (done|did|have|finished)\b/,
  /\b(it|that) already\b/,
];

/** "I've finished my crossword", "done with these questions": done with something else is not an answer. */
const OTHER_OBJECT = /\b(i'?ve )?(done|finished|had) (with|my|a|an|the|some)\b/g;

export function normalizeUtterance(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const any = (patterns: RegExp[], text: string) => patterns.some((p) => p.test(text));

/**
 * Applies the safety rules to a claimed response and the person's own words.
 * Crisis, help, and distress wording override any claim. A claimed `done` survives only with affirmative
 * wording and no hedge, negation, or deferral; otherwise it becomes `unsure` (never upgraded).
 */
export function applySafety(claimed: CheckinResponse, utterance?: string): SafetyResult {
  const text = utterance ? normalizeUtterance(utterance) : '';
  const alarm = text.replace(NEGATED, ' ');
  const needsHelp = (branch: SafetyBranch, reason: string, extra: Partial<SafetyResult> = {}): SafetyResult => ({
    response: 'needs_help',
    branch,
    selfHarm: false,
    downgraded: claimed === 'done',
    reason,
    ...extra,
  });

  if (text && any(SELF_HARM, text)) return needsHelp('crisis', 'self-harm wording', { selfHarm: true });
  if (alarm && (any(EMERGENCY, alarm) || (any(FALLS, alarm) && !(LONG_AGO.test(alarm) && !RECENT.test(alarm))))) {
    return needsHelp('crisis', 'emergency wording');
  }
  if (alarm && bareHelpRequest(alarm)) return needsHelp('distress', 'asked for help', { helpRequest: true });
  if (alarm && any(DISTRESS, alarm)) return needsHelp('distress', 'distress wording');
  if (claimed === 'needs_help') {
    return { response: 'needs_help', branch: 'distress', selfHarm: false, downgraded: false, reason: 'asked for help' };
  }

  if (claimed !== 'done') {
    return { response: claimed, branch: 'none', selfHarm: false, downgraded: false, reason: 'claim kept' };
  }

  // claimed === 'done'
  if (!text) {
    // No words to check: kept as done. The rules can only judge words they are given.
    return { response: 'done', branch: 'none', selfHarm: false, downgraded: false, reason: 'no utterance provided' };
  }
  if (any(NEGATION, text)) return downgrade('negation wording');
  if (CONDITIONAL.test(text)) return downgrade('deferral wording');
  if (any(DEFERRAL, text) && !(PAST_DONE.test(text) && !WILL.test(text))) return downgrade('deferral wording');
  if (any(HEDGE, text)) return downgrade('hedged wording');
  if (!any(AFFIRMATIVE, text.replace(OTHER_OBJECT, ' '))) return downgrade('no clear affirmative');
  return { response: 'done', branch: 'none', selfHarm: false, downgraded: false, reason: 'clear affirmative' };
}

function downgrade(reason: string): SafetyResult {
  return { response: 'unsure', branch: 'none', selfHarm: false, downgraded: true, reason };
}

const FUTURE = [/\bi'?ll (say|tell)\b/, /\bwill (say|tell)\b/, /\bgoing to say\b/];

/**
 * For a check-in the person set up themselves, saying their own phrase ("good night") is the report.
 * Crisis and distress wording still win. No words, a different phrase, or a negated or postponed one
 * ("I haven't said good night", "I'll say good night later") fails closed to `unsure`.
 */
export function applySafetyForPhrase(claimed: CheckinResponse, utterance: string | undefined, phrase: string): SafetyResult {
  const base = applySafety(claimed, utterance);
  if (base.branch !== 'none' || claimed !== 'done') return base;
  const text = utterance ? normalizeUtterance(utterance) : '';
  const compact = (s: string) => s.replace(/[^a-z0-9]/g, '');
  if (!text || !compact(text).includes(compact(normalizeUtterance(phrase)))) return downgrade('own phrase not said');
  if (any(NEGATION, text)) return downgrade('negation wording');
  if (any(DEFERRAL, text) || any(FUTURE, text)) return downgrade('deferral wording');
  return { response: 'done', branch: 'none', selfHarm: false, downgraded: false, reason: 'own phrase said' };
}
