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
