import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { emptyStore, upsertDetected, transition, recoverInterrupted, loadStore, saveStore } =
  require('../src/lib/state.cjs');

const ref = { key: 'a/b#1', owner: 'a', repo: 'b', number: 1, url: 'https://github.com/a/b/pull/1' };
const NOW = '2026-07-10T12:00:00.000Z';

test('upsertDetected creates once, then appends sources', () => {
  const store = emptyStore();
  assert.equal(upsertDetected(store, ref, '00-inbox/note.md', NOW).isNew, true);
  const pr = store.prs['a/b#1'];
  assert.equal(pr.state, 'detected');
  assert.deepEqual(pr.sources, ['00-inbox/note.md']);
  assert.equal(pr.timestamps.detected, NOW);

  assert.equal(upsertDetected(store, ref, 'other.md', NOW).isNew, false);
  assert.equal(upsertDetected(store, ref, 'other.md', NOW).isNew, false);
  assert.deepEqual(store.prs['a/b#1'].sources, ['00-inbox/note.md', 'other.md']);
});

test('transition enforces the machine and stamps timestamps', () => {
  const store = emptyStore();
  upsertDetected(store, ref, 'n.md', NOW);
  transition(store, 'a/b#1', 'reviewing', NOW, { account: 'nikrich' });
  const pr = transition(store, 'a/b#1', 'awaiting_approval', NOW, { draft: { summary: 's', verdict: 'v', findings: [] } });
  assert.equal(pr.state, 'awaiting_approval');
  assert.equal(pr.account, 'nikrich');
  assert.equal(pr.timestamps.awaiting_approval, NOW);

  assert.throws(() => transition(store, 'a/b#1', 'reviewing', NOW), /illegal transition/);
  assert.throws(() => transition(store, 'nope#1', 'reviewing', NOW), /unknown pr/);

  transition(store, 'a/b#1', 'submitted', NOW, { reviewUrl: 'https://x' });
  assert.throws(() => transition(store, 'a/b#1', 'dismissed', NOW), /illegal transition/);
});

test('failed is retryable back to detected', () => {
  const store = emptyStore();
  upsertDetected(store, ref, 'n.md', NOW);
  transition(store, 'a/b#1', 'reviewing', NOW);
  transition(store, 'a/b#1', 'failed', NOW, { error: 'boom' });
  const pr = transition(store, 'a/b#1', 'detected', NOW, { error: null });
  assert.equal(pr.state, 'detected');
  assert.equal(pr.error, null);
});

test('recoverInterrupted resets reviewing PRs', () => {
  const store = emptyStore();
  upsertDetected(store, ref, 'n.md', NOW);
  transition(store, 'a/b#1', 'reviewing', NOW);
  assert.equal(recoverInterrupted(store, NOW), 1);
  assert.equal(store.prs['a/b#1'].state, 'detected');
  assert.equal(recoverInterrupted(store, NOW), 0);
});

test('loadStore/saveStore round-trip, missing and corrupt files → empty', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'prrev-'));
  const file = path.join(dir, 'state.json');
  assert.deepEqual(await loadStore(file), emptyStore());

  const store = emptyStore();
  upsertDetected(store, ref, 'n.md', NOW);
  store.accountCache['a/b'] = 'nikrich';
  await saveStore(file, store);
  assert.deepEqual(await loadStore(file), store);
  // atomic write leaves valid JSON on disk
  JSON.parse(await readFile(file, 'utf8'));

  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, '{not json');
  assert.deepEqual(await loadStore(file), emptyStore());
});
