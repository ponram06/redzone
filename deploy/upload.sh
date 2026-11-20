#!/usr/bin/env bash
# Run on your computer (Git Bash) to copy what is not in git to the server:
#   deploy/upload.sh ubuntu@<server-ip> [-i path/to/ssh-key]
# Copies backend/.env (as server.env), the referee key and backend/data (robot brains, profiles,
# owner keys, replays). Stop the RedZone backend on your computer first: the relayer must run in
# one place only, or two servers would send transactions with the same nonces.
set -euo pipefail
cd "$(dirname "$0")/.."
host="$1"; shift || true
ssh_opts=("$@")

# Server settings: everything from backend/.env except local-only lines (Ollama on this laptop,
# paths, host and port, which docker-compose.yml sets).
grep -vE '^(FALLBACK_[0-9]_[A-Z_]+|PORT|HOST|DATA_DIR|REFEREE_KEY_FILE|TRUST_PROXY|CORS_ORIGIN)=' backend/.env > /tmp/rz-server.env || true
# Keep FALLBACK_n entries that point to the internet; drop ones that point to localhost.
for n in 1 2 3 4 5 6 7 8 9; do
  url=$(grep -E "^FALLBACK_${n}_BASE_URL=" backend/.env | cut -d= -f2- || true)
  if [ -n "$url" ] && ! echo "$url" | grep -qE 'localhost|127\.0\.0\.1'; then
    grep -E "^FALLBACK_${n}_" backend/.env >> /tmp/rz-server.env
  fi
done

if curl -fsS -o /dev/null --max-time 3 http://127.0.0.1:8787/health 2>/dev/null; then
  echo "The RedZone backend is still running on this computer (port 8787). Stop it first."; exit 1
fi

tar -czf /tmp/rz-data.tgz -C backend/data --exclude=server.lock .
scp "${ssh_opts[@]}" /tmp/rz-server.env "$host:redzone/deploy/server.env"
scp "${ssh_opts[@]}" contracts/.referee-key.json "$host:redzone/deploy/referee-key.json"
scp "${ssh_opts[@]}" /tmp/rz-data.tgz "$host:/tmp/rz-data.tgz"
ssh "${ssh_opts[@]}" "$host" 'mkdir -p ~/redzone/deploy/data && tar -xzf /tmp/rz-data.tgz -C ~/redzone/deploy/data && rm /tmp/rz-data.tgz && chmod 600 ~/redzone/deploy/server.env ~/redzone/deploy/referee-key.json'
rm -f /tmp/rz-server.env /tmp/rz-data.tgz
echo "Uploaded. On the server: ~/redzone/deploy/start.sh"
