#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Single-instance guard: a parallel/mid-sync build emits a dist/ without the
# plugin and fails silently (see AGENTS.md). Fail fast instead of interleaving
# rm/cp/build with another instance.
if command -v flock >/dev/null 2>&1; then
    exec 9>"$ROOT/.sync-build.lock"
    if ! flock -n 9; then
        echo "ERROR: another sync-and-build is running (lock $ROOT/.sync-build.lock)" >&2
        exit 1
    fi
fi

# Fail early when the pinned upstream checkout is absent (git-ignored,
# so a fresh clone has no Vencord/).
if [ ! -f "$ROOT/Vencord/package.json" ]; then
    echo "ERROR: Vencord checkout missing at $ROOT/Vencord" >&2
    echo "Clone the pinned upstream first, e.g.:" >&2
    echo "  git clone <vencord-upstream-url> Vencord && cd Vencord && git checkout 383409e6" >&2
    exit 1
fi

rm -rf "$ROOT/Vencord/src/userplugins/quickFind"
rm -rf "$ROOT/Vencord/src/userplugins/QuickFind"
cp -r "$ROOT/QuickFind" "$ROOT/Vencord/src/userplugins/QuickFind"
rm -rf "$ROOT/Vencord/src/userplugins/QuickFind/e2e/node_modules" \
       "$ROOT/Vencord/src/userplugins/QuickFind/e2e/dist"
# Guard against a silent partial sync (e.g. disk-full cp): the built bundle
# check at the end would pass on a STALE dist, so verify the sync itself.
if [ ! -f "$ROOT/Vencord/src/userplugins/QuickFind/index.tsx" ]; then
    echo "ERROR: plugin sync failed (index.tsx missing after cp)" >&2
    exit 1
fi

nix-shell -p nodejs --run "node $ROOT/QuickFind/run_tests.mjs"

PNPM_CJS="/tmp/opencode/corepack/v1/pnpm/12.15.0/bin/pnpm.mjs"
if [ ! -f "$PNPM_CJS" ]; then
    export COREPACK_HOME=/tmp/opencode/corepack
    nix-shell -p nodejs --run "corepack prepare pnpm@12.15.0 --activate"
fi

cd "$ROOT/Vencord"
nix-shell -p nodejs --run "node $PNPM_CJS build"

for f in vencordDesktopMain.js vencordDesktopPreload.js vencordDesktopRenderer.js vencordDesktopRenderer.css; do
    # Verify each artifact exists before (re)linking it.
    if [ ! -f "dist/$f" ]; then
        echo "ERROR: dist/$f missing after build" >&2
        exit 1
    fi
    ln -sf "dist/$f" "$f"
done
# Repo-root safety net (see AGENTS.md): if Vesktop's Vencord Location ever
# points at the repo root instead of Vencord/dist, these symlinks keep it
# working instead of silently breaking all of Vencord.
for f in vencordDesktopMain.js vencordDesktopPreload.js vencordDesktopRenderer.js vencordDesktopRenderer.css; do
    ln -sf "Vencord/dist/$f" "$ROOT/$f"
done

ROOT_DIR="$ROOT" python3 - "$HOME/.config/vesktop/state.json" <<'EOF'
import json, os, sys, shutil, time
p = sys.argv[1]
want = os.path.join(os.environ["ROOT_DIR"], "Vencord", "dist")
try:
    with open(p) as f:
        s = json.load(f)
    created = False
except FileNotFoundError:
    # A missing state.json is created; corrupt JSON is backed up, not lost.
    s = {}
    created = True
except Exception as e:
    try:
        bak = f"{p}.corrupt-{int(time.time())}.bak"
        shutil.copyfile(p, bak)
        print(f"ERROR: cannot parse {p}: {e}; backed up to {bak}", file=sys.stderr)
    except Exception:
        print(f"ERROR: cannot parse {p}: {e}", file=sys.stderr)
    sys.exit(1)
if s.get("vencordDir") != want:
    action = "creating" if created else "repairing"
    print(f"{action} vencordDir -> {want}")
    s["vencordDir"] = want
    os.makedirs(os.path.dirname(p), exist_ok=True)
    # Backup before overwrite so a crash mid-write never loses settings.
    try:
        if os.path.exists(p):
            shutil.copyfile(p, f"{p}.bak")
    except Exception as e:
        print(f"WARN: state backup failed: {e}", file=sys.stderr)
    with open(p, "w") as f:
        json.dump(s, f, indent=4)
else:
    print(f"vencordDir OK: {want}")
EOF

echo "--- verifying plugin in bundle:"
# Case-sensitive match on the exact plugin name.
COUNT=$(grep -c "QuickFind" dist/vencordDesktopRenderer.js || true)
echo "QuickFind references in vencordDesktopRenderer.js: $COUNT"
if [ "$COUNT" -eq 0 ]; then
    echo "ERROR: plugin missing from bundle!" >&2
    exit 1
fi
echo OK
