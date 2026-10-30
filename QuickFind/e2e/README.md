# QuickFind e2e

Headless end-to-end tests: the **real** plugin component (`../index.tsx`,
bundled as-is) running inside jsdom with mocked Discord stores. No network,
no Discord login.

## What it covers

- `Ctrl+K` opens the modal; input is autofocused
- Typing filters; best match first
- Arrow keys move selection exactly one row (regression: double-fire)
- Mouse-clicking All/Servers/Channels/Friends tabs filters (regression: dead buttons)
- `scrollIntoView({ block: "nearest" })` fires while navigating
- Enter navigates + closes; Esc closes; `Ctrl+K` reopens repeatedly
- `Ctrl+1–4` map to tabs in button order (regression: off-by-one)
- Theme tokens chain midnight-discord vars → Discord vars (never bare hex)
- Probe degrades gracefully without the real store; no console errors on open/close

## Run

```sh
cd QuickFind/e2e
nix-shell -p nodejs --run "npm install"
nix-shell -p nodejs --run "npm run e2e"   # build + test
```

`npm run build` bundles `entry.jsx` + `../index.tsx` with esbuild, aliasing
`@api/*`, `@utils/*`, `@webpack*`, `@components/*` to local mocks
(`mocks/`). `react`/`react-dom` stay **external** so the bundle and the
runner share one React instance (bundling a second copy breaks `act()`
flushing — every keydown assertion goes stale).

`npm test` runs `run-tests.cjs`:
- jsdom globals + `scrollIntoView` recorder
- all key/mouse interactions go through **async** `act()` — sync `act()`
  does not flush on a concurrent root, which reads stale DOM
- `globalThis.IS_REACT_ACT_ENVIRONMENT = true` is required
  (`process.env` alone is ignored by React)

## Strict boot test (`build:strict` + `strict-test.cjs`)

Reproduces Vencord's lazy React assignment: the bundle is built against
`mocks/webpack-common-strict.jsx`, where `React` and hooks are **undefined**
at import time (exactly like Vencord before its internal `waitFor(React)`
fires) and only assigned when the test calls
`globalThis.__qsMockReady()`.

- `require()` must not throw. This caught a real production outage:
  `React.memo` at module top level threw `Cannot read properties of
  undefined (reading 'memo')` during import, taking down the entire
  Vencord renderer (whole settings section gone).
- After `__qsMockReady()`, the modal must open and navigate.

**Plugin rule this enforces: never call any `React.*` API (memo,
forwardRef, createElement, hooks) at module top level.** All React usage
must happen inside components, hooks, or event handlers, which only run
after Vencord has assigned React.

## Workspace browser harness (`harness.html` + `harness.jsx`)

Runs the same code in a **real Chromium** (isolated via the
`agent-workspace-linux` skill) instead of jsdom. The page self-drives:
open → arrows → type → group avatars → Escape close (timed via
MutationObserver) → toggle reopen, then renders all measurements into the
page title/body for `workspace_browser_snapshot` to read.

Rebuild + serve + open: `esbuild harness.jsx` (see `package.json`, no
`--external` flags so React is bundled), copy `harness-bundle.js` next to
`harness.html`, serve over HTTP, navigate with a long `wait_ms`, snapshot.

Caveats learned the hard way:
- Real timers apply (no `act` flushing). The in-page mock `closeModal` is
  a counter-only no-op under `window.__qsNoAct`, so **close latency measures
  only our optimistic hide**, never the host — that is intentional.
- Always `clearTimeout` measurement fallbacks on early resolve, or a later
  reopened modal clobbers the true value with a stale `-1`.
- Keep `IS_REACT_ACT_ENVIRONMENT` semantics out of the browser build; the
  jsdom suite owns the act-based assertions.
