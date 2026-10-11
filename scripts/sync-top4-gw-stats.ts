/**
 * Sync finished Top-4 GW fixture player stats from API-Football.
 * Usage: npm run top4:gw:sync
 *        npm run top4:gw:sync -- --force
 *        npm run top4:gw:sync -- --gw-min=2 --gw-max=5
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireApiKey } from "../src/apiFootball.js";
import { gameweekFromKickoff } from "../src/gameweeks.js";
import {
  RESULTS_MIN_GW,
  syncFinishedGwFixtureStats,
} from "../src/top4GwResults.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const dbPath = process.env.DIN8STY_DB ?? path.join(root, "data", "din8sty.db");

function argNum(name: string): number | undefined {
  const pref = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  if (!hit) return undefined;
  const n = Number(hit.slice(pref.length));
  return Number.isFinite(n) ? n : undefined;
}

async function main() {
  requireApiKey();
  if (!fs.existsSync(dbPath)) {
    throw new Error(`DB not found: ${dbPath}`);
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  const force = process.argv.includes("--force");
  const gwMin = argNum("gw-min") ?? RESULTS_MIN_GW;
  const current = gameweekFromKickoff(new Date());
  const gwMax = argNum("gw-max") ?? Math.max(gwMin, current);
  const limit = argNum("limit") ?? 500;

  console.log(`Syncing AF fixture player stats GW${gwMin}–${gwMax} (limit ${limit})…`);
  const res = await syncFinishedGwFixtureStats(db, {
    gwMin,
    gwMax,
    limit,
    force,
  });
  console.log(`Fetched ${res.fetched}; still pending ${res.pending}`);
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
