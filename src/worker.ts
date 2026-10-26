import { Inbox } from './inbox.js';
import { LedgerError } from './ledger.js';
import { LeaseError, type Lease } from './leases.js';

export class TransientHandlerError extends Error {
  constructor() { super('Transient handler failure'); }
}
export type StepResult = { state: 'idle' }
  | { id: string; state: 'done'; effect: 'applied' | 'duplicate' }
  | { id: string; state: 'retry' | 'dead' | 'lost' };

/** One bounded step. The optional trusted fault hook is for local failure drills. */
export function processNext(inbox: Inbox, options: {
  now?: number;
  beforeLedger?: (lease: Lease) => void;
} = {}): StepResult {
  const lease = inbox.claim(options.now);
  if (!lease) return { state: 'idle' };
  try {
    options.beforeLedger?.(lease);
    const effect = inbox.completeLedger(lease, options.now);
    return { id: lease.id, state: 'done', effect };
  } catch (error) {
    if (error instanceof LeaseError) return { id: lease.id, state: 'lost' };
    if (!(error instanceof LedgerError) && !(error instanceof TransientHandlerError)) {
      // Unknown/storage failures stop the caller and leave the lease for recovery.
      // Never turn arbitrary exception strings into durable errors or log bodies.
      throw new Error('Worker unavailable');
    }
    const code = error instanceof LedgerError ? error.code : 'transient_handler_error';
    try { return { id: lease.id, state: inbox.fail(lease, code, options.now) }; }
    catch (failure) {
      if (failure instanceof LeaseError) return { id: lease.id, state: 'lost' };
      throw new Error('Worker unavailable');
    }
  }
}

export function processBatch(inbox: Inbox, limit = 100): StepResult[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid worker batch limit');
  const results: StepResult[] = [];
  for (let n = 0; n < limit; n++) {
    const result = processNext(inbox);
    if (result.state === 'idle') break;
    results.push(result);
  }
  return results;
}
