#!/usr/bin/env bash
# Redeploy Din8sty to panenka-prod (Hetzner).
# Usage (from Mac): ./scripts/deploy.sh
#
# Live draft safety:
# - Never rsync data/*.db* (host bind-mount survives container rebuild).
# - Never call startLiveDraft / resetTop4League as part of deploy.
# - Snapshot + verify top4 draft counters before/after restart.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${DIN8STY_SSH_HOST:-panenka-prod}"
REMOTE="${DIN8STY_REMOTE_DIR:-/opt/din8sty}"

draft_snapshot() {
  # Prints: status|current_pick_no|current_pick_at|pick_count
  # Uses the running container so we hit the same DB the app uses (incl. WAL).
  ssh "$HOST" "cd $REMOTE && docker compose exec -T din8sty node -e \"
const Database = require('better-sqlite3');
const db = new Database('/app/data/din8sty.db', { readonly: true });
const s = db.prepare('SELECT status, current_pick_no, current_pick_at FROM top4_state WHERE id = 1').get() || {};
const picks = db.prepare('SELECT COUNT(*) AS c FROM top4_draft_picks').get().c;
process.stdout.write([s.status || '', s.current_pick_no ?? '', s.current_pick_at || '', picks].join('|'));
\""
}

echo "==> Pre-deploy draft snapshot"
BEFORE="$(draft_snapshot || true)"
echo "    $BEFORE"
if [[ -z "${BEFORE}" ]]; then
  echo "WARN: could not read draft snapshot (container may be down); continuing"
fi

echo "==> Snapshot SQLite draft tables on host (safety copy)"
ssh "$HOST" "cd $REMOTE/data && ts=\$(date -u +%Y%m%dT%H%M%SZ) && cp -a din8sty.db \"din8sty.db.bak-pre-deploy-\$ts\" && cp -a din8sty.db-wal \"din8sty.db-wal.bak-pre-deploy-\$ts\" 2>/dev/null || true && cp -a din8sty.db-shm \"din8sty.db-shm.bak-pre-deploy-\$ts\" 2>/dev/null || true && ls -1t din8sty.db.bak-pre-deploy-* 2>/dev/null | tail -n +4 | xargs -r rm -f"

echo "==> Sync to $HOST:$REMOTE"
# Never overwrite production SQLite (registrations, live draft, lineups, team maps).
# Player DB refreshes must be done on the server or via a dedicated merge path.
rsync -az --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude .env \
  --exclude .env.bot \
  --exclude 'data/*.db' \
  --exclude 'data/*.db-shm' \
  --exclude 'data/*.db-wal' \
  --exclude 'data/*.db.tmp-shm' \
  --exclude 'data/*.db.bak*' \
  --exclude 'data/*.db-wal.bak*' \
  --exclude 'data/*.db-shm.bak*' \
  --exclude data/fminside_raw.json \
  --exclude data/capology_raw.json \
  --exclude data/scrape.log \
  --exclude 'data/uploads/' \
  --exclude .DS_Store \
  "$ROOT/" "$HOST:$REMOTE/"

echo "==> Sync SSO secret from panenka AUTH_SECRET (+ preserve .env.bot)"
# deploy overwrites .env; keep TOP4_PING_BOT_TOKEN etc. in $REMOTE/.env.bot (not in git).
ssh "$HOST" "grep -E '^AUTH_SECRET=' /opt/panenka.games/.env.production | sed 's/^AUTH_SECRET=/SSO_SECRET=/' > $REMOTE/.env && if [ -f $REMOTE/.env.bot ]; then cat $REMOTE/.env.bot >> $REMOTE/.env; fi"

echo "==> Build & restart containers (bind-mount ./data preserves live draft DB)"
ssh "$HOST" "cd $REMOTE && docker compose build && docker compose up -d"

echo "==> Reload Caddy (pick up Caddyfile if changed)"
ssh "$HOST" 'cd /opt/panenka.games && docker compose -f docker-compose.prod.yml exec -T caddy caddy reload --config /etc/caddy/Caddyfile'

echo "==> Health checks"
ok=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "https://din8sty.panenka.games/api/health" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 2
done
if [[ "$ok" -ne 1 ]]; then
  echo "ERROR: /api/health did not become ready"
  exit 1
fi
curl -fsS -I "https://din8sty.panenka.games/" | head -n 5
curl -fsS "https://din8sty.panenka.games/api/health"
echo
curl -fsS "https://din8sty.panenka.games/api/fixtures?limit=1" | head -c 200
echo

if [[ -n "${BEFORE}" ]]; then
  echo "==> Post-deploy draft snapshot (must match pre if still drafting)"
  AFTER="$(draft_snapshot)"
  echo "    before: $BEFORE"
  echo "    after:  $AFTER"
  IFS='|' read -r b_status b_pick b_at b_count <<<"$BEFORE"
  IFS='|' read -r a_status a_pick a_at a_count <<<"$AFTER"
  if [[ "$b_status" == "drafting" ]]; then
    if [[ "$a_status" != "drafting" || "$a_pick" != "$b_pick" || "$a_at" != "$b_at" || "$a_count" != "$b_count" ]]; then
      echo "ERROR: live draft state changed across deploy!"
      echo "  Restore from latest data/din8sty.db.bak-pre-deploy-* on the host if needed."
      echo "  Do NOT run startLiveDraft / POST /api/top4/draft/start to 'fix' this."
      exit 1
    fi
    echo "OK draft preserved (status=drafting pick=$a_pick picks=$a_count)"
  else
    echo "OK (pre-deploy status was '$b_status'; no live-draft continuity check)"
  fi
fi

echo "OK → https://din8sty.panenka.games/"
