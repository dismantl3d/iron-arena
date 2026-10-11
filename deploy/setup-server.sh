#!/usr/bin/env bash
# One-shot setup for a fresh Ubuntu/Debian VM (x86 or ARM). Run ONCE as root:
#
#   sudo DOMAIN=play.example.com REPO_URL=https://github.com/YOU/iron-arena.git \
#        CLIENT_ORIGIN=https://iron-arena.pages.dev bash setup-server.sh
#
# DOMAIN        hostname that points at this VM's public IP (a free DuckDNS name works, or use
#               "<ip-with-dashes>.sslip.io", e.g. 203-0-113-7.sslip.io, with no signup at all).
# REPO_URL      your git repo (public, or an https URL with a read token).
# CLIENT_ORIGIN the website that serves the game client (becomes the WebSocket allow-list).
# BRANCH        optional, default main.
set -euo pipefail
: "${DOMAIN:?set DOMAIN}"; : "${REPO_URL:?set REPO_URL}"; : "${CLIENT_ORIGIN:?set CLIENT_ORIGIN}"
BRANCH="${BRANCH:-main}"
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }

echo "==> packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git sqlite3 ufw ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https
if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

echo "==> service user + directories"
id ironarena >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/ironarena --shell /bin/bash ironarena
mkdir -p /opt/iron-arena /var/lib/iron-arena /var/backups/iron-arena
chown -R ironarena:ironarena /opt/iron-arena /var/lib/iron-arena /var/backups/iron-arena

echo "==> code"
if [ ! -d /opt/iron-arena/.git ]; then sudo -u ironarena git clone --branch "$BRANCH" "$REPO_URL" /opt/iron-arena; fi
cd /opt/iron-arena
sudo -u ironarena git fetch --quiet origin "$BRANCH" && sudo -u ironarena git reset --hard "origin/$BRANCH"
sudo -u ironarena npm ci --omit=dev --no-audit --no-fund
chmod +x deploy/*.sh

echo "==> config (/etc/iron-arena.env)"
if [ ! -f /etc/iron-arena.env ]; then
cat > /etc/iron-arena.env <<ENV
NODE_ENV=production
PORT=8080
IRON_DB=sqlite
IRON_DATA_DIR=/var/lib/iron-arena
ALLOWED_ORIGINS=$CLIENT_ORIGIN
TRUST_PROXY=1
# Optional off-machine backup target (needs rclone configured): RCLONE_REMOTE=gdrive:iron-arena-backups
ENV
chmod 640 /etc/iron-arena.env; chown root:ironarena /etc/iron-arena.env
else echo "   (kept existing /etc/iron-arena.env)"; fi

echo "==> systemd service (auto-start + auto-restart)"
install -m 644 deploy/iron-arena.service /etc/systemd/system/iron-arena.service
# Let the deploy user restart ONLY this service without a password.
echo 'ironarena ALL=(root) NOPASSWD: /usr/bin/systemctl restart iron-arena' > /etc/sudoers.d/iron-arena
chmod 440 /etc/sudoers.d/iron-arena
systemctl daemon-reload
systemctl enable --now iron-arena

echo "==> https (Caddy) for $DOMAIN"
echo "DOMAIN=$DOMAIN" > /etc/caddy/caddy.env
install -m 644 deploy/Caddyfile /etc/caddy/Caddyfile
mkdir -p /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironmentFile=/etc/caddy/caddy.env\n' > /etc/systemd/system/caddy.service.d/env.conf
systemctl daemon-reload
systemctl enable caddy && systemctl restart caddy

echo "==> firewall (SSH + web only; the game port stays private behind Caddy)"
ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

echo "==> nightly backup (03:15)"
cat > /etc/cron.d/iron-arena-backup <<'CRON'
15 3 * * * root /opt/iron-arena/deploy/backup.sh >> /var/log/iron-arena-backup.log 2>&1
CRON

sleep 3
echo
echo "Local health:  $(curl -s http://127.0.0.1:8080/healthz || echo 'not responding yet')"
echo "Public URL:    wss://$DOMAIN   (https://$DOMAIN/healthz should show {\"ok\":true,...})"
echo "Build the client with:  VITE_SERVER_URL=wss://$DOMAIN npm run build"
echo "Logs:          journalctl -u iron-arena -f"
