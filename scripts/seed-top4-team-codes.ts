/**
 * Seed / backfill unique 3-letter team_code on top4_registrations.
 *
 * Usage:
 *   npx tsx scripts/seed-top4-team-codes.ts
 *   DIN8STY_DB=/path/to/din8sty.db npx tsx scripts/seed-top4-team-codes.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { seedTop4TeamCodes } from "../src/top4League.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPath =
  process.env.DIN8STY_DB ||
  process.env.DB_PATH ||
  path.join(root, "data", "din8sty.db");

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
const rows = seedTop4TeamCodes(db);
for (const r of rows) {
  const flag = r.updated ? "SET" : "ok ";
  console.log(`${flag}  ${r.team_code}  ${r.team_name}  <${r.email}>`);
}
console.log(`\nDone: ${rows.length} teams (${rows.filter((r) => r.updated).length} updated)`);
db.close();
