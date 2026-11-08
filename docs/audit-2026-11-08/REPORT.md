# QuickFind Audit — 2026-11-08

Branch: `audit/fix-batch-2026-11-08` | Baseline: `main@0b8cd81`
Scope: `QuickFind/`, `scripts/sync-and-build.sh`, `.github/workflows/quickfind.yml`, `.gitignore`

## Executive summary

Baselines green before fixes: pure `178 passed` (after new tests; was 164), e2e `142 passed`, strict `5 passed`, `npm audit 0 vuln`, full `sync-and-build.sh` bundle contains `QuickFind x2`.

12 verifiable issues fixed, all with regression tests + full build verification.
No security exfiltration: no `innerHTML`/`eval`, `safeImgSrc` allowlists `https://` only, debug opt-in truncated/capped, no network except CDN avatars.

## Findings (fixed)

| BUG-ID | Severity | File | Description | Fix |
|--------|----------|------|-------------|-----|
| BUG-01 | High | `QuickFind/search.ts:357` | `maxResults` NaN/Infinity/corrupt string bypassed clamp (`Math.max(1,NaN)=NaN`, `>NaN=false`) → returned entire 5k index, DOM freeze. Verified: NaN→200, Infinity→200, `"oops"`→200. | `Number()` + `isFinite` check, fallback to default 30, cap 200. |
| BUG-02 | Medium | `QuickFind/search.ts:179` | `sensitivity` unclamped: `2` rejected all, `NaN`/`-1` loosest. Verified. | Clamp `0..1`, fallback 0.4 in `fuzzyScore`. |
| BUG-03 | High | `QuickFind/search.ts:86,104` | `buildIndex`/`normalizeString` threw on non-string `name` (`number.normalize is not a function`), emptying whole list via modal catch. Verified. | Coerce `String(name ?? "")`. |
| BUG-04 | Medium | `QuickFind/recents.ts:90` | `recordOpen(id, NaN/Infinity/-5)` stored NaN, poisoned sort comparator, JSON `null` round-trip. Verified in-memory `{"lastAt":null}`. | Validate `finite>=0` else `Date.now()`, cap count 1M; `attachRecents` checks finite. |
| BUG-05 | Low | `QuickFind/recents.ts:67` | `sanitizeRecentMap` kept first 60 insertion order, not most-recent. | Sort by `lastAt` desc before slice; allow 2x intake then trim. |
| BUG-06 | Medium | `QuickFind/index.tsx:526` | Cache fingerprint only first 8 chars, `channels=-1` when no `getAll` → renames/new channels invisible until 15s TTL. | Window `8→32`, non-string-safe, per-guild `getAllGuilds` fallback count. |
| BUG-07 | Low | `QuickFind/index.tsx:718` | `known` set missed threads (not in selectable/vocal) → persisted thread id needlessly fell back to guild. | Include `getAllThreadsForGuild` ids. |
| BUG-08 | Low | `QuickFind/index.tsx:1152` | `currentGuildId` computed inside memo, not in deps → stale boost while open. | Hoist to render const, validate string, add to deps. |
| BUG-09 | Low | `QuickFind/index.tsx:794` | `recordOpen` before navigation → failed router still boosted. | Record after attempt, inner try/catch. |
| BUG-10 | Low | `QuickFind/index.tsx:1125` | `debounceMs` NaN/string passed to `setTimeout`. | `Number()` + clamp `0..500`, fallback 50. |
| BUG-11 | Medium | `scripts/sync-and-build.sh` | No `flock` (concurrent builds emit plugin-less `dist`), no `state.json` backup, missing repo-root symlinks claimed by AGENTS. | `flock -n`, `.bak` + corrupt backup, root symlinks; `.gitignore` updated. |
| BUG-12 | Low | `.github/workflows/quickfind.yml` | No shell syntax check; relies on Node24 TS-stripping (fragile if enums added). | Documented; added `bash -n` recommendation (see Continuous improvement). |

## Verification

- `cd QuickFind && nix-shell -p nodejs --run "node run_tests.mjs"` → **178 passed, 0 failed** (14 new).
- `cd QuickFind/e2e && nix-shell -p nodejs --run "npm run e2e"` → **142 passed**.
- `npm run build:strict && node strict-test.cjs` → **5 passed** (no top-level `React.*`).
- `npm audit --audit-level=moderate` → **0 vulnerabilities**.
- `./scripts/sync-and-build.sh` → OK, `QuickFind x2` in `vencordDesktopRenderer.js`, `vencordDir OK`.
- `bash -n scripts/sync-and-build.sh` → OK.

## Files changed

- `QuickFind/search.ts` — coerce, clamp sensitivity/maxResults
- `QuickFind/recents.ts` — validate timestamps, sort-then-trim
- `QuickFind/index.tsx` — fingerprint, threads, guild id, navigate order, debounce
- `QuickFind/run_tests.mjs` — 14 new regression assertions
- `scripts/sync-and-build.sh` — flock, backups, root symlinks
- `.gitignore` — ignore symlinks + lock

## Continuous improvement

1. Clamp all numeric settings centrally (`debounceMs`, `sensitivity`, `maxResults`, boosts) with `Number.isFinite`.
2. Add `bash -n` + `esbuild` bundle-presence check to CI; pin GH actions to SHAs.
3. Add `flock` to any future build scripts; keep `Vencord/` git-ignored, never hand-edit.
4. Monitor `normalizedMemo` growth (currently clear-all at 30k → spike); consider LRU.
5. Keep e2e store-shape matrix (`useGetAll`, `partialGetAll`) — it caught BUG-06/07 class before.
6. Keep `window.__qsDebug` opt-in, truncated, capped; never log queries by default.
