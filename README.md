# PR Reviewer — Poltergeist plugin

Watches your vault for GitHub pull-request links, reviews each PR once with
headless Claude Code, and — after you approve the draft in the plugin tab —
submits it as a real GitHub review (inline comments + summary, always
`COMMENT`, never approve/request-changes) via the `gh` CLI.

## Requirements

- [gh](https://cli.github.com) installed with at least one logged-in account
  (`gh auth login`); multiple accounts are supported — the plugin probes which
  one can access each repo and uses a per-call `GH_TOKEN`, never switching
  your active account.
- [Claude Code](https://claude.com/claude-code) installed and authenticated
  (`claude` on PATH, or set the binary path in settings).

## How it works

1. Every few minutes the plugin sweeps your configured vault folders for
   markdown containing `github.com/<owner>/<repo>/pull/<n>` links.
2. New PRs are cloned shallowly into plugin data, reviewed by `claude -p`
   with your configured prompt + thoroughness — or your own skill (e.g.
   `code-review`) — under a read-only tool allowlist.
3. The drafted review lands in the **reviews** tab (with a system
   notification). Edit the summary, edit or delete findings, then **submit**
   or **dismiss**. Nothing is ever posted without your approval.

## Settings

- vault path, watched folders, poll interval
- review prompt + thoroughness (`quick` / `standard` / `thorough`), or a
  skill name that overrides the prompt
- claude binary path, review timeout

## Development

```
npm install
npm test        # node --test unit suites
npm run build   # bundles src → dist (committed — installs use the repo as-is)
```
