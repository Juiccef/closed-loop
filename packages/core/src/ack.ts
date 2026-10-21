import { createHmac, timingSafeEqual } from 'node:crypto';

// Signed, expiring acknowledge links for caregiver emails. Payload is not secret, only tamper-proof.

export interface AckPayload {
  householdId: string;
  occurrenceId: string;
  contactId: string;
  /** Unix seconds. */
  exp: number;
}

const b64url = (buf: Buffer) => buf.toString('base64url');

export function signAck(secret: string, payload: AckPayload): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyAck(secret: string, token: string, nowSeconds: number): AckPayload | undefined {
  const [body, sig] = token.split('.');
  if (!body || !sig) return undefined;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AckPayload;
    if (typeof payload.exp !== 'number' || payload.exp < nowSeconds) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}
