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
