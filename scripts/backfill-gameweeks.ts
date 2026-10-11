/**
 * Ensure fixtures.gameweek exists and is filled from kickoff (UTC → London GW).
 * Usage: npm run fixtures:gameweeks
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gameweekFromKickoff, gameweekRange } from "../src/gameweeks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const dbPath = process.env.DIN8STY_DB ?? path.join(root, "data", "din8sty.db");

export function ensureGameweekColumn(db: Database.Database) {
  const cols = db.prepare(`PRAGMA table_info(fixtures)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "gameweek")) {
    db.exec(`ALTER TABLE fixtures ADD COLUMN gameweek INTEGER`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS fixtures_gameweek ON fixtures(gameweek)`);
}

export function backfillGameweeks(db: Database.Database): number {
  ensureGameweekColumn(db);
  const rows = db.prepare(`SELECT id, date FROM fixtures`).all() as Array<{
    id: number;
    date: string;
  }>;
  const upd = db.prepare(`UPDATE fixtures SET gameweek = ? WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const r of rows) {
      upd.run(gameweekFromKickoff(r.date), r.id);
    }
  });
  tx();
  return rows.length;
}

function main() {
  if (!fs.existsSync(dbPath)) {
    console.error(`DB not found: ${dbPath}`);
    process.exit(1);
  }
  const db = new Database(dbPath);
  const n = backfillGameweeks(db);

  const summary = db
    .prepare(
      `SELECT gameweek AS gw, COUNT(*) AS n, MIN(date) AS first, MAX(date) AS last
       FROM fixtures WHERE gameweek IS NOT NULL
       GROUP BY gameweek ORDER BY gameweek`,
    )
    .all() as Array<{ gw: number; n: number; first: string; last: string }>;

  console.log(`Backfilled gameweek on ${n} fixtures`);
  for (const s of summary.slice(0, 5)) {
    console.log(`  ${gameweekRange(s.gw).label}: ${s.n} fixtures (${s.first} → ${s.last})`);
  }
  if (summary.length > 5) console.log(`  … ${summary.length - 5} more GWs`);
  db.close();
}

const runningAsCli = process.argv[1]?.includes("backfill-gameweeks");
if (runningAsCli) main();
