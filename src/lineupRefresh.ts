import type Database from "better-sqlite3";
import { fixturesByTeam } from "./apiFootball.js";
import { purgePlaceholderKickoffFixtures, upsertAfFixtures } from "./fixtureUpsert.js";
import { AF_SEASON } from "./leagues.js";
import { refreshAvailabilityForSquad } from "./playerAvailability.js";
import { refreshPlayerCurrentClub } from "./transferSync.js";

export type LineupRefreshResult = {
  clubs_updated: number;
  fixtures: number;
  availability: number;
};

export async function refreshManagerSquadInfo(
  db: Database.Database,
  playerIds: string[],
): Promise<LineupRefreshResult> {
  let clubsUpdated = 0;
  for (const id of playerIds) {
    try {
      if (await refreshPlayerCurrentClub(db, id)) clubsUpdated++;
    } catch (err) {
      console.warn(
        `lineup refresh club ${id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const clubRows = playerIds.length
    ? (db
        .prepare(
          `SELECT DISTINCT club_id FROM players WHERE id IN (${playerIds.map(() => "?").join(",")}) AND club_id IS NOT NULL AND club_id != ''`,
        )
        .all(...playerIds) as Array<{ club_id: string }>)
    : [];
  const clubIds = clubRows.map((r) => r.club_id);

  let fixtures = 0;
  const afTeams = clubIds.length
    ? (db
        .prepare(
          `SELECT DISTINCT af_team_id FROM club_af_map WHERE club_id IN (${clubIds.map(() => "?").join(",")})`,
        )
        .all(...clubIds) as Array<{ af_team_id: number }>)
    : [];
  for (const t of afTeams) {
    try {
      const { response } = await fixturesByTeam(t.af_team_id, AF_SEASON);
      fixtures += upsertAfFixtures(db, AF_SEASON, response);
    } catch (err) {
      console.warn(
        `lineup refresh fixtures ${t.af_team_id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  try {
    purgePlaceholderKickoffFixtures(db);
  } catch (err) {
    console.warn(
      "lineup refresh placeholder purge:",
      err instanceof Error ? err.message : err,
    );
  }

  let availability = 0;
  try {
    const av = await refreshAvailabilityForSquad(db, playerIds, clubIds);
    availability = av.injured;
  } catch (err) {
    console.warn(
      "lineup refresh availability:",
      err instanceof Error ? err.message : err,
    );
  }

  return { clubs_updated: clubsUpdated, fixtures, availability };
}
