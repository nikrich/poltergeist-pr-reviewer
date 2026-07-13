# Sweep Lookback Window — Design

**Date:** 2026-07-13
**Status:** Approved

## Summary

Add a `lookbackDays` setting (default 14, `0` = no limit) that limits the
sweep to notes modified within the last N days, so old vault history never
triggers PR reviews.

## Behavior

- Rolling window on note modification time: `sweep()` filters stat'ed files
  to `mtimeMs >= now − lookbackDays·86400·1000` before the `changedFiles`
  diff. Cutoff derives from the injected `now()` clock (testable).
- An old note edited today re-enters the window and triggers normally.
- Notes aging out drop from the sweep cache (cache is rebuilt from the
  filtered list each pass) — harmless; a later edit re-detects them.
- Already-tracked PRs are unaffected: the state store owns them, not the
  sweep. `lookbackDays: 0` disables the filter.

## Changes

| Where | What |
|---|---|
| `src/main.cjs` | `lookbackDays: 14` in `DEFAULT_CONFIG`; mtime filter in `sweep()` |
| `src/ui/tabs/settings.jsx` | same default; numeric field "look back (days, 0 = no limit)" in the vault panel |
| `test/main.test.mjs` | old-note-skipped (default), old-note-detected (`lookbackDays: 0`), fresh-note-still-detected alongside old |

Out of scope: per-folder windows, PR-age filtering (the open/closed probe
already skips stale PRs).
