import { createHmac, timingSafeEqual } from 'node:crypto';

export const MAX_BODY_BYTES = 64 * 1024;
export const TOLERANCE_SECONDS = 300;

export class VerificationError extends Error {
  constructor() { super('Invalid webhook'); }
}

export interface SignedHeaders {
  id: string;
  timestamp: string;
  signature: string;
}

export interface VerifiedDelivery {
  readonly id: string;
  readonly timestamp: number;
  readonly body: Buffer;
}

// Reject Node's permissive base64 decoding of malformed or noncanonical secrets.
function decodeSecret(secret: string): Buffer {
  if (!secret.startsWith('whsec_')) throw new Error('Invalid signing-secret configuration');
  const encoded = secret.slice(6);
  const key = Buffer.from(encoded, 'base64');
  if (key.toString('base64') !== encoded || key.length < 24 || key.length > 64) {
    throw new Error('Invalid signing-secret configuration');
  }
  return key;
}

/** HMAC v1 only. Configure secrets locally; never accept keys from request data. */
export class Authenticator {
  private readonly keys: Buffer[];
  constructor(secrets: readonly string[]) {
    if (secrets.length < 1 || secrets.length > 2) throw new Error('Configure one or two signing secrets');
    this.keys = secrets.map(decodeSecret);
  }

  verify(body: Buffer, headers: SignedHeaders, nowSeconds = Math.floor(Date.now() / 1000)): VerifiedDelivery {
    const { id, timestamp, signature } = headers;
    if (body.length > MAX_BODY_BYTES || !/^[A-Za-z0-9_-]{1,128}$/.test(id)
      || !/^[1-9][0-9]{0,11}$/.test(timestamp) || signature.length > 2048
      || !Number.isSafeInteger(nowSeconds) || nowSeconds < 0) throw new VerificationError();
    const sentAt = Number(timestamp);
    if (Math.abs(nowSeconds - sentAt) > TOLERANCE_SECONDS) throw new VerificationError();

    const candidates = signature.split(' ');
    if (candidates.length > 8) throw new VerificationError();
    const expected = this.keys.map(key => createHmac('sha256', key)
      .update(`${id}.${timestamp}.`, 'ascii').update(body).digest());
    let matched = false;
    for (const candidate of candidates) {
      const parsed = /^v1,([A-Za-z0-9+/]{43}=)$/.exec(candidate);
      if (!parsed?.[1]) continue; // Unknown versions can coexist during rotation.
      const actual = Buffer.from(parsed[1], 'base64');
      if (actual.toString('base64') !== parsed[1]) continue;
      for (const digest of expected) matched = timingSafeEqual(actual, digest) || matched;
    }
    if (!matched) throw new VerificationError();
    return { id, timestamp: sentAt, body: Buffer.from(body) };
  }
}
