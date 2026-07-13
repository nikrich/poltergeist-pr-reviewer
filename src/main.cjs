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
  lookbackDays: 14,
  engine: { prompt: '', thoroughness: 'standard', skill: '' },
  claudeBin: 'claude',
  timeoutMinutes: 15,
};

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

// GUI-launched Electron apps get launchd's minimal PATH (/usr/bin:/bin:...),
// which lacks the dirs gh and claude are installed to — PATH lookup then fails
// with ENOENT even though both work in a terminal.
const EXTRA_PATH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')];

function augmentedPath(base) {
  const parts = String(base ?? '')
    .split(path.delimiter)
    .filter(Boolean);
  for (const d of EXTRA_PATH_DIRS) if (!parts.includes(d)) parts.push(d);
  return parts.join(path.delimiter);
}

/** Never rejects: nonzero exit / spawn error → code !== 0. */
function execP(cmd, args, opts = {}) {
  const env = { ...(opts.env ?? process.env) };
  env.PATH = augmentedPath(env.PATH);
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { maxBuffer: 16 * 1024 * 1024, timeout: opts.timeout, cwd: opts.cwd, env },
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
  const isStopped = deps.isStopped ?? (() => false);
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
    // Rolling window: notes last modified before the cutoff never trigger
    // reviews; editing an old note brings it back into the window.
    const days = Number(cfg.lookbackDays);
    const cutoffMs = days > 0 ? Date.parse(now()) - days * 86_400_000 : -Infinity;
    const withStat = [];
    for (const f of files) {
      try {
        const st = await fsp.stat(f);
        if (st.mtimeMs >= cutoffMs) withStat.push({ path: f, mtimeMs: st.mtimeMs });
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
        const attempted = new Set();
        for (;;) {
          if (isStopped()) break;
          const store = await loadStore(storeFile);
          const next = Object.values(store.prs)
            .filter((p) => p.state === 'detected' && !attempted.has(p.key))
            .sort((a, b) => (a.timestamps.detected < b.timestamps.detected ? -1 : 1))[0];
          if (!next) break;
          attempted.add(next.key);
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
    if (!pr || pr.state !== 'detected') return;
    const repoKey = `${pr.owner}/${pr.repo}`;

    // Resolve account + PR meta before committing to a review.
    let resolved;
    try {
      resolved = await resolveAccount(exec, pr.owner, pr.repo, { preferLogin: store.accountCache[repoKey] });
    } catch (err) {
      ctx.log(`account enumeration failed for ${key}: ${err.message}`);
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

      let reviewUrl = pr.url;
      try {
        reviewUrl = JSON.parse(r.stdout).html_url ?? pr.url;
      } catch {
        ctx.log('review posted but response was not JSON; falling back to PR url');
      }
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
  const plugin = createHandlers(ctx, { isStopped: () => stopped });
  for (const [channel, fn] of Object.entries(plugin.handlers)) ctx.ipc.handle(channel, fn);

  async function loop() {
    if (stopped) return;
    try {
      await plugin.sweep();
      await plugin.kickQueue();
    } catch (err) {
      ctx.log('sweep loop failed:', err.message);
    }
    const cfg = { ...DEFAULT_CONFIG, ...((await ctx.settings.get('config')) ?? {}) };
    if (!stopped) timer = setTimeout(loop, Math.max(1, Number(cfg.pollMinutes) || 3) * 60_000);
  }

  plugin
    .recover()
    .catch((err) => ctx.log('recovery failed:', err.message))
    .finally(() => loop().catch((err) => ctx.log('initial sweep failed:', err.message)));
}

function deactivate() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = { activate, deactivate, createHandlers, augmentedPath };
