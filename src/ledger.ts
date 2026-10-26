import type { DatabaseSync } from 'node:sqlite';
import { TextDecoder } from 'node:util';
import { requireLease, type Lease } from './leases.js';

export class LedgerError extends Error {
  constructor(readonly code: 'invalid_event' | 'business_conflict') { super(code); }
}
export interface Credit { entryId: string; account: string; amount: number }

function parseCredit(body: Uint8Array): Credit {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const event = value as Record<string, unknown>;
    if (event.type !== 'ledger.credit' || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) throw new Error();
    const data = event.data as Record<string, unknown>;
    if (Object.keys(data).some(key => !['entryId', 'account', 'amount'].includes(key))
      || typeof data.entryId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.entryId)
      || typeof data.account !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(data.account)
      || typeof data.amount !== 'number' || !Number.isSafeInteger(data.amount) || data.amount < 1 || data.amount > 1_000_000_000) throw new Error();
    return { entryId: data.entryId, account: data.account, amount: data.amount };
  } catch { throw new LedgerError('invalid_event'); }
}

/** Caller owns BEGIN IMMEDIATE: effect and event completion share the commit. */
export function applyLedger(db: DatabaseSync, lease: Lease, now: number): 'applied' | 'duplicate' {
  const row = requireLease(db, lease, now);
  const credit = parseCredit(row.body);
  const existing = db.prepare('SELECT account,amount FROM ledger WHERE entry_id=?').get(credit.entryId);
  if (existing && (existing.account !== credit.account || existing.amount !== credit.amount)) {
    throw new LedgerError('business_conflict');
  }
  if (!existing) db.prepare('INSERT INTO ledger(entry_id,account,amount,first_event_id,applied_at) VALUES(?,?,?,?,?)')
    .run(credit.entryId, credit.account, credit.amount, lease.id, now);
  db.prepare(`UPDATE inbox SET state='done', completed_at=?, lease_token=NULL, lease_until=NULL,
    last_error=NULL WHERE id=?`).run(now, lease.id);
  return existing ? 'duplicate' : 'applied';
}
