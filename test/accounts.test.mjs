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
