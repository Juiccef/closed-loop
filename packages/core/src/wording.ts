// Every sentence the person hears and the family reads lives here, so the honesty rules hold in one place:
// never "confirmed" or "taken"; "no response" never claims the person was asked unless promptedAt is set;
// nothing here is medical advice or an emergency promise.

import { spokenTime } from './clock';
import type { CheckinDefinition, Household, Occurrence, OpenReason } from './model';
import type { CheckinResponse } from './safety';

export const SCOPE_NOTICE = 'Reminders and check-ins only. Not an emergency alert system. No answer does not mean an emergency.';
export const SIMULATED_CLIENT_NOTICE =
  'Simulated Alexa+ client. Not Amazon software. Alexa+ add-on tooling is partner-only, so this project implements the MCP server side and demonstrates it through a self-built MCP client, as the hackathon FAQ allows.';
export const VOICE_TURNS_NOTICE =
  'Check-in conversations are started by the person, a household routine, or the simulator. MCP add-ons have no documented way to speak first.';

/** What a tool reports back as recorded. Mirrors the ledger, never stronger than what was said. */
export const LEDGER_STATUSES = [
  'scheduled',
  'asked',
  'reported_by_person',
  'said_later',
  'said_not_yet',
  'declined',
  'not_sure',
  'no_response',
  'needs_human_contact',
  'acknowledged',
] as const;
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

export function ledgerStatusFor(response: CheckinResponse): LedgerStatus {
  switch (response) {
    case 'done':
      return 'reported_by_person';
    case 'later':
      return 'said_later';
    case 'not_yet':
      return 'said_not_yet';
    case 'no':
      return 'declined';
    case 'unsure':
      return 'not_sure';
    case 'needs_help':
      return 'needs_human_contact';
  }
}

export const LEDGER_WORDING: Record<LedgerStatus, string> = {
  scheduled: 'not asked yet',
  asked: 'asked, no answer yet',
  reported_by_person: 'reported by the person',
  said_later: 'said later',
  said_not_yet: 'said not yet',
  declined: 'said no',
  not_sure: 'said they would, not sure',
  no_response: 'no response',
  needs_human_contact: 'needs human contact',
  acknowledged: 'acknowledged by family',
};

const OPEN_REASON_WORDING: Record<OpenReason, string> = {
  not_reached: 'no response (not reached)',
  no_answer: 'no response (asked, no answer)',
  said_later: 'said later, no follow-up answer',
  not_sure: 'said they would, not sure',
  declined: 'said no',
};

/** One line for the caregiver ledger. `own`: a check-in the person set up, which is listened for, never asked. */
export function ledgerLine(occ: Occurrence, contactName?: (id: string) => string | undefined, opts: { own?: boolean } = {}): string {
  switch (occ.state) {
    case 'SCHEDULED':
      return opts.own ? 'not said yet' : LEDGER_WORDING.scheduled;
    case 'PROMPTED':
      return LEDGER_WORDING.asked;
    case 'DEFERRED':
      return LEDGER_WORDING.said_later;
    case 'UNSURE':
      return LEDGER_WORDING.not_sure;
    case 'DECLINED':
      return LEDGER_WORDING.declined;
    case 'REPORTED_DONE':
      return occ.reportedLate ? `${LEDGER_WORDING.reported_by_person} (after the window closed)` : LEDGER_WORDING.reported_by_person;
    case 'NEEDS_HUMAN':
      return LEDGER_WORDING.needs_human_contact;
    case 'MISSED':
      return OPEN_REASON_WORDING[occ.openReason ?? 'not_reached'];
    case 'ESCALATED_L1':
      return `${OPEN_REASON_WORDING[occ.openReason ?? 'not_reached']} · family emailed`;
    case 'ESCALATED_L2':
      return `${OPEN_REASON_WORDING[occ.openReason ?? 'not_reached']} · second contact emailed`;
    case 'ACKNOWLEDGED': {
      const by = occ.ackedBy ? contactName?.(occ.ackedBy) ?? occ.ackedBy : undefined;
      return by ? `acknowledged by ${by}` : LEDGER_WORDING.acknowledged;
    }
    case 'PAUSED':
      return 'paused';
    case 'CANCELLED':
      return 'cancelled by the person';
  }
}

// ---- Spoken replies (short, plain, no re-quizzing) ----

export const spoken = {
  noneDue: 'There are no check-ins right now.',
  paused: (until: Date, tz: string) => `Check-ins are paused until ${spokenTime(until, tz)}.`,
  inactive: 'Check-ins are turned off right now.',
  done: "Thank you. I've noted that it's done.",
  unsure: "Okay. I've noted that you're not sure. I'll check again later.",
  later: (at: Date, tz: string) => `Okay. I'll ask again around ${spokenTime(at, tz)}.`,
  laterNoTime: "Okay, I've noted that you'll do it later.",
  declined: "Okay, I've noted that. I won't ask about it again today.",
  needsHelp: "Okay. I'll ask your family to give you a call.",
  alreadyDone: "That one is already noted as done. Thank you.",
  notFound: "I couldn't find that check-in. It may have already closed.",
  pausedToday: "Okay. Check-ins are paused for the rest of today.",
  paused24h: "Okay. Check-ins are paused for the next 24 hours.",
};

/** Follow-ups avoid re-reading time-of-day greetings ("Good morning") hours later. */
export function followUpPrompt(def: CheckinDefinition): string {
  return def.kind === 'wellbeing' ? `Just checking again. ${def.prompt}` : `Just checking again about ${def.label}. Is that done now?`;
}

export function statusSentence(reported: number, open: number, missed: number, l1Names: string[]): string {
  const parts = [`Today: ${reported} reported, ${open} still open`];
  if (missed > 0) parts.push(`${missed} not answered in time`);
  const who = l1Names.length ? `${joinNames(l1Names)} ${l1Names.length === 1 ? 'gets' : 'get'} an email if a check-in stays open.` : 'No one is set up to get emails.';
  return `${parts.join(', ')}. ${who}`;
}

export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

// ---- Caregiver emails ----

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function render(subject: string, paragraphs: string[], link?: { href: string; label: string }): EmailContent {
  const text = [...paragraphs, ...(link ? [`${link.label}: ${link.href}`] : []), '', SCOPE_NOTICE].join('\n\n');
  const html = `<!doctype html><html lang="en"><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:17px;line-height:1.5;max-width:560px">
${paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n')}
${link ? `<p><a href="${escapeHtml(link.href)}" style="display:inline-block;padding:12px 22px;background:#0972d3;color:#fff;font-weight:700;text-decoration:none;border-radius:999px">${escapeHtml(link.label)}</a></p>` : ''}
<p style="font-size:14px;color:#555">${escapeHtml(SCOPE_NOTICE)}</p>
</body></html>`;
  return { subject, text, html };
}

function windowText(occ: Occurrence, tz: string): string {
  return `${spokenTime(new Date(occ.windowStart), tz)} to ${spokenTime(new Date(occ.windowEnd), tz)}`;
}

export function missedEmail(args: {
  household: Household;
  def: CheckinDefinition;
  occ: Occurrence;
  level: 1 | 2;
  consecutiveDays: number;
  ackUrl: string;
}): EmailContent {
  const { household: h, def, occ, level, consecutiveDays, ackUrl } = args;
  const name = h.recipientName;
  const tz = h.timezone;
  const reason = occ.openReason ?? 'not_reached';
  const first =
    reason === 'declined' ? `${name} said no to ${def.label} today.` : `We did not hear back about ${def.label} today.`;
  const detail: Record<OpenReason, string> = {
    not_reached: `No check-in conversation took place during the ${windowText(occ, tz)} window, so ${name} was not asked.`,
    no_answer: `${name} was asked at ${occ.promptedAt ? spokenTime(new Date(occ.promptedAt), tz) : 'the start of the window'} and we did not get an answer before ${spokenTime(new Date(occ.windowEnd), tz)}.`,
    said_later: `${name} said they would do it later, and we did not hear back before ${spokenTime(new Date(occ.windowEnd), tz)}.`,
    not_sure: `${name} said they would, but it was not clear that it happened.`,
    declined: `${name} was asked and said no. We did not ask again.`,
  };
  const paragraphs = [`${first} This is not an emergency alert.`, detail[reason]];
  if (level === 2) paragraphs.push(`This is day ${consecutiveDays} in a row that this check-in stayed open without anyone acknowledging it, so you are receiving this as the second contact.`);
  paragraphs.push('If you have already been in touch, acknowledge this to stop further emails about it.');
  const subject = level === 2 ? `Second notice: ${def.label} (not an emergency alert)` : `Check-in update: ${def.label} (not an emergency alert)`;
  return render(subject, paragraphs, { href: ackUrl, label: 'Acknowledge' });
}

/**
 * A check-in the person set up by voice stayed open: sent in the person's name, to the contact they chose.
 * Uses the person's name throughout, never an assumed pronoun.
 */
export function ownMissedEmail(args: {
  household: Household;
  def: CheckinDefinition;
  occ: Occurrence;
  level: 1 | 2;
  consecutiveDays: number;
  ackUrl: string;
}): EmailContent {
  const { household: h, def, occ, level, consecutiveDays, ackUrl } = args;
  const name = h.recipientName;
  const phrase = def.self?.phrase ?? 'the check-in phrase';
  const by = spokenTime(new Date(occ.windowEnd), h.timezone);
  const paragraphs = [
    `${name} asked Closed Loop to let you know if ${name} hadn't said "${phrase}" by ${by}. ${name} hasn't yet. This is not an emergency alert.`,
    `${name} set this up by voice${def.self?.repeat === 'daily' ? ', for every day' : ''}. Closed Loop never asks ${name} about it; the loop closes when ${name} says it.`,
  ];
  if (level === 2) paragraphs.push(`This is day ${consecutiveDays} in a row that this check-in stayed open without anyone acknowledging it, so you are receiving this as the second contact.`);
  paragraphs.push('If you have already been in touch, acknowledge this to stop further emails about it.');
  const subject =
    level === 2 ? `Second notice: ${name}'s "${phrase}" by ${by} (not an emergency alert)` : `${name} asked us to let you know: no "${phrase}" by ${by} (not an emergency alert)`;
  return render(subject, paragraphs, { href: ackUrl, label: 'Acknowledge' });
}

export function needsHumanEmail(args: { household: Household; occ: Occurrence; crisis: boolean; ackUrl: string }): EmailContent {
  const name = args.household.recipientName;
  const paragraphs = [`${name} seemed confused or upset during a check-in. A call may help.`];
  if (args.crisis) {
    paragraphs.push(
      `${name} used words that can mean they need help, and was told to call 911 if it is an emergency. This service cannot tell what happened and does not contact emergency services.`,
    );
  }
  paragraphs.push('Acknowledge this once you have been in touch.');
  return render(`Check-in note: ${name} may need a call`, paragraphs, { href: args.ackUrl, label: 'Acknowledge' });
}
