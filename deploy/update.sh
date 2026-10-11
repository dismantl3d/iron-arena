#!/usr/bin/env bash
# Pull the latest code, install deps, restart the service, and confirm it came back healthy.
# Run on the server (by hand or by the GitHub Action):   sudo -u ironarena /opt/iron-arena/deploy/update.sh
set -euo pipefail
cd /opt/iron-arena
BRANCH="${BRANCH:-main}"
git fetch --quiet origin "$BRANCH"
git reset --hard "origin/$BRANCH"
npm ci --omit=dev --no-audit --no-fund
sudo systemctl restart iron-arena
for i in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1; then echo "iron-arena is up: $(curl -s http://127.0.0.1:8080/healthz)"; exit 0; fi
  sleep 1
done
echo "iron-arena did not become healthy — see: journalctl -u iron-arena -n 50" >&2
exit 1
