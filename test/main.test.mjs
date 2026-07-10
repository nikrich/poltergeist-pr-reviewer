import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createHandlers } = require('../src/main.cjs');
const { loadStore } = require('../src/lib/state.cjs');

const AUTH_STATUS = '  ✓ Logged in to github.com account nikrich (keyring)\n';
const REVIEW_JSON = JSON.stringify({
  summary: 'One bug.',
  verdict: 'needs a fix',
  findings: [{ path: 'src/x.js', line: 5, severity: 'issue', body: 'Null deref.' }],
});

function fakeCtx(dir, config) {
  const store = new Map([['config', config]]);
  const sent = [];
  return {
    ctx: {
      pluginId: 'pr-reviewer',
      pluginDir: dir,
      dataDir: dir,
      settings: { get: async (k) => store.get(k), set: async (k, v) => void store.set(k, v) },
      ipc: { handle: () => {}, send: (ch, p) => sent.push({ ch, p }) },
      api: { fetch: async () => ({}) },
      log: () => {},
    },
    sent,
  };
}

/** gh happy-path exec: auth, token, repo probe, PR meta, clone, checkout, review POST. */
function fakeExec(overrides = {}) {
  const calls = [];
  const exec = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts });
    const sig = `${cmd} ${args.slice(0, 1).join(' ')}`;
    if (overrides[sig]) return overrides[sig](args, opts);
    if (sig === 'gh auth' && args[1] === 'status') return { code: 0, stdout: AUTH_STATUS, stderr: '' };
    if (sig === 'gh auth' && args[1] === 'token') return { code: 0, stdout: 'tok-nikrich\n', stderr: '' };
    if (sig === 'gh api' && args[1] === 'repos/a/b') return { code: 0, stdout: '{}', stderr: '' };
    if (sig === 'gh api' && args[1] === 'repos/a/b/pulls/7')
      return { code: 0, stdout: JSON.stringify({ title: 'Fix', state: 'open', merged: false }), stderr: '' };
    if (sig === 'gh repo' && args[1] === 'clone') return { code: 0, stdout: '', stderr: '' };
    if (sig === 'gh pr' && args[1] === 'checkout') return { code: 0, stdout: '', stderr: '' };
    if (sig === 'gh api' && args[1] === 'repos/a/b/pulls/7/reviews')
      return { code: 0, stdout: JSON.stringify({ html_url: 'https://github.com/a/b/pull/7#pullrequestreview-1' }), stderr: '' };
    return { code: 1, stdout: '', stderr: `no route: ${sig} ${args.join(' ')}` };
  };
  exec.calls = calls;
  return exec;
}

async function setupVault(dir) {
  const vault = path.join(dir, 'vault');
  await mkdir(path.join(vault, 'notes'), { recursive: true });
  await writeFile(path.join(vault, 'notes', 'capture.md'), 'Please review https://github.com/a/b/pull/7 today.');
  return vault;
}

async function makePlugin(overrides = {}, claudeResult = REVIEW_JSON) {
  const dir = await mkdtemp(path.join(tmpdir(), 'prrev-main-'));
  const vault = await setupVault(dir);
  const config = { vaultPath: vault, folders: ['notes'], pollMinutes: 3, engine: { prompt: '', thoroughness: 'standard', skill: '' }, claudeBin: 'claude', timeoutMinutes: 15 };
  const { ctx, sent } = fakeCtx(dir, config);
  const exec = fakeExec(overrides);
  const notifications = [];
  // claudeResult may be a string or a () => string so tests can flip behavior
  const runClaude = async () => (typeof claudeResult === 'function' ? claudeResult() : claudeResult);
  const plugin = createHandlers(ctx, {
    exec,
    runClaude,
    notify: (title, body) => notifications.push({ title, body }),
    now: () => '2026-07-10T12:00:00.000Z',
  });
  return { dir, plugin, exec, sent, notifications, storeFile: path.join(dir, 'state.json') };
}

test('sweep detects PR, queue reviews it to awaiting_approval with a draft', async () => {
  const { plugin, storeFile, notifications, sent } = await makePlugin();
  const res = await plugin.handlers['sweep:now']();
  assert.equal(res.newPrs, 1);
  await plugin.kickQueue();

  const store = await loadStore(storeFile);
  const pr = store.prs['a/b#7'];
  assert.equal(pr.state, 'awaiting_approval');
  assert.equal(pr.account, 'nikrich');
  assert.equal(pr.title, 'Fix');
  assert.equal(pr.draft.findings.length, 1);
  assert.equal(store.accountCache['a/b'], 'nikrich');
  assert.equal(notifications.length, 1);
  assert.ok(sent.some((s) => s.ch === 'state:changed'));

  // re-sweeping the same unchanged vault finds nothing new
  const again = await plugin.handlers['sweep:now']();
  assert.equal(again.newPrs, 0);
});

test('closed PR is skipped, not reviewed', async () => {
  const { plugin, storeFile } = await makePlugin({
    'gh api': (args) =>
      args[1] === 'repos/a/b/pulls/7'
        ? { code: 0, stdout: JSON.stringify({ title: 'Old', state: 'closed', merged: true }), stderr: '' }
        : args[1] === 'repos/a/b'
          ? { code: 0, stdout: '{}', stderr: '' }
          : { code: 1, stdout: '', stderr: 'no route' },
  });
  await plugin.handlers['sweep:now']();
  await plugin.kickQueue();
  const pr = (await loadStore(storeFile)).prs['a/b#7'];
  assert.equal(pr.state, 'skipped');
  assert.match(pr.error, /merged/);
});

test('no account with access → skipped with no-access reason', async () => {
  const { plugin, storeFile } = await makePlugin({
    'gh api': (args) => ({ code: 1, stdout: '', stderr: 'HTTP 404' }),
  });
  await plugin.handlers['sweep:now']();
  await plugin.kickQueue();
  const pr = (await loadStore(storeFile)).prs['a/b#7'];
  assert.equal(pr.state, 'skipped');
  assert.match(pr.error, /no gh account/);
});

test('unparseable claude output twice → failed with error tail; retry re-reviews', async () => {
  let good = false;
  const { plugin, storeFile } = await makePlugin({}, () => (good ? REVIEW_JSON : 'i am not json at all'));
  await plugin.handlers['sweep:now']();
  await plugin.kickQueue();
  let pr = (await loadStore(storeFile)).prs['a/b#7'];
  assert.equal(pr.state, 'failed');
  assert.match(pr.error, /JSON/);

  good = true;
  await plugin.handlers['review:retry']({ key: 'a/b#7' });
  await plugin.kickQueue(); // joins the drain the handler kicked off
  pr = (await loadStore(storeFile)).prs['a/b#7'];
  assert.equal(pr.state, 'awaiting_approval');
  assert.equal(pr.error, null);
  assert.equal(pr.draft.findings.length, 1);
});

test('draft edits and dismiss', async () => {
  const { plugin, storeFile } = await makePlugin();
  await plugin.handlers['sweep:now']();
  await plugin.kickQueue();

  await plugin.handlers['summary:update']({ key: 'a/b#7', summary: 'Edited summary.' });
  await plugin.handlers['finding:update']({ key: 'a/b#7', index: 0, body: 'Edited body.' });
  let pr = (await loadStore(storeFile)).prs['a/b#7'];
  assert.equal(pr.draft.summary, 'Edited summary.');
  assert.equal(pr.draft.findings[0].body, 'Edited body.');

  await plugin.handlers['finding:delete']({ key: 'a/b#7', index: 0 });
  pr = (await loadStore(storeFile)).prs['a/b#7'];
  assert.deepEqual(pr.draft.findings, []);
  await assert.rejects(() => plugin.handlers['finding:update']({ key: 'a/b#7', index: 5, body: 'x' }), /index/);

  await plugin.handlers['review:dismiss']({ key: 'a/b#7' });
  pr = (await loadStore(storeFile)).prs['a/b#7'];
  assert.equal(pr.state, 'dismissed');
});

test('submit posts COMMENT review with inline comments and stores the url', async () => {
  const { plugin, exec, storeFile } = await makePlugin();
  await plugin.handlers['sweep:now']();
  await plugin.kickQueue();
  const res = await plugin.handlers['review:submit']({ key: 'a/b#7' });
  assert.match(res.reviewUrl, /pullrequestreview/);

  const post = exec.calls.find((c) => c.args[1] === 'repos/a/b/pulls/7/reviews');
  assert.ok(post.args.includes('--method') && post.args.includes('POST'));
  const payload = JSON.parse(post.opts.input);
  assert.equal(payload.event, 'COMMENT');
  assert.equal(payload.comments.length, 1);
  assert.equal(post.opts.env.GH_TOKEN, 'tok-nikrich');

  const pr = (await loadStore(storeFile)).prs['a/b#7'];
  assert.equal(pr.state, 'submitted');
  assert.match(pr.reviewUrl, /pullrequestreview/);
});

test('submit falls back to folded payload on 422', async () => {
  let posts = 0;
  const { plugin, exec, storeFile } = await makePlugin({
    'gh api': (args, opts) => {
      if (args[1] === 'repos/a/b') return { code: 0, stdout: '{}', stderr: '' };
      if (args[1] === 'repos/a/b/pulls/7')
        return { code: 0, stdout: JSON.stringify({ title: 'Fix', state: 'open', merged: false }), stderr: '' };
      if (args[1] === 'repos/a/b/pulls/7/reviews') {
        posts++;
        if (posts === 1) return { code: 1, stdout: '', stderr: 'HTTP 422: Unprocessable Entity (pull_request_review_thread.line)' };
        return { code: 0, stdout: JSON.stringify({ html_url: 'https://github.com/a/b/pull/7#r2' }), stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'no route' };
    },
  });
  await plugin.handlers['sweep:now']();
  await plugin.kickQueue();
  await plugin.handlers['review:submit']({ key: 'a/b#7' });

  assert.equal(posts, 2);
  const second = exec.calls.filter((c) => c.args[1] === 'repos/a/b/pulls/7/reviews')[1];
  const payload = JSON.parse(second.opts.input);
  assert.deepEqual(payload.comments, []);
  assert.match(payload.body, /Not anchored to the diff/);
  assert.equal((await loadStore(storeFile)).prs['a/b#7'].state, 'submitted');
});

test('env:check reports tool availability', async () => {
  const { plugin } = await makePlugin({
    'claude --version': () => ({ code: 0, stdout: '2.0.0', stderr: '' }),
    'gh --version': () => ({ code: 0, stdout: 'gh version', stderr: '' }),
  });
  const env = await plugin.handlers['env:check']();
  assert.deepEqual(env, { claude: true, gh: true, accounts: 1 });
});
