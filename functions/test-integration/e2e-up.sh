#!/usr/bin/env bash
# Starts the local E2E stack used by test-integration/e2e-*.cjs (no cloud accounts needed):
#   Firestore :8080 + RTDB :9000 (emulator jars, rules loaded), Auth emulator :9099,
#   e2e-shim (:5001 callables, :8787 geocoder, :7070 fake Paystack, :8788 fake evidence store),
#   web on :4173 and ops on :4174 (vite preview, built against the emulators).
# Logs go to $LOGS (default /tmp/courier-e2e). Stop with: e2e-up.sh stop
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
LOGS=${LOGS:-/tmp/courier-e2e}
JARS=${JARS:-$HOME/.cache/firebase/emulators}
stop() {
  pkill -f e2e-shim.ts || true; pkill -f "vite preview" || true; pkill -f "emulators:start" || true
  pkill -f cloud-firestore-emulator || true; pkill -f firebase-database-emulator || true
}
[ "${1:-}" = stop ] && { stop; exit 0; }
stop; mkdir -p "$LOGS"
wait_for() { for _ in $(seq 1 60); do curl -s --noproxy '*' "$1" >/dev/null && return 0; sleep 1; done; echo "timeout: $1"; exit 1; }

setsid nohup java -jar "$JARS"/cloud-firestore-emulator-*.jar --host 127.0.0.1 --port 8080 >"$LOGS/firestore.log" 2>&1 &
setsid nohup java -jar "$JARS"/firebase-database-emulator-*.jar --host 127.0.0.1 --port 9000 >"$LOGS/database.log" 2>&1 &
(cd "$ROOT" && setsid nohup firebase/rules-tests/node_modules/.bin/firebase emulators:start --project demo-courier --only auth >"$LOGS/auth.log" 2>&1 &)
wait_for http://127.0.0.1:8080; wait_for http://127.0.0.1:9000/.json; wait_for http://127.0.0.1:9099

# Load the real security rules.
node -e '
const fs = require("fs");
const rules = fs.readFileSync(process.argv[1], "utf8");
fetch("http://127.0.0.1:8080/emulator/v1/projects/demo-courier:securityRules", { method: "PUT", body: JSON.stringify({ rules: { files: [{ name: "firestore.rules", content: rules }] } }) })
  .then((r) => { if (!r.ok) throw new Error("firestore rules " + r.status); });
fetch("http://127.0.0.1:9000/.settings/rules.json?ns=demo-courier", { method: "PUT", headers: { Authorization: "Bearer owner" }, body: fs.readFileSync(process.argv[2], "utf8") })
  .then((r) => { if (!r.ok) throw new Error("database rules " + r.status); });
' "$ROOT/firebase/firestore.rules" "$ROOT/firebase/database.rules.json"

(cd "$ROOT/functions" && FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 pnpm seed --project demo-courier >"$LOGS/seed.log" 2>&1)
(cd "$ROOT/functions" && FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:9000 \
  setsid nohup npx tsx test-integration/e2e-shim.ts >"$LOGS/shim.log" 2>&1 &)

VARS=(VITE_USE_EMULATORS=true VITE_FIREBASE_API_KEY=demo-key VITE_FIREBASE_AUTH_DOMAIN=demo-courier.firebaseapp.com VITE_COMPANY_NAME="Example Courier GH"
  VITE_EDGE_API_URL=http://127.0.0.1:8787 "VITE_FIREBASE_DATABASE_URL=http://127.0.0.1:9000?ns=demo-courier")
(cd "$ROOT/apps/web" && env "${VARS[@]}" npx vite build >"$LOGS/web-build.log" 2>&1 && (setsid nohup npx vite preview --host 127.0.0.1 --port 4173 --strictPort >"$LOGS/web.log" 2>&1 </dev/null &))
(cd "$ROOT/apps/admin-tools" && env "${VARS[@]}" npx vite build >"$LOGS/ops-build.log" 2>&1 && (setsid nohup npx vite preview --host 127.0.0.1 --port 4174 --strictPort >"$LOGS/ops.log" 2>&1 </dev/null &))
wait_for http://127.0.0.1:5001; wait_for http://127.0.0.1:4173; wait_for http://127.0.0.1:4174
echo "E2E stack up (logs in $LOGS)"
