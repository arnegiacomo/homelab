#!/bin/bash
# Pi-hole's entrypoint. /etc/pihole persists on the PVC, so before the image's start.sh runs, this resets what the UI
# can change there to git: settings to the FTLCONF_* env, and gravity.db to the lists in adlists.list and the allow
# entries in allowlist.list, with no groups, clients, or other allow and deny entries. Gravity runs in the background only when that changed the lists, so a plain
# restart keeps blocking with the last good database. See docs/dns.md.
set -euo pipefail

db=/etc/pihole/gravity.db
adlists=/etc/pihole/adlists.list
allowlist=/homelab/allowlist.list

# FTL writes it fresh from the env and the defaults. A kept file would keep the settings changed in the UI.
rm -f /etc/pihole/pihole.toml

# The image creates the database from adlists.list itself on the first start. allowlist.list applies from the next start.
if [[ ! -f $db ]]; then
  exec /usr/bin/start.sh
fi

# Prints one INSERT per entry of a list file into the given table, skipping comments and blank lines.
inserts() {
  grep -v '^[[:space:]]*#' "$1" | sed 's/[[:space:]]//g' | grep . | sed "s/'/''/g; s/.*/INSERT OR IGNORE INTO $2 VALUES ('&');/" || true
}
repo=$(inserts "$adlists" repo)
allow=$(inserts "$allowlist" allow)

# Removed lists stop blocking right away: vw_gravity, which FTL reads, only joins enabled lists that exist.
# Prints what needs a gravity run: lists gravity has never processed, and domains of removed lists. Both stay until a
# run succeeds, so a run that fails or is cut short is tried again on the next start.
# On an error nothing is changed, and Pi-hole still starts with the database as it is.
if ! changed=$(pihole-FTL sqlite3 -ni "$db" <<SQL
.bail on
.timeout 30000
-- pihole-FTL's sqlite3 turns them on, and gravity's rows reference their list without ON DELETE.
PRAGMA foreign_keys = OFF;
CREATE TEMP TABLE repo (address TEXT PRIMARY KEY);
$repo
CREATE TEMP TABLE allow (domain TEXT PRIMARY KEY);
$allow
BEGIN;
DELETE FROM domainlist;
-- Type 0 is an exact allow entry. A trigger adds it to the default group.
INSERT INTO domainlist (type, domain, comment) SELECT 0, domain, 'allowlist.list' FROM allow;
DELETE FROM client;
DELETE FROM adlist_by_group WHERE group_id != 0;
DELETE FROM "group" WHERE id != 0;
UPDATE "group" SET enabled = 1 WHERE id = 0 AND enabled = 0;
DELETE FROM adlist WHERE type != 0 OR address NOT IN (SELECT address FROM repo);
INSERT OR IGNORE INTO adlist (address, comment) SELECT address, 'adlists.list' FROM repo;
UPDATE adlist SET enabled = 1 WHERE enabled = 0;
INSERT OR IGNORE INTO adlist_by_group (adlist_id, group_id) SELECT id, 0 FROM adlist;
COMMIT;
SELECT 'new list ' || address FROM adlist WHERE status = 0;
SELECT 'removed list ' || adlist_id FROM (SELECT adlist_id FROM gravity UNION SELECT adlist_id FROM antigravity)
  WHERE adlist_id NOT IN (SELECT id FROM adlist);
SQL
); then
  echo "  [!] Could not reset $db to adlists.list, starting with it as it is"
  changed=""
fi

if [[ -n $changed ]]; then
  echo "  [i] The lists changed, gravity runs once Pi-hole answers:"
  echo "$changed"
  # Gravity exits non-zero without touching the database when it can't resolve the list hosts, e.g. before the
  # internet is back after a power cut. A download that fails once DNS works falls back to the cached list.
  {
    until dig +short +norecurse +time=1 +tries=1 @127.0.0.1 pi.hole | grep -q .; do sleep 2; done
    until pihole -g; do
      echo "  [!] Gravity failed, retrying in 5 minutes"
      sleep 300
    done
  } &
fi

exec /usr/bin/start.sh
