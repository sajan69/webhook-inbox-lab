import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { TextDecoder } from 'node:util';
import { Authenticator, MAX_BODY_BYTES, VerificationError } from './auth.js';
import { Inbox, CapacityError, ConflictError, StorageError } from './inbox.js';

class RequestError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

function respond(response: ServerResponse, status: number, code: string): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'connection': 'close',
    ...(status === 503 || status === 429 ? { 'retry-after': '5' } : {}),
  });
  response.end(JSON.stringify({ status: code }) + '\n');
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0; let finished = false;
    const fail = (error: Error) => { if (!finished) { finished = true; chunks.length = 0; reject(error); } };
    request.on('data', (chunk: Buffer) => {
      if (finished) return; // Drain without retaining rejected payload bytes.
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { fail(new RequestError(413, 'payload_too_large')); return; }
      chunks.push(chunk);
    });
    request.on('end', () => { if (!finished) { finished = true; resolve(Buffer.concat(chunks)); } });
    request.on('aborted', () => fail(new RequestError(400, 'incomplete_request')));
    request.on('error', () => fail(new RequestError(400, 'invalid_request')));
  });
}

function validateJson(body: Buffer): void {
  try {
    const event: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error();
    const value = event as Record<string, unknown>;
    if (typeof value.type !== 'string' || !/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/.test(value.type)
      || value.type.length > 100 || !value.data || typeof value.data !== 'object' || Array.isArray(value.data)) throw new Error();
  } catch { throw new RequestError(422, 'invalid_event'); }
}

/** Loopback-only, one configured endpoint. There is no network inspection API. */
export async function startReceiver(options: {
  inbox: Inbox;
  auth: Authenticator;
  port?: number;
  now?: () => number;
}): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  let active = 0;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    const address = server.address();
    const host = typeof address === 'object' && address ? `127.0.0.1:${address.port}` : '';
    if (request.headers.host !== host || request.headers.origin !== undefined) {
      request.resume(); respond(response, 403, 'forbidden'); return;
    }
    if (active >= 32) { request.resume(); respond(response, 429, 'busy'); return; }
    active++;
    void (async () => {
      try {
        if (request.url === '/health' && request.method === 'GET') { respond(response, 200, 'ready'); return; }
        if (request.url !== '/webhooks') throw new RequestError(404, 'not_found');
        if (request.method !== 'POST') throw new RequestError(405, 'method_not_allowed');
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')
          || (request.headers['content-encoding'] !== undefined && request.headers['content-encoding'] !== 'identity')) {
          throw new RequestError(415, 'unsupported_media_type');
        }
        const fields: Record<string, string> = {};
        for (let i = 0; i < request.rawHeaders.length; i += 2) {
          const name = request.rawHeaders[i]?.toLowerCase();
          if (!name || !['webhook-id', 'webhook-timestamp', 'webhook-signature'].includes(name)) continue;
          if (fields[name] !== undefined) throw new RequestError(400, 'duplicate_header');
          fields[name] = request.rawHeaders[i + 1] ?? '';
        }
        const length = request.headers['content-length'];
        if (length !== undefined && Number(length) > MAX_BODY_BYTES) throw new RequestError(413, 'payload_too_large');
        const body = await readBody(request);
        const delivery = options.auth.verify(body, {
          id: fields['webhook-id'] ?? '',
          timestamp: fields['webhook-timestamp'] ?? '',
          signature: fields['webhook-signature'] ?? '',
        }, now());
        validateJson(delivery.body);
        // This synchronous transaction must complete successfully before either 2xx.
        const result = options.inbox.enqueue(delivery, now());
        respond(response, result === 'inserted' ? 202 : 200, result);
      } catch (error) {
        if (error instanceof VerificationError) respond(response, 401, 'invalid_webhook');
        else if (error instanceof ConflictError) respond(response, 409, 'event_conflict');
        else if (error instanceof CapacityError) respond(response, 503, 'capacity_reached');
        else if (error instanceof StorageError) respond(response, 503, 'storage_unavailable');
        else if (error instanceof RequestError) respond(response, error.status, error.code);
        else respond(response, 500, 'internal_error');
      } finally { active--; request.resume(); }
    })();
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 10_000;
  server.setTimeout(10_000, socket => socket.destroy());
  server.maxConnections = 64;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Receiver did not start');
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeIdleConnections();
    }),
  };
}
