import { afterEach, describe, expect, it } from 'vitest';
import { getDueCheckins, recordResponse, setRealTimeSource } from '../packages/core/src';
import { reviewDecision, reviewUtterance } from '../packages/classifier/src';
import { H, demo, setLocal } from './helpers';

const MORNING = 'OCC#2026-10-19#morning#0';
afterEach(() => setRealTimeSource(() => Date.now()));

describe('async second opinion', () => {
  it('only ever moves toward caution', () => {
    expect(reviewDecision('done', 'done')).toBe('agrees');
    expect(reviewDecision('done', 'unsure')).toBe('flagged_done');
    expect(reviewDecision('unsure', 'distress')).toBe('escalated_needs_human');
    expect(reviewDecision('done', 'crisis')).toBe('escalated_needs_human');
    expect(reviewDecision('needs_help', 'done')).toBe('agrees');
    expect(reviewDecision('unsure', 'done')).toBe('agrees'); // never upgrades
  });

  it('distress heard by the model escalates and queues the family note', async () => {
    const { store, mailer, tick } = await demo();
    setLocal('2026-10-19 08:05');
    await getDueCheckins(store, H);
    await recordResponse(store, H, { occurrenceId: MORNING, response: 'done', utterance: 'yes I did it, but the house feels strange today' });
    const [u] = await store.listUtterances(H, MORNING);
    const r = await reviewUtterance(store, u!, async () => 'distress');
    expect(r.outcome).toBe('escalated_needs_human');
    expect((await store.getOccurrence(H, MORNING))?.state).toBe('NEEDS_HUMAN');
    setLocal('2026-10-19 08:06');
    await tick();
    expect(mailer.sent.some((m) => m.kind === 'needs_human')).toBe(true);
  });

  it('a model failure changes nothing (fail-safe: the rules result stands)', async () => {
    const { store } = await demo();
    setLocal('2026-10-19 08:05');
    await getDueCheckins(store, H);
    await recordResponse(store, H, { occurrenceId: MORNING, response: 'done', utterance: 'Yes, all done.' });
    const [u] = await store.listUtterances(H, MORNING);
    const r = await reviewUtterance(store, u!, async () => {
      throw Object.assign(new Error('Too many tokens per day'), { name: 'ThrottlingException' });
    });
    expect(r).toEqual({ outcome: 'skipped', error: 'ThrottlingException' });
    expect((await store.getOccurrence(H, MORNING))?.state).toBe('REPORTED_DONE');
  });
});
