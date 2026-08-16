# Din8sty

Fantasy на топ-8 лиг по клубному рейтингу УЕФА:
Premier League, Bundesliga, LaLiga, Serie A, Ligue 1, Liga Portugal, Jupiler Pro League, Eredivisie.

База игроков берётся из `../transfermarkt/data/app.db`, Rating и wage p/w — с [fminside.net/players](https://fminside.net/players).

## Quick start

```bash
npm install
npm run db:build
npm run fm:scrape          # Playwright + Chrome, ~150 клубов
npm run fm:match
npm run dev                # http://127.0.0.1:3080
```

Локальный хост `din8sty.panenka.games`:

```bash
sudo sh -c 'grep -q "din8sty.panenka.games" /etc/hosts || echo "127.0.0.1 din8sty.panenka.games" >> /etc/hosts'
open http://din8sty.panenka.games:3080
```

## Scripts

| Command | What |
|---------|------|
| `npm run db:build` | Собрать `data/din8sty.db` из Transfermarkt top-8 |
| `npm run fm:scrape` | Скачать Full Squad (Rating + wagep/w) с FMInside |
| `npm run fm:match` | Сопоставить FMInside → игроки TM |
| `npm run transfers:sync` | Загрузить историю клубов (TM ceapi) в `player_transfers` |
| `npm run transfers:sync -- --all` | Полный backfill всех игроков (медленно, rate limit TM) |
| `npm run transfers:sync -- --player ID` | Один игрок (можно несколько `--player`) |
| `npm run dev` / `start` | Fastify UI на порту 3080 |
| `npm run top4:ping-bot` | Telegram bot: `/pihajme` + `/h2h` draft assistant |

### Top-4 / H2H Telegram bot

Same bot process (`top4-ping-bot`):

- **Top-4:** turn pings, pick log, `/pihajme`, `/deadline`
- **H2H (Пекло):** `/h2h` — bind email, notify on your turn & opponent picks, draft by numbers (`0` = back)

```bash
# Local
echo 'TOP4_PING_BOT_TOKEN=...' >> .env
echo 'H2H_BOT_SECRET=shared-with-panenka' >> .env
echo 'H2H_BOT_API_ORIGIN=https://panenka.games' >> .env
npm run top4:ping-bot
```

Production: `/opt/din8sty/.env.bot` must include `H2H_BOT_SECRET` matching `H2H_BOT_SECRET` in panenka `.env.production`.

```bash
# on panenka-prod (.env.bot is append-only; deploy merges into .env)
echo 'H2H_BOT_SECRET=...' >> /opt/din8sty/.env.bot
# and in panenka:
echo 'H2H_BOT_SECRET=...' >> /opt/panenka.games/.env.production
```

Player page «История клубов» reads `player_transfers`. On first view the API tries a lazy TM fetch (rate-limited, 10‑min cooldown on failure). TM often blocks datacenter IPs, so prefer batch sync on this machine, then deploy:

```bash
npm run transfers:sync -- --player ID          # one or more --player
npm run transfers:sync -- --all                # full backfill (slow)
./scripts/deploy.sh                            # code only — does NOT overwrite prod SQLite
```

## Production

Live: **https://din8sty.panenka.games/** (Hetzner, same host as panenka.games).

- App: Docker at `/opt/din8sty` on `panenka-prod`, joined to `panenkagames_default` so Caddy can reach `din8sty:3080`.
- Caddy site block: `din8sty.panenka.games` in `/opt/panenka.games/Caddyfile` (repo: `panenka.games`).
- SQLite: `data/din8sty.db` on the host, mounted at `/app/data` (volume). **Deploy excludes `data/*.db*`** so Top-4 registrations, **live draft** (`top4_state` / `top4_draft_picks` / `top4_draft_banks`), lineups, and team maps survive updates. `ensureTop4Tables` only creates missing schema — it does **not** reset drafting rows. Never call `startLiveDraft` / `POST /api/top4/draft/start` as part of deploy. `deploy.sh` snapshots the DB and verifies `status` / `current_pick_no` / `current_pick_at` / pick count unchanged when status is `drafting`. Refresh player data on the server (or merge carefully); never rsync a local empty/stale DB over prod. TM enrichment is optional (`TM_DB_PATH`); missing path → `tm: null`, no crash.
- Auth: login via **panenka.games** Google (SSO handoff). Admin: `aharodnik@gmail.com`. Team maps in SQLite `user_team_map`.

Redeploy from this machine:

```bash
chmod +x scripts/deploy.sh
./scripts/deploy.sh
```

That rsyncs code (not the SQLite DB) to `panenka-prod:/opt/din8sty`, copies `SSO_SECRET` from panenka `AUTH_SECRET`, rebuilds the container, and reloads Caddy.

### Login & teams

1. Click **Войти** → Google login on `panenka.games` → return to Din8sty (httpOnly session cookie).
2. Admin opens **Админ** (`/admin.html`) and maps emails → celestial teams (Сатурн, Марс, …).
3. Logged-in users see their team in the header; on **Пример** non-admins open on their team tab.
