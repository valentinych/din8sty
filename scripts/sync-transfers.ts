/**
 * Sync Transfermarkt transfer history into din8sty.db (player_transfers).
 *
 * Source: https://www.transfermarkt.com/ceapi/transferHistory/list/{playerId}
 * Rate-limited via src/tmRateLimit.ts (≤4/s, ≤100/min).
 *
 * Usage:
 *   npm run transfers:sync
 *   npm run transfers:sync -- --player 1282860
 *   npm run transfers:sync -- --player 345189 --player 418560
 *   npm run transfers:sync -- --unmatched --limit 80
 *   npm run transfers:sync -- --all
 *   npm run transfers:sync -- --force --apply-clubs --player 398184
 *   npm run transfers:sync -- --apply-clubs --player 460939
 *
 * Player pages also lazy-sync on first view when history is missing.
 * For a full backfill of all players (slow, TM rate limits):
 *   npm run transfers:sync -- --all
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  clubsInSeason2526,
  ensurePlayerTransfersTable,
  type PlayerTransfer,
} from "../src/playerTransfers.js";
import {
  applyLatestCompletedClub,
  fetchTransfersFromTm,
  mapTransferRows,
  replacePlayerTransfers,
} from "../src/transferSync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const dbPath = process.env.DIN8STY_DB || path.join(root, "data", "din8sty.db");
const seasonClubsPath = path.join(root, "data", "fm_season_clubs.json");

function parseArgs(argv: string[]) {
  const out = {
    players: [] as string[],
    unmatched: false,
    all: false,
    force: false,
    applyClubs: false,
    limit: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--player") {
      const id = argv[++i] ?? "";
      if (id) out.players.push(id);
    } else if (a === "--unmatched") out.unmatched = true;
    else if (a === "--all") out.all = true;
    else if (a === "--force") out.force = true;
    else if (a === "--apply-clubs") out.applyClubs = true;
    else if (a === "--limit") out.limit = Number(argv[++i] ?? 0) || 0;
  }
  // Default: unmatched movers + Modou if nothing specified
  if (!out.players.length && !out.unmatched && !out.all) {
    out.unmatched = true;
    out.players.push("1282860");
  }
  return out;
}

function collectTargets(db: Database.Database, args: ReturnType<typeof parseArgs>): string[] {
  const ids = new Set<string>();
  for (const id of args.players) ids.add(id);
  if (args.all) {
    for (const row of db.prepare(`SELECT id FROM players`).all() as Array<{ id: string }>) {
      ids.add(String(row.id));
    }
  } else if (args.unmatched) {
    for (const row of db
      .prepare(
        `SELECT id FROM players
         WHERE fm_rating IS NULL
         ORDER BY COALESCE(market_value_eur, 0) DESC`,
      )
      .all() as Array<{ id: string }>) {
      ids.add(String(row.id));
    }
  }
  let list = [...ids];
  if (args.limit > 0) list = list.slice(0, args.limit);
  return list;
}

function alreadySynced(db: Database.Database, playerId: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM player_transfers WHERE player_id = ? LIMIT 1`)
    .get(playerId) as { ok: number } | undefined;
  return Boolean(row);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(dbPath)) {
    console.error("Missing data/din8sty.db");
    process.exit(1);
  }

  const db = new Database(dbPath);
  ensurePlayerTransfersTable(db);

  const targets = collectTargets(db, args);
  console.log(
    `Syncing transfers for ${targets.length} players` +
      ` (unmatched=${args.unmatched}, force=${args.force})`,
  );

  let synced = 0;
  let skipped = 0;
  let failed = 0;
  let clubsMoved = 0;
  const seasonMap: Record<string, string[]> = fs.existsSync(seasonClubsPath)
    ? (JSON.parse(fs.readFileSync(seasonClubsPath, "utf8")) as Record<string, string[]>)
    : {};

  const maybeApplyClub = (id: string, name: string) => {
    if (!args.applyClubs) return;
    const moved = applyLatestCompletedClub(db, id);
    if (moved) {
      clubsMoved += 1;
      const row = db
        .prepare(
          `SELECT p.club_id, c.name AS club_name, p.league_id
           FROM players p LEFT JOIN clubs c ON c.id = p.club_id WHERE p.id = ?`,
        )
        .get(id) as { club_id: string; club_name: string | null; league_id: string } | undefined;
      console.log(
        `  ${id} ${name}: club → ${row?.club_name || row?.club_id || "?"} (${row?.league_id || "?"})`,
      );
    }
  };

  for (const id of targets) {
    const name =
      (db.prepare(`SELECT name FROM players WHERE id = ?`).get(id) as { name: string } | undefined)
        ?.name ?? id;
    if (!args.force && alreadySynced(db, id)) {
      skipped += 1;
      const existing = db
        .prepare(`SELECT * FROM player_transfers WHERE player_id = ? ORDER BY sort_order`)
        .all(id) as PlayerTransfer[];
      const clubs = clubsInSeason2526(existing);
      if (clubs.length) seasonMap[id] = clubs;
      maybeApplyClub(id, name);
      continue;
    }
    try {
      const raw = await fetchTransfersFromTm(id);
      const now = new Date().toISOString();
      const rows = mapTransferRows(id, raw, now);
      if (!rows.length) {
        failed += 1;
        console.warn(`  ! ${id} ${name}: empty TM payload, transfers unchanged`);
        maybeApplyClub(id, name);
        continue;
      }
      replacePlayerTransfers(db, id, rows);
      const clubs = clubsInSeason2526(rows);
      if (clubs.length) seasonMap[id] = clubs;
      else delete seasonMap[id];
      synced += 1;
      console.log(
        `  ${id} ${name}: ${rows.length} transfers` +
          (clubs.length ? ` · 25/26 clubs ${clubs.join(",")}` : ""),
      );
      maybeApplyClub(id, name);
    } catch (err) {
      failed += 1;
      console.warn(`  ! ${id} ${name}:`, err instanceof Error ? err.message : err);
    }
  }

  fs.writeFileSync(seasonClubsPath, JSON.stringify(seasonMap, null, 2) + "\n");
  console.log(
    `Done: synced=${synced} skipped=${skipped} failed=${failed}` +
      (args.applyClubs ? ` clubsMoved=${clubsMoved}` : "") +
      ` · season map ${Object.keys(seasonMap).length} players → ${seasonClubsPath}`,
  );
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
