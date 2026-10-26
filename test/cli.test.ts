import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Inbox } from '../src/inbox.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
test('invalid secret configuration fails without exposing values or creating storage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-cli-'));
  try {
    const path = join(dir, 'inbox.sqlite');
    const result = spawnSync(process.execPath, [cli, 'serve', path, '0'], {
      encoding: 'utf8', env: { ...process.env, WEBHOOK_SECRETS: '["private-invalid-value"]' }, timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.ok(!result.stderr.includes('private-invalid-value'));
    assert.ok(!result.stderr.includes(path));
    assert.equal(existsSync(path), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('CLI inspection returns bounded metadata without requiring signing secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-cli-'));
  try {
    const path = join(dir, 'inbox.sqlite');
    const inbox = new Inbox(path);
    inbox.enqueue({ id: 'sample', timestamp: 1_800_000_000, body: Buffer.from('private-body-marker') }); inbox.close();
    const result = spawnSync(process.execPath, [cli, 'inspect', path, '1'], {
      encoding: 'utf8', env: { ...process.env, WEBHOOK_SECRETS: '' }, timeout: 5000,
    });
    assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).total, 1);
    assert.ok(!result.stdout.includes('private-body-marker'));
    const invalid = spawnSync(process.execPath, [cli, 'inspect', path, '1junk'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(invalid.status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI worker processes a bounded batch without signing secrets and leaves remaining work queued', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-cli-'));
  try {
    const path = join(dir, 'inbox.sqlite'); const inbox = new Inbox(path);
    for (let n = 0; n < 2; n++) inbox.enqueue({ id: `event_${n}`, timestamp: 1000,
      body: Buffer.from(JSON.stringify({ type: 'ledger.credit', data: { entryId: `entry_${n}`, account: 'lab', amount: 1 } })) }, 1000);
    inbox.close();
    const result = spawnSync(process.execPath, [cli, 'work', path, '1'], {
      encoding: 'utf8', env: { ...process.env, WEBHOOK_SECRETS: '' }, timeout: 5000,
    });
    assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).results.length, 1);
    const reopened = new Inbox(path);
    assert.equal(reopened.inspect().filter(row => row.state === 'done').length, 1);
    assert.equal(reopened.inspect().filter(row => row.state === 'pending').length, 1); reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
