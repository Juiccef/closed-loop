import { afterEach, describe, expect, it } from 'vitest';
import {
  MemoryStore,
  addDays,
  advanceClock,
  datesBetween,
  inLocalRange,
  localDate,
  localTime,
  now,
  resetClock,
  setRealTimeSource,
  spokenTime,
  zonedInstant,
} from '../packages/core/src';

const NY = 'America/New_York';

describe('simulated clock', () => {
  afterEach(() => setRealTimeSource(() => Date.now()));

  it('adds the stored offset to real time', async () => {
    const store = new MemoryStore();
    setRealTimeSource(() => Date.parse('2026-10-19T12:00:00Z'));
    expect((await now(store)).toISOString()).toBe('2026-10-19T12:00:00.000Z');
    await advanceClock(store, 5 * 3600);
    expect((await now(store)).toISOString()).toBe('2026-10-19T17:00:00.000Z');
    await advanceClock(store, 86_400);
    expect((await now(store)).toISOString()).toBe('2026-10-20T17:00:00.000Z');
    await resetClock(store);
    expect((await now(store)).toISOString()).toBe('2026-10-19T12:00:00.000Z');
  });
});

describe('time zone helpers', () => {
  it('converts local wall time to an instant (EDT, UTC-4)', () => {
    expect(zonedInstant('2026-10-19', '08:00', NY).toISOString()).toBe('2026-10-19T12:00:00.000Z');
  });

  it('converts local wall time to an instant (EST, UTC-5)', () => {
    expect(zonedInstant('2026-12-01', '08:00', NY).toISOString()).toBe('2026-12-01T13:00:00.000Z');
  });

  it('handles the spring-forward gap (02:30 does not exist on 2026-03-08)', () => {
    const t = zonedInstant('2026-03-08', '02:30', NY);
    expect(localDate(t, NY)).toBe('2026-03-08');
    expect(['01:30', '03:30']).toContain(localTime(t, NY));
  });

  it('picks the first 01:30 on fall-back day (2026-11-01)', () => {
    expect(zonedInstant('2026-11-01', '01:30', NY).toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('reads local date and time back', () => {
    const t = new Date('2026-10-20T03:30:00Z'); // 23:30 the previous evening in New York
    expect(localDate(t, NY)).toBe('2026-10-19');
    expect(localTime(t, NY)).toBe('23:30');
  });

  it('round-trips every half hour across a DST change', () => {
    for (const date of ['2026-03-07', '2026-03-09', '2026-10-31', '2026-11-02']) {
      for (let m = 0; m < 24 * 60; m += 30) {
        const hhmm = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        const t = zonedInstant(date, hhmm, NY);
        expect(localDate(t, NY)).toBe(date);
        expect(localTime(t, NY)).toBe(hhmm);
      }
    }
  });

  it('does date arithmetic across month ends', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(datesBetween('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  });

  it('checks local ranges, including ones that cross midnight', () => {
    expect(inLocalRange('08:00', '08:00', '11:00')).toBe(true);
    expect(inLocalRange('11:00', '08:00', '11:00')).toBe(false);
    expect(inLocalRange('22:00', '21:00', '07:00')).toBe(true);
    expect(inLocalRange('06:59', '21:00', '07:00')).toBe(true);
    expect(inLocalRange('12:00', '21:00', '07:00')).toBe(false);
  });

  it('speaks times plainly', () => {
    expect(spokenTime(zonedInstant('2026-10-19', '13:00', NY), NY)).toBe('1 pm');
    expect(spokenTime(zonedInstant('2026-10-19', '12:00', NY), NY)).toBe('noon');
    expect(spokenTime(zonedInstant('2026-10-19', '08:30', NY), NY)).toBe('8:30 am');
  });
});
