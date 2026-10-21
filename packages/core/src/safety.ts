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
  /** True when a claimed `done` was downgraded. */
  downgraded: boolean;
  reason: string;
}

export const CRISIS_REPLY = 'If this is an emergency, please call 911 now.';
export const SELF_HARM_REPLY = 'If this is an emergency, please call 911 now. You can also call or text 988 to reach the Suicide and Crisis Lifeline.';

const SELF_HARM = [
  /\bkill(ing)? myself\b/,
  /\bend(ing)? (my|it) (life|all)\b/,
  /\bwant(ed)? to die\b/,
  /\bdon'?t want to (live|be here|wake up)\b/,
  /\bsuicid/,
  /\bhurt(ing)? myself\b/,
  /\bbetter off dead\b/,
];

const EMERGENCY = [
  /\bi (fell|have fallen|'ve fallen|just fell)\b/,
  /\bfallen (down|over)\b/,
  /\bcan'?t get up\b/,
  /\bcannot get up\b/,
  /\bcan'?t breathe\b/,
  /\bcannot breathe\b/,
  /\btrouble breathing\b/,
  /\bchest (pain|hurts|is tight)\b/,
  /\bhelp me\b/,
  /\bcall (911|an ambulance|for help)\b/,
  /\bambulance\b/,
  /\bbleeding\b/,
  /\bheart attack\b/,
  /\bstroke\b/,
  /\bi'?m (hurt|injured)\b/,
];

const DISTRESS = [
  /\bwhere(?: is|'s| are) every(one|body)\b/,
  /\bi want to go home\b/,
  /\bwho are you\b/,
  /\bi'?m (so )?(scared|frightened|afraid|lost|confused)\b/,
  /\bi am (so )?(scared|frightened|afraid|lost|confused)\b/,
  /\bwhere am i\b/,
  /\bi don'?t know where i am\b/,
  /\b(no ?one|nobody) is here\b/,
  /\bwhy is no ?one here\b/,
];

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
];

const HEDGE = [
  /\bi think\b/,
  /\bi believe\b/,
  /\bmaybe\b/,
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
  /\bmight\b/,
  /\bdon'?t (remember|recall|know)\b/,
  /\bcan'?t (remember|recall)\b/,
  /\bi forg[eo]t\b/,
  /\bi hope\b/,
];

const DEFERRAL = [/\blater\b/, /\bafter (lunch|dinner|breakfast)\b/, /\bthis (afternoon|evening)\b/, /\btonight\b/, /\bin an? (hour|few minutes)\b/];

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
  /\balready\b/,
];

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
 * Crisis and distress wording override any claim. A claimed `done` survives only with affirmative
 * wording and no hedge, negation, or deferral; otherwise it becomes `unsure` (never upgraded).
 */
export function applySafety(claimed: CheckinResponse, utterance?: string): SafetyResult {
  const text = utterance ? normalizeUtterance(utterance) : '';

  if (text && any(SELF_HARM, text)) {
    return { response: 'needs_help', branch: 'crisis', selfHarm: true, downgraded: claimed === 'done', reason: 'self-harm wording' };
  }
  if (text && any(EMERGENCY, text)) {
    return { response: 'needs_help', branch: 'crisis', selfHarm: false, downgraded: claimed === 'done', reason: 'emergency wording' };
  }
  if (text && any(DISTRESS, text)) {
    return { response: 'needs_help', branch: 'distress', selfHarm: false, downgraded: claimed === 'done', reason: 'distress wording' };
  }
  if (claimed === 'needs_help') {
    return { response: 'needs_help', branch: 'distress', selfHarm: false, downgraded: false, reason: 'asked for help' };
  }

  if (claimed !== 'done') {
    return { response: claimed, branch: 'none', selfHarm: false, downgraded: false, reason: 'claim kept' };
  }

  // claimed === 'done'
  if (!text) {
    // No words to check. Kept, but the ledger marks it as reported without an utterance.
    return { response: 'done', branch: 'none', selfHarm: false, downgraded: false, reason: 'no utterance provided' };
  }
  if (any(NEGATION, text)) return downgrade('negation wording');
  if (any(DEFERRAL, text)) return downgrade('deferral wording');
  if (any(HEDGE, text)) return downgrade('hedged wording');
  if (!any(AFFIRMATIVE, text)) return downgrade('no clear affirmative');
  return { response: 'done', branch: 'none', selfHarm: false, downgraded: false, reason: 'clear affirmative' };
}

function downgrade(reason: string): SafetyResult {
  return { response: 'unsure', branch: 'none', selfHarm: false, downgraded: true, reason };
}
