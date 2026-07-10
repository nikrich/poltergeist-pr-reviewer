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
