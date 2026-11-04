#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# BUG-02 fix: fail early with actionable instructions when the pinned upstream
# checkout is absent (it is git-ignored, so a fresh clone has no Vencord/).
# Previously `cp` died here with a bare "No such file or directory".
if [ ! -f "$ROOT/Vencord/package.json" ]; then
    echo "ERROR: Vencord checkout missing at $ROOT/Vencord" >&2
    echo "Clone the pinned upstream first, e.g.:" >&2
    echo "  git clone <vencord-upstream-url> Vencord && cd Vencord && git checkout 443688b5" >&2
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

PNPM_CJS="/tmp/opencode/corepack/v1/pnpm/11.9.0/bin/pnpm.cjs"
if [ ! -f "$PNPM_CJS" ]; then
    export COREPACK_HOME=/tmp/opencode/corepack
    nix-shell -p nodejs --run "corepack prepare pnpm@11.9.0 --activate"
fi

cd "$ROOT/Vencord"
nix-shell -p nodejs --run "node $PNPM_CJS build"

for f in vencordDesktopMain.js vencordDesktopPreload.js vencordDesktopRenderer.js vencordDesktopRenderer.css; do
    # BUG-02 fix: a failed build must not leave fresh symlinks pointing at a
    # stale dist. Verify each artifact exists before (re)linking it.
    if [ ! -f "dist/$f" ]; then
        echo "ERROR: dist/$f missing after build" >&2
        exit 1
    fi
    ln -sf "dist/$f" "$f"
done

ROOT_DIR="$ROOT" python3 - "$HOME/.config/vesktop/state.json" <<'EOF'
import json, os, sys
p = sys.argv[1]
want = os.path.join(os.environ["ROOT_DIR"], "Vencord", "dist")
try:
    with open(p) as f:
        s = json.load(f)
    created = False
except FileNotFoundError:
    # BUG-02 fix: a missing state.json used to exit 0 silently, leaving
    # Vesktop on its default vencordDir (silently broken). Create it.
    s = {}
    created = True
except Exception as e:
    print(f"ERROR: cannot parse {p}: {e}", file=sys.stderr)
    sys.exit(1)
if s.get("vencordDir") != want:
    action = "creating" if created else "repairing"
    print(f"{action} vencordDir -> {want}")
    s["vencordDir"] = want
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as f:
        json.dump(s, f, indent=4)
else:
    print(f"vencordDir OK: {want}")
EOF

echo "--- verifying plugin in bundle:"
# BUG-02 fix: case-sensitive match on the exact plugin name. The old
# `grep -ci quickfind` also matched unrelated substrings and could pass on a
# stale bundle that merely mentions the word.
COUNT=$(grep -c "QuickFind" dist/vencordDesktopRenderer.js || true)
echo "QuickFind references in vencordDesktopRenderer.js: $COUNT"
if [ "$COUNT" -eq 0 ]; then
    echo "ERROR: plugin missing from bundle!" >&2
    exit 1
fi
echo OK
