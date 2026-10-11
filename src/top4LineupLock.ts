/**
 * Top-4 lineup deadline = first GW kickoff involving any club from the
 * manager's extended squad. After that, saves are still allowed, but
 * players whose clubs have already played ≥1 minute in that GW cannot
 * be included.
 */
import type Database from "better-sqlite3";
import {
  excludeIgnoredFixturesWhere,
  seasonGameweekWhere,
} from "./fixturesFilter.js";

const STARTED = new Set([
  "1H",
  "2H",
  "HT",
  "ET",
  "BT",
  "P",
  "LIVE",
  "INT",
  "FT",
  "AET",
  "PEN",
]);

const SKIP_DEADLINE = new Set(["CANC", "PST", "ABD", "AWD", "WO"]);

export type SquadGwLock = {
  deadlineAt: string | null;
  lockedClubIds: string[];
};

export function fixtureHasPlayedMinute(status: string | null | undefined): boolean {
  return STARTED.has(String(status || "").trim().toUpperCase());
}

export function loadSquadGwLock(
  db: Database.Database,
  clubIds: readonly string[],
  gw: number,
): SquadGwLock {
  if (!clubIds.length || !Number.isInteger(gw) || gw < 1) {
    return { deadlineAt: null, lockedClubIds: [] };
  }
  const hasFixtures = !!db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'fixtures'`)
    .get();
  const hasMap = !!db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'club_af_map'`)
    .get();
  if (!hasFixtures || !hasMap) return { deadlineAt: null, lockedClubIds: [] };

  const where = `${seasonGameweekWhere("f")} AND ${excludeIgnoredFixturesWhere("f")}`;
  const placeholders = clubIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT f.date AS date,
              f.status AS status,
              hm.club_id AS home_club_id,
              am.club_id AS away_club_id
       FROM fixtures f
       LEFT JOIN club_af_map hm ON hm.af_team_id = f.home_af_id
       LEFT JOIN club_af_map am ON am.af_team_id = f.away_af_id
       WHERE ${where}
         AND f.gameweek = ?
         AND (hm.club_id IN (${placeholders}) OR am.club_id IN (${placeholders}))
       ORDER BY f.date ASC`,
    )
    .all(gw, ...clubIds, ...clubIds) as Array<{
    date: string;
    status: string | null;
    home_club_id: string | null;
    away_club_id: string | null;
  }>;

  const wanted = new Set(clubIds);
  let deadlineMs = Number.POSITIVE_INFINITY;
  const locked = new Set<string>();
  for (const r of rows) {
    const st = String(r.status || "").trim().toUpperCase();
    if (SKIP_DEADLINE.has(st)) continue;
    const ms = Date.parse(r.date);
    if (Number.isFinite(ms) && ms < deadlineMs) deadlineMs = ms;
    if (fixtureHasPlayedMinute(r.status)) {
      if (r.home_club_id && wanted.has(r.home_club_id)) locked.add(r.home_club_id);
      if (r.away_club_id && wanted.has(r.away_club_id)) locked.add(r.away_club_id);
    }
  }

  return {
    deadlineAt: Number.isFinite(deadlineMs) ? new Date(deadlineMs).toISOString() : null,
    lockedClubIds: [...locked],
  };
}

export function isClubLocked(
  clubId: string | null | undefined,
  lockedClubIds: Iterable<string>,
): boolean {
  if (!clubId) return false;
  const set = lockedClubIds instanceof Set ? lockedClubIds : new Set(lockedClubIds);
  return set.has(clubId);
}
