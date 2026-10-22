// The one clock. Every component asks `now()` for the time: real time plus a simulated offset (demo only),
// so the MCP server, tick, and console agree. The offset is stored once for the deployment; a per-visitor
// demo household keeps its own offset instead, so one visitor moving time never moves anyone else's.

export interface ClockStore {
  /** The household's own offset when it has one, otherwise the deployment-wide offset. */
  getClockOffsetSeconds(householdId?: string): Promise<number>;
  /** With a household: that household's own offset. Without: the deployment-wide offset. */
  setClockOffsetSeconds(seconds: number, householdId?: string): Promise<void>;
}

let realTime: () => number = () => Date.now();

/** Tests replace the real-time source; production never calls this. */
export function setRealTimeSource(fn: () => number): void {
  realTime = fn;
}

/** Real time in milliseconds (no simulated offset), from the same source the clock uses. */
export function realNow(): number {
  return realTime();
}

/** The simulated time for a given offset. */
export function clockAt(offsetSeconds: number): Date {
  return new Date(realTime() + offsetSeconds * 1000);
}

export async function now(store: ClockStore, householdId?: string): Promise<Date> {
  return clockAt(await store.getClockOffsetSeconds(householdId));
}

export async function advanceClock(store: ClockStore, seconds: number, householdId?: string): Promise<number> {
  const next = (await store.getClockOffsetSeconds(householdId)) + seconds;
  await store.setClockOffsetSeconds(next, householdId);
  return next;
}

export async function resetClock(store: ClockStore, householdId?: string): Promise<void> {
  await store.setClockOffsetSeconds(0, householdId);
}

// ---- Time zone helpers (Intl only, no dependencies) ----

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallTime(instant: Date, tz: string): WallTime {
  const parts: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(instant)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
}

/** Offset of `tz` from UTC at `instant`, in milliseconds (e.g. -4h for New York in October). */
function tzOffsetMs(instant: Date, tz: string): number {
  const w = wallTime(instant, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar date, YYYY-MM-DD. */
export function localDate(instant: Date, tz: string): string {
  const w = wallTime(instant, tz);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/** Local time of day, HH:MM. */
export function localTime(instant: Date, tz: string): string {
  const w = wallTime(instant, tz);
  return `${pad(w.hour)}:${pad(w.minute)}`;
}

export function localDateTime(instant: Date, tz: string): string {
  return `${localDate(instant, tz)} ${localTime(instant, tz)}`;
}

export function parseHHMM(hhmm: string): { hour: number; minute: number } {
  const m = hhmm.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!m) throw new Error(`invalid time "${hhmm}", expected HH:MM`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

export function isValidHHMM(hhmm: string): boolean {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(hhmm);
}

/**
 * The instant at which the wall clock in `tz` reads `date` `hhmm`.
 * In a spring-forward gap the result lands just after the gap; in a fall-back overlap, the first occurrence.
 */
export function zonedInstant(date: string, hhmm: string, tz: string): Date {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const { hour, minute } = parseHHMM(hhmm);
  const guess = Date.UTC(y, mo - 1, d, hour, minute);
  let result = guess - tzOffsetMs(new Date(guess), tz);
  const corrected = guess - tzOffsetMs(new Date(result), tz);
  if (corrected !== result) result = Math.min(result, corrected);
  return new Date(result);
}

export function addDays(date: string, days: number): string {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, mo - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Inclusive list of dates from `from` to `to`. */
export function datesBetween(from: string, to: string, max = 14): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < max; d = addDays(d, 1)) out.push(d);
  return out;
}

/** True when local time `hhmm` falls inside [start, end), handling ranges that cross midnight. */
export function inLocalRange(hhmm: string, start: string, end: string): boolean {
  if (start === end) return false;
  return start < end ? hhmm >= start && hhmm < end : hhmm >= start || hhmm < end;
}

/** "1 pm", "1:30 pm", "noon" — for spoken replies. */
export function spokenTime(instant: Date, tz: string): string {
  const { hour, minute } = parseHHMM(localTime(instant, tz));
  if (hour === 12 && minute === 0) return 'noon';
  if (hour === 0 && minute === 0) return 'midnight';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const suffix = hour < 12 ? 'am' : 'pm';
  return minute === 0 ? `${h12} ${suffix}` : `${h12}:${pad(minute)} ${suffix}`;
}

export function addMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * 60_000);
}

export function minutesBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 60_000;
}
