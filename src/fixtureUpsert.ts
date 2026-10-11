import type Database from "better-sqlite3";
import type { AfFixture } from "./apiFootball.js";
import { gameweekFromKickoff } from "./gameweeks.js";
import { AF_TO_TM } from "./leagues.js";

function inferCompetitionType(league: AfFixture["league"]): string | null {
  if (league.type) return league.type;
  const name = (league.name || "").toLowerCase();
  if (
    /cup|coppa|shield|super|friendly|friendlies|championship|play.?off|trophy|copa|coupe|pokal|taça|taca|supercoppa|community|champions|europa|conference/.test(
      name,
    )
  ) {
    return "Cup";
  }
  if (AF_TO_TM[league.id]) return "League";
  return null;
}

function resolveLeagueId(afLeagueId: number): string {
  return AF_TO_TM[afLeagueId] ?? `AF${afLeagueId}`;
}

/** Drop AF league-phase stubs: same competition + kickoff, a team listed twice. */
export function dropPlaceholderKickoffFixtures(rows: AfFixture[]): {
  keep: AfFixture[];
  dropIds: number[];
} {
  const groups = new Map<string, AfFixture[]>();
  for (const row of rows) {
    const date = row.fixture?.date;
    const leagueId = row.league?.id;
    if (!date || leagueId == null) continue;
    const key = `${leagueId}|${date}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const dropIds = new Set<number>();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const counts = new Map<number, number>();
    for (const row of list) {
      for (const id of [row.teams.home.id, row.teams.away.id]) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    if ([...counts.values()].some((n) => n > 1)) {
      for (const row of list) dropIds.add(row.fixture.id);
    }
  }
  if (!dropIds.size) return { keep: rows, dropIds: [] };
  return {
    keep: rows.filter((r) => !dropIds.has(r.fixture.id)),
    dropIds: [...dropIds],
  };
}

/** Remove already-stored AF placeholder batches (e.g. all UCL MD stubs on one date). */
export function purgePlaceholderKickoffFixtures(db: Database.Database): number {
  db.exec(
    `CREATE INDEX IF NOT EXISTS fixtures_season_league_date
     ON fixtures(season, af_league_id, date)`,
  );
  const ids = db
    .prepare(
      `SELECT f.id AS id FROM fixtures f
       WHERE EXISTS (
         SELECT 1 FROM fixtures px
         WHERE px.season = f.season
           AND px.af_league_id IS NOT NULL
           AND f.af_league_id IS NOT NULL
           AND px.af_league_id = f.af_league_id
           AND px.date = f.date
           AND px.id != f.id
           AND (
             px.home_af_id IN (f.home_af_id, f.away_af_id)
             OR px.away_af_id IN (f.home_af_id, f.away_af_id)
           )
       )`,
    )
    .all() as Array<{ id: number }>;
  if (!ids.length) return 0;
  const del = db.prepare(`DELETE FROM fixtures WHERE id = ?`);
  const tx = db.transaction((list: Array<{ id: number }>) => {
    for (const row of list) del.run(row.id);
  });
  tx(ids);
  return ids.length;
}

export function upsertAfFixtures(
  db: Database.Database,
  season: number,
  rows: AfFixture[],
): number {
  const { keep, dropIds } = dropPlaceholderKickoffFixtures(rows);
  if (dropIds.length) {
    const del = db.prepare(`DELETE FROM fixtures WHERE id = ?`);
    const txDel = db.transaction((list: number[]) => {
      for (const id of list) del.run(id);
    });
    txDel(dropIds);
  }
  if (!keep.length) return 0;
  const upsert = db.prepare(
    `INSERT INTO fixtures (
       id, date, status, round, league_id, af_league_id, season,
       home_af_id, away_af_id, home_name, away_name, home_goals, away_goals, venue,
       gameweek, competition_name, competition_country, competition_type
     ) VALUES (
       @id, @date, @status, @round, @league_id, @af_league_id, @season,
       @home_af_id, @away_af_id, @home_name, @away_name, @home_goals, @away_goals, @venue,
       @gameweek, @competition_name, @competition_country, @competition_type
     )
     ON CONFLICT(id) DO UPDATE SET
       date = excluded.date,
       status = excluded.status,
       round = excluded.round,
       league_id = excluded.league_id,
       af_league_id = excluded.af_league_id,
       season = excluded.season,
       home_af_id = excluded.home_af_id,
       away_af_id = excluded.away_af_id,
       home_name = excluded.home_name,
       away_name = excluded.away_name,
       home_goals = excluded.home_goals,
       away_goals = excluded.away_goals,
       venue = excluded.venue,
       gameweek = excluded.gameweek,
       competition_name = excluded.competition_name,
       competition_country = excluded.competition_country,
       competition_type = excluded.competition_type`,
  );
  const tx = db.transaction((list: AfFixture[]) => {
    for (const row of list) {
      const venueParts = [row.fixture.venue?.name, row.fixture.venue?.city].filter(Boolean);
      upsert.run({
        id: row.fixture.id,
        date: row.fixture.date,
        status: row.fixture.status.short,
        round: row.league.round,
        league_id: resolveLeagueId(row.league.id),
        af_league_id: row.league.id,
        season,
        home_af_id: row.teams.home.id,
        away_af_id: row.teams.away.id,
        home_name: row.teams.home.name,
        away_name: row.teams.away.name,
        home_goals: row.goals.home,
        away_goals: row.goals.away,
        venue: venueParts.length ? venueParts.join(", ") : null,
        gameweek: gameweekFromKickoff(row.fixture.date),
        competition_name: row.league.name || null,
        competition_country: row.league.country || null,
        competition_type: inferCompetitionType(row.league),
      });
    }
  });
  tx(keep);
  return keep.length;
}
