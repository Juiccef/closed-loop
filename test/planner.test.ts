import { describe, expect, it } from 'vitest';
import { CRISIS_REPLY, SELF_HARM_REPLY } from '../packages/core/src';
import { rulesPlanner } from '../packages/api/src/planner';
import { bedrockOrRulesPlanner } from '../packages/api/src/planner-bedrock';

const current = { occurrenceId: 'OCC#2026-10-19#morning#0', label: 'your morning routine', prompt: 'Have you done it?' };

describe('planner: safety runs first', () => {
  it('emergency words during a check-in go to record_response as needs_help', () => {
    const p = rulesPlanner({ userText: "I fell and I can't get up", current });
    expect(p.toolCall).toEqual({ name: 'record_response', arguments: { occurrenceId: current.occurrenceId, response: 'needs_help', utterance: "I fell and I can't get up" } });
  });

  it('emergency words right after distress (no check-in being asked) still reach the server', () => {
    const p = rulesPlanner({ userText: "I fell and I can't get up", current: null, recent: { occurrenceId: current.occurrenceId } });
    expect(p.toolCall?.name).toBe('record_response');
    expect(p.toolCall?.arguments.response).toBe('needs_help');
  });

  it('emergency words with no check-in at all get the fixed 911 line', () => {
    expect(rulesPlanner({ userText: 'My chest hurts', current: null }).reply).toBe(CRISIS_REPLY);
    expect(rulesPlanner({ userText: "I don't want to live anymore" }).reply).toBe(SELF_HARM_REPLY);
  });

  it('the Bedrock path applies the same rule before calling any model', async () => {
    const before = process.env.BEDROCK_MODEL_ID;
    process.env.BEDROCK_MODEL_ID = 'model-that-must-not-be-called';
    try {
      const p = await bedrockOrRulesPlanner({ userText: 'help me, I fell', current: null, tools: [{ name: 'record_response' }] });
      expect(p.planner).toBe('rules');
      expect(p.reply).toBe(CRISIS_REPLY);
    } finally {
      if (before === undefined) delete process.env.BEDROCK_MODEL_ID;
      else process.env.BEDROCK_MODEL_ID = before;
    }
  });

  it('ordinary replies are unchanged', () => {
    expect(rulesPlanner({ userText: 'I think so, maybe after lunch', current }).toolCall).toEqual({
      name: 'defer_checkin',
      arguments: { occurrenceId: current.occurrenceId, until: 'after_lunch' },
    });
    expect(rulesPlanner({ userText: 'Yes, done.', current }).toolCall?.arguments.response).toBe('done');
  });
});

describe('planner: a family member speaking from their own assistant', () => {
  it('asking how the day went reads the summary', () => {
    expect(rulesPlanner({ userText: 'How is Mom doing today?', speaker: 'family' }).toolCall).toEqual({ name: 'get_family_summary', arguments: {} });
  });

  it('family words are never recorded as the person’s answer, even with a check-in in progress', async () => {
    for (const userText of ['Yes, she did it.', 'Done.', 'She took care of it']) {
      const p = rulesPlanner({ userText, speaker: 'family', current, recent: current });
      expect(p.toolCall, userText).toBeNull();
      expect(p.reply).toContain('Only the person can answer');
    }
    const b = await bedrockOrRulesPlanner({ userText: 'Yes, done', speaker: 'family', current, tools: [{ name: 'record_response' }] });
    expect(b.toolCall).toBeNull();
  });

  it('emergency wording from family gets the fixed line, not a needs-help record for the person', () => {
    const p = rulesPlanner({ userText: 'Mom fell and she is hurt', speaker: 'family', current, recent: current });
    expect(p.toolCall).toBeNull();
    expect(p.reply).toBe(CRISIS_REPLY);
  });
});
