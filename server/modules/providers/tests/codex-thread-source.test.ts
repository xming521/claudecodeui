import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { markCodexThreadInteractive } from '@/modules/providers/list/codex/codex-thread-source.js';

const THREAD_ID = '01a16e2f-6b4c-7853-a5d4-b8f835ccbcd7';

function sessionMeta(source: string, instructions = 'Be brief.') {
  return JSON.stringify({
    timestamp: '2026-10-24T13:51:24.000Z',
    type: 'session_meta',
    payload: { id: THREAD_ID, cwd: '/w', originator: 'codex_sdk_ts', source, base_instructions: { text: instructions } },
  });
}

async function writeRollout(root: string, firstLine: string) {
  const directory = path.join(root, '2026', '10', '24');
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `rollout-2026-10-24T21-51-24-${THREAD_ID}.jsonl`);
  const rest = '{"type":"event_msg","payload":{"type":"user_message","message":"你好"}}\n';
  await writeFile(filePath, `${firstLine}\n${rest}`, { mode: 0o600 });
  return { filePath, rest };
}

test('rewrites an exec thread to vscode and keeps the rest of the rollout', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { filePath, rest } = await writeRollout(root, sessionMeta('exec'));

  assert.equal(await markCodexThreadInteractive(THREAD_ID, root), true);

  const [first, ...others] = (await readFile(filePath, 'utf8')).split('\n');
  assert.equal(JSON.parse(first).payload.source, 'vscode');
  assert.equal(JSON.parse(first).payload.originator, 'codex_sdk_ts');
  assert.equal(others.join('\n'), rest);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);

  // A second run finds nothing to change.
  assert.equal(await markCodexThreadInteractive(THREAD_ID, root), false);
});

test('leaves non-exec threads and escaped look-alikes alone', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const { filePath } = await writeRollout(root, sessionMeta('vscode', 'quote "source":"exec" here'));
  const before = await readFile(filePath, 'utf8');
  assert.equal(await markCodexThreadInteractive(THREAD_ID, root), false);
  assert.equal(await readFile(filePath, 'utf8'), before);

  await writeRollout(root, sessionMeta('exec', 'quote "source":"exec" here'));
  assert.equal(await markCodexThreadInteractive(THREAD_ID, root), true);
  const first = JSON.parse((await readFile(filePath, 'utf8')).split('\n')[0]);
  assert.equal(first.payload.source, 'vscode');
  assert.equal(first.payload.base_instructions.text, 'quote "source":"exec" here');
});

test('returns false when the thread has no rollout', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await markCodexThreadInteractive(THREAD_ID, root), false);
  assert.equal(await markCodexThreadInteractive(THREAD_ID, path.join(root, 'missing')), false);
});
