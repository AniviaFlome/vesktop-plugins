# QuickFind — Improved Discord Search.

Faster `Ctrl+K` for Vesktop / Vencord. Replaces the native Quick Switcher
with a lightweight modal that:

- Pre-indexes once per open, debounces input, slices to `maxResults` before render.
- Filters: servers-only mode, per-type toggles (servers / text / voice / threads /
  DMs / group DMs / users), friends-only, hide blocked / muted / archived threads.
- Search: fuzzy toggle + sensitivity slider, substring / prefix modes,
  case-sensitive toggle, normalize toggle (accents / leading emoji / spaces).
- Prefix scopes: `#channels`, `@friends`, `*servers` (also `c:`, `u:`, `s:`/`g:`).
  An explicit prefix in the query always wins over the tab (tabs are defaults).
- Type priority: optionally rank servers / channels / people first (`kindOrder` + `kindBoost`).
- Recents + frequency boost, current-server boost, unread boost (no badge).
- In-modal tabs + `Ctrl+1–4` to switch All / Servers / Channels / Friends live.

No `patches` are used — the plugin hijacks `Ctrl+K` / `Cmd+K` in capture phase
when `hijackCtrlK` is on. Turn it off to fall back to native Discord search.

## Repo layout (nixcord-compatible)

Repo root **is** the plugin, so a recursive copy of the root into
`Vencord/src/userplugins/QuickFind` lands `index.tsx` correctly:

- `index.tsx` — plugin, settings, keybind hijack, modal, store collection
- `search.ts` — pure scorer, no Discord imports (unit-tested)
- `filters.ts` — pure visibility filters (unit-tested)
- `recents.ts` — localStorage recency (unit-tested)
- `run_tests.mjs` — 131 assertions + 5000-item perf check, zero deps
- `e2e/` — headless tests (real component in jsdom, mocked Discord stores)
- `scripts/sync-and-build.sh` — sync into the pinned `Vencord/` checkout, build, verify
- `Vencord/` — upstream build-only checkout (pinned, git-ignored, never hand-edit)

## Install

```sh
# Vencord dev / Vesktop custom build
mkdir -p src/userplugins
cp -r /path/to/repo src/userplugins/QuickFind   # root IS the plugin
pnpm build
# restart Discord / Vesktop, enable "QuickFind" in Settings > Vencord > Plugins
```

nixcord (`flake = false` input): `userPlugins.QuickFind = inputs.vesktop-plugins;`
— the pin lives in `flake.lock`; pick up updates with
`nix flake update vesktop-plugins && sudo nixos-rebuild switch --flake .#nixos`.

## Settings

See `index.tsx` `definePluginSettings`. Key ones:

- `serversOnly`, `friendsOnly`, `hideBlocked`, per-type `show*`
- `searchMode` (fuzzy/substring/prefix), `fuzzyEnabled`, `sensitivity`
- `maxResults` (lower = faster), `debounceMs`, `sortBy`
- `currentGuildBoost`, `recentBoost`, `hijackCtrlK`, `disableAnimations`
- `kindOrder` (prioritize servers / channels / people), `kindBoost` (priority strength)

## Test

```sh
nix-shell -p nodejs --run "node run_tests.mjs"
# 131 passed, 0 failed

cd e2e && nix-shell -p nodejs --run "npm install" && nix-shell -p nodejs --run "npm run e2e"
# 109 passed, 0 failed

nix-shell -p nodejs --run "npm run build:strict" && nix-shell -p nodejs --run "node strict-test.cjs"
# 5 passed, 0 failed
```

## Dev setup (reproducible build)

```sh
git clone https://github.com/Vendicated/Vencord Vencord
git -C Vencord checkout 443688b5
./scripts/sync-and-build.sh   # runs unit tests, builds, verifies plugin in bundle
```

Last verified against Vencord `443688b5`. If you move the pin, re-run the
full gate above plus `./scripts/sync-and-build.sh`.

## Release checklist

1. `node run_tests.mjs` — green.
2. `npm run e2e` in `e2e/` — green.
3. `build:strict` + `strict-test.cjs` — green.
4. `./scripts/sync-and-build.sh` — bundle contains the plugin, `vencordDir` healed.
5. Bump `BUILD_TAG` in `index.tsx` and restart Vesktop to verify the new
   build loads (Settings > Vencord > Plugins > QuickFind).

## Limitations

- Relies on stable stores (`GuildStore`, `ChannelStore`, `RelationshipStore`,
  `SelectedGuildStore`, `ReadStateStore`, `GuildReadStateStore`) and routers
  (`ChannelRouter`, `NavigationRouter`). A Discord rename degrades to fewer
  results, never a crash (all access is optional-chained). Unread degrades to
  no boost when the read-state shape is unknown.
- Cross-open collect cache (15s TTL, guild-fingerprint key): same-count swaps
  and same-length renames can stay stale until expiry; mute/block/unread and
  recency refresh on every open.
- No typo tolerance (`genreal` won't match `general`) — deliberate, keeps it dependency-free and fast.
- Voice-channel join uses channel transition only; full RTC join is Discord's native behavior.
