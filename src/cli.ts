import { Authenticator } from './auth.js';
import { Inbox, inspectInbox } from './inbox.js';
import { startReceiver } from './server.js';
import { processBatch } from './worker.js';

async function main(): Promise<void> {
  const [command, path, option, ...extra] = process.argv.slice(2);
  if (!path || extra.length || !['serve', 'inspect', 'work'].includes(command ?? '')) {
    throw new Error('Usage: npm start -- serve <database> [port] | inspect <database> [limit] | work <database> [limit]');
  }
  if (option !== undefined && !/^(0|[1-9][0-9]{0,4})$/.test(option)) throw new Error('Invalid numeric option');
  if (command === 'inspect') {
    console.log(JSON.stringify(inspectInbox(path, option === undefined ? 100 : Number(option)), null, 2));
    return;
  }
  if (command === 'work') {
    const limit = option === undefined ? 100 : Number(option);
    if (limit < 1 || limit > 1000) throw new Error('Invalid worker batch limit');
    const inbox = new Inbox(path);
    try { console.log(JSON.stringify({ results: processBatch(inbox, limit) }, null, 2)); }
    finally { inbox.close(); }
    return;
  }
  const parsed: unknown = JSON.parse(process.env.WEBHOOK_SECRETS ?? 'null');
  if (!Array.isArray(parsed) || !parsed.every(value => typeof value === 'string')) throw new Error('Invalid secret configuration');
  const auth = new Authenticator(parsed as string[]);
  const port = option === undefined ? 8787 : Number(option);
  if (port > 65535) throw new Error('Invalid port');
  const inbox = new Inbox(path);
  try {
    const receiver = await startReceiver({ inbox, auth, port });
    console.log(`Receiver: ${receiver.url}/webhooks`);
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void receiver.close().then(() => inbox.close()).catch(() => { process.exitCode = 1; });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) { inbox.close(); throw error; }
}

main().catch(() => {
  // No exception text, paths, signatures, bodies or configured secrets in logs.
  console.error('Command failed. Check command, configuration and database access. See README.md.');
  process.exitCode = 1;
});
