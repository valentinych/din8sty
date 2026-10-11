/**
 * Fetch Top-8 club player season stats from API-Football (season 2025 = 2025/26),
 * cache fixtures + CS player minutes, write precomputed JSON for «Сезон 2025/26».
 *
 * Clubs are taken from domestic league standings (not `/teams`), so relegation-playoff
 * sides (e.g. SC Paderborn 07 in Bundesliga) are excluded.
 *
 * Usage:
 *   npm run top8:season:sync
 *   npm run top8:season:sync -- --force
 *   npm run top8:season:sync -- --force-cs
 *   npm run top8:season:sync -- --skip-cs
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fixturePlayers,
  fixtures,
  playersByTeam,
  requireApiKey,
  standingTeamRows,
  standingsByLeague,
  type AfFixture,
  type AfPlayerSeasonRow,
} from "../src/apiFootball.js";
import {
  TOP8_DOMESTIC_AF,
  TOP8_SEASON_LABEL,
  TOP8_SEASON_SLUG,
  TOP8_SEASON_YEAR,
  SCOPED_AF_LEAGUE_IDS,
  aggregateSeasonScores,
  classifyAfLeague,
  seasonNotes,
  COMP_MULTIPLIER,
  COMP_BUCKET_LABEL,
  type CleanSheetCredit,
  type RawSeasonRow,
  type SeasonScorePayload,
} from "../src/top8SeasonFpts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const dbPath = process.env.DIN8STY_DB ?? path.join(root, "data", "din8sty.db");
const outJson =
  process.env.TOP8_SEASON_JSON ??
  path.join(root, "data", `top8-season-${TOP8_SEASON_SLUG}.json`);
const force = process.argv.includes("--force");
const forceCs = process.argv.includes("--force-cs") || force;
const skipCs = process.argv.includes("--skip-cs");
const SEASON = TOP8_SEASON_YEAR;
const FINISHED = new Set(["FT", "AET", "PEN"]);

function ensureSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS af_player_season_stats (
      season INTEGER NOT NULL,
      af_player_id INTEGER NOT NULL,
      af_team_id INTEGER NOT NULL,
      af_league_id INTEGER NOT NULL,
      player_name TEXT NOT NULL,
      photo TEXT,
      position TEXT,
      appearances INTEGER NOT NULL DEFAULT 0,
      lineups INTEGER NOT NULL DEFAULT 0,
      minutes INTEGER NOT NULL DEFAULT 0,
      goals INTEGER NOT NULL DEFAULT 0,
      assists INTEGER NOT NULL DEFAULT 0,
      conceded INTEGER NOT NULL DEFAULT 0,
      saves INTEGER NOT NULL DEFAULT 0,
      yellow INTEGER NOT NULL DEFAULT 0,
      yellowred INTEGER NOT NULL DEFAULT 0,
      red INTEGER NOT NULL DEFAULT 0,
      pen_missed INTEGER NOT NULL DEFAULT 0,
      pen_saved INTEGER NOT NULL DEFAULT 0,
      team_name TEXT,
      league_name TEXT,
      home_league_id TEXT,
      home_league_label TEXT,
      synced_at TEXT NOT NULL,
      PRIMARY KEY (season, af_player_id, af_team_id, af_league_id)
    );
    CREATE INDEX IF NOT EXISTS af_pss_season ON af_player_season_stats(season);

    CREATE TABLE IF NOT EXISTS af_season_fixtures (
      season INTEGER NOT NULL,
      af_fixture_id INTEGER NOT NULL,
      af_league_id INTEGER NOT NULL,
      status_short TEXT,
      home_team_id INTEGER NOT NULL,
      away_team_id INTEGER NOT NULL,
      home_goals INTEGER,
      away_goals INTEGER,
      kickoff TEXT,
      synced_at TEXT NOT NULL,
      PRIMARY KEY (season, af_fixture_id)
    );
    CREATE INDEX IF NOT EXISTS af_sf_season_league ON af_season_fixtures(season, af_league_id);

    CREATE TABLE IF NOT EXISTS af_fixture_player_minutes (
      season INTEGER NOT NULL,
      af_fixture_id INTEGER NOT NULL,
      af_team_id INTEGER NOT NULL,
      af_player_id INTEGER NOT NULL,
      minutes INTEGER NOT NULL DEFAULT 0,
      position TEXT,
      synced_at TEXT NOT NULL,
      PRIMARY KEY (season, af_fixture_id, af_team_id, af_player_id)
    );
    CREATE INDEX IF NOT EXISTS af_fpm_fixture ON af_fixture_player_minutes(season, af_fixture_id);

    CREATE TABLE IF NOT EXISTS af_fixture_stats_status (
      season INTEGER NOT NULL,
      af_fixture_id INTEGER NOT NULL,
      has_stats INTEGER NOT NULL DEFAULT 0,
      synced_at TEXT NOT NULL,
      PRIMARY KEY (season, af_fixture_id)
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

function setMeta(db: Database.Database, key: string, value: string) {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

function getMeta(db: Database.Database, key: string): string | null {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function nz(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

async function fetchAllPlayersForTeam(teamId: number): Promise<AfPlayerSeasonRow[]> {
  const out: AfPlayerSeasonRow[] = [];
  let page = 1;
  let total = 1;
  while (page <= total) {
    const data = await playersByTeam(teamId, SEASON, page);
    total = data.paging?.total ?? 1;
    out.push(...(data.response || []));
    page += 1;
  }
  return out;
}

function loadTop8TeamIds(db: Database.Database): Set<number> {
  const rows = db
    .prepare(`SELECT DISTINCT af_team_id FROM af_player_season_stats WHERE season = ?`)
    .all(SEASON) as Array<{ af_team_id: number }>;
  return new Set(rows.map((r) => r.af_team_id));
}

type Top8Club = {
  af_team_id: number;
  team_name: string;
  home_league_id: string;
  home_league_label: string;
};

/**
 * Resolve Top-8 domestic squads from league standings (regular season only).
 * `/teams?league=&season=` can include relegation-playoff clubs (e.g. SC Paderborn 07).
 */
async function resolveTop8ClubsFromStandings(): Promise<Top8Club[]> {
  const clubs: Top8Club[] = [];
  const seen = new Set<number>();
  for (const lig of TOP8_DOMESTIC_AF) {
    const { response } = await standingsByLeague(lig.afId, SEASON);
    const rows = standingTeamRows(response);
    let added = 0;
    for (const row of rows) {
      const id = row.team.id;
      if (seen.has(id)) continue;
      seen.add(id);
      clubs.push({
        af_team_id: id,
        team_name: row.team.name,
        home_league_id: lig.leagueId,
        home_league_label: lig.label,
      });
      added += 1;
    }
    console.log(`  ${lig.label}: ${added} teams (standings)`);
  }
  return clubs;
}

/** Drop cached season rows for clubs not in the regular-season squad list. */
function pruneNonSquadSeasonStats(db: Database.Database, allowed: Set<number>): number {
  const existing = loadTop8TeamIds(db);
  let removed = 0;
  const del = db.prepare(
    `DELETE FROM af_player_season_stats WHERE season = ? AND af_team_id = ?`,
  );
  for (const teamId of existing) {
    if (allowed.has(teamId)) continue;
    const info = del.run(SEASON, teamId);
    removed += Number(info.changes || 0);
    console.log(`  pruned af_team_id=${teamId} (${info.changes} stat rows)`);
  }
  return removed;
}

function upsertFixture(db: Database.Database, fx: AfFixture, syncedAt: string) {
  db.prepare(
    `INSERT INTO af_season_fixtures (
      season, af_fixture_id, af_league_id, status_short,
      home_team_id, away_team_id, home_goals, away_goals, kickoff, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(season, af_fixture_id) DO UPDATE SET
      af_league_id = excluded.af_league_id,
      status_short = excluded.status_short,
      home_team_id = excluded.home_team_id,
      away_team_id = excluded.away_team_id,
      home_goals = excluded.home_goals,
      away_goals = excluded.away_goals,
      kickoff = excluded.kickoff,
      synced_at = excluded.synced_at`,
  ).run(
    SEASON,
    fx.fixture.id,
    fx.league.id,
    fx.fixture.status?.short ?? null,
    fx.teams.home.id,
    fx.teams.away.id,
    fx.goals.home,
    fx.goals.away,
    fx.fixture.date,
    syncedAt,
  );
}

async function syncScopedFixtures(db: Database.Database): Promise<void> {
  const syncedAt = getMeta(db, `top8_fixtures_${SEASON}_synced_at`);
  const existing = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM af_season_fixtures WHERE season = ?`)
      .get(SEASON) as { n: number }
  ).n;
  if (!forceCs && existing > 0 && syncedAt) {
    console.log(`Fixtures cache hit: ${existing} rows (synced ${syncedAt}).`);
    return;
  }

  console.log(`Syncing fixtures for ${SCOPED_AF_LEAGUE_IDS.length} scoped competitions…`);
  const now = new Date().toISOString();
  let total = 0;
  for (const leagueId of SCOPED_AF_LEAGUE_IDS) {
    const { response } = await fixtures(leagueId, SEASON);
    const tx = db.transaction((rows: AfFixture[]) => {
      for (const fx of rows) upsertFixture(db, fx, now);
    });
    tx(response || []);
    total += (response || []).length;
    console.log(`  league ${leagueId}: ${(response || []).length} fixtures`);
  }
  setMeta(db, `top8_fixtures_${SEASON}_synced_at`, now);
  console.log(`Synced ${total} fixtures.`);
}

type CsFixtureNeed = {
  af_fixture_id: number;
  af_league_id: number;
  cs_team_ids: number[];
};

function listCsFixtureNeeds(db: Database.Database, top8: Set<number>): CsFixtureNeed[] {
  const rows = db
    .prepare(
      `SELECT af_fixture_id, af_league_id, status_short,
              home_team_id, away_team_id, home_goals, away_goals
       FROM af_season_fixtures WHERE season = ?`,
    )
    .all(SEASON) as Array<{
    af_fixture_id: number;
    af_league_id: number;
    status_short: string | null;
    home_team_id: number;
    away_team_id: number;
    home_goals: number | null;
    away_goals: number | null;
  }>;

  const out: CsFixtureNeed[] = [];
  for (const r of rows) {
    if (!FINISHED.has(r.status_short || "")) continue;
    if (!classifyAfLeague(r.af_league_id)) continue;
    if (r.home_goals == null || r.away_goals == null) continue;
    const csTeams: number[] = [];
    if (top8.has(r.home_team_id) && r.away_goals === 0) csTeams.push(r.home_team_id);
    if (top8.has(r.away_team_id) && r.home_goals === 0) csTeams.push(r.away_team_id);
    if (!csTeams.length) continue;
    out.push({
      af_fixture_id: r.af_fixture_id,
      af_league_id: r.af_league_id,
      cs_team_ids: csTeams,
    });
  }
  return out;
}

async function syncCsPlayerMinutes(
  db: Database.Database,
  needs: CsFixtureNeed[],
): Promise<{ withStats: number; missing: number }> {
  const statusGet = db.prepare(
    `SELECT has_stats FROM af_fixture_stats_status WHERE season = ? AND af_fixture_id = ?`,
  );
  const statusUpsert = db.prepare(
    `INSERT INTO af_fixture_stats_status (season, af_fixture_id, has_stats, synced_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(season, af_fixture_id) DO UPDATE SET
       has_stats = excluded.has_stats,
       synced_at = excluded.synced_at`,
  );
  const clearPlayers = db.prepare(
    `DELETE FROM af_fixture_player_minutes WHERE season = ? AND af_fixture_id = ?`,
  );
  const insertPlayer = db.prepare(
    `INSERT INTO af_fixture_player_minutes (
      season, af_fixture_id, af_team_id, af_player_id, minutes, position, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(season, af_fixture_id, af_team_id, af_player_id) DO UPDATE SET
      minutes = excluded.minutes,
      position = excluded.position,
      synced_at = excluded.synced_at`,
  );

  let withStats = 0;
  let missing = 0;
  let fetched = 0;
  const now = new Date().toISOString();

  for (let i = 0; i < needs.length; i++) {
    const need = needs[i]!;
    const cached = statusGet.get(SEASON, need.af_fixture_id) as
      | { has_stats: number }
      | undefined;
    if (!forceCs && cached) {
      if (cached.has_stats) withStats += 1;
      else missing += 1;
      continue;
    }

    try {
      const { response } = await fixturePlayers(need.af_fixture_id);
      const teams = response || [];
      const has = teams.some((t) => (t.players || []).length > 0);
      db.transaction(() => {
        clearPlayers.run(SEASON, need.af_fixture_id);
        for (const t of teams) {
          for (const p of t.players || []) {
            const st = p.statistics?.[0];
            insertPlayer.run(
              SEASON,
              need.af_fixture_id,
              t.team.id,
              p.player.id,
              nz(st?.games?.minutes),
              st?.games?.position ?? null,
              now,
            );
          }
        }
        statusUpsert.run(SEASON, need.af_fixture_id, has ? 1 : 0, now);
      })();
      if (has) withStats += 1;
      else missing += 1;
    } catch (err) {
      statusUpsert.run(SEASON, need.af_fixture_id, 0, now);
      missing += 1;
      console.warn(
        `  fixture ${need.af_fixture_id}: ${(err as Error).message?.slice(0, 120) || err}`,
      );
    }

    fetched += 1;
    if (fetched % 25 === 0 || i === needs.length - 1) {
      console.log(`  … CS player stats ${i + 1}/${needs.length} (fetched ${fetched})`);
    }
  }

  return { withStats, missing };
}

function buildCsCredits(db: Database.Database, needs: CsFixtureNeed[]): CleanSheetCredit[] {
  const minutesStmt = db.prepare(
    `SELECT af_player_id, minutes, position
     FROM af_fixture_player_minutes
     WHERE season = ? AND af_fixture_id = ? AND af_team_id = ? AND minutes >= 60`,
  );
  type Key = string;
  const map = new Map<Key, CleanSheetCredit>();
  for (const need of needs) {
    const has = db
      .prepare(
        `SELECT has_stats FROM af_fixture_stats_status WHERE season = ? AND af_fixture_id = ?`,
      )
      .get(SEASON, need.af_fixture_id) as { has_stats: number } | undefined;
    if (!has?.has_stats) continue;
    for (const teamId of need.cs_team_ids) {
      const rows = minutesStmt.all(SEASON, need.af_fixture_id, teamId) as Array<{
        af_player_id: number;
        minutes: number;
        position: string | null;
      }>;
      for (const r of rows) {
        const key = `${r.af_player_id}:${teamId}:${need.af_league_id}`;
        const prev = map.get(key);
        if (prev) {
          prev.clean_sheets += 1;
          if (!prev.position && r.position) prev.position = r.position;
        } else {
          map.set(key, {
            af_player_id: r.af_player_id,
            af_team_id: teamId,
            af_league_id: need.af_league_id,
            clean_sheets: 1,
            position: r.position,
          });
        }
      }
    }
  }
  return [...map.values()];
}

function buildClubMatchCounts(db: Database.Database, top8: Set<number>): Map<number, number> {
  const rows = db
    .prepare(
      `SELECT home_team_id, away_team_id, status_short, af_league_id
       FROM af_season_fixtures WHERE season = ?`,
    )
    .all(SEASON) as Array<{
    home_team_id: number;
    away_team_id: number;
    status_short: string | null;
    af_league_id: number;
  }>;
  const counts = new Map<number, number>();
  for (const r of rows) {
    if (!FINISHED.has(r.status_short || "")) continue;
    if (!classifyAfLeague(r.af_league_id)) continue;
    if (top8.has(r.home_team_id)) {
      counts.set(r.home_team_id, (counts.get(r.home_team_id) ?? 0) + 1);
    }
    if (top8.has(r.away_team_id)) {
      counts.set(r.away_team_id, (counts.get(r.away_team_id) ?? 0) + 1);
    }
  }
  return counts;
}

async function main() {
  requireApiKey();
  if (!fs.existsSync(dbPath)) {
    console.error(`DB not found: ${dbPath}`);
    process.exit(1);
  }

  const db = new Database(dbPath);
  ensureSchema(db);

  console.log(`Resolving Top-8 clubs for season ${SEASON} (standings)…`);
  const clubs = await resolveTop8ClubsFromStandings();
  const allowedTeamIds = new Set(clubs.map((c) => c.af_team_id));
  console.log(`Total unique clubs: ${clubs.length}`);
  const pruned = pruneNonSquadSeasonStats(db, allowedTeamIds);
  if (pruned > 0) {
    console.log(`Pruned ${pruned} stale season-stat rows (non-top-flight / playoff clubs).`);
  }
  setMeta(db, `top8_season_${SEASON}_teams`, String(clubs.length));

  const syncedAt = getMeta(db, `top8_season_${SEASON}_synced_at`);
  const existing = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM af_player_season_stats WHERE season = ?`)
      .get(SEASON) as { n: number }
  ).n;

  if (!force && existing > 0 && syncedAt) {
    console.log(
      `Cache hit: ${existing} rows for season ${SEASON} (synced ${syncedAt}). Use --force to refresh.`,
    );
  } else {
    const upsert = db.prepare(`
      INSERT INTO af_player_season_stats (
        season, af_player_id, af_team_id, af_league_id,
        player_name, photo, position,
        appearances, lineups, minutes, goals, assists, conceded, saves,
        yellow, yellowred, red, pen_missed, pen_saved,
        team_name, league_name, home_league_id, home_league_label, synced_at
      ) VALUES (
        @season, @af_player_id, @af_team_id, @af_league_id,
        @player_name, @photo, @position,
        @appearances, @lineups, @minutes, @goals, @assists, @conceded, @saves,
        @yellow, @yellowred, @red, @pen_missed, @pen_saved,
        @team_name, @league_name, @home_league_id, @home_league_label, @synced_at
      )
      ON CONFLICT(season, af_player_id, af_team_id, af_league_id) DO UPDATE SET
        player_name = excluded.player_name,
        photo = excluded.photo,
        position = excluded.position,
        appearances = excluded.appearances,
        lineups = excluded.lineups,
        minutes = excluded.minutes,
        goals = excluded.goals,
        assists = excluded.assists,
        conceded = excluded.conceded,
        saves = excluded.saves,
        yellow = excluded.yellow,
        yellowred = excluded.yellowred,
        red = excluded.red,
        pen_missed = excluded.pen_missed,
        pen_saved = excluded.pen_saved,
        team_name = excluded.team_name,
        league_name = excluded.league_name,
        home_league_id = excluded.home_league_id,
        home_league_label = excluded.home_league_label,
        synced_at = excluded.synced_at
    `);

    const now = new Date().toISOString();
    const tx = db.transaction((rows: Record<string, unknown>[]) => {
      for (const r of rows) upsert.run(r);
    });

    let i = 0;
    let rowCount = 0;
    for (const club of clubs) {
      i++;
      const players = await fetchAllPlayersForTeam(club.af_team_id);
      const batch: Record<string, unknown>[] = [];
      for (const p of players) {
        for (const s of p.statistics || []) {
          // API-Football occasionally returns a stats block with no league id.
          if (s.league?.id == null) continue;
          batch.push({
            season: SEASON,
            af_player_id: p.player.id,
            af_team_id: s.team?.id ?? club.af_team_id,
            af_league_id: s.league.id,
            player_name: p.player.name,
            photo: p.player.photo ?? null,
            position: s.games?.position ?? null,
            appearances: nz(s.games?.appearences),
            lineups: nz(s.games?.lineups),
            minutes: nz(s.games?.minutes),
            goals: nz(s.goals?.total),
            assists: nz(s.goals?.assists),
            conceded: nz(s.goals?.conceded),
            saves: nz(s.goals?.saves),
            yellow: nz(s.cards?.yellow),
            yellowred: nz(s.cards?.yellowred),
            red: nz(s.cards?.red),
            pen_missed: nz(s.penalty?.missed),
            pen_saved: nz(s.penalty?.saved),
            team_name: s.team?.name ?? club.team_name,
            league_name: s.league?.name ?? null,
            home_league_id: club.home_league_id,
            home_league_label: club.home_league_label,
            synced_at: now,
          });
        }
      }
      tx(batch);
      rowCount += batch.length;
      if (i % 10 === 0 || i === clubs.length) {
        console.log(`  … ${i}/${clubs.length} clubs (${rowCount} stat rows)`);
      }
    }

    setMeta(db, `top8_season_${SEASON}_synced_at`, now);
    setMeta(db, `top8_season_${SEASON}_teams`, String(clubs.length));
    console.log(`Synced ${rowCount} rows for ${clubs.length} clubs.`);
  }

  const top8 = loadTop8TeamIds(db);
  let csMeta: SeasonScorePayload["cs_meta"] | undefined;
  let csCredits: CleanSheetCredit[] = [];
  let clubMatchCounts = new Map<number, number>();

  if (!skipCs) {
    await syncScopedFixtures(db);
    clubMatchCounts = buildClubMatchCounts(db, top8);
    const needs = listCsFixtureNeeds(db, top8);
    console.log(`CS candidate fixtures (Top-8 team, 0 conceded): ${needs.length}`);
    const coverage = await syncCsPlayerMinutes(db, needs);
    csCredits = buildCsCredits(db, needs);
    const awards = csCredits.reduce((s, c) => s + c.clean_sheets, 0);
    csMeta = {
      cs_team_fixtures: needs.length,
      fixtures_with_stats: coverage.withStats,
      fixtures_missing_stats: coverage.missing,
      cs_awards: awards,
    };
    console.log(
      `CS: ${coverage.withStats} with stats / ${needs.length} · missing ${coverage.missing} · awards ${awards}`,
    );
  } else {
    console.log("Skipping CS fixture sync (--skip-cs).");
  }

  const raw = db
    .prepare(
      `SELECT af_player_id, player_name, photo, af_team_id, team_name,
              af_league_id, league_name, position,
              appearances, lineups, minutes, goals, assists, conceded, saves,
              yellow, yellowred, red, pen_missed, pen_saved,
              home_league_id, home_league_label
       FROM af_player_season_stats WHERE season = ?`,
    )
    .all(SEASON) as RawSeasonRow[];

  const players = aggregateSeasonScores(raw, { csCredits, clubMatchCounts });
  const teamsSynced = Number(getMeta(db, `top8_season_${SEASON}_teams`) || 0);
  const payload: SeasonScorePayload = {
    season: TOP8_SEASON_LABEL,
    season_year: SEASON,
    generated_at: new Date().toISOString(),
    source: "api-football:/players + /fixtures + /fixtures/players",
    notes: seasonNotes(csMeta),
    multipliers: { ...COMP_MULTIPLIER },
    bucket_labels: { ...COMP_BUCKET_LABEL },
    teams_synced: teamsSynced,
    player_count: players.length,
    players,
    cs_meta: csMeta,
  };

  fs.mkdirSync(path.dirname(outJson), { recursive: true });
  fs.writeFileSync(outJson, JSON.stringify(payload));
  console.log(
    `Wrote ${outJson} · ${players.length} players · top: ${players[0]?.name} ${players[0]?.total}` +
      (players[0]?.clean_sheets ? ` (CS ${players[0].clean_sheets})` : ""),
  );
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
