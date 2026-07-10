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
