#!/usr/bin/env bash
# Builds the card-free demo: the website at $DEMO_BASE and the ops app at $DEMO_BASE/ops/, both
# running an in-browser backend with sample data (no Firebase, Cloudflare or cards needed).
#   DEMO_BASE=/Delivery_app/ deploy/build-demo.sh     → demo-dist/ (ready for GitHub Pages)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BASE=${DEMO_BASE:-/}
[[ "$BASE" == */ ]] || BASE="$BASE/"
OUT=${DEMO_OUT:-$ROOT/demo-dist}
export VITE_DEMO=true
export VITE_FIREBASE_API_KEY=demo VITE_FIREBASE_AUTH_DOMAIN=demo.invalid VITE_FIREBASE_PROJECT_ID=demo-courier VITE_FIREBASE_APP_ID=demo
export VITE_EDGE_API_URL=https://edge.demo.invalid VITE_ONLINE_PAYMENTS=false
export VITE_COMPANY_NAME="${DEMO_COMPANY_NAME:-Swift Courier GH}" VITE_SUPPORT_PHONE="${DEMO_SUPPORT_PHONE:-+233 30 000 0000}"
export VITE_DEMO_WEB_BASE="$BASE" VITE_DEMO_OPS_BASE="${BASE}ops/"
rm -rf "$OUT"
(cd "$ROOT/apps/web" && APP_BASE="$BASE" npx vite build --outDir "$OUT" --emptyOutDir --sourcemap false)
(cd "$ROOT/apps/admin-tools" && APP_BASE="${BASE}ops/" npx vite build --outDir "$OUT/ops" --emptyOutDir --sourcemap false)
# GitHub Pages has no SPA routing: unknown paths load 404.html, which sends the browser to the
# right app with the original address in ?__p= (each app restores it on load).
cat > "$OUT/404.html" <<HTML
<!doctype html><meta charset="utf-8"><title>Loading…</title>
<script>
  var base = '${BASE}', p = location.pathname + location.search + location.hash;
  location.replace((p.indexOf(base + 'ops/') === 0 ? base + 'ops/' : base) + '?__p=' + encodeURIComponent(p));
</script>
HTML
touch "$OUT/.nojekyll"
rm -f "$OUT/_headers" "$OUT/_redirects" "$OUT/ops/_headers" "$OUT/ops/_redirects"
echo "Demo built in $OUT (base $BASE)"
