/**
 * Schedule columns: manager team codes whose GW starting XI (XI) or full
 * drafted roster (FULL) includes a player whose current club is in the fixture.
 */
import type Database from "better-sqlite3";
import {
  getTop4State,
  listTop4Registrations,
  parseLotteryOrder,
} from "./top4League.js";
import { parseSlotsJson } from "./userLineups.js";

export type FixtureXiTeam = { code: string; name: string };

type FixtureClubRef = {
  id: number;
  gameweek?: number | null;
  home_club_id?: string | null;
  away_club_id?: string | null;
};

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { ok: number } | undefined;
  return Boolean(row);
}

function teamMetaById(
  db: Database.Database,
): Map<number, { code: string; name: string }> {
  const regs = listTop4Registrations(db);
  const byEmail = new Map(
    regs.map((r) => [r.email.toLowerCase(), r]),
  );
  const lottery = parseLotteryOrder(getTop4State(db)) ?? [];
  const out = new Map<number, { code: string; name: string }>();
  for (const entry of lottery) {
    const email = String(entry.email || "").toLowerCase();
    const reg = byEmail.get(email);
    const code = reg?.team_code?.trim()?.toUpperCase();
    if (!code) continue;
    out.set(Number(entry.team_id), {
      code,
      name: (reg?.team_name || entry.team_name || code).trim() || code,
    });
  }
  return out;
}

/** fixture id → unique manager codes with an XI player who can play this match. */
export function xiTeamsByFixtureId(
  db: Database.Database,
  fixtures: readonly FixtureClubRef[],
): Map<number, FixtureXiTeam[]> {
  const empty = new Map<number, FixtureXiTeam[]>();
  if (!fixtures.length) return empty;
  if (!tableExists(db, "top4_lineups") || !tableExists(db, "players")) {
    return empty;
  }

  const gws = [
    ...new Set(
      fixtures
        .map((f) => Number(f.gameweek))
        .filter((gw) => Number.isInteger(gw) && gw > 0),
    ),
  ];
  if (!gws.length) return empty;

  const teamMeta = teamMetaById(db);
  if (!teamMeta.size) return empty;

  const lineupRows = db
    .prepare(
      `SELECT team_id, gw, slots_json FROM top4_lineups
       WHERE gw IN (${gws.map(() => "?").join(",")})`,
    )
    .all(...gws) as Array<{ team_id: number; gw: number; slots_json: string }>;
  if (!lineupRows.length) return empty;

  const playerIds = new Set<string>();
  const parsed = lineupRows.map((row) => {
    const slots = parseSlotsJson(row.slots_json).slots.filter(
      (id): id is string => Boolean(id),
    );
    for (const id of slots) playerIds.add(id);
    return { team_id: row.team_id, gw: row.gw, slots };
  });
  if (!playerIds.size) return empty;

  const clubByPlayer = new Map<string, string>();
  const idList = [...playerIds];
  const clubRows = db
    .prepare(
      `SELECT id, club_id FROM players WHERE id IN (${idList.map(() => "?").join(",")})`,
    )
    .all(...idList) as Array<{ id: string; club_id: string | null }>;
  for (const r of clubRows) {
    const clubId = String(r.club_id || "").trim();
    if (clubId) clubByPlayer.set(String(r.id), clubId);
  }

  /** gw → team_id → clubs represented in that team's XI */
  const xiClubs = new Map<number, Map<number, Set<string>>>();
  for (const row of parsed) {
    const clubs = new Set<string>();
    for (const id of row.slots) {
      const clubId = clubByPlayer.get(id);
      if (clubId) clubs.add(clubId);
    }
    if (!clubs.size) continue;
    let byTeam = xiClubs.get(row.gw);
    if (!byTeam) {
      byTeam = new Map();
      xiClubs.set(row.gw, byTeam);
    }
    byTeam.set(row.team_id, clubs);
  }

  const out = new Map<number, FixtureXiTeam[]>();
  for (const f of fixtures) {
    const gw = Number(f.gameweek);
    const home = String(f.home_club_id || "").trim();
    const away = String(f.away_club_id || "").trim();
    const byTeam = Number.isInteger(gw) ? xiClubs.get(gw) : undefined;
    if (!byTeam || (!home && !away)) {
      out.set(f.id, []);
      continue;
    }
    const teams: FixtureXiTeam[] = [];
    for (const [teamId, clubs] of byTeam) {
      if ((home && clubs.has(home)) || (away && clubs.has(away))) {
        const meta = teamMeta.get(teamId);
        if (meta) teams.push(meta);
      }
    }
    teams.sort((a, b) => a.code.localeCompare(b.code));
    out.set(f.id, teams);
  }
  return out;
}

/**
 * fixture id → unique manager codes with a drafted roster player who can play
 * this match (current club). Not GW-specific; uses active `top4_draft_picks`
 * (vacancies deleted; replaced rows keep the new player_id).
 */
export function fullTeamsByFixtureId(
  db: Database.Database,
  fixtures: readonly FixtureClubRef[],
): Map<number, FixtureXiTeam[]> {
  const empty = new Map<number, FixtureXiTeam[]>();
  if (!fixtures.length) return empty;
  if (!tableExists(db, "top4_draft_picks") || !tableExists(db, "players")) {
    return empty;
  }

  const teamMeta = teamMetaById(db);
  if (!teamMeta.size) return empty;

  const pickRows = db
    .prepare(`SELECT team_id, player_id FROM top4_draft_picks`)
    .all() as Array<{ team_id: number; player_id: string }>;
  if (!pickRows.length) return empty;

  const playerIds = [...new Set(pickRows.map((p) => String(p.player_id)))];
  const clubByPlayer = new Map<string, string>();
  const clubRows = db
    .prepare(
      `SELECT id, club_id FROM players WHERE id IN (${playerIds.map(() => "?").join(",")})`,
    )
    .all(...playerIds) as Array<{ id: string; club_id: string | null }>;
  for (const r of clubRows) {
    const clubId = String(r.club_id || "").trim();
    if (clubId) clubByPlayer.set(String(r.id), clubId);
  }

  /** team_id → clubs represented on that team's current drafted roster */
  const clubsByTeam = new Map<number, Set<string>>();
  for (const row of pickRows) {
    const clubId = clubByPlayer.get(String(row.player_id));
    if (!clubId) continue;
    let clubs = clubsByTeam.get(row.team_id);
    if (!clubs) {
      clubs = new Set();
      clubsByTeam.set(row.team_id, clubs);
    }
    clubs.add(clubId);
  }

  const out = new Map<number, FixtureXiTeam[]>();
  for (const f of fixtures) {
    const home = String(f.home_club_id || "").trim();
    const away = String(f.away_club_id || "").trim();
    if (!home && !away) {
      out.set(f.id, []);
      continue;
    }
    const teams: FixtureXiTeam[] = [];
    for (const [teamId, clubs] of clubsByTeam) {
      if ((home && clubs.has(home)) || (away && clubs.has(away))) {
        const meta = teamMeta.get(teamId);
        if (meta) teams.push(meta);
      }
    }
    teams.sort((a, b) => a.code.localeCompare(b.code));
    out.set(f.id, teams);
  }
  return out;
}
