import { createHash, randomBytes } from 'node:crypto';

/** SHA-256, base64url. Codes and tokens are stored only as hashes. */
export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

// Crockford base32: no I, L, O, U, so codes are easy to read aloud and type.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A one-time link code like "K7P2-9QXM" (40 bits; single use; expires in minutes). */
export function generateLinkCode(): string {
  const bytes = randomBytes(8);
  const chars = [...bytes].map((b) => ALPHABET[b % 32]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/** Accepts lower case, spaces, missing dash, and the usual look-alikes (O for 0, I or L for 1). */
export function normalizeLinkCode(input: string): string {
  const raw = input.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

export const LINK_CODE_MINUTES = 10;
