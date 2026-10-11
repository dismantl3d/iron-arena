#!/usr/bin/env bash
# Nightly, WAL-safe backup of the accounts database. Keeps the last 14 copies.
# Optional off-machine copy: if `rclone` is installed and RCLONE_REMOTE is set in
# /etc/iron-arena.env (e.g. "gdrive:iron-arena-backups"), the newest backup is uploaded too.
set -euo pipefail
[ -f /etc/iron-arena.env ] && set -a && . /etc/iron-arena.env && set +a
DB="${IRON_DATA_DIR:-/var/lib/iron-arena}/iron-arena.db"
OUT=/var/backups/iron-arena
mkdir -p "$OUT"
[ -f "$DB" ] || { echo "no database yet at $DB"; exit 0; }
STAMP=$(date +%Y%m%d-%H%M%S)
sqlite3 "$DB" ".backup '$OUT/iron-arena-$STAMP.db'"
gzip -f "$OUT/iron-arena-$STAMP.db"
ls -1t "$OUT"/iron-arena-*.db.gz | tail -n +15 | xargs -r rm -f
if command -v rclone >/dev/null 2>&1 && [ -n "${RCLONE_REMOTE:-}" ]; then
  rclone copy "$OUT/iron-arena-$STAMP.db.gz" "$RCLONE_REMOTE" --quiet || echo "rclone upload failed (local backup kept)" >&2
fi
echo "backup ok: $OUT/iron-arena-$STAMP.db.gz"
