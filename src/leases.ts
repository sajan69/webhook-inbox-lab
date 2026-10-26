import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { MAX_ATTEMPTS } from './schema.js';

export class LeaseError extends Error {
  constructor() { super('Lease is no longer owned'); }
}
export interface Lease {
  readonly id: string;
  readonly token: string;
  readonly attempt: number;
  readonly expiresAt: number;
}
export type FailureCode = 'transient_handler_error' | 'invalid_event' | 'business_conflict';

export function validateTime(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || now > 999_999_999_999) throw new Error('Invalid processing time');
}
export function requireLease(db: DatabaseSync, lease: Lease, now: number): { body: Uint8Array } {
  validateTime(now);
  const row = db.prepare(`SELECT body FROM inbox WHERE id=? AND state='leased'
    AND lease_token=? AND lease_until>?`).get(lease.id, lease.token, now);
  if (!row) throw new LeaseError();
  return row as unknown as { body: Uint8Array };
}

// These functions run inside the caller's BEGIN IMMEDIATE transaction.
export function claimEvent(db: DatabaseSync, now: number, leaseSeconds: number): Lease | null {
  validateTime(now);
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 300) throw new Error('Invalid lease duration');
  // Crashed final attempts become terminal when a worker next checks the queue.
  db.prepare(`UPDATE inbox SET state='dead', lease_token=NULL, lease_until=NULL,
    last_error='lease_expired', completed_at=?
    WHERE state='leased' AND lease_until<=? AND attempts>=?`).run(now, now, MAX_ATTEMPTS);
  const row = db.prepare(`SELECT id,attempts FROM inbox
    WHERE ((state IN ('pending','retry') AND available_at<=?) OR (state='leased' AND lease_until<=?))
      AND attempts<? ORDER BY available_at,received_at,id LIMIT 1`).get(now, now, MAX_ATTEMPTS);
  if (!row) return null;
  const id = row.id as string;
  const token = randomUUID();
  const expiresAt = now + leaseSeconds;
  const attempt = (row.attempts as number) + 1;
  db.prepare(`UPDATE inbox SET state='leased', attempts=?, lease_token=?, lease_until=?,
    last_error=CASE WHEN state='leased' THEN 'lease_expired' ELSE last_error END WHERE id=?`)
    .run(attempt, token, expiresAt, id);
  return { id, token, attempt, expiresAt };
}

export function failEvent(db: DatabaseSync, lease: Lease, code: FailureCode, now: number): 'retry' | 'dead' {
  requireLease(db, lease, now);
  if (!['transient_handler_error', 'invalid_event', 'business_conflict'].includes(code)) throw new Error('Invalid failure code');
  // Read persisted attempts, never the caller-supplied attempt field.
  const attempts = db.prepare('SELECT attempts FROM inbox WHERE id=?').get(lease.id)?.attempts as number;
  const terminal = code !== 'transient_handler_error' || attempts >= MAX_ATTEMPTS;
  const state = terminal ? 'dead' : 'retry';
  const delay = Math.min(60, 2 ** (attempts - 1));
  db.prepare(`UPDATE inbox SET state=?, available_at=?, lease_token=NULL, lease_until=NULL,
    last_error=?, completed_at=? WHERE id=?`).run(state, now + delay, code, terminal ? now : null, lease.id);
  return state;
}
