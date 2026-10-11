/**
 * Pull season fixtures from API-Football → din8sty.db.
 *
 * 1) Top-8 domestic leagues (bulk): GET /fixtures?league=&season=
 * 2) All mapped clubs (all comps): GET /fixtures?team=&season=
 *    — domestic cups, Europe, supers, friendlies when AF has published them
 *
 * Idempotent upserts; re-run safe.
 * Usage:
 *   npm run fixtures:sync
 *   npm run fixtures:sync -- --force
 *   npm run fixtures:sync -- --all-comps   # skip league bulk if already present; still refresh teams
 *   npm run fixtures:sync -- --all-comps --top4  # only GB1/ES1/IT1/L1 clubs (cups/supers/Europe)
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fixtures as fetchFixtures,
  fixturesByTeam,
  requireApiKey,
  type AfFixture,
} from "../src/apiFootball.js";
import { AF_SEASON, TOP8_LEAGUES } from "../src/leagues.js";
import { backfillGameweeks, ensureGameweekColumn } from "./backfill-gameweeks.js";
import {
  purgePlaceholderKickoffFixtures,
  upsertAfFixtures,
} from "../src/fixtureUpsert.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const dbPath = process.env.DIN8STY_DB ?? path.join(root, "data", "din8sty.db");
const tmDbPath =
  process.env.TM_DB_PATH ?? path.resolve(root, "..", "transfermarkt", "data", "app.db");

const SEASON = Number(process.env.AF_SEASON ?? AF_SEASON);
const force = process.argv.includes("--force");
const allCompsOnly = process.argv.includes("--all-comps");
/** Limit per-team all-comps sync to Top-4 domestic leagues (ENG/SPA/ITA/GER). */
const top4Only = process.argv.includes("--top4");
const TOP4_CLUB_LEAGUES = ["GB1", "ES1", "IT1", "L1"] as const;

/** Hard AF team_id → din8sty club_id when names diverge (Rennes vs Rennais, etc.). */
const AF_CLUB_OVERRIDE: Record<number, string> = {
  94: "273", // Rennes → Stade Rennais FC
};

function normName(input: string): string {
  return input
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ø/gi, "o")
    .replace(/æ/gi, "ae")
    .replace(/œ/gi, "oe")
    .replace(/ł/gi, "l")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(fc|cf|sc|afc|ac|as|ss|rcd|ud|cd|sd|kv|rsc|sv|vfb|vfl|tsv|bsc|osc)\b/g, " ")
    .replace(/\b(united|city|town|hotspur|wanderers|albion|sporting|athletic)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clubNamesMatch(a: string, b: string): boolean {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) {
    const shorter = na.length <= nb.length ? na : nb;
    return shorter.length >= 4;
  }
  const ta = na.split(" ").filter((t) => t.length > 2);
  const tb = nb.split(" ").filter((t) => t.length > 2);
  const inter = ta.filter((t) => tb.includes(t));
  return inter.length >= 1 && (ta.length <= 2 || tb.length <= 2 || inter.length >= 2);
}

function ensureSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fixtures (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      status TEXT,
      round TEXT,
      league_id TEXT NOT NULL,
      af_league_id INTEGER NOT NULL,
      season INTEGER NOT NULL,
      home_af_id INTEGER NOT NULL,
      away_af_id INTEGER NOT NULL,
      home_name TEXT NOT NULL,
      away_name TEXT NOT NULL,
      home_goals INTEGER,
      away_goals INTEGER,
      venue TEXT
    );
    CREATE INDEX IF NOT EXISTS fixtures_league ON fixtures(league_id);
    CREATE INDEX IF NOT EXISTS fixtures_date ON fixtures(date);
    CREATE INDEX IF NOT EXISTS fixtures_home ON fixtures(home_af_id);
    CREATE INDEX IF NOT EXISTS fixtures_away ON fixtures(away_af_id);
    CREATE INDEX IF NOT EXISTS fixtures_season ON fixtures(season);

    CREATE TABLE IF NOT EXISTS club_af_map (
      af_team_id INTEGER PRIMARY KEY,
      club_id TEXT NOT NULL,
      af_name TEXT,
      FOREIGN KEY (club_id) REFERENCES clubs(id)
    );
    CREATE INDEX IF NOT EXISTS club_af_map_club ON club_af_map(club_id);
  `);

  const cols = new Set(
    (db.prepare(`PRAGMA table_info(fixtures)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  );
  if (!cols.has("competition_name")) {
    db.exec(`ALTER TABLE fixtures ADD COLUMN competition_name TEXT`);
  }
  if (!cols.has("competition_country")) {
    db.exec(`ALTER TABLE fixtures ADD COLUMN competition_country TEXT`);
  }
  if (!cols.has("competition_type")) {
    db.exec(`ALTER TABLE fixtures ADD COLUMN competition_type TEXT`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS fixtures_af_league ON fixtures(af_league_id)`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS fixtures_competition ON fixtures(competition_name)`,
  );
}

function upsertFixtures(db: Database.Database, season: number, rows: AfFixture[]) {
  upsertAfFixtures(db, season, rows);
}

function importTmClubMap(db: Database.Database): number {
  if (!fs.existsSync(tmDbPath)) {
    console.log(`  TM DB not found (${tmDbPath}) — skip import`);
    return 0;
  }
  const tm = new Database(tmDbPath, { readonly: true });
  try {
    const dinClubs = new Set(
      (db.prepare(`SELECT id FROM clubs`).all() as Array<{ id: string }>).map((r) => r.id),
    );
    const allMaps = tm
      .prepare(`SELECT af_team_id, tm_club_id, tm_name FROM tm_club_map`)
      .all() as Array<{ af_team_id: number; tm_club_id: string; tm_name: string }>;

    const upsert = db.prepare(
      `INSERT INTO club_af_map (af_team_id, club_id, af_name)
       VALUES (@af_team_id, @club_id, @af_name)
       ON CONFLICT(af_team_id) DO UPDATE SET
         club_id = excluded.club_id,
         af_name = COALESCE(excluded.af_name, club_af_map.af_name)`,
    );

    let n = 0;
    const tx = db.transaction(() => {
      for (const m of allMaps) {
        if (!dinClubs.has(m.tm_club_id)) continue;
        upsert.run({
          af_team_id: m.af_team_id,
          club_id: m.tm_club_id,
          af_name: m.tm_name,
        });
        n++;
      }
    });
    tx();
    return n;
  } finally {
    tm.close();
  }
}

function mapTeamsFromFixtures(db: Database.Database): { mapped: number; misses: string[] } {
  const teams = db
    .prepare(
      `SELECT home_af_id AS id, home_name AS name, league_id FROM fixtures
       UNION
       SELECT away_af_id, away_name, league_id FROM fixtures`,
    )
    .all() as Array<{ id: number; name: string; league_id: string }>;

  const byLeague = new Map<string, Array<{ id: string; name: string; short_name: string | null }>>();
  for (const league of TOP8_LEAGUES) {
    byLeague.set(
      league.id,
      db
        .prepare(`SELECT id, name, short_name FROM clubs WHERE league_id = ?`)
        .all(league.id) as Array<{ id: string; name: string; short_name: string | null }>,
    );
  }

  const existing = new Set(
    (db.prepare(`SELECT af_team_id FROM club_af_map`).all() as Array<{ af_team_id: number }>).map(
      (r) => r.af_team_id,
    ),
  );

  const upsert = db.prepare(
    `INSERT INTO club_af_map (af_team_id, club_id, af_name)
     VALUES (@af_team_id, @club_id, @af_name)
     ON CONFLICT(af_team_id) DO UPDATE SET
       club_id = excluded.club_id,
       af_name = excluded.af_name`,
  );

  const usedClub = new Set(
    (db.prepare(`SELECT club_id FROM club_af_map`).all() as Array<{ club_id: string }>).map(
      (r) => r.club_id,
    ),
  );

  let mapped = 0;
  const misses: string[] = [];
  const seen = new Set<number>();

  for (const t of teams) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    if (existing.has(t.id)) continue;

    const override = AF_CLUB_OVERRIDE[t.id];
    if (override) {
      upsert.run({ af_team_id: t.id, club_id: override, af_name: t.name });
      usedClub.add(override);
      existing.add(t.id);
      mapped++;
      continue;
    }

    // Only name-match against Top-8 domestic leagues
    if (!byLeague.has(t.league_id)) continue;

    const clubs = byLeague.get(t.league_id) ?? [];
    const hit =
      clubs.find((c) => !usedClub.has(c.id) && clubNamesMatch(t.name, c.name)) ??
      clubs.find(
        (c) =>
          !usedClub.has(c.id) && c.short_name && clubNamesMatch(t.name, c.short_name),
      ) ??
      clubs.find((c) => clubNamesMatch(t.name, c.name));

    if (!hit) {
      misses.push(`${t.name} (af=${t.id}, ${t.league_id})`);
      continue;
    }
    upsert.run({ af_team_id: t.id, club_id: hit.id, af_name: t.name });
    usedClub.add(hit.id);
    existing.add(t.id);
    mapped++;
  }
  return { mapped, misses };
}

function setMeta(db: Database.Database, key: string, value: string) {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

async function syncLeagues(db: Database.Database): Promise<Array<{ league: string; afId: number; count: number }>> {
  const counts: Array<{ league: string; afId: number; count: number }> = [];

  for (const league of TOP8_LEAGUES) {
    const metaKey = `fixtures_${league.id}_${SEASON}`;
    const prev = (
      db.prepare(`SELECT value FROM meta WHERE key = ?`).get(metaKey) as
        | { value: string }
        | undefined
    )?.value;
    const existing = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM fixtures WHERE league_id = ? AND season = ?`)
        .get(league.id, SEASON) as { n: number }
    ).n;

    if (!force && existing > 0 && prev) {
      console.log(
        `  ${league.id} ${league.name} (AF ${league.afId}): skip ${existing} existing (use --force)`,
      );
      counts.push({ league: league.id, afId: league.afId, count: existing });
      continue;
    }

    console.log(`  ${league.id} ${league.name} (AF ${league.afId}): fetching…`);
    const { response } = await fetchFixtures(league.afId, SEASON);
    upsertFixtures(db, SEASON, response);
    setMeta(db, metaKey, String(response.length));
    console.log(`    → ${response.length} fixtures`);
    counts.push({ league: league.id, afId: league.afId, count: response.length });
  }

  return counts;
}

async function syncAllClubComps(db: Database.Database): Promise<{
  teams: number;
  fixturesUpserted: number;
  byCompetition: Array<{ name: string; n: number }>;
}> {
  const leagueFilter = top4Only
    ? `WHERE c.league_id IN (${TOP4_CLUB_LEAGUES.map(() => "?").join(",")})`
    : "";
  const teams = db
    .prepare(
      `SELECT m.af_team_id, m.af_name, c.name AS club_name
       FROM club_af_map m
       JOIN clubs c ON c.id = m.club_id
       ${leagueFilter}
       ORDER BY c.league_id, c.name`,
    )
    .all(...(top4Only ? [...TOP4_CLUB_LEAGUES] : [])) as Array<{
    af_team_id: number;
    af_name: string | null;
    club_name: string;
  }>;

  const metaKey = top4Only ? `fixtures_teams_top4_${SEASON}` : `fixtures_teams_${SEASON}`;
  const prev = (
    db.prepare(`SELECT value FROM meta WHERE key = ?`).get(metaKey) as
      | { value: string }
      | undefined
  )?.value;

  // Skip unless --force or --all-comps (explicit refresh of cups/Europe).
  if (!force && !allCompsOnly && prev) {
    console.log(
      `  team comps: skip (meta ${metaKey}=${prev}; use --force or --all-comps)`,
    );
    return { teams: 0, fixturesUpserted: 0, byCompetition: [] };
  }

  console.log(
    `  fetching all comps for ${teams.length} mapped clubs${top4Only ? " (Top-4 only)" : ""}…`,
  );
  let fixturesUpserted = 0;
  let i = 0;
  for (const t of teams) {
    i++;
    const { response } = await fixturesByTeam(t.af_team_id, SEASON);
    upsertFixtures(db, SEASON, response);
    fixturesUpserted += response.length;
    if (i % 25 === 0 || i === teams.length) {
      console.log(`    … ${i}/${teams.length} teams (${fixturesUpserted} fixture rows upserted)`);
    }
  }

  setMeta(db, metaKey, String(teams.length));
  setMeta(db, `fixtures_teams_synced_at`, new Date().toISOString());

  const byCompetition = db
    .prepare(
      `SELECT COALESCE(competition_name, '(unknown)') AS name, COUNT(*) AS n
       FROM fixtures WHERE season = ?
       GROUP BY competition_name
       ORDER BY n DESC`,
    )
    .all(SEASON) as Array<{ name: string; n: number }>;

  return { teams: teams.length, fixturesUpserted, byCompetition };
}

async function main() {
  requireApiKey(); // fail early / clearly

  if (!fs.existsSync(dbPath)) {
    console.error(`Din8sty DB not found: ${dbPath}`);
    process.exit(1);
  }

  const db = new Database(dbPath);
  ensureSchema(db);
  ensureGameweekColumn(db);

  console.log(`Season ${SEASON} · ${TOP8_LEAGUES.length} leagues + all comps → ${dbPath}`);
  console.log(`Mapping: import TM club map…`);
  const imported = importTmClubMap(db);
  console.log(`  imported ${imported} AF↔club rows from transfermarkt`);

  let counts: Array<{ league: string; afId: number; count: number }> = [];
  if (allCompsOnly) {
    console.log(`--all-comps: skipping league bulk sync`);
  } else {
    console.log(`Syncing Top-8 domestic leagues…`);
    counts = await syncLeagues(db);
  }

  console.log(`Name-matching unmapped AF teams…`);
  const { mapped, misses } = mapTeamsFromFixtures(db);
  console.log(`  newly mapped: ${mapped}`);
  if (misses.length) {
    console.log(`  misses (${misses.length}):`);
    for (const m of misses.slice(0, 30)) console.log(`    · ${m}`);
    if (misses.length > 30) console.log(`    … +${misses.length - 30} more`);
  }

  console.log(`Syncing all competitions per mapped club…`);
  const teamSync = await syncAllClubComps(db);

  const totalMap = (
    db.prepare(`SELECT COUNT(*) AS n FROM club_af_map`).get() as { n: number }
  ).n;
  const totalFx = (
    db.prepare(`SELECT COUNT(*) AS n FROM fixtures WHERE season = ?`).get(SEASON) as {
      n: number;
    }
  ).n;
  const gwFilled = backfillGameweeks(db);
  console.log(`Gameweeks backfilled: ${gwFilled}`);
  const purged = purgePlaceholderKickoffFixtures(db);
  console.log(`Purged placeholder kickoffs: ${purged}`);

  setMeta(db, `fixtures_synced_at`, new Date().toISOString());
  setMeta(db, `fixtures_season`, String(SEASON));
  setMeta(db, `club_af_map_count`, String(totalMap));

  if (counts.length) {
    console.log("\nCounts by domestic league:");
    for (const c of counts) {
      console.log(`  ${c.league} (AF ${c.afId}): ${c.count}`);
    }
  }
  if (teamSync.byCompetition.length) {
    console.log("\nFixtures by competition:");
    for (const c of teamSync.byCompetition.slice(0, 20)) {
      console.log(`  ${c.name}: ${c.n}`);
    }
    if (teamSync.byCompetition.length > 20) {
      console.log(`  … +${teamSync.byCompetition.length - 20} more`);
    }
  }
  console.log(`Team sync: ${teamSync.teams} clubs, ${teamSync.fixturesUpserted} upserted rows`);
  console.log(`Total fixtures season ${SEASON}: ${totalFx}`);
  console.log(`club_af_map rows: ${totalMap}`);

  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
