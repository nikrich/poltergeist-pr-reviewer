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
