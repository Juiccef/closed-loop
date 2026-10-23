// Echo Show card (APL): the same reading of a tool result as the MCP App card (packages/mcp-server/src/card.ts),
// ring status by shape, then a kicker, a title, and a sub line. Voice stands alone; the card is sent only when
// the device reports Alexa.Presentation.APL.

import type { interfaces } from 'ask-sdk-model';
import type { ToolResult } from './mcp';

/** Ring shapes, so the status never depends on color alone. */
export type RingKind = 'open' | 'later' | 'closed' | 'human' | 'paused';

export interface CardModel {
  kind: RingKind;
  kicker: string;
  title: string;
  sub: string;
}

type Sc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** "22:00" -> "10 pm", as the MCP App card writes it. */
function clock(hhmm: unknown): string {
  const [hs, m = '00'] = String(hhmm ?? '').split(':');
  const h = Number(hs);
  if (!hs || Number.isNaN(h)) return '';
  if (h === 12 && m === '00') return 'noon';
  if (h === 0 && m === '00') return 'midnight';
  return `${h % 12 || 12}${m === '00' ? '' : `:${m}`}${h < 12 ? ' am' : ' pm'}`;
}

const ownTitle = (c: Sc) => `Tell ${c.tell || 'family'} if there’s no “${c.phrase}” by ${clock(c.byLocal)}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Mirrors render() in the MCP App card, branch for branch. */
export function cardFor(result: ToolResult): CardModel {
  const sc: Sc = result.structuredContent ?? {};
  if (Array.isArray(sc.items)) {
    const bits = [`${sc.reported} reported`, `${sc.open} open`];
    if (sc.needsHumanContact) bits.push(`${sc.needsHumanContact} needs a call`);
    return {
      kind: sc.needsHumanContact ? 'human' : sc.open ? 'open' : 'closed',
      kicker: bits.join(' · '),
      title: `${sc.recipientName ? `${sc.recipientName}’s` : 'Today’s'} check-ins today`,
      sub: 'Recorded as said. Nobody checked.',
    };
  }
  if (Array.isArray(sc.checkins)) {
    const n = sc.checkins.length;
    return {
      kind: n ? 'open' : sc.paused ? 'paused' : 'closed',
      kicker: n ? 'Open check-ins' : 'Check-ins',
      title: n ? `${n} ${n === 1 ? 'loop' : 'loops'} open` : sc.paused ? 'Paused' : 'Nothing due right now',
      sub: n ? 'Asked one at a time, in the family’s own words.' : '',
    };
  }
  if (sc.status === 'confirm_needed' || sc.status === 'set' || sc.status === 'not_set') {
    const c = sc.checkin;
    if (sc.status === 'not_set' || !c) {
      const crisis = sc.nextStep === 'call_emergency_services';
      return { kind: crisis ? 'human' : 'paused', kicker: 'Your own check-in', title: 'Nothing was set', sub: crisis ? 'Told to call 911 if it is an emergency.' : '' };
    }
    const set = sc.status === 'set';
    return {
      kind: set ? 'open' : 'later',
      kicker: set ? 'Set by you' : 'Your own check-in · not set yet',
      title: ownTitle(c),
      sub: set ? `Closes when you say “${c.phrase}”${c.repeat === 'daily' ? ', every day.' : '.'}` : 'Say yes to set it up.',
    };
  }
  if ('remaining' in sc) {
    const done = sc.status === 'cancelled' && sc.checkin;
    return {
      kind: 'paused',
      kicker: sc.status === 'cancelled' ? 'Cancelled' : 'Your own check-ins',
      title: done ? `“${sc.checkin.phrase}” by ${clock(sc.checkin.byLocal)}` : 'Nothing cancelled',
      sub: done ? `${sc.checkin.tell || 'Family'} won’t be emailed about it.` : '',
    };
  }
  if (sc.recordedWording) {
    const next: Record<string, string> = {
      none: '',
      will_ask_again_later: 'Will ask again later.',
      family_will_be_told: 'Family will get a note.',
      call_emergency_services: 'Told to call 911 if it is an emergency.',
    };
    return {
      kind: sc.recordedAs === 'reported_by_person' ? 'closed' : sc.recordedAs === 'needs_human_contact' ? 'human' : sc.recordedAs === 'not_recorded' ? 'paused' : 'later',
      kicker: 'Recorded',
      title: cap(String(sc.recordedWording)),
      sub: next[sc.nextStep] ?? '',
    };
  }
  if ('deferredUntilLocal' in sc) {
    return { kind: 'later', kicker: 'Said later', title: sc.deferredUntilLocal ? `Ask again at ${sc.deferredUntilLocal}` : 'Noted for later', sub: 'The loop stays open until then.' };
  }
  if ('reported' in sc) {
    return {
      kind: sc.open ? 'open' : 'closed',
      kicker: 'Today',
      title: `${sc.reported} reported · ${sc.open} open`,
      sub: sc.sharedWith?.length ? `Shared with ${sc.sharedWith.join(', ')} only if a loop stays open.` : 'Not shared with anyone.',
    };
  }
  if ('pausedUntilLocal' in sc) {
    return { kind: 'paused', kicker: 'Paused', title: `No check-ins until ${sc.pausedUntilLocal || 'later'}`, sub: 'The family sees the pause in the console.' };
  }
  return { kind: 'open', kicker: 'Check-in', title: result.content?.find((c) => c.type === 'text')?.text ?? 'Done', sub: '' };
}

// ---- The ring, as AVG path data (56 x 56, radius 22, from 12 o'clock clockwise) ----

const C = 28;
const R = 22;
const point = (deg: number) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return `${(C + R * Math.cos(a)).toFixed(2)},${(C + R * Math.sin(a)).toFixed(2)}`;
};
const arc = (from: number, to: number) => `M${point(from)} A${R},${R} 0 ${to - from > 180 ? 1 : 0},1 ${point(to)}`;
const FULL = `M${C},${C - R} A${R},${R} 0 1,1 ${C},${C + R} A${R},${R} 0 1,1 ${C},${C - R}`;

/** How much of the ring is drawn, as in the MCP App card's stroke-dasharray. */
export function ringPath(kind: RingKind): string {
  if (kind === 'closed' || kind === 'human') return FULL;
  if (kind === 'paused') return Array.from({ length: 12 }, (_, i) => arc(i * 30, i * 30 + 6)).join(' ');
  return arc(0, (kind === 'later' ? 0.58 : 0.72) * 360);
}

const COLORS: Record<RingKind, string> = { open: '#5aa7f0', later: '#5aa7f0', closed: '#4cc35a', human: '#ff7a7a', paused: '#a9b2be' };

function ringGraphic(kind: RingKind) {
  const color = COLORS[kind];
  const items: Array<Record<string, unknown>> = [
    { type: 'path', pathData: FULL, stroke: '#2a2f36', strokeWidth: 6 },
    { type: 'path', pathData: ringPath(kind), stroke: color, strokeWidth: 6, strokeLineCap: 'round' },
  ];
  // A dot in the middle when closed; an exclamation mark when someone should get in touch (as loopGlyph does).
  if (kind === 'closed') items.push({ type: 'path', pathData: `M${C - 6},${C} a6,6 0 1,0 12,0 a6,6 0 1,0 -12,0`, fill: color });
  if (kind === 'human') {
    items.push({ type: 'path', pathData: `M${C},${C - 11} L${C},${C + 3}`, stroke: color, strokeWidth: 4.5, strokeLineCap: 'round' });
    items.push({ type: 'path', pathData: `M${C - 2.6},${C + 10} a2.6,2.6 0 1,0 5.2,0 a2.6,2.6 0 1,0 -5.2,0`, fill: color });
  }
  return { type: 'AVG', version: '1.2', width: 56, height: 56, items };
}

/** Shown under every card: what this is, honestly. */
export const CARD_FOOTER = 'Classic Alexa skill calling the Closed Loop MCP server. Not an Alexa+ add-on. Reminders and check-ins only, not an emergency alert system.';

export const APL_TOKEN = 'closed-loop-card';

/** Alexa.Presentation.APL.RenderDocument for one card. Text goes through datasources; the ring is drawn per result. */
export function renderDirective(card: CardModel): interfaces.alexa.presentation.apl.RenderDocumentDirective {
  return {
    type: 'Alexa.Presentation.APL.RenderDocument',
    token: APL_TOKEN,
    document: {
      type: 'APL',
      version: '2023.3',
      theme: 'dark',
      graphics: { ring: ringGraphic(card.kind) },
      mainTemplate: {
        parameters: ['payload'],
        items: [
          {
            type: 'Frame',
            width: '100vw',
            height: '100vh',
            backgroundColor: '#121417',
            item: {
              type: 'Container',
              width: '100vw',
              height: '100vh',
              justifyContent: 'center',
              paddingLeft: '6vw',
              paddingRight: '6vw',
              items: [
                {
                  type: 'Container',
                  direction: 'row',
                  alignItems: 'start',
                  items: [
                    { type: 'VectorGraphic', source: 'ring', width: '22vh', height: '22vh', scale: 'best-fit', accessibilityLabel: '${payload.card.status}' },
                    {
                      type: 'Container',
                      grow: 1,
                      shrink: 1,
                      paddingLeft: '4vw',
                      items: [
                        { type: 'Text', text: '${payload.card.kicker}', color: COLORS[card.kind], fontSize: '24dp', fontWeight: 'bold', maxLines: 1 },
                        { type: 'Text', text: '${payload.card.title}', color: '#f2f3f5', fontSize: '40dp', fontWeight: 'bold', maxLines: 3, paddingTop: '8dp' },
                        { type: 'Text', text: '${payload.card.sub}', color: '#a9b2be', fontSize: '26dp', maxLines: 2, paddingTop: '10dp' },
                      ],
                    },
                  ],
                },
                { type: 'Text', text: '${payload.card.footer}', color: '#a9b2be', fontSize: '18dp', maxLines: 2, paddingTop: '6vh' },
              ],
            },
          },
        ],
      },
    },
    datasources: { card: { ...card, status: STATUS_LABEL[card.kind], footer: CARD_FOOTER } },
  };
}

/** For screen readers on the device: what the ring shape means. */
const STATUS_LABEL: Record<RingKind, string> = {
  open: 'Loop open',
  later: 'Loop open, said later',
  closed: 'Loop closed',
  human: 'Needs human contact',
  paused: 'Paused',
};
