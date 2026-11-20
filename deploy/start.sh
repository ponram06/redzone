#!/usr/bin/env bash
# Start or update RedZone on the server: pulls the latest code, rebuilds, restarts.
# The address is https://<ip-with-dashes>.sslip.io unless DOMAIN is set (e.g. DOMAIN=redzone.example).
set -euo pipefail
cd "$(dirname "$0")"
git -C .. pull --ff-only
for f in server.env referee-key.json; do
  [ -f "$f" ] || { echo "missing deploy/$f: run deploy/upload.sh from your computer first"; exit 1; }
done
if [ -z "${DOMAIN:-}" ]; then
  [ -f .domain ] && DOMAIN=$(cat .domain) || DOMAIN="$(curl -fsS https://api.ipify.org | tr . -).sslip.io"
fi
echo "$DOMAIN" > .domain
export DOMAIN
docker compose up -d --build
echo "RedZone is starting at https://$DOMAIN (the first HTTPS certificate takes a minute)."
