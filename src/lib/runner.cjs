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

// Read/explore + gh PR read commands. No git Bash: `git log/diff/show` accept
// --output=<file>, which can write arbitrary files under prompt injection.
const ALLOWED_TOOLS = 'Read Glob Grep LS Bash(gh pr view:*) Bash(gh pr diff:*)';

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

/** Slice one balanced {...} starting at `from`, respecting JSON strings. */
function balancedJsonSlice(text, from) {
  let depth = 0, inStr = false, esc = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  return null;
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
  let fallback = null;
  for (let idx = text.indexOf('{'); idx !== -1; idx = text.indexOf('{', idx + 1)) {
    const candidate = balancedJsonSlice(text, idx);
    if (!candidate) continue;
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === 'object') {
        if (typeof obj.summary === 'string') return obj;
        if (!fallback) fallback = obj;
      }
    } catch {}
  }
  return fallback;
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
