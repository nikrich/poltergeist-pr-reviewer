# PR Reviewer Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Poltergeist plugin that detects GitHub PR links in vault captures, reviews each PR once with headless Claude Code, and submits user-approved reviews via `gh` under the right account.

**Architecture:** Pure logic lives in `src/lib/*.cjs` modules (detection, state machine, account resolution, prompt/output handling, submit payloads) so it is unit-testable with `node --test`. `src/main.cjs` wires them into the Poltergeist plugin lifecycle with injectable side-effect deps (`exec`, `runClaude`, `notify`) so the pipeline is testable end-to-end without real gh/claude. The renderer is a small React app bundled by esbuild, copied structurally from the sibling `poltergeist-freelancer` plugin.

**Tech Stack:** Node (CommonJS libs), esbuild, React 19 (bundled into renderer), `node --test`, `gh` CLI, `claude` CLI.

**Spec:** `docs/superpowers/specs/2026-07-10-pr-reviewer-design.md` (same repo).

## Global Constraints

- Repo root: `/Users/jannik/development/nikrich/poltergeist-pr-reviewer`. All paths below are relative to it. Run all commands from the repo root.
- Manifest: `id` = `pr-reviewer`, `apiVersion` = literally `1`, `entry.main` must be `*.cjs`, `entry.renderer` must be `*.mjs`, icon `git-pull-request`.
- `dist/` is COMMITTED, never gitignored — the app installs the repo as-is and never builds it.
- ipc channel names must match `^[a-z0-9:_-]+$` (lowercase, no dots).
- Mutable state goes in `ctx.dataDir`, never in the plugin install dir.
- gh tokens are NEVER persisted to disk or the state store — only account logins are cached.
- GitHub review event is always `COMMENT` — never `APPROVE` or `REQUEST_CHANGES`.
- The global gh active account is never switched — every gh call sets `GH_TOKEN` in its env.
- Everything crossing ipc must be JSON-serializable.
- Reference implementation for host-API patterns: `/Users/jannik/development/nikrich/poltergeist-freelancer` (read-only; do not modify it).
- Commit after every task with the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Structure

```
manifest.json              # plugin contract
package.json build.mjs     # build + test scripts (esbuild, node --test)
.gitignore                 # node_modules only — NOT dist
src/main.cjs               # activate/deactivate, sweep loop, review queue, ipc handlers
src/lib/detect.cjs         # PR-URL extraction, mtime-change diffing        (Task 2)
src/lib/state.cjs          # store shape, state machine, atomic persistence (Task 3)
src/lib/accounts.cjs       # gh auth parsing, token fetch, repo-access probe (Task 4)
src/lib/runner.cjs         # prompt assembly, claude CLI/review output parsing (Task 5)
src/lib/submit.cjs         # GitHub review payload construction + fold fallback (Task 6)
src/renderer.jsx           # tab shell (React)
src/ui/kit.jsx             # styling primitives, copied from freelancer
src/ui/tabs/reviews.jsx    # queue/approval/history UI
src/ui/tabs/settings.jsx   # config UI
test/*.test.mjs            # node --test units per lib + main pipeline
dist/main.cjs dist/renderer.mjs   # committed build output
README.md
```

---

### Task 1: Scaffold, manifest, build pipeline

**Files:**
- Create: `manifest.json`, `package.json`, `build.mjs`, `.gitignore`, `src/main.cjs` (placeholder), `src/renderer.jsx` (placeholder)

**Interfaces:**
- Produces: a repo where `npm run build` emits `dist/main.cjs` + `dist/renderer.mjs` and `npm test` runs `test/*.test.mjs`. Later tasks replace the placeholder entries.

- [ ] **Step 1: Write the config files**

`manifest.json`:

```json
{
  "id": "pr-reviewer",
  "name": "PR Reviewer",
  "version": "0.1.0",
  "description": "Watches your vault for GitHub PR links, reviews them with headless Claude Code, and submits approved reviews via gh",
  "apiVersion": 1,
  "icon": "git-pull-request",
  "entry": { "main": "dist/main.cjs", "renderer": "dist/renderer.mjs" }
}
```

`package.json`:

```json
{
  "name": "poltergeist-pr-reviewer",
  "private": true,
  "version": "0.1.0",
  "scripts": {
    "build": "node build.mjs",
    "test": "node --test \"test/*.test.mjs\""
  },
  "devDependencies": {
    "esbuild": "^0.25.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  }
}
```

`build.mjs` (same shape as freelancer's):

```js
import { build } from 'esbuild';

// Renderer: React bundled in, ESM for the app's dynamic import via plugin://
await build({
  entryPoints: ['src/renderer.jsx'],
  outfile: 'dist/renderer.mjs',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});

// Main: CommonJS for require() in the Electron main process.
// electron is provided by the host app at runtime — never bundle it.
await build({
  entryPoints: ['src/main.cjs'],
  outfile: 'dist/main.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  minify: true,
  logLevel: 'info',
});
```

`.gitignore` (dist is deliberately NOT ignored):

```
node_modules/
```

- [ ] **Step 2: Write placeholder entries so the build passes**

`src/main.cjs`:

```js
module.exports = {
  activate(ctx) {
    ctx.log('pr-reviewer activated (placeholder)');
  },
  deactivate() {},
};
```

`src/renderer.jsx`:

```jsx
export function mount(el) {
  el.textContent = 'pr-reviewer placeholder';
  return () => {
    el.textContent = '';
  };
}
```

- [ ] **Step 3: Install and build**

Run: `npm install && npm run build`
Expected: esbuild logs two outputs; `dist/main.cjs` and `dist/renderer.mjs` exist.

- [ ] **Step 4: Commit**

```bash
git add manifest.json package.json package-lock.json build.mjs .gitignore src dist
git commit -m "chore: scaffold pr-reviewer plugin (manifest, build, placeholder entries)"
```

---

### Task 2: `src/lib/detect.cjs` — PR-URL extraction and change diffing

**Files:**
- Create: `src/lib/detect.cjs`
- Test: `test/detect.test.mjs`

**Interfaces:**
- Produces:
  - `extractPrRefs(text: string) → Array<{key, owner, repo, number, url}>` — deduped per text; `key` is `` `${owner}/${repo}#${number}` ``; `url` is the canonical `https://github.com/{owner}/{repo}/pull/{n}`.
  - `changedFiles(files: Array<{path, mtimeMs}>, cache: Record<path, mtimeMs>) → { changed: Array<{path, mtimeMs}>, cache }` — files whose mtime differs from the cache, plus the next cache (deleted files drop out).

- [ ] **Step 1: Write the failing test**

`test/detect.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extractPrRefs, changedFiles } = require('../src/lib/detect.cjs');

test('extractPrRefs finds and normalizes PR URLs', () => {
  const text = `
    Check https://github.com/nikrich/poltergeist-freelancer/pull/4 please.
    Also [this](https://github.com/acme/my.repo/pull/12/files) and
    http://github.com/acme/my.repo/pull/12 again (dupe).
  `;
  const refs = extractPrRefs(text);
  assert.equal(refs.length, 2);
  assert.deepEqual(refs[0], {
    key: 'nikrich/poltergeist-freelancer#4',
    owner: 'nikrich',
    repo: 'poltergeist-freelancer',
    number: 4,
    url: 'https://github.com/nikrich/poltergeist-freelancer/pull/4',
  });
  assert.equal(refs[1].key, 'acme/my.repo#12');
});

test('extractPrRefs ignores non-PR github URLs and returns [] on none', () => {
  assert.deepEqual(extractPrRefs('see https://github.com/acme/repo/issues/9 and github.com/acme/repo'), []);
  assert.deepEqual(extractPrRefs(''), []);
});

test('extractPrRefs does not swallow markdown link punctuation', () => {
  const refs = extractPrRefs('(https://github.com/a/b/pull/7)');
  assert.equal(refs[0].key, 'a/b#7');
});

test('changedFiles diffs against mtime cache and rebuilds it', () => {
  const files = [
    { path: '/v/a.md', mtimeMs: 100 },
    { path: '/v/b.md', mtimeMs: 200 },
  ];
  const first = changedFiles(files, {});
  assert.equal(first.changed.length, 2);
  assert.deepEqual(first.cache, { '/v/a.md': 100, '/v/b.md': 200 });

  const second = changedFiles([{ path: '/v/a.md', mtimeMs: 100 }, { path: '/v/b.md', mtimeMs: 250 }], first.cache);
  assert.deepEqual(second.changed, [{ path: '/v/b.md', mtimeMs: 250 }]);
  // deleted file dropped from next cache
  const third = changedFiles([{ path: '/v/b.md', mtimeMs: 250 }], second.cache);
  assert.deepEqual(third.cache, { '/v/b.md': 250 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/lib/detect.cjs'`

- [ ] **Step 3: Write the implementation**

`src/lib/detect.cjs`:

```js
// PR-link detection over capture text + sweep change diffing. Pure logic —
// filesystem walking and stat-ing stay in main.cjs.

const PR_URL_RE = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g;

/** All distinct PRs referenced in a text. Dedupe per owner/repo#number. */
function extractPrRefs(text) {
  const out = new Map();
  for (const m of String(text).matchAll(PR_URL_RE)) {
    const [, owner, repo, num] = m;
    const number = Number(num);
    const key = `${owner}/${repo}#${number}`;
    if (!out.has(key)) {
      out.set(key, { key, owner, repo, number, url: `https://github.com/${owner}/${repo}/pull/${number}` });
    }
  }
  return [...out.values()];
}

/** Files whose mtime differs from the cache; returns the rebuilt cache. */
function changedFiles(files, cache = {}) {
  const changed = [];
  const next = {};
  for (const f of files) {
    next[f.path] = f.mtimeMs;
    if (cache[f.path] !== f.mtimeMs) changed.push(f);
  }
  return { changed, cache: next };
}

module.exports = { extractPrRefs, changedFiles };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all detect tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/detect.cjs test/detect.test.mjs
git commit -m "feat: PR-URL extraction and mtime change diffing"
```

---

### Task 3: `src/lib/state.cjs` — state store and machine

**Files:**
- Create: `src/lib/state.cjs`
- Test: `test/state.test.mjs`

**Interfaces:**
- Consumes: refs from `extractPrRefs` (Task 2).
- Produces:
  - `emptyStore() → { prs: {}, accountCache: {}, sweepCache: {} }`
  - `upsertDetected(store, ref, sourceNote: string, nowIso: string) → { isNew: boolean }` — mutates store; existing PRs collect `sourceNote` into `sources`, no state change.
  - `transition(store, key, to, nowIso, patch?) → pr` — enforces the machine below, applies `patch` onto the pr record, stamps `pr.timestamps[to]`.
  - `recoverInterrupted(store, nowIso) → number` — resets every `reviewing` pr to `detected`, returns count.
  - `loadStore(file) → Promise<store>` (missing/corrupt file → `emptyStore()`), `saveStore(file, store) → Promise<void>` (atomic: tmp + rename).
  - PR record shape (all later tasks rely on it): `{ key, owner, repo, number, url, title, state, sources: string[], account: string|null, draft: {summary, verdict, findings[]}|null, error: string|null, reviewUrl: string|null, timestamps: Record<state, iso> }`.
  - State machine: `detected → reviewing|skipped|dismissed`; `reviewing → awaiting_approval|failed|detected`; `awaiting_approval → submitted|dismissed`; `failed → detected|dismissed`; `submitted|dismissed|skipped` terminal.

- [ ] **Step 1: Write the failing test**

`test/state.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/lib/state.cjs'`

- [ ] **Step 3: Write the implementation**

`src/lib/state.cjs`:

```js
// PR review state store: one JSON document in dataDir. Tokens are never
// stored here — accountCache maps owner/repo → login only.

const fsp = require('node:fs/promises');
const path = require('node:path');

const TRANSITIONS = {
  detected: ['reviewing', 'skipped', 'dismissed'],
  reviewing: ['awaiting_approval', 'failed', 'detected'], // → detected = crash recovery
  awaiting_approval: ['submitted', 'dismissed'],
  failed: ['detected', 'dismissed'],
  submitted: [],
  dismissed: [],
  skipped: [],
};

function emptyStore() {
  return { prs: {}, accountCache: {}, sweepCache: {} };
}

function upsertDetected(store, ref, sourceNote, nowIso) {
  const existing = store.prs[ref.key];
  if (existing) {
    if (!existing.sources.includes(sourceNote)) existing.sources.push(sourceNote);
    return { isNew: false };
  }
  store.prs[ref.key] = {
    key: ref.key,
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    url: ref.url,
    title: '',
    state: 'detected',
    sources: [sourceNote],
    account: null,
    draft: null,
    error: null,
    reviewUrl: null,
    timestamps: { detected: nowIso },
  };
  return { isNew: true };
}

function transition(store, key, to, nowIso, patch = {}) {
  const pr = store.prs[key];
  if (!pr) throw new Error(`unknown pr ${key}`);
  const allowed = TRANSITIONS[pr.state] ?? [];
  if (!allowed.includes(to)) throw new Error(`illegal transition ${pr.state} → ${to} for ${key}`);
  Object.assign(pr, patch);
  pr.state = to;
  pr.timestamps[to] = nowIso;
  return pr;
}

function recoverInterrupted(store, nowIso) {
  let n = 0;
  for (const pr of Object.values(store.prs)) {
    if (pr.state === 'reviewing') {
      transition(store, pr.key, 'detected', nowIso);
      n++;
    }
  }
  return n;
}

async function loadStore(file) {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    return { ...emptyStore(), ...parsed };
  } catch {
    return emptyStore();
  }
}

async function saveStore(file, store) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

module.exports = { TRANSITIONS, emptyStore, upsertDetected, transition, recoverInterrupted, loadStore, saveStore };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/state.cjs test/state.test.mjs
git commit -m "feat: PR state store with enforced state machine and atomic persistence"
```

---

### Task 4: `src/lib/accounts.cjs` — gh account resolution

**Files:**
- Create: `src/lib/accounts.cjs`
- Test: `test/accounts.test.mjs`

**Interfaces:**
- Consumes: an injected `exec(cmd: string, args: string[], opts?: {env?, cwd?, input?, timeout?}) → Promise<{code, stdout, stderr}>` (never rejects; nonzero exit → `code !== 0`). Task 7 provides the real one.
- Produces:
  - `parseAuthStatus(text) → Array<{host, login}>` (deduped)
  - `listAccounts(exec) → Promise<Array<{host, login}>>` — parses stdout+stderr of `gh auth status`; throws `no gh accounts` when empty.
  - `getToken(exec, {host, login}) → Promise<string>` — via `gh auth token --user <login> --hostname <host>`; throws on failure.
  - `resolveAccount(exec, owner, repo, {preferLogin}?) → Promise<{host, login, token} | null>` — probes `gh api repos/{owner}/{repo}` per account with `GH_TOKEN`; `preferLogin` is tried first; `null` when nobody has access.
  - `fetchPrMeta(exec, token, owner, repo, number) → Promise<{title, state, merged}>`
  - `ghEnv(token) → env object` (spreads `process.env`, sets `GH_TOKEN` and `GIT_TERMINAL_PROMPT: '0'`)

- [ ] **Step 1: Write the failing test**

`test/accounts.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseAuthStatus, listAccounts, getToken, resolveAccount, fetchPrMeta, ghEnv } =
  require('../src/lib/accounts.cjs');

const AUTH_STATUS = `github.com
  ✓ Logged in to github.com account nikrich (keyring)
  - Active account: true
  - Git operations protocol: https
  ✓ Logged in to github.com account jannik-sanlam (keyring)
  - Active account: false
`;

test('parseAuthStatus extracts host/login pairs and dedupes', () => {
  assert.deepEqual(parseAuthStatus(AUTH_STATUS), [
    { host: 'github.com', login: 'nikrich' },
    { host: 'github.com', login: 'jannik-sanlam' },
  ]);
  assert.deepEqual(parseAuthStatus(AUTH_STATUS + AUTH_STATUS), [
    { host: 'github.com', login: 'nikrich' },
    { host: 'github.com', login: 'jannik-sanlam' },
  ]);
  assert.deepEqual(parseAuthStatus('You are not logged into any GitHub hosts.'), []);
});

/** Scriptable fake exec: routes by command signature, records calls. */
function fakeExec(routes) {
  const calls = [];
  const exec = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts });
    for (const r of routes) if (r.match(cmd, args)) return { code: 0, stdout: '', stderr: '', ...r.result(cmd, args, opts) };
    return { code: 1, stdout: '', stderr: `no route for ${cmd} ${args.join(' ')}` };
  };
  exec.calls = calls;
  return exec;
}

test('listAccounts parses gh auth status (stderr too) and throws on none', async () => {
  const exec = fakeExec([
    { match: (c, a) => a[0] === 'auth' && a[1] === 'status', result: () => ({ stderr: AUTH_STATUS }) },
  ]);
  assert.equal((await listAccounts(exec)).length, 2);

  const none = fakeExec([{ match: () => true, result: () => ({ code: 1, stderr: 'not logged in' }) }]);
  await assert.rejects(() => listAccounts(none), /no gh accounts/);
});

test('resolveAccount probes accounts in order, preferLogin first, null when none fit', async () => {
  const routes = [
    { match: (c, a) => a[0] === 'auth' && a[1] === 'status', result: () => ({ stdout: AUTH_STATUS }) },
    { match: (c, a) => a[0] === 'auth' && a[1] === 'token', result: (c, a) => ({ stdout: `tok-${a[3]}\n` }) },
    {
      match: (c, a) => a[0] === 'api' && a[1] === 'repos/sanlam/secret',
      result: (c, a, o) => (o.env.GH_TOKEN === 'tok-jannik-sanlam' ? { stdout: '{}' } : { code: 1, stderr: 'HTTP 404' }),
    },
  ];
  const exec = fakeExec(routes);
  const hit = await resolveAccount(exec, 'sanlam', 'secret');
  assert.deepEqual(hit, { host: 'github.com', login: 'jannik-sanlam', token: 'tok-jannik-sanlam' });

  // preferLogin skips the failing probe of the first account
  const exec2 = fakeExec(routes);
  await resolveAccount(exec2, 'sanlam', 'secret', { preferLogin: 'jannik-sanlam' });
  const probes = exec2.calls.filter((c) => c.args[0] === 'api');
  assert.equal(probes.length, 1);

  const execNone = fakeExec([
    { match: (c, a) => a[0] === 'auth' && a[1] === 'status', result: () => ({ stdout: AUTH_STATUS }) },
    { match: (c, a) => a[0] === 'auth' && a[1] === 'token', result: (c, a) => ({ stdout: `tok-${a[3]}\n` }) },
    { match: (c, a) => a[0] === 'api', result: () => ({ code: 1, stderr: 'HTTP 404' }) },
  ]);
  assert.equal(await resolveAccount(execNone, 'sanlam', 'secret'), null);
});

test('getToken threads --user and --hostname; fetchPrMeta parses PR JSON', async () => {
  const exec = fakeExec([
    { match: (c, a) => a[0] === 'auth' && a[1] === 'token', result: () => ({ stdout: 'tok\n' }) },
    {
      match: (c, a) => a[0] === 'api' && a[1] === 'repos/a/b/pulls/7',
      result: () => ({ stdout: JSON.stringify({ title: 'Fix it', state: 'open', merged: false }) }),
    },
  ]);
  assert.equal(await getToken(exec, { host: 'ghe.example.com', login: 'me' }), 'tok');
  const tokenCall = exec.calls[0];
  assert.deepEqual(tokenCall.args, ['auth', 'token', '--user', 'me', '--hostname', 'ghe.example.com']);

  const meta = await fetchPrMeta(exec, 'tok', 'a', 'b', 7);
  assert.deepEqual(meta, { title: 'Fix it', state: 'open', merged: false });
  assert.equal(exec.calls[1].opts.env.GH_TOKEN, 'tok');
});

test('ghEnv sets GH_TOKEN and disables git prompts', () => {
  const env = ghEnv('t0k');
  assert.equal(env.GH_TOKEN, 't0k');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.PATH, process.env.PATH);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/lib/accounts.cjs'`

- [ ] **Step 3: Write the implementation**

`src/lib/accounts.cjs`:

```js
// Multi-account gh resolution. The global active account is never switched:
// every call sets GH_TOKEN in its own env. Tokens live in memory only.

function ghEnv(token) {
  return { ...process.env, GH_TOKEN: token, GIT_TERMINAL_PROMPT: '0' };
}

/** gh writes auth status to stdout or stderr depending on version — parse both. */
function parseAuthStatus(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text).split('\n')) {
    const m = line.match(/Logged in to (\S+) account (\S+)/);
    if (!m) continue;
    const id = `${m[1]}:${m[2]}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ host: m[1], login: m[2] });
  }
  return out;
}

async function listAccounts(exec) {
  const r = await exec('gh', ['auth', 'status']);
  const accounts = parseAuthStatus(`${r.stdout}\n${r.stderr}`);
  if (!accounts.length) throw new Error('no gh accounts — run `gh auth login`');
  return accounts;
}

async function getToken(exec, account) {
  const r = await exec('gh', ['auth', 'token', '--user', account.login, '--hostname', account.host]);
  const token = r.stdout.trim();
  if (r.code !== 0 || !token) throw new Error(`no token for ${account.login}: ${r.stderr.trim()}`);
  return token;
}

/** First authenticated account that can see owner/repo, preferLogin tried first. */
async function resolveAccount(exec, owner, repo, { preferLogin } = {}) {
  const accounts = await listAccounts(exec);
  const ordered = [
    ...accounts.filter((a) => a.login === preferLogin),
    ...accounts.filter((a) => a.login !== preferLogin),
  ];
  for (const account of ordered) {
    let token;
    try {
      token = await getToken(exec, account);
    } catch {
      continue;
    }
    const probe = await exec('gh', ['api', `repos/${owner}/${repo}`], { env: ghEnv(token) });
    if (probe.code === 0) return { host: account.host, login: account.login, token };
  }
  return null;
}

async function fetchPrMeta(exec, token, owner, repo, number) {
  const r = await exec('gh', ['api', `repos/${owner}/${repo}/pulls/${number}`], { env: ghEnv(token) });
  if (r.code !== 0) throw new Error(`fetch PR meta failed: ${r.stderr.trim().slice(0, 500)}`);
  const j = JSON.parse(r.stdout);
  return { title: j.title ?? '', state: j.state, merged: !!j.merged };
}

module.exports = { ghEnv, parseAuthStatus, listAccounts, getToken, resolveAccount, fetchPrMeta };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/accounts.cjs test/accounts.test.mjs
git commit -m "feat: gh multi-account resolution via per-call GH_TOKEN, no global switch"
```

---

### Task 5: `src/lib/runner.cjs` — prompt assembly and output parsing

**Files:**
- Create: `src/lib/runner.cjs`
- Test: `test/runner.test.mjs`

**Interfaces:**
- Consumes: engine config `{ prompt: string, thoroughness: 'quick'|'standard'|'thorough', skill: string }` and a pr record (Task 3 shape, with `title` populated).
- Produces:
  - `buildPrompt(engine, pr) → string` — skill mode when `engine.skill` is set (message starts with `/<skill>`); prompt mode otherwise; both end with `OUTPUT_CONTRACT`.
  - `parseClaudeCliOutput(stdout) → string` — unwraps `claude -p --output-format json` (`{type:'result', result, is_error}`); throws on non-JSON, missing result, or `is_error`.
  - `parseReviewOutput(text) → {summary, verdict, findings: [{path, line, severity, body}]}` — extracts/validates the review JSON (bare, fenced, or embedded); throws with a specific reason on invalid shape. Unknown severity coerces to `'issue'`.
  - Constants Task 7 uses: `DEFAULT_PROMPT`, `OUTPUT_CONTRACT`, `RETRY_SUFFIX`, `ALLOWED_TOOLS`.

- [ ] **Step 1: Write the failing test**

`test/runner.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildPrompt, parseClaudeCliOutput, parseReviewOutput, OUTPUT_CONTRACT } =
  require('../src/lib/runner.cjs');

const pr = { key: 'a/b#7', owner: 'a', repo: 'b', number: 7, url: 'https://github.com/a/b/pull/7', title: 'Fix parser' };

test('buildPrompt prompt mode: header, custom prompt, thoroughness, contract', () => {
  const p = buildPrompt({ prompt: 'Focus on concurrency.', thoroughness: 'thorough', skill: '' }, pr);
  assert.match(p, /pull request #7/);
  assert.match(p, /Fix parser/);
  assert.match(p, /Focus on concurrency\./);
  assert.match(p, /callers/i); // thorough preamble mentions exploring callers
  assert.ok(p.endsWith(OUTPUT_CONTRACT));
});

test('buildPrompt prompt mode falls back to default prompt and standard thoroughness', () => {
  const p = buildPrompt({ prompt: '  ', thoroughness: 'bogus', skill: '' }, pr);
  assert.match(p, /correctness/i); // default prompt
  assert.ok(p.endsWith(OUTPUT_CONTRACT));
});

test('buildPrompt skill mode starts with the slash command', () => {
  const p = buildPrompt({ prompt: '', thoroughness: 'standard', skill: 'code-review' }, pr);
  assert.ok(p.startsWith('/code-review https://github.com/a/b/pull/7'));
  assert.ok(p.endsWith(OUTPUT_CONTRACT));
  // leading slash in config is tolerated
  assert.ok(buildPrompt({ skill: '/code-review' }, pr).startsWith('/code-review '));
});

test('parseClaudeCliOutput unwraps the CLI JSON envelope', () => {
  assert.equal(parseClaudeCliOutput(JSON.stringify({ type: 'result', is_error: false, result: 'hello' })), 'hello');
  assert.throws(() => parseClaudeCliOutput('not json'), /not JSON/);
  assert.throws(() => parseClaudeCliOutput(JSON.stringify({ type: 'result', is_error: true, result: 'ran out' })), /errored/);
  assert.throws(() => parseClaudeCliOutput(JSON.stringify({ type: 'result' })), /missing result/);
});

const GOOD = {
  summary: 'Looks solid overall.',
  verdict: 'minor issues only',
  findings: [{ path: 'src/a.js', line: 12, severity: 'issue', body: 'Off-by-one.' }],
};

test('parseReviewOutput accepts bare, fenced, and embedded JSON', () => {
  assert.deepEqual(parseReviewOutput(JSON.stringify(GOOD)), GOOD);
  assert.deepEqual(parseReviewOutput('Here you go:\n```json\n' + JSON.stringify(GOOD) + '\n```'), GOOD);
  assert.deepEqual(parseReviewOutput('preamble ' + JSON.stringify(GOOD) + ' trailing'), GOOD);
});

test('parseReviewOutput validates shape and coerces severity', () => {
  assert.throws(() => parseReviewOutput('no json here'), /no JSON object/);
  assert.throws(() => parseReviewOutput('{"findings": []}'), /summary/);
  assert.throws(() => parseReviewOutput('{"summary": "s"}'), /findings/);
  assert.throws(
    () => parseReviewOutput(JSON.stringify({ summary: 's', findings: [{ path: 'a', line: 0, body: 'x' }] })),
    /line/
  );
  assert.throws(
    () => parseReviewOutput(JSON.stringify({ summary: 's', findings: [{ path: '', line: 1, body: 'x' }] })),
    /path/
  );
  const coerced = parseReviewOutput(
    JSON.stringify({ summary: 's', findings: [{ path: 'a', line: '3', severity: 'meh', body: 'x' }] })
  );
  assert.equal(coerced.verdict, '');
  assert.deepEqual(coerced.findings[0], { path: 'a', line: 3, severity: 'issue', body: 'x' });
  assert.deepEqual(parseReviewOutput('{"summary":"s","findings":[]}').findings, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/lib/runner.cjs'`

- [ ] **Step 3: Write the implementation**

`src/lib/runner.cjs`:

```js
// Prompt assembly + claude CLI output handling. Spawning stays in main.cjs.

const DEFAULT_PROMPT =
  'Review this pull request for correctness bugs, security issues, and significant design problems. Skip style nits unless they obscure meaning.';

const THOROUGHNESS = {
  quick:
    'Limit yourself to the diff (`gh pr diff`) — do not explore the wider codebase. Flag only clear problems.',
  standard:
    'Read the diff, and open the files it touches to check the surrounding context before judging.',
  thorough:
    'Read the diff, explore every file it touches plus their callers and tests, and verify each claim in the code before reporting it.',
};

const OUTPUT_CONTRACT = `When you are done, your FINAL message must be exactly one JSON object — no prose before or after — matching:
{"summary": "<markdown review summary>", "verdict": "<one-line overall judgement>", "findings": [{"path": "<repo-relative file path>", "line": <line number in the NEW version of the file>, "severity": "blocker|issue|nit", "body": "<markdown comment for that line>"}]}
Only include findings you are confident in. Use "findings": [] when there are none.`;

const RETRY_SUFFIX =
  '\n\nYour previous reply was not a single valid JSON object. Reply again with ONLY the JSON object described above.';

// Read/explore + gh read-only. No write, no push, no arbitrary shell.
const ALLOWED_TOOLS =
  'Read Glob Grep LS Bash(git log:*) Bash(git diff:*) Bash(git show:*) Bash(gh pr view:*) Bash(gh pr diff:*)';

function buildPrompt(engine = {}, pr) {
  let core;
  if (engine.skill && engine.skill.trim()) {
    // Slash command must start the message; contract text rides along as args.
    core = `/${engine.skill.trim().replace(/^\//, '')} ${pr.url}`;
  } else {
    const header = `You are reviewing GitHub pull request #${pr.number} — "${pr.title}" (${pr.url}). The repository is checked out at the PR head in the current directory.`;
    const prompt = engine.prompt && engine.prompt.trim() ? engine.prompt.trim() : DEFAULT_PROMPT;
    const depth = THOROUGHNESS[engine.thoroughness] ?? THOROUGHNESS.standard;
    core = `${header}\n\n${prompt}\n\n${depth}`;
  }
  return `${core}\n\n${OUTPUT_CONTRACT}`;
}

/** Unwrap `claude -p --output-format json` stdout → the final message text. */
function parseClaudeCliOutput(stdout) {
  let o;
  try {
    o = JSON.parse(stdout);
  } catch {
    throw new Error('claude CLI output was not JSON');
  }
  if (o.is_error) throw new Error(`claude run errored: ${String(o.result ?? '').slice(0, 500)}`);
  if (typeof o.result !== 'string') throw new Error('claude CLI output missing result');
  return o.result;
}

function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch {}
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }
  return null;
}

/** Validate the review contract; throws with a specific reason. */
function parseReviewOutput(text) {
  const obj = extractJson(String(text));
  if (!obj || typeof obj !== 'object') throw new Error('no JSON object in review output');
  if (typeof obj.summary !== 'string' || !obj.summary.trim()) throw new Error('review output missing summary');
  if (!Array.isArray(obj.findings)) throw new Error('review output missing findings array');
  const findings = obj.findings.map((f, i) => {
    if (!f || typeof f.path !== 'string' || !f.path) throw new Error(`finding ${i}: bad path`);
    const line = Number(f.line);
    if (!Number.isInteger(line) || line < 1) throw new Error(`finding ${i}: bad line`);
    if (typeof f.body !== 'string' || !f.body.trim()) throw new Error(`finding ${i}: bad body`);
    const severity = ['blocker', 'issue', 'nit'].includes(f.severity) ? f.severity : 'issue';
    return { path: f.path, line, severity, body: f.body };
  });
  return {
    summary: obj.summary,
    verdict: typeof obj.verdict === 'string' ? obj.verdict : '',
    findings,
  };
}

module.exports = {
  DEFAULT_PROMPT,
  THOROUGHNESS,
  OUTPUT_CONTRACT,
  RETRY_SUFFIX,
  ALLOWED_TOOLS,
  buildPrompt,
  parseClaudeCliOutput,
  parseReviewOutput,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/runner.cjs test/runner.test.mjs
git commit -m "feat: review prompt assembly and claude output contract parsing"
```

---

### Task 6: `src/lib/submit.cjs` — GitHub review payloads

**Files:**
- Create: `src/lib/submit.cjs`
- Test: `test/submit.test.mjs`

**Interfaces:**
- Consumes: draft `{summary, verdict, findings}` (Task 5 shape).
- Produces:
  - `buildReviewPayload(draft) → { body, event: 'COMMENT', comments: [{path, line, side: 'RIGHT', body}] }`
  - `foldAllPayload(draft) → { body, event: 'COMMENT', comments: [] }` — every finding folded into the body under a "Not anchored to the diff" section (422 fallback).
  - `renderSummary(draft, unanchored?) / renderFindingBody(finding)` helpers (exported for tests).

- [ ] **Step 1: Write the failing test**

`test/submit.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildReviewPayload, foldAllPayload, renderFindingBody } = require('../src/lib/submit.cjs');

const draft = {
  summary: 'Overall fine.',
  verdict: 'minor issues',
  findings: [
    { path: 'src/a.js', line: 12, severity: 'blocker', body: 'Race condition.' },
    { path: 'src/b.js', line: 3, severity: 'nit', body: 'Typo.' },
  ],
};

test('buildReviewPayload maps findings to RIGHT-side inline comments, event COMMENT', () => {
  const p = buildReviewPayload(draft);
  assert.equal(p.event, 'COMMENT');
  assert.match(p.body, /Overall fine\./);
  assert.match(p.body, /minor issues/);
  assert.equal(p.comments.length, 2);
  assert.deepEqual(p.comments[0], { path: 'src/a.js', line: 12, side: 'RIGHT', body: '**[blocker]** Race condition.' });
});

test('empty findings → no comments array entries, still COMMENT', () => {
  const p = buildReviewPayload({ summary: 'LGTM-ish.', verdict: '', findings: [] });
  assert.deepEqual(p.comments, []);
  assert.equal(p.event, 'COMMENT');
  assert.equal(p.body.includes('Not anchored'), false);
});

test('foldAllPayload lists every finding in the body with no inline comments', () => {
  const p = foldAllPayload(draft);
  assert.deepEqual(p.comments, []);
  assert.equal(p.event, 'COMMENT');
  assert.match(p.body, /Not anchored to the diff/);
  assert.match(p.body, /`src\/a\.js:12`/);
  assert.match(p.body, /Race condition\./);
  assert.match(p.body, /`src\/b\.js:3`/);
});

test('renderFindingBody prefixes severity', () => {
  assert.equal(renderFindingBody({ severity: 'nit', body: 'Typo.' }), '**[nit]** Typo.');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/lib/submit.cjs'`

- [ ] **Step 3: Write the implementation**

`src/lib/submit.cjs`:

```js
// GitHub review payloads for POST /repos/{o}/{r}/pulls/{n}/reviews.
// Event is always COMMENT — this plugin never approves or requests changes.

function renderFindingBody(f) {
  return `**[${f.severity}]** ${f.body}`;
}

function renderSummary(draft, unanchored = []) {
  let body = draft.summary.trim();
  if (draft.verdict && draft.verdict.trim()) body += `\n\n**Verdict:** ${draft.verdict.trim()}`;
  if (unanchored.length) {
    body +=
      '\n\n---\n**Not anchored to the diff:**\n' +
      unanchored.map((f) => `- \`${f.path}:${f.line}\` — ${renderFindingBody(f)}`).join('\n');
  }
  return body;
}

function buildReviewPayload(draft) {
  return {
    body: renderSummary(draft),
    event: 'COMMENT',
    comments: draft.findings.map((f) => ({ path: f.path, line: f.line, side: 'RIGHT', body: renderFindingBody(f) })),
  };
}

/** 422 fallback: GitHub rejected inline anchoring — fold everything into the body. */
function foldAllPayload(draft) {
  return { body: renderSummary(draft, draft.findings), event: 'COMMENT', comments: [] };
}

module.exports = { renderFindingBody, renderSummary, buildReviewPayload, foldAllPayload };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/submit.cjs test/submit.test.mjs
git commit -m "feat: COMMENT-only review payloads with unanchored fold fallback"
```

---

### Task 7: `src/main.cjs` — plugin main: sweep loop, review queue, ipc handlers

**Files:**
- Modify: `src/main.cjs` (replace placeholder entirely)
- Test: `test/main.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 2–6 (exact exports listed in their Interface blocks); the host `ctx` (pluginId, dataDir, settings, ipc, log).
- Produces:
  - `module.exports = { activate, deactivate, createHandlers }`
  - `createHandlers(ctx, deps?) → { handlers: Record<channel, fn>, sweep(), kickQueue(), recover() }` — deps `{ exec, runClaude, notify, now }` all optional with real defaults. Handlers receive one JSON payload argument.
  - ipc channels (renderer contract, Task 8 consumes): `state:get` → store; `env:check` → `{claude: bool, gh: bool, accounts: number}`; `sweep:now` → `{newPrs, scanned}`; `review:submit {key}` → `{reviewUrl}`; `review:dismiss {key}`; `review:retry {key}`; `summary:update {key, summary}`; `finding:update {key, index, body}`; `finding:delete {key, index}`. Push event: `state:changed`.
  - Config under settings key `config`, defaults: `{ vaultPath: '~/ghostbrain/vault', folders: ['00-inbox', '20-contexts'], pollMinutes: 3, engine: { prompt: '', thoroughness: 'standard', skill: '' }, claudeBin: 'claude', timeoutMinutes: 15 }` (renderer reads/writes the same key via `api.settings`).

- [ ] **Step 1: Write the failing test**

`test/main.test.mjs`:

```js
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
    const sig = `${cmd} ${args.slice(0, 2).join(' ')}`;
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `createHandlers is not a function` (placeholder main has no such export)

- [ ] **Step 3: Write the implementation**

`src/main.cjs` (replace the placeholder entirely):

```js
// PR Reviewer main process: vault sweep → PR detection → claude review →
// approval queue → gh submit. All handlers throw on bad input/failed calls —
// the host rejects only that call, never the plugin. Side effects (exec,
// claude spawn, notifications, clock) are injectable for tests.

const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { extractPrRefs, changedFiles } = require('./lib/detect.cjs');
const { loadStore, saveStore, upsertDetected, transition, recoverInterrupted } = require('./lib/state.cjs');
const { ghEnv, listAccounts, resolveAccount, fetchPrMeta } = require('./lib/accounts.cjs');
const { buildPrompt, parseClaudeCliOutput, parseReviewOutput, RETRY_SUFFIX, ALLOWED_TOOLS } = require('./lib/runner.cjs');
const { buildReviewPayload, foldAllPayload } = require('./lib/submit.cjs');

const DEFAULT_CONFIG = {
  vaultPath: '~/ghostbrain/vault',
  folders: ['00-inbox', '20-contexts'],
  pollMinutes: 3,
  engine: { prompt: '', thoroughness: 'standard', skill: '' },
  claudeBin: 'claude',
  timeoutMinutes: 15,
};

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Never rejects: nonzero exit / spawn error → code !== 0. */
function execP(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { maxBuffer: 16 * 1024 * 1024, timeout: opts.timeout, cwd: opts.cwd, env: opts.env },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) })
    );
    if (opts.input != null && child.stdin) child.stdin.end(opts.input);
  });
}

function notifyDefault(title, body) {
  try {
    const { Notification } = require('electron');
    new Notification({ title, body }).show();
  } catch {
    /* headless / tests */
  }
}

async function walkMd(dir, out) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walkMd(p, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
}

/** Exported for tests: handler map + pipeline from a ctx + injectable deps. */
function createHandlers(ctx, deps = {}) {
  const exec = deps.exec ?? execP;
  const notify = deps.notify ?? notifyDefault;
  const now = deps.now ?? (() => new Date().toISOString());
  const runClaude =
    deps.runClaude ??
    (async ({ bin, prompt, cwd, timeoutMs, env }) => {
      const r = await exec(bin, ['-p', prompt, '--output-format', 'json', '--allowedTools', ALLOWED_TOOLS], {
        cwd,
        env,
        timeout: timeoutMs,
      });
      if (r.code !== 0) throw new Error(`claude exited ${r.code}: ${(r.stderr || r.stdout).slice(-2000)}`);
      return parseClaudeCliOutput(r.stdout);
    });

  const storeFile = path.join(ctx.dataDir, 'state.json');

  async function config() {
    const c = (await ctx.settings.get('config')) ?? {};
    return { ...DEFAULT_CONFIG, ...c, engine: { ...DEFAULT_CONFIG.engine, ...(c.engine ?? {}) } };
  }

  function pushChanged() {
    ctx.ipc.send('state:changed', {});
  }

  /* ---------- sweep ---------- */

  async function sweep() {
    const cfg = await config();
    const vault = expandHome(cfg.vaultPath);
    const files = [];
    for (const sub of cfg.folders) await walkMd(path.join(vault, sub), files);
    const withStat = [];
    for (const f of files) {
      try {
        const st = await fsp.stat(f);
        withStat.push({ path: f, mtimeMs: st.mtimeMs });
      } catch {}
    }
    const store = await loadStore(storeFile);
    const { changed, cache } = changedFiles(withStat, store.sweepCache);
    store.sweepCache = cache;
    let newPrs = 0;
    for (const f of changed) {
      let text;
      try {
        text = await fsp.readFile(f.path, 'utf8');
      } catch {
        continue;
      }
      const rel = path.relative(vault, f.path);
      for (const ref of extractPrRefs(text)) {
        if (upsertDetected(store, ref, rel, now()).isNew) newPrs++;
      }
    }
    await saveStore(storeFile, store);
    if (newPrs) pushChanged();
    return { newPrs, scanned: changed.length };
  }

  /* ---------- review queue (serial) ---------- */

  let queueRun = null;

  /** Serial drain of detected PRs; concurrent kicks join the in-flight run. */
  function kickQueue() {
    if (!queueRun) {
      queueRun = (async () => {
        for (;;) {
          const store = await loadStore(storeFile);
          const next = Object.values(store.prs)
            .filter((p) => p.state === 'detected')
            .sort((a, b) => (a.timestamps.detected < b.timestamps.detected ? -1 : 1))[0];
          if (!next) break;
          await reviewOne(next.key);
        }
      })().finally(() => {
        queueRun = null;
      });
    }
    return queueRun;
  }

  async function reviewOne(key) {
    const cfg = await config();
    let store = await loadStore(storeFile);
    const pr = store.prs[key];
    const repoKey = `${pr.owner}/${pr.repo}`;

    // Resolve account + PR meta before committing to a review.
    let resolved;
    try {
      resolved = await resolveAccount(exec, pr.owner, pr.repo, { preferLogin: store.accountCache[repoKey] });
    } catch (err) {
      transition(store, key, 'skipped', now(), { error: err.message });
      await saveStore(storeFile, store);
      pushChanged();
      return;
    }
    if (!resolved) {
      transition(store, key, 'skipped', now(), { error: `no gh account with access to ${repoKey}` });
      await saveStore(storeFile, store);
      pushChanged();
      return;
    }
    store.accountCache[repoKey] = resolved.login;

    let meta;
    try {
      meta = await fetchPrMeta(exec, resolved.token, pr.owner, pr.repo, pr.number);
    } catch (err) {
      transition(store, key, 'failed', now(), { error: err.message });
      await saveStore(storeFile, store);
      pushChanged();
      return;
    }
    if (meta.state !== 'open') {
      transition(store, key, 'skipped', now(), { error: `PR is ${meta.merged ? 'merged' : meta.state}` });
      await saveStore(storeFile, store);
      pushChanged();
      return;
    }

    transition(store, key, 'reviewing', now(), { account: resolved.login, title: meta.title, error: null });
    await saveStore(storeFile, store);
    pushChanged();

    const ws = path.join(ctx.dataDir, 'workspaces', `${pr.owner}-${pr.repo}-${pr.number}`);
    try {
      await fsp.rm(ws, { recursive: true, force: true });
      await fsp.mkdir(path.dirname(ws), { recursive: true });
      const env = ghEnv(resolved.token);
      let r = await exec('gh', ['repo', 'clone', repoKey, ws, '--', '--depth', '50'], { env });
      if (r.code !== 0) throw new Error(`clone failed: ${r.stderr.slice(-500)}`);
      r = await exec('gh', ['pr', 'checkout', String(pr.number)], { cwd: ws, env });
      if (r.code !== 0) throw new Error(`pr checkout failed: ${r.stderr.slice(-500)}`);

      const prompt = buildPrompt(cfg.engine, { ...pr, title: meta.title });
      const claudeOpts = { bin: cfg.claudeBin, cwd: ws, timeoutMs: cfg.timeoutMinutes * 60_000, env };
      let draft;
      try {
        draft = parseReviewOutput(await runClaude({ ...claudeOpts, prompt }));
      } catch {
        // one corrective retry on malformed output
        draft = parseReviewOutput(await runClaude({ ...claudeOpts, prompt: prompt + RETRY_SUFFIX }));
      }

      store = await loadStore(storeFile);
      transition(store, key, 'awaiting_approval', now(), { draft });
      await saveStore(storeFile, store);
      notify('PR review ready', `${key}: ${meta.title}`);
      pushChanged();
    } catch (err) {
      store = await loadStore(storeFile);
      transition(store, key, 'failed', now(), { error: String(err.message ?? err).slice(0, 2000) });
      await saveStore(storeFile, store);
      pushChanged();
    } finally {
      await fsp.rm(ws, { recursive: true, force: true }).catch(() => {});
    }
  }

  /* ---------- draft helpers ---------- */

  async function withDraft(key, fn) {
    const store = await loadStore(storeFile);
    const pr = store.prs[key];
    if (!pr) throw new Error(`unknown pr ${key}`);
    if (pr.state !== 'awaiting_approval' || !pr.draft) throw new Error(`${key} has no editable draft`);
    fn(pr);
    await saveStore(storeFile, store);
    return { ok: true };
  }

  /* ---------- handlers ---------- */

  const handlers = {
    'state:get': async () => loadStore(storeFile),

    'env:check': async () => {
      const cfg = await config();
      const claude = (await exec(cfg.claudeBin, ['--version'])).code === 0;
      const gh = (await exec('gh', ['--version'])).code === 0;
      let accounts = 0;
      try {
        accounts = (await listAccounts(exec)).length;
      } catch {}
      return { claude, gh, accounts };
    },

    'sweep:now': async () => {
      const res = await sweep();
      // fire-and-forget: reviews run long; don't block the invoke
      kickQueue().catch((err) => ctx.log('queue failed:', err.message));
      return res;
    },

    'summary:update': async ({ key, summary }) => {
      if (typeof summary !== 'string' || !summary.trim()) throw new Error('summary must be a non-empty string');
      return withDraft(key, (pr) => {
        pr.draft.summary = summary;
      });
    },

    'finding:update': async ({ key, index, body }) => {
      if (typeof body !== 'string' || !body.trim()) throw new Error('body must be a non-empty string');
      return withDraft(key, (pr) => {
        if (!pr.draft.findings[index]) throw new Error(`no finding at index ${index}`);
        pr.draft.findings[index].body = body;
      });
    },

    'finding:delete': async ({ key, index }) => {
      return withDraft(key, (pr) => {
        if (!pr.draft.findings[index]) throw new Error(`no finding at index ${index}`);
        pr.draft.findings.splice(index, 1);
      });
    },

    'review:dismiss': async ({ key }) => {
      const store = await loadStore(storeFile);
      transition(store, key, 'dismissed', now());
      await saveStore(storeFile, store);
      pushChanged();
      return { ok: true };
    },

    'review:retry': async ({ key }) => {
      const store = await loadStore(storeFile);
      transition(store, key, 'detected', now(), { error: null });
      await saveStore(storeFile, store);
      pushChanged();
      kickQueue().catch((err) => ctx.log('queue failed:', err.message));
      return { ok: true };
    },

    'review:submit': async ({ key }) => {
      const store = await loadStore(storeFile);
      const pr = store.prs[key];
      if (!pr) throw new Error(`unknown pr ${key}`);
      if (pr.state !== 'awaiting_approval' || !pr.draft) throw new Error(`${key} is not awaiting approval`);

      const resolved = await resolveAccount(exec, pr.owner, pr.repo, { preferLogin: pr.account });
      if (!resolved) throw new Error(`no gh account with access to ${pr.owner}/${pr.repo}`);

      const post = (payload) =>
        exec('gh', ['api', `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`, '--method', 'POST', '--input', '-'], {
          env: ghEnv(resolved.token),
          input: JSON.stringify(payload),
        });

      let r = await post(buildReviewPayload(pr.draft));
      if (r.code !== 0 && /422/.test(r.stderr + r.stdout)) r = await post(foldAllPayload(pr.draft));
      if (r.code !== 0) throw new Error(`submit failed: ${(r.stderr || r.stdout).slice(-1000)}`);

      const reviewUrl = JSON.parse(r.stdout).html_url ?? pr.url;
      transition(store, key, 'submitted', now(), { reviewUrl });
      await saveStore(storeFile, store);
      pushChanged();
      return { reviewUrl };
    },
  };

  async function recover() {
    const store = await loadStore(storeFile);
    if (recoverInterrupted(store, now()) > 0) await saveStore(storeFile, store);
  }

  return { handlers, sweep, kickQueue, recover };
}

/* ---------- lifecycle ---------- */

let stopped = false;
let timer = null;

function activate(ctx) {
  stopped = false;
  const plugin = createHandlers(ctx);
  for (const [channel, fn] of Object.entries(plugin.handlers)) ctx.ipc.handle(channel, fn);

  async function loop() {
    if (stopped) return;
    try {
      await plugin.recover();
      await plugin.sweep();
      await plugin.kickQueue();
    } catch (err) {
      ctx.log('sweep loop failed:', err.message);
    }
    const cfg = { ...DEFAULT_CONFIG, ...((await ctx.settings.get('config')) ?? {}) };
    if (!stopped) timer = setTimeout(loop, Math.max(1, Number(cfg.pollMinutes) || 3) * 60_000);
  }
  loop().catch((err) => ctx.log('initial sweep failed:', err.message));
}

function deactivate() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = { activate, deactivate, createHandlers };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all suites: detect, state, accounts, runner, submit, main)

- [ ] **Step 5: Build to confirm main still bundles**

Run: `npm run build`
Expected: both outputs emitted without errors.

- [ ] **Step 6: Commit**

```bash
git add src/main.cjs test/main.test.mjs dist
git commit -m "feat: main pipeline — sweep loop, serial review queue, approval + submit handlers"
```

---

### Task 8: Renderer — kit, shell, Reviews tab, Settings tab

**Files:**
- Create: `src/ui/kit.jsx` (copied), `src/ui/tabs/reviews.jsx`, `src/ui/tabs/settings.jsx`
- Modify: `src/renderer.jsx` (replace placeholder entirely)

**Interfaces:**
- Consumes: ipc channels and config shape from Task 7 (listed in its Interfaces block); host `api` (`ipc.invoke/on`, `settings.get/set`, `openExternal`, `theme`).
- Produces: `mount(el, api)` renderer entry. No unit tests (matches the freelancer plugin — renderer verified via build + manual install).

- [ ] **Step 1: Copy the styling kit from freelancer**

```bash
cp /Users/jannik/development/nikrich/poltergeist-freelancer/src/ui/kit.jsx src/ui/kit.jsx
```

(Exports used below: `S`, `setTheme`, `btnStyle`, `inputStyle`, `Panel`, `ErrorBanner`, `Btn`, `Input`, `Pill`, `Field`.)

- [ ] **Step 2: Write the shell**

`src/renderer.jsx`:

```jsx
// PR Reviewer renderer shell: theme, tabs, mount. Tab bodies live in
// src/ui/tabs/*.jsx; styling primitives in src/ui/kit.jsx (from freelancer).

import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { S, setTheme, btnStyle } from './ui/kit.jsx';
import { ReviewsTab } from './ui/tabs/reviews.jsx';
import { SettingsTab } from './ui/tabs/settings.jsx';

const TABS = [
  { id: 'reviews', label: 'reviews', Component: ReviewsTab },
  { id: 'settings', label: 'settings', Component: SettingsTab },
];

function App({ api }) {
  const s = S();
  const [tab, setTab] = useState('reviews');
  const Active = TABS.find((t) => t.id === tab)?.Component ?? ReviewsTab;

  return (
    <div style={{ padding: 18, color: s.ink0, fontSize: 13, fontFamily: 'inherit' }}>
      <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${s.hairline}`, marginBottom: 14 }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            style={{
              ...btnStyle(s, false),
              border: 'none',
              borderBottom: tab === t.id ? `2px solid ${s.neon}` : '2px solid transparent',
              borderRadius: 0,
              color: tab === t.id ? s.ink0 : s.ink2,
              fontWeight: tab === t.id ? 600 : 400,
            }}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <Active api={api} s={s} />
    </div>
  );
}

export function mount(el, api) {
  setTheme(api.theme ?? {});
  const root = createRoot(el);
  root.render(<App api={api} />);
  return () => root.unmount();
}
```

- [ ] **Step 3: Write the Reviews tab**

`src/ui/tabs/reviews.jsx`:

```jsx
// Queue + approval + history. Pull state on mount, re-pull on pushed
// state:changed events (ipc.send is never queued by the host).

import { useEffect, useState } from 'react';
import { Panel, ErrorBanner, Btn, Pill, inputStyle } from '../kit.jsx';

const ORDER = ['awaiting_approval', 'reviewing', 'detected', 'failed', 'submitted', 'skipped', 'dismissed'];
const LABEL = {
  awaiting_approval: 'awaiting approval',
  reviewing: 'reviewing',
  detected: 'queued',
  failed: 'failed',
  submitted: 'submitted',
  skipped: 'skipped',
  dismissed: 'dismissed',
};
const TONE = {
  awaiting_approval: 'neon',
  reviewing: 'fog',
  detected: 'fog',
  failed: 'oxblood',
  submitted: 'moss',
  skipped: 'outline',
  dismissed: 'outline',
};
const SEV_TONE = { blocker: 'oxblood', issue: 'neon', nit: 'fog' };

function areaStyle(s) {
  return { ...inputStyle(s), width: '100%', minHeight: 60, resize: 'vertical', fontFamily: 'inherit' };
}

function Finding({ s, f, onEdit, onDelete, disabled }) {
  const [body, setBody] = useState(f.body);
  return (
    <div style={{ border: `1px solid ${s.hairline}`, borderRadius: 6, padding: 8, marginTop: 6 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
        <Pill s={s} tone={SEV_TONE[f.severity] ?? 'fog'}>{f.severity}</Pill>
        <code style={{ color: s.ink1, fontSize: 12 }}>{f.path}:{f.line}</code>
        <span style={{ flex: 1 }} />
        <Btn s={s} danger disabled={disabled} onClick={onDelete}>delete</Btn>
      </div>
      <textarea
        style={areaStyle(s)}
        value={body}
        disabled={disabled}
        onChange={(e) => setBody(e.target.value)}
        onBlur={() => body !== f.body && onEdit(body)}
      />
    </div>
  );
}

function PrCard({ api, s, pr, refresh, setError }) {
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState(pr.draft?.summary ?? '');

  const act = async (channel, payload = {}) => {
    setBusy(true);
    setError('');
    try {
      await api.ipc.invoke(channel, { key: pr.key, ...payload });
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ border: `1px solid ${s.hairline}`, borderRadius: 8, padding: 12, marginBottom: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Pill s={s} tone={TONE[pr.state]}>{LABEL[pr.state]}</Pill>
        <a
          href="#"
          style={{ color: s.ink0, fontWeight: 600, textDecoration: 'none' }}
          onClick={(e) => {
            e.preventDefault();
            api.openExternal(pr.url);
          }}
        >
          {pr.key}
        </a>
        <span style={{ color: s.ink2 }}>{pr.title}</span>
        <span style={{ flex: 1 }} />
        {pr.account && <span style={{ color: s.ink2, fontSize: 12 }}>as {pr.account}</span>}
      </div>
      <div style={{ color: s.ink2, fontSize: 12, marginTop: 4 }}>from {pr.sources.join(', ')}</div>

      {pr.error && <div style={{ color: s.oxblood, marginTop: 6, whiteSpace: 'pre-wrap', fontSize: 12 }}>{pr.error}</div>}

      {pr.state === 'awaiting_approval' && pr.draft && (
        <div style={{ marginTop: 8 }}>
          <div style={{ color: s.ink2, fontSize: 12, marginBottom: 4 }}>summary</div>
          <textarea
            style={areaStyle(s)}
            value={summary}
            disabled={busy}
            onChange={(e) => setSummary(e.target.value)}
            onBlur={() => summary !== pr.draft.summary && act('summary:update', { summary })}
          />
          {pr.draft.findings.map((f, i) => (
            <Finding
              key={`${f.path}:${f.line}:${i}`}
              s={s}
              f={f}
              disabled={busy}
              onEdit={(body) => act('finding:update', { index: i, body })}
              onDelete={() => act('finding:delete', { index: i })}
            />
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <Btn s={s} primary disabled={busy} onClick={() => act('review:submit')}>
              submit review
            </Btn>
            <Btn s={s} disabled={busy} onClick={() => act('review:dismiss')}>dismiss</Btn>
          </div>
        </div>
      )}

      {pr.state === 'failed' && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <Btn s={s} primary disabled={busy} onClick={() => act('review:retry')}>retry</Btn>
          <Btn s={s} disabled={busy} onClick={() => act('review:dismiss')}>dismiss</Btn>
        </div>
      )}

      {pr.state === 'submitted' && pr.reviewUrl && (
        <div style={{ marginTop: 6 }}>
          <a
            href="#"
            style={{ color: s.moss, fontSize: 12 }}
            onClick={(e) => {
              e.preventDefault();
              api.openExternal(pr.reviewUrl);
            }}
          >
            view submitted review →
          </a>
        </div>
      )}
    </div>
  );
}

export function ReviewsTab({ api, s }) {
  const [store, setStore] = useState(null);
  const [env, setEnv] = useState(null);
  const [error, setError] = useState('');

  const refresh = () => api.ipc.invoke('state:get').then(setStore).catch((e) => setError(e.message));

  useEffect(() => {
    refresh();
    api.ipc.invoke('env:check').then(setEnv).catch(() => {});
    const off = api.ipc.on('state:changed', refresh);
    return off;
  }, []);

  if (!store) return <div style={{ color: s.ink2 }}>loading…</div>;

  const prs = Object.values(store.prs).sort(
    (a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || (a.timestamps.detected < b.timestamps.detected ? 1 : -1)
  );

  const envProblem =
    env && (!env.claude || !env.gh || env.accounts === 0)
      ? [
          !env.gh && 'gh CLI not found — install GitHub CLI',
          env.gh && env.accounts === 0 && 'no gh accounts — run `gh auth login`',
          !env.claude && 'claude CLI not found — install Claude Code or set its path in settings',
        ]
          .filter(Boolean)
          .join(' · ')
      : '';

  return (
    <div>
      <ErrorBanner error={error} s={s} />
      {envProblem && <div style={{ color: s.oxblood, marginBottom: 10, fontSize: 12 }}>{envProblem}</div>}
      <Panel
        title={`pull requests (${prs.length})`}
        s={s}
        action={
          <Btn s={s} onClick={() => api.ipc.invoke('sweep:now').then(refresh).catch((e) => setError(e.message))}>
            sweep now
          </Btn>
        }
      >
        {prs.length === 0 && <div style={{ color: s.ink2 }}>No PR links found in your vault yet.</div>}
        {prs.map((pr) => (
          <PrCard key={pr.key} api={api} s={s} pr={pr} refresh={refresh} setError={setError} />
        ))}
      </Panel>
    </div>
  );
}
```

- [ ] **Step 4: Write the Settings tab**

`src/ui/tabs/settings.jsx`:

```jsx
// Config editor persisted via api.settings under the same 'config' key main
// reads. Poll-interval changes take effect on the next loop tick.

import { useEffect, useState } from 'react';
import { Panel, Btn, Field, ErrorBanner } from '../kit.jsx';

const DEFAULT_CONFIG = {
  vaultPath: '~/ghostbrain/vault',
  folders: ['00-inbox', '20-contexts'],
  pollMinutes: 3,
  engine: { prompt: '', thoroughness: 'standard', skill: '' },
  claudeBin: 'claude',
  timeoutMinutes: 15,
};

export function SettingsTab({ api, s }) {
  const [config, setConfig] = useState(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.settings
      .get('config')
      .then((c) => setConfig({ ...DEFAULT_CONFIG, ...(c ?? {}), engine: { ...DEFAULT_CONFIG.engine, ...(c?.engine ?? {}) } }))
      .catch(() => setConfig(DEFAULT_CONFIG));
  }, [api]);

  if (!config) return null;

  const set = (patch) => {
    setConfig({ ...config, ...patch });
    setSaved(false);
  };
  const setEngine = (patch) => set({ engine: { ...config.engine, ...patch } });

  const save = async () => {
    setError('');
    try {
      await api.settings.set('config', config);
      setSaved(true);
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div style={{ maxWidth: 560 }}>
      <ErrorBanner error={error} s={s} />
      <Panel title="vault" s={s}>
        <Field s={s} label="vault path" value={config.vaultPath} onChange={(v) => set({ vaultPath: v })} />
        <Field
          s={s}
          label="watched folders (comma-separated)"
          value={config.folders.join(', ')}
          onChange={(v) => set({ folders: v.split(',').map((x) => x.trim()).filter(Boolean) })}
        />
        <Field
          s={s}
          label="poll interval (minutes)"
          type="number"
          value={String(config.pollMinutes)}
          onChange={(v) => set({ pollMinutes: Math.max(1, Number(v) || 3) })}
        />
      </Panel>

      <Panel title="review engine" s={s}>
        <Field
          s={s}
          label="skill (optional — overrides prompt, e.g. code-review)"
          value={config.engine.skill}
          onChange={(v) => setEngine({ skill: v })}
        />
        <Field s={s} label="review prompt (used when no skill is set)" value={config.engine.prompt} onChange={(v) => setEngine({ prompt: v })} />
        <div style={{ margin: '8px 0' }}>
          <div style={{ color: s.ink2, fontSize: 12, marginBottom: 4 }}>thoroughness</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {['quick', 'standard', 'thorough'].map((t) => (
              <Btn key={t} s={s} primary={config.engine.thoroughness === t} onClick={() => setEngine({ thoroughness: t })}>
                {t}
              </Btn>
            ))}
          </div>
        </div>
        <Field s={s} label="claude binary" value={config.claudeBin} onChange={(v) => set({ claudeBin: v })} />
        <Field
          s={s}
          label="review timeout (minutes)"
          type="number"
          value={String(config.timeoutMinutes)}
          onChange={(v) => set({ timeoutMinutes: Math.max(1, Number(v) || 15) })}
        />
      </Panel>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Btn s={s} primary onClick={save}>save</Btn>
        {saved && <span style={{ color: s.moss, fontSize: 12 }}>saved</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Build and run all tests**

Run: `npm run build && npm test`
Expected: build emits both bundles with no esbuild errors; all tests still PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui src/renderer.jsx dist
git commit -m "feat: renderer — reviews approval queue and settings tabs"
```

---

### Task 9: README, final dist, manual verification

**Files:**
- Create: `README.md`
- Modify: `dist/` (final rebuild)

**Interfaces:**
- Produces: an installable plugin repo (README is rendered on the marketplace page).

- [ ] **Step 1: Write the README**

`README.md`:

```markdown
# PR Reviewer — Poltergeist plugin

Watches your vault for GitHub pull-request links, reviews each PR once with
headless Claude Code, and — after you approve the draft in the plugin tab —
submits it as a real GitHub review (inline comments + summary, always
`COMMENT`, never approve/request-changes) via the `gh` CLI.

## Requirements

- [gh](https://cli.github.com) installed with at least one logged-in account
  (`gh auth login`); multiple accounts are supported — the plugin probes which
  one can access each repo and uses a per-call `GH_TOKEN`, never switching
  your active account.
- [Claude Code](https://claude.com/claude-code) installed and authenticated
  (`claude` on PATH, or set the binary path in settings).

## How it works

1. Every few minutes the plugin sweeps your configured vault folders for
   markdown containing `github.com/<owner>/<repo>/pull/<n>` links.
2. New PRs are cloned shallowly into plugin data, reviewed by `claude -p`
   with your configured prompt + thoroughness — or your own skill (e.g.
   `code-review`) — under a read-only tool allowlist.
3. The drafted review lands in the **reviews** tab (with a system
   notification). Edit the summary, edit or delete findings, then **submit**
   or **dismiss**. Nothing is ever posted without your approval.

## Settings

- vault path, watched folders, poll interval
- review prompt + thoroughness (`quick` / `standard` / `thorough`), or a
  skill name that overrides the prompt
- claude binary path, review timeout

## Development

```
npm install
npm test        # node --test unit suites
npm run build   # bundles src → dist (committed — installs use the repo as-is)
```
```

- [ ] **Step 2: Final build, full test run, commit**

Run: `npm run build && npm test`
Expected: clean build, all tests PASS.

```bash
git add README.md dist
git commit -m "docs: README; final dist build"
```

- [ ] **Step 3: Manual verification (human-in-the-loop)**

1. Poltergeist → **Plugins → install from folder** → pick this repo. Expected state: `enabled`.
2. Open the PR Reviewer sidebar entry: reviews tab renders; if `claude`/`gh` are missing the banner says so.
3. Drop a note containing a real PR URL (a repo one of your gh accounts can access) into `00-inbox` of your vault, press **sweep now**, and watch it move `queued → reviewing → awaiting approval`; check the notification fires.
4. Edit a finding, submit, and confirm the review appears on GitHub under the expected account with inline comments and event `COMMENT`.
5. Plugins screen → **reload**: state survives (store in plugin data), no duplicate review of the same PR.

---

## Self-Review Notes

- Spec coverage: monitor (T2/T7), state machine + crash recovery (T3/T7), account resolution without `gh auth switch` (T4/T7), prompt/skill/thoroughness + output contract + corrective retry (T5/T7), shallow clone workspace lifecycle (T7), COMMENT-only submit with 422 fold fallback (T6/T7), approval queue UI + env banner + settings (T8), README/marketplace (T9). The spec's "re-submit with the remainder" on 422 is implemented as fold-all-findings — GitHub's 422 does not reliably identify which comment failed to anchor; this is the deterministic subset of the spec behavior and is noted here deliberately.
- The spec's open item (exact claude permission flags) is resolved as `--allowedTools` with a read-only set in `runner.cjs` (`ALLOWED_TOOLS`).
- `sweep:now` returns before reviews finish (queue is fire-and-forget from handlers) — tests therefore `await plugin.kickQueue()`, which JOINS the in-flight drain rather than no-op'ing, so assertions after it are deterministic. Renderer `Field` onChange passes the plain value (verified against freelancer kit.jsx), matching the settings tab code.
```
