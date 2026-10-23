// Alexa speaks first, through the Alexa Reminders API (POST /v1/alerts/reminders), since an MCP add-on cannot
// (FRICTION_LOG #4). Request shapes follow Amazon's Reminders API reference and the ask-sdk-model types
// (services.reminderManagement.ReminderRequest). The reminder only asks the person to open the skill; the
// check-in itself, and everything recorded, stays on the Closed Loop server.

import type { services } from 'ask-sdk-model';
import { localDate, localTime, spokenClock } from '@closed-loop/core';
import type { ToolResult } from './mcp';

export const REMINDERS_PERMISSION = 'alexa::alerts:reminders:skill:readwrite';
export const OPEN_LINE = 'Say: Alexa, open Closed Loop.';
export const PERMISSION_SPEECH = 'To set reminders, I need your permission. I sent a card to the Alexa app, where you can allow reminders for Closed Loop.';

/** Local wall time without an offset, one of the formats the API lists (YYYY-MM-DDTHH:mm:ss.SSS). */
export function localStamp(instant: Date, tz: string): string {
  return `${localDate(instant, tz)}T${localTime(instant, tz)}:00.000`;
}

function spokenInfo(text: string): services.reminderManagement.AlertInfo {
  return { spokenInfo: { content: [{ locale: 'en-US', text }] } };
}

/** "Remind me to check in in one minute": SCHEDULED_RELATIVE, for filming. */
export function relativeReminder(text: string, offsetSeconds: number, now: Date): services.reminderManagement.ReminderRequest {
  return {
    requestTime: now.toISOString().slice(0, 23),
    trigger: { type: 'SCHEDULED_RELATIVE', offsetInSeconds: offsetSeconds },
    alertInfo: spokenInfo(text),
    pushNotification: { status: 'ENABLED' },
  };
}

/** Every day at hh:mm household time: SCHEDULED_ABSOLUTE with a daily RRULE (the non-deprecated recurrence fields). */
export function dailyReminder(text: string, hhmm: string, tz: string, now: Date): services.reminderManagement.ReminderRequest {
  const [hour, minute] = hhmm.split(':').map(Number) as [number, number];
  return {
    requestTime: now.toISOString().slice(0, 23),
    trigger: {
      type: 'SCHEDULED_ABSOLUTE',
      timeZoneId: tz,
      recurrence: {
        startDateTime: localStamp(now, tz),
        recurrenceRules: [`FREQ=DAILY;BYHOUR=${hour};BYMINUTE=${minute};BYSECOND=0;INTERVAL=1;`],
      },
    },
    alertInfo: spokenInfo(text),
    pushNotification: { status: 'ENABLED' },
  };
}

/** ISO 8601 duration from AMAZON.DURATION ("PT1M", "PT90S", "PT2H") -> seconds; undefined when unreadable. */
export function durationSeconds(iso: string | undefined): number | undefined {
  const m = iso?.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m || iso === 'P' || iso === 'PT') return undefined;
  const [, d = '0', h = '0', min = '0', s = '0'] = m;
  const total = Number(d) * 86400 + Number(h) * 3600 + Number(min) * 60 + Number(s);
  return total > 0 ? total : undefined;
}

const WORD_NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30 };

/**
 * A reminder request in free text, for when the catch-all intent took it: "remind me to check in in two minutes",
 * "remind me every day". Undefined `seconds` means the default (one minute). Null when it isn't a reminder request.
 */
export function reminderAsk(text: string): { daily: boolean; seconds?: number } | null {
  const t = text.toLowerCase();
  if (!/^(please )?(remind me|set (up )?(a |my )?(daily )?(check ?in )?reminders?)\b/.test(t)) return null;
  if (/\b(every ?day|daily|each day)\b/.test(t)) return { daily: true };
  const m = t.match(/\bin (a|an|one|two|three|four|five|ten|fifteen|twenty|thirty|\d+) (second|minute|hour)s?\b/);
  if (!m) return { daily: false };
  const n = WORD_NUMBERS[m[1]!] ?? Number(m[1]);
  return { daily: false, seconds: n * (m[2] === 'hour' ? 3600 : m[2] === 'minute' ? 60 : 1) };
}

/** "90 seconds" -> "1 minute and 30 seconds" for the spoken reply. */
export function spokenDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const parts = [h && unit(h, 'hour'), m && unit(m, 'minute'), s && unit(s, 'second')].filter(Boolean) as string[];
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? '0 seconds');
}

export interface DailyCheckin {
  /** Window start, household time, "12:00". */
  start: string;
  /** The person's own wording for it: "your lunchtime check". */
  label: string;
}

/**
 * The family's daily check-ins, from get_family_summary (today's items, each with its window and label).
 * The person's own check-ins are left out: core labels them with the quoted phrase ("Margaret's “good night”
 * by 10 pm") and they are listened for, never asked. So is the record kept for an upset moment outside a check-in.
 */
export function familyCheckins(summary: ToolResult): { name: string; checkins: DailyCheckin[] } {
  const sc = summary.structuredContent ?? {};
  const name = typeof sc.recipientName === 'string' ? sc.recipientName : '';
  const items = Array.isArray(sc.items) ? (sc.items as Array<{ label?: string; window?: string }>) : [];
  const seen = new Set<string>();
  const checkins: DailyCheckin[] = [];
  for (const i of items) {
    const label = String(i.label ?? '');
    const start = String(i.window ?? '').match(/^([01]\d|2[0-3]):[0-5]\d/)?.[0];
    if (!start || /["“”]/.test(label) || /^outside a check-in$/i.test(label) || seen.has(start)) continue;
    seen.add(start);
    const own = name && label.startsWith(`${name}'s `) ? `your ${label.slice(name.length + 3)}` : label.charAt(0).toLowerCase() + label.slice(1);
    checkins.push({ start, label: own });
  }
  return { name, checkins };
}

/** "Margaret, it's time for your lunchtime check. Say: Alexa, open Closed Loop." */
export function reminderText(name: string, label: string): string {
  return `${name ? `${name}, it's` : "It's"} time for ${label}. ${OPEN_LINE}`;
}

/** "8 am, noon, and 6 pm" */
export function spokenTimes(starts: string[]): string {
  const t = starts.map(spokenClock);
  return t.length > 2 ? `${t.slice(0, -1).join(', ')}, and ${t.at(-1)}` : t.join(' and ');
}

/** What the person hears when the API refuses. Codes from the Reminders API reference. */
export function reminderErrorSpeech(err: unknown): { speech: string; askPermission: boolean } {
  const status = (err as { statusCode?: number })?.statusCode;
  const code = (err as { response?: { code?: string } })?.response?.code;
  if (status === 403 && code === 'MAX_REMINDERS_EXCEEDED') return { speech: 'There are too many reminders already, so I couldn’t set a new one.', askPermission: false };
  if (status === 403 && code === 'DEVICE_NOT_SUPPORTED') return { speech: 'This device can’t set reminders.', askPermission: false };
  // 401 is documented for a missing or invalid token; which code a missing grant returns is not (unverified), so any
  // other 401 or 403 asks for the permission again.
  if ((status === 401 && code !== 'NOT_IN_SESSION') || status === 403) return { speech: PERMISSION_SPEECH, askPermission: true };
  return { speech: 'Sorry, I couldn’t set the reminder just now.', askPermission: false };
}
