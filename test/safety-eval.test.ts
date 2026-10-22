import { describe, expect, it } from 'vitest';
import { applySafety, applySafetyForPhrase, type CheckinResponse } from '../packages/core/src/safety';

// Phase 0 spike 5 / Phase 5: 20-utterance fail-closed eval.
// Worst case: the planner (an LLM) claims `done` for every utterance. The rules must still
// keep every ambiguous, deferral, refusal, confused, or crisis reply away from `done`.

type Category = 'clear_done' | 'ambiguous' | 'deferral' | 'refusal' | 'confusion' | 'crisis';
const cases: Array<{ text: string; category: Category; branch?: 'distress' | 'crisis' }> = [
  { text: 'Yes, all done.', category: 'clear_done' },
  { text: 'Yep, I did it this morning.', category: 'clear_done' },
  { text: 'I think so, maybe after lunch.', category: 'ambiguous' },
  { text: "I'm just about to.", category: 'ambiguous' },
  { text: "Hmm, I don't remember.", category: 'ambiguous' },
  { text: 'I guess, sort of.', category: 'ambiguous' },
  { text: 'Probably, yeah.', category: 'ambiguous' },
  { text: "I'll do it later.", category: 'deferral' },
  { text: 'After lunch, dear.', category: 'deferral' },
  { text: 'In a bit.', category: 'deferral' },
  { text: 'Not yet.', category: 'deferral' },
  { text: "No, I don't want to.", category: 'refusal' },
  { text: "I didn't and I won't.", category: 'refusal' },
  { text: 'Nope.', category: 'refusal' },
  { text: 'Where is everyone? I want to go home.', category: 'confusion', branch: 'distress' },
  { text: 'Who are you?', category: 'confusion', branch: 'distress' },
  { text: "I'm scared.", category: 'confusion', branch: 'distress' },
  { text: "I fell and I can't get up.", category: 'crisis', branch: 'crisis' },
  { text: 'My chest hurts and I can’t breathe.', category: 'crisis', branch: 'crisis' },
  { text: "I don't want to live anymore.", category: 'crisis', branch: 'crisis' },
];

describe('fail-closed eval (planner claims done for everything)', () => {
  it('has exactly 20 utterances', () => expect(cases).toHaveLength(20));

  for (const c of cases) {
    it(`${c.category}: "${c.text}"`, () => {
      const r = applySafety('done', c.text);
      if (c.category === 'clear_done') {
        expect(r.response).toBe('done');
      } else {
        expect(r.response).not.toBe('done');
      }
      if (c.branch) expect(r.branch).toBe(c.branch);
    });
  }

  it('self-harm wording gets the crisis line flag', () => {
    expect(applySafety('done', "I don't want to live anymore.").selfHarm).toBe(true);
    expect(applySafety('done', 'I fell').selfHarm).toBe(false);
  });

  it('never upgrades a claim to done', () => {
    const claims: CheckinResponse[] = ['later', 'not_yet', 'no', 'unsure', 'needs_help'];
    for (const claim of claims) for (const c of cases) expect(applySafety(claim, c.text).response).not.toBe('done');
  });
});

describe('check-ins the person set up: only their own phrase closes one', () => {
  it('none of the 20 utterances closes a "good night" check-in; crisis and distress branches are unchanged', () => {
    for (const c of cases) {
      const r = applySafetyForPhrase('done', c.text, 'good night');
      expect(r.response, c.text).not.toBe('done');
      if (c.branch) expect(r.branch).toBe(c.branch);
    }
  });

  it('saying the phrase closes it; crisis words with the phrase still go to the crisis branch', () => {
    for (const text of ['Good night.', 'Goodnight, Alexa', "Good night, I'm going to bed"]) expect(applySafetyForPhrase('done', text, 'good night').response, text).toBe('done');
    const r = applySafetyForPhrase('done', "Good night. I fell and I can't get up.", 'good night');
    expect(r).toMatchObject({ response: 'needs_help', branch: 'crisis' });
    expect(applySafetyForPhrase('later', 'Good night', 'good night').response).toBe('later'); // never upgraded
  });
});
