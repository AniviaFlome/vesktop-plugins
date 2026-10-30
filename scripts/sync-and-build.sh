#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

rm -rf "$ROOT/Vencord/src/userplugins/QuickFind"
mkdir -p "$ROOT/Vencord/src/userplugins/QuickFind"
cp "$ROOT"/index.tsx "$ROOT"/channelSources.ts "$ROOT"/filters.ts "$ROOT"/search.ts "$ROOT"/recents.ts "$ROOT/Vencord/src/userplugins/QuickFind/"

nix-shell -p nodejs --run "node $ROOT/run_tests.mjs"

PNPM_CJS="/tmp/opencode/corepack/v1/pnpm/11.9.0/bin/pnpm.cjs"
if [ ! -f "$PNPM_CJS" ]; then
    export COREPACK_HOME=/tmp/opencode/corepack
    nix-shell -p nodejs --run "corepack prepare pnpm@11.9.0 --activate"
fi

cd "$ROOT/Vencord"
nix-shell -p nodejs --run "node $PNPM_CJS build"

for f in vencordDesktopMain.js vencordDesktopPreload.js vencordDesktopRenderer.js vencordDesktopRenderer.css; do
    ln -sf "dist/$f" "$f"
done

ROOT_DIR="$ROOT" python3 - "$HOME/.config/vesktop/state.json" <<'EOF'
import json, os, sys
p = sys.argv[1]
try:
    s = json.load(open(p))
except Exception as e:
    print(f"WARN: cannot read {p}: {e}")
    sys.exit(0)
want = os.path.join(os.environ["ROOT_DIR"], "Vencord", "dist")
if s.get("vencordDir") != want:
    print(f"repairing vencordDir: {s.get('vencordDir')} -> {want}")
    s["vencordDir"] = want
    json.dump(s, open(p, "w"), indent=4)
else:
    print(f"vencordDir OK: {want}")
EOF

echo "--- verifying plugin in bundle:"
COUNT=$(grep -ci "quickfind" dist/vencordDesktopRenderer.js || true)
echo "QuickFind references in vencordDesktopRenderer.js: $COUNT"
if [ "$COUNT" -eq 0 ]; then
    echo "ERROR: plugin missing from bundle!" >&2
    exit 1
fi
echo OK
