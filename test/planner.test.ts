import { describe, expect, it } from 'vitest';
import { CRISIS_REPLY, SELF_HARM_REPLY } from '../packages/core/src';
import { parseOwnCheckin, rulesPlanner } from '../packages/api/src/planner';
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

describe('planner: check-ins the person sets up by voice', () => {
  const mine = [{ checkinId: 'me-0123456789', occurrenceId: 'OCC#2026-10-19#me-0123456789#0', phrase: 'good night' }];

  it('reads the phrase, the time, who to tell, and how often', () => {
    const p = rulesPlanner({ userText: "If I haven't said good night by ten, let Dana know." });
    expect(p.toolCall).toEqual({
      name: 'set_my_checkin',
      arguments: { phrase: 'good night', by: '22:00', tell: 'dana', repeat: 'tonight', utterance: "If I haven't said good night by ten, let Dana know." },
    });
    expect(parseOwnCheckin('Let Sam know if I don\u2019t say good morning by 9 every day')).toEqual({ phrase: 'good morning', by: '09:00', tell: 'sam', repeat: 'daily' });
    expect(parseOwnCheckin("If I haven't said good night by 10:30 pm, tell my daughter")).toMatchObject({ by: '22:30', tell: 'daughter' });
    expect(parseOwnCheckin("Tell Dana if I'm not back by four")).toMatchObject({ phrase: "I'm back", by: '16:00' });
    expect(parseOwnCheckin("If I haven't said good night by twelve, tell Dana").by).toBe('00:00');
  });

  it('the next words after a preview go back to the server with the token; the server decides', () => {
    for (const userText of ['Yes, please.', 'No', 'I guess']) {
      expect(rulesPlanner({ userText, pending: { confirmToken: 'a.b' } }).toolCall).toEqual({ name: 'set_my_checkin', arguments: { confirmToken: 'a.b', utterance: userText } });
    }
  });

  it('"cancel my good-night check" cancels by phrase; "stop the check-ins" is still a pause', () => {
    expect(rulesPlanner({ userText: 'Cancel my good-night check' }).toolCall).toEqual({ name: 'cancel_my_checkin', arguments: { phrase: 'good night' } });
    expect(rulesPlanner({ userText: 'Stop the check-ins' }).toolCall?.name).toBe('pause_checkins');
  });

  it('"good night" closes the open loop; when the loops are not known yet, it looks them up first', () => {
    expect(rulesPlanner({ userText: 'Good night', mine }).toolCall).toEqual({
      name: 'record_response',
      arguments: { occurrenceId: mine[0]!.occurrenceId, response: 'done', utterance: 'Good night' },
    });
    const lookup = rulesPlanner({ userText: 'Good night' });
    expect(lookup.toolCall?.name).toBe('get_my_status');
    expect(lookup.replan).toBe(true);
    expect(rulesPlanner({ userText: 'Good night', mine: [] })).toMatchObject({ toolCall: null, reply: 'Good night.' });
  });

  it('pausing wins over a greeting, and extra words answer the check-in in progress', () => {
    expect(rulesPlanner({ userText: 'Stop asking, good night', mine }).toolCall?.name).toBe('pause_checkins');
    expect(rulesPlanner({ userText: 'Good night! Yes, all done.', mine, current }).toolCall?.arguments.occurrenceId).toBe(current.occurrenceId);
  });

  it('a crisis said while setting one up, or while answering the preview, gets the 911 line first', () => {
    expect(rulesPlanner({ userText: "If I haven't said good night by ten, tell Dana. I fell and I can't get up." }).reply).toBe(CRISIS_REPLY);
    expect(rulesPlanner({ userText: "Yes. I don't want to live anymore.", pending: { confirmToken: 'a.b' } }).reply).toBe(SELF_HARM_REPLY);
  });
});
