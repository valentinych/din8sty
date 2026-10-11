/**
 * Default schedule visibility: season gameweeks (GW1+) without club friendlies.
 * Override with ?include_friendlies=1 on GET /api/fixtures.
 */

/** API-Football league id for "Friendlies Clubs". */
export const AF_FRIENDLIES_LEAGUE_ID = 667;

export function parseIncludeFriendlies(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** SQL fragment: fixture row is a club friendly (alias must be `f` or passed). */
export function clubFriendlyWhere(alias = "f"): string {
  const t = `${alias}.competition_type`;
  const n = `${alias}.competition_name`;
  const lid = `${alias}.af_league_id`;
  return `(
    LOWER(COALESCE(${t}, '')) LIKE '%friendly%'
    OR LOWER(COALESCE(${n}, '')) LIKE '%friendl%'
    OR ${lid} = ${AF_FRIENDLIES_LEAGUE_ID}
  )`;
}

export function excludeClubFriendliesWhere(alias = "f"): string {
  return `NOT ${clubFriendlyWhere(alias)}`;
}

/**
 * AF sometimes publishes a whole cup league-phase as one timestamp (every
 * team listed vs all opponents on the same date). A club cannot play two
 * matches in the same competition at the same kickoff — drop those rows.
 */
export function excludePlaceholderKickoffsWhere(alias = "f"): string {
  const px = alias === "px" ? "pxx" : "px";
  return `NOT EXISTS (
    SELECT 1 FROM fixtures ${px}
    WHERE ${px}.season = ${alias}.season
      AND ${px}.af_league_id IS NOT NULL
      AND ${alias}.af_league_id IS NOT NULL
      AND ${px}.af_league_id = ${alias}.af_league_id
      AND ${px}.date = ${alias}.date
      AND ${px}.id != ${alias}.id
      AND (
        ${px}.home_af_id IN (${alias}.home_af_id, ${alias}.away_af_id)
        OR ${px}.away_af_id IN (${alias}.home_af_id, ${alias}.away_af_id)
      )
  )`;
}

/** Club matches shown in lineup / lock / GWs: no friendlies, no AF placeholders. */
export function excludeIgnoredFixturesWhere(alias = "f"): string {
  return `${excludeClubFriendliesWhere(alias)} AND ${excludePlaceholderKickoffsWhere(alias)}`;
}

/** Season schedule: GW1+ (London anchor Fri 7 Aug 2026). */
export function seasonGameweekWhere(alias = "f"): string {
  return `${alias}.gameweek IS NOT NULL AND ${alias}.gameweek >= 1`;
}

export type ScheduleDefaults = {
  excludeFriendlies: boolean;
  seasonOnly: boolean;
};

export function defaultScheduleFilters(opts?: {
  includeFriendlies?: boolean;
  /** When true, only GW1+ fixtures (default for public schedule). */
  seasonOnly?: boolean;
}): ScheduleDefaults {
  return {
    excludeFriendlies: !opts?.includeFriendlies,
    seasonOnly: opts?.seasonOnly !== false,
  };
}

export function scheduleWhereClauses(
  alias = "f",
  defaults: ScheduleDefaults = defaultScheduleFilters(),
): string[] {
  const clauses: string[] = [];
  if (defaults.seasonOnly) clauses.push(seasonGameweekWhere(alias));
  if (defaults.excludeFriendlies) clauses.push(excludeClubFriendliesWhere(alias));
  clauses.push(excludePlaceholderKickoffsWhere(alias));
  return clauses;
}
