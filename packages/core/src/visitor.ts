import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Household, HouseholdId } from './model';

// Per-visitor demo households. Each visitor to the hosted demo gets a copy of the demo household of their own
// ("demo-<random>"), with its own simulated clock, ledger, and email panel, so two people using the demo at the
// same time never affect each other. The shared 'demo' household (MCP Inspector, OAuth linking, scripts) and the
// deployment-wide clock it follows are unchanged.

/** A visitor's demo household lives this long (real time). Each of its other items expires this long after it is written. */
export const VISITOR_HOURS = 24;

/** Deployment-wide limit on check-in emails from visitor households per real (UTC) day; protects the SES sending quota. */
export const VISITOR_EMAILS_PER_DAY = 100;

/** Counter for that limit. Not a household: it is never registered, so the tick never visits it. */
export const VISITOR_EMAIL_BUDGET_ID = '_visitors';

const VISITOR_ID = /^demo-[a-z0-9]{10}$/;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function newVisitorHouseholdId(): HouseholdId {
  return `demo-${[...randomBytes(10)].map((b) => ALPHABET[b % ALPHABET.length]).join('')}`;
}

/** Only these households keep their own clock and expire; every other household is left exactly as before. */
export function isVisitorHousehold(id: string): boolean {
  return VISITOR_ID.test(id);
}

/** The household's own clock offset, when it is a visitor household that has one. */
export function ownClockOffset(h: Household | undefined): number | undefined {
  return h && isVisitorHousehold(h.id) && typeof h.clockOffsetSeconds === 'number' ? h.clockOffsetSeconds : undefined;
}

/** Past its expiry, a visitor household is treated as deleted even before DynamoDB TTL removes it. */
export function isExpired(h: Pick<Household, 'expiresAt'>, realNowMs: number): boolean {
  return typeof h.expiresAt === 'string' && Date.parse(h.expiresAt) <= realNowMs;
}

// ---- MCP bearer tokens for visitor households ----
// The simulator's MCP calls must act for the visitor's own household. Each token is derived from the deployment's
// MCP bearer token, so no new secret is needed, and it can only ever act for one visitor household.

const PREFIX = 'cldemo';

function sign(secret: string, id: HouseholdId): string {
  return createHmac('sha256', secret).update(`closed-loop visitor household:${id}`).digest('base64url');
}

export function visitorToken(secret: string, id: HouseholdId): string {
  if (!isVisitorHousehold(id)) throw new Error(`not a visitor household: ${id}`);
  return `${PREFIX}.${id}.${sign(secret, id)}`;
}

/** The visitor household a token acts for, or undefined. */
export function verifyVisitorToken(secret: string, token: string): HouseholdId | undefined {
  const [prefix, id, sig, ...rest] = token.split('.');
  if (prefix !== PREFIX || !id || !sig || rest.length || !isVisitorHousehold(id)) return undefined;
  const expected = Buffer.from(sign(secret, id));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected) ? id : undefined;
}
