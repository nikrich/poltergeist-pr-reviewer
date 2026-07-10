# PR Reviewer — Poltergeist Plugin Design

**Date:** 2026-07-10
**Status:** Approved

## Summary

A Poltergeist plugin (id `pr-reviewer`) that monitors the vault for captures
mentioning GitHub pull requests, reviews each PR once using headless Claude
Code with a user-configured prompt/thoroughness or skill, queues the drafted
review for user approval in the plugin tab, and on approval submits it as a
proper GitHub PR review (inline comments + summary, `COMMENT` event) via `gh`,
using whichever of the user's authenticated gh accounts has access to the repo.

## Decisions (locked during brainstorming)

| Question | Decision |
|---|---|
| Review engine | Headless Claude Code (`claude -p`) — the only option supporting skills |
| Submission | Approval gate: reviews are drafted, user approves in the tab before anything is posted |
| PR detection | Regex for `github.com/<owner>/<repo>/pull/<n>` URLs in vault markdown; no LLM classification |
| Multi-account gh | Token per call (`gh auth token --user X` → `GH_TOKEN` env); never `gh auth switch` |
| Review shape | Real PR review: inline comments anchored to diff lines + summary body, event always `COMMENT` |
| Workspace | Shallow clone of the PR head into `dataDir` per review; deleted afterwards |
| Monitoring | Poll on interval (default 3 min), mtime-cached sweep like the freelancer plugin |
| Output contract | Claude emits structured JSON findings; the plugin owns submission (Claude never runs `gh` writes) |

## Repo anatomy

New repo `poltergeist-pr-reviewer`, scaffolded after `poltergeist-freelancer`:

```
manifest.json          # id: pr-reviewer, apiVersion 1, icon: git-pull-request
src/main.cjs           # activate/deactivate, monitor, queue, ipc handlers
src/lib/*.cjs          # detect, state, accounts, runner, submit — unit-testable
src/renderer.jsx       # mount, tab shell
src/ui/tabs/*.jsx      # reviews.jsx, settings.jsx
build.mjs              # esbuild: main → dist/main.cjs (cjs/node), renderer → dist/renderer.mjs (esm/browser)
dist/                  # committed — installs clone the repo as-is
test/                  # node --test units
```

## Components

### 1. Vault monitor (`src/lib/detect.cjs` + timer in main.cjs)

- `setInterval` sweep, default every 3 min (configurable). Timers cleared in
  `deactivate`.
- Walks configured vault folders (default `00-inbox`, `20-contexts`) for `.md`
  files; skips files whose mtime is unchanged since the last sweep (cache in
  `dataDir`).
- Extracts PR URLs with a regex on
  `github\.com/([\w.-]+)/([\w.-]+)/pull/(\d+)`.
- Each new `owner/repo#n` becomes one tracked PR. The same PR appearing in
  other notes later is deduped (first source note wins; later sightings are
  appended to a `sources` list, no re-review).
- PRs found to be closed/merged at probe time are recorded as `skipped`.

### 2. State store (`src/lib/state.cjs`)

JSON file in `dataDir` (atomic write: tmp + rename). Per PR:

- key `owner/repo#number`, PR URL, title (fetched at probe), source note
  path(s), resolved account, timestamps per transition
- state machine:
  `detected → reviewing → awaiting_approval → submitted`
  with exits `failed` (retryable → back to `detected` on retry), `dismissed`,
  and `skipped` (closed/merged/no-access)
- drafted findings + summary while `awaiting_approval` (including user edits)
- on activate, any PR stuck in `reviewing` (app quit mid-review) resets to
  `detected`

### 3. Account resolver (`src/lib/accounts.cjs`)

- Enumerate authenticated users: `gh auth status` (parse) across hosts.
- Per user, obtain a token: `gh auth token --user <login>`.
- Probe repo access: `gh api repos/{owner}/{repo}` with `GH_TOKEN=<token>`;
  first success wins. Resolution cached per `owner/repo` in the state store;
  invalidated if a later call fails auth (re-probe once).
- Every `gh` invocation for a PR runs with `env: { ...process.env, GH_TOKEN }`.
  The global active gh account is never touched.
- No account can access the repo → PR `skipped` with reason `no-access`.

### 4. Review runner (`src/lib/runner.cjs`)

- Serial queue: one review at a time; `detected` PRs are picked up FIFO.
- Workspace: `dataDir/workspaces/<owner>-<repo>-<n>/` — shallow clone
  (`git clone --depth 50`) using the resolved token, then
  `gh pr checkout <n>` (with `GH_TOKEN`). Deleted after the run, success or
  fail.
- Spawn `claude -p <prompt> --output-format json` in the workspace with a
  timeout (default 15 min). Prompt assembled from:
  - **skill mode** (if a skill name is configured): the prompt is
    `/<skill> <args>` plus the output contract; or
  - **prompt mode**: user's review prompt + thoroughness preamble
    (quick / standard / thorough map to instructions on how deeply to explore)
  - always appended: the output contract — final message must be exactly one
    JSON object `{ summary, verdict, findings: [{ path, line, body,
    severity }] }` (severity: `blocker|issue|nit`; `line` is the line in the
    new file version).
- Permissions: run claude with read/explore + `gh` read-only allowed; no
  write/push tools. (`--allowedTools`/settings flags, finalized during
  implementation.)
- Parse the JSON out of the result; on malformed output, one retry with a
  corrective prompt; second failure → PR `failed` with stderr/output tail
  stored.
- On success → `awaiting_approval`, fire a system `Notification` and
  `ipc.send` a refresh event.

### 5. Submitter (`src/lib/submit.cjs`)

- On user approval: POST
  `gh api repos/{owner}/{repo}/pulls/{n}/reviews` with
  `{ body: summary, event: "COMMENT", comments: [{ path, line, side: "RIGHT",
  body }] }` using the resolved token.
- Findings GitHub rejects for anchoring (line not in diff) are removed and
  folded into the summary body under a "Not anchored to the diff" section;
  the review is re-submitted once with the remainder.
- Success → `submitted` with the review URL stored. Failure → stays
  `awaiting_approval` with the error shown.

### 6. Renderer UI (`src/ui/tabs/`)

Two tabs, styled from `api.theme` variables with fallbacks:

- **Reviews** — PRs grouped by state. `awaiting_approval` entries expand to
  show the editable summary and per-finding cards (edit body, delete);
  actions: Submit, Dismiss. `failed` entries show the error tail and a Retry.
  `submitted` history shows the review link (via `openExternal`).
- **Settings** — vault path, watched folders, poll interval, engine config
  (review prompt, thoroughness quick/standard/thorough, optional skill name),
  claude binary path (default `claude`), review timeout.

Renderer pulls current state with `ipc.invoke` on mount, then applies pushed
refresh events (standard Poltergeist pattern; `ipc.send` is not queued).

### ipc surface (channels registered in activate)

`state:get`, `settings:get`, `settings:set`, `review:submit`,
`review:dismiss`, `review:retry`, `finding:update`, `finding:delete`,
`summary:update`, `pr:open` (openExternal handled renderer-side where
possible), `sweep:now`. Push events: `state:changed`.

## Error handling

- `claude` binary missing or unauthenticated, `gh` missing or no accounts →
  persistent banner in the tab with setup instructions; monitor keeps running
  and PRs accumulate as `detected`.
- Throws inside ipc handlers surface as rejected promises in the renderer
  (host behavior); handlers validate inputs and throw freely.
- Review process failures store an stderr/output tail on the PR entry.
- All state writes atomic; sweep cache corruption → cold resweep, dedup via
  state store prevents duplicate reviews.

## Testing

- `node --test` units with injected exec/fs where needed:
  - URL extraction & dedup (detect)
  - state machine transitions incl. crash-recovery reset
  - claude output parsing (valid, malformed, retry path)
  - account probe ordering & caching (gh mocked)
  - submit payload construction & unanchored-finding fallback
- Manual loop: build → Plugins → install from folder → reload.

## Out of scope (YAGNI)

Auto-submit (even per-repo), APPROVE/REQUEST_CHANGES events, webhooks or
fs.watch, LLM-based capture classification, re-review on PR update,
GitHub Enterprise hosts beyond what `gh auth status` already reports,
concurrent reviews.
