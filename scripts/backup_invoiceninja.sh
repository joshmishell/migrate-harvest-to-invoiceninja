#!/bin/bash
# Nightly Invoice Ninja backup (written for Cloudways; set APP below for other hosts).
# Writes into private_html/backups (not web-accessible):
#   db-YYYY-MM-DD.sql.gz      full database (clients, projects, time, invoices, payments, settings)
#   files-YYYY-MM-DD.tar.gz   uploaded documents/PDFs + logo (storage/app) + .env (includes APP_KEY, needed to restore)
# Keeps the last 14 days here; the NAS copy keeps longer.
#
# Cron (Cloudways > Cron Job Management > Advanced), 2:15am UTC:
#   15 2 * * * bash /home/master/applications/YOUR_APP_FOLDER/private_html/backup_invoiceninja.sh >> /home/master/applications/YOUR_APP_FOLDER/private_html/backups/backup.log 2>&1

set -euo pipefail
APP=/home/master/applications/YOUR_APP_FOLDER
SRC="$APP/public_html"
OUT="$APP/private_html/backups"
KEEP_DAYS=14
DAY=$(date +%F)

# Dropbox (optional): copies each night's backup up with rclone. Leave REMOTE empty to skip.
RCLONE="$APP/private_html/bin/rclone"
RCLONE_CONF="$APP/private_html/.rclone.conf"
REMOTE="dropbox-crypt:"          # encrypted; use "dropbox:Invoice Ninja Backups" for plain files
REMOTE_KEEP="365d"

mkdir -p "$OUT"
chmod 700 "$OUT"

env_val() {   # read KEY from .env, strip surrounding quotes
  grep -E "^$1=" "$SRC/.env" | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}
DB_HOST=$(env_val DB_HOST); DB_PORT=$(env_val DB_PORT)
DB_NAME=$(env_val DB_DATABASE); DB_USER=$(env_val DB_USERNAME); DB_PASS=$(env_val DB_PASSWORD)

# password goes in a temp options file so it never shows in the process list
CNF=$(mktemp); chmod 600 "$CNF"; trap 'rm -f "$CNF"' EXIT
printf '[client]\nhost=%s\nport=%s\nuser=%s\npassword="%s"\n' "${DB_HOST:-localhost}" "${DB_PORT:-3306}" "$DB_USER" "${DB_PASS//\"/\\\"}" > "$CNF"

echo "$(date '+%F %T') backup start"
mysqldump --defaults-extra-file="$CNF" --single-transaction --quick --routines --no-tablespaces "$DB_NAME" | gzip -9 > "$OUT/db-$DAY.sql.gz.tmp"
mv "$OUT/db-$DAY.sql.gz.tmp" "$OUT/db-$DAY.sql.gz"

tar -czf "$OUT/files-$DAY.tar.gz.tmp" -C "$SRC" .env storage/app 2>/dev/null || tar -czf "$OUT/files-$DAY.tar.gz.tmp" -C "$SRC" .env
mv "$OUT/files-$DAY.tar.gz.tmp" "$OUT/files-$DAY.tar.gz"

# sanity check: the dump must be non-trivial and end cleanly
if [ "$(gzip -dc "$OUT/db-$DAY.sql.gz" | tail -1 | grep -c 'Dump completed')" != "1" ]; then
  echo "$(date '+%F %T') ERROR: database dump looks incomplete"; exit 1
fi

find "$OUT" -maxdepth 1 -type f \( -name 'db-*.sql.gz' -o -name 'files-*.tar.gz' \) -mtime +$KEEP_DAYS -delete
chmod 600 "$OUT"/*.gz

if [ -n "$REMOTE" ] && [ -x "$RCLONE" ]; then
  "$RCLONE" --config "$RCLONE_CONF" copy "$OUT" "$REMOTE" --include "*-$DAY.*" --transfers 2
  "$RCLONE" --config "$RCLONE_CONF" delete "$REMOTE" --min-age "$REMOTE_KEEP" --include "*.gz"
  echo "$(date '+%F %T') copied to Dropbox"
fi
echo "$(date '+%F %T') backup ok: $(du -h "$OUT/db-$DAY.sql.gz" | cut -f1) db, $(du -h "$OUT/files-$DAY.tar.gz" | cut -f1) files"
