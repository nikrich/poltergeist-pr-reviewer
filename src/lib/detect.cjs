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
