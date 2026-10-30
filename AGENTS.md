# AGENTS.md — vesktop-plugins

Single Vencord userplugin (`QuickFind/`, display name QuickFind) + a pinned `Vencord/` checkout used only to build it. `Vencord/` is an upstream clone (pinned at `443688b5`, git-ignored) — never hand-edit it (the sync script owns `Vencord/src/userplugins/`).

## Build (only this)

```sh
./scripts/sync-and-build.sh
```

It syncs the plugin (excluding `e2e/node_modules`, `e2e/dist`), builds with pinned pnpm, verifies the plugin is in the bundle, and self-heals Vesktop's `vencordDir`. Never run bare `pnpm build` in `Vencord/`, especially not concurrently — a parallel/mid-sync build emits a `dist/` **without** the plugin and fails silently.

## Toolchain (NixOS)

No `node`/`npm`/`pnpm` on PATH. Use `nix-shell -p nodejs --run "..."`. pnpm must be **11.9.0** via corepack (`/tmp/opencode/corepack/.../pnpm.cjs`, auto-provisioned by the script); nixpkgs pnpm is v12 and breaks the install (`ERR_PNPM_UNUSED_PATCH`). Never modify `Vencord/package.json` — same failure.

## Plugin constraint (killed production once)

**Never call any `React.*` API at module top level** (`memo`, `forwardRef`, hooks, `createElement`). Vencord assigns React into `@webpack/common` lazily *after* evaluating plugin modules, so a top-level `React.memo()` throws during import and takes down the entire Vencord renderer (whole settings section gone). All React use belongs inside components/hooks/handlers. Enforced by the strict boot test below.

## Tests

- Pure logic: `cd QuickFind && nix-shell -p nodejs --run "node run_tests.mjs"` (search/filters/recents, incl. perf gate + dedupe)
- Headless e2e (real component in jsdom, mocked Discord stores): `cd QuickFind/e2e && npm install` (once), then `nix-shell -p nodejs --run "npm run e2e"`
- Strict boot test (lazy-React fidelity): `npm run build:strict && node strict-test.cjs`
- e2e harness rules, all load-bearing: `react`/`react-dom` must stay **external** in esbuild (a second bundled copy breaks `act()` flushing → every assertion reads stale DOM); only **async** `act()`; set `globalThis.IS_REACT_ACT_ENVIRONMENT = true` (`process.env` alone is ignored)

## Vesktop wiring

Vesktop loads the build via Settings → Developer Settings → **Vencord Location**, which must be `.../Vencord/dist` — selecting the repo root silently breaks all of Vencord. Repo-root symlinks to `dist/` exist as a safety net; `sync-and-build.sh` re-creates them and repairs `~/.config/vesktop/state.json`'s `vencordDir` every run.

## Debugging Vesktop

- Main-process boot log (loader/ENOENT errors): `vesktop 2>&1 | tee /tmp/opencode/vesktop-boot.log`
- Renderer errors: DevTools console (`Ctrl+Shift+I`) after startup
- Headless repro without touching the live session (catches init crashes, no login needed): Xvfb + `vesktop --user-data-dir=/tmp/opencode/vesktop-test --enable-logging=stderr --disable-gpu --no-sandbox` with a hand-written `state.json` pointing `vencordDir` at the dist
- Shell forensics: atuin history is sqlite at `~/.local/share/atuin/history.db`, table `history` (`timestamp` ns, `command`, `cwd`)
