/**
 * Sync Transfermarkt coach performance history into din8sty.db (player_coaches).
 *
 * Source: tmapi /player/{id}/performance-game → aggregate by club coachId
 * (participationState === "played"), resolve names via /coaches?ids[].
 * Rate-limited via src/tmRateLimit.ts (≤4/s, ≤100/min).
 *
 * Usage:
 *   npm run coaches:sync -- --player 19726
 *   npm run coaches:sync -- --player 418560 --player 342229
 *   npm run coaches:sync -- --all
 *   npm run coaches:sync -- --all --limit 50
 *   npm run coaches:sync -- --force
 *
 * Player pages also lazy-sync on first view when coach history is missing.
 * Prefer running the batch on a residential/desktop host (TM may block datacenter IPs).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { ensurePlayerCoachesTable, playerHasCoaches } from "../src/playerCoaches.js";
import { syncPlayerCoaches } from "../src/coachSync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const dbPath = path.join(root, "data", "din8sty.db");

function parseArgs(argv: string[]) {
  const out = {
    players: [] as string[],
    all: false,
    force: false,
    limit: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--player") {
      const id = argv[++i] ?? "";
      if (id) out.players.push(id);
    } else if (a === "--all") out.all = true;
    else if (a === "--force") out.force = true;
    else if (a === "--limit") out.limit = Number(argv[++i] ?? 0) || 0;
  }
  return out;
}

function collectTargets(db: Database.Database, args: ReturnType<typeof parseArgs>): string[] {
  const ids = new Set<string>();
  for (const id of args.players) ids.add(id);
  if (args.all) {
    for (const row of db
      .prepare(
        `SELECT id FROM players
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(dbPath)) {
    console.error("Missing data/din8sty.db");
    process.exit(1);
  }
  if (!args.players.length && !args.all) {
    console.error(
      "Specify --player <tmId> and/or --all (optional --limit N, --force).",
    );
    process.exit(1);
  }

  const db = new Database(dbPath);
  ensurePlayerCoachesTable(db);

  const targets = collectTargets(db, args);
  console.log(
    `Syncing coaches for ${targets.length} players (force=${args.force})`,
  );

  let synced = 0;
  let skipped = 0;
  let empty = 0;
  let failed = 0;

  for (const id of targets) {
    if (!args.force && playerHasCoaches(db, id)) {
      skipped += 1;
      continue;
    }
    const name =
      (db.prepare(`SELECT name FROM players WHERE id = ?`).get(id) as { name: string } | undefined)
        ?.name ?? id;
    try {
      const rows = await syncPlayerCoaches(db, id);
      if (!rows.length) {
        empty += 1;
        console.log(`  ${id} ${name}: 0 coaches (empty or blocked)`);
        continue;
      }
      synced += 1;
      const top = rows[0]!;
      console.log(
        `  ${id} ${name}: ${rows.length} coaches` +
          ` · top ${top.trainer_name ?? top.trainer_id} (${top.apps}` +
          (top.first_date && top.last_date
            ? `, ${top.first_date}→${top.last_date}`
            : "") +
          `)`,
      );
    } catch (err) {
      failed += 1;
      console.warn(`  ! ${id} ${name}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(
    `Done: synced=${synced} skipped=${skipped} empty=${empty} failed=${failed}`,
  );
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
