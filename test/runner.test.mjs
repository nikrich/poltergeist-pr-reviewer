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

test('parseReviewOutput survives stray braces and decoy objects in prose', () => {
  assert.deepEqual(parseReviewOutput('as discussed {see notes} here it is: ' + JSON.stringify(GOOD) + ' done.'), GOOD);
  assert.deepEqual(parseReviewOutput(JSON.stringify(GOOD) + '\nfootnote: unbalanced }'), GOOD);
  assert.deepEqual(parseReviewOutput('empty decoy {} first, then ' + JSON.stringify(GOOD)), GOOD);
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
