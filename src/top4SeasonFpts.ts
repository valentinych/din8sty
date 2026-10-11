/**
 * Top-4 «Сезон 2025/26» fantasy scoring from API-Football season stats.
 *
 * Points = raw FPTS (primerLineups weights) × competition multiplier.
 * +20% ideal-position bonus is skipped (no GW lineup data for historical sim).
 * Clean sheets: from finished fixtures + /fixtures/players (60′+, GKP/DEF +4, MID +1).
 */
import {
  APPEARANCE_60_PTS,
  APPEARANCE_SUB_PTS,
  ASSIST_PTS,
  CS_PTS,
  FULL_GAME_PTS,
  GOAL_PTS,
  GOALS_CONCEDED_PER_POINT,
  PENALTY_MISS_PTS,
  PENALTY_SAVE_PTS,
  RED_CARD_PTS,
  SAVES_PER_POINT,
  YELLOW_CARD_PTS,
  type FantasyLine,
} from "./primerLineups.js";

export const TOP4_SEASON_YEAR = 2025;
export const TOP4_SEASON_LABEL = "2025/26";
export const TOP4_SEASON_SLUG = "2025-26";

/** AF domestic league ids for Top-4. */
export const TOP4_DOMESTIC_AF: ReadonlyArray<{
  afId: number;
  leagueId: "GB1" | "ES1" | "IT1" | "L1";
  label: string;
}> = [
  { afId: 39, leagueId: "GB1", label: "ENG · Premier League" },
  { afId: 140, leagueId: "ES1", label: "SPA · LaLiga" },
  { afId: 135, leagueId: "IT1", label: "ITA · Serie A" },
  { afId: 78, leagueId: "L1", label: "GER · Bundesliga" },
];

export type CompBucket =
  | "domestic"
  | "league_cup"
  | "ucl"
  | "el"
  | "uecl"
  | "national_cup"
  | "supercup";

export const COMP_MULTIPLIER: Record<CompBucket, number> = {
  domestic: 2,
  league_cup: 0.4,
  ucl: 1.5,
  el: 1.0,
  uecl: 0.7,
  national_cup: 0.5,
  supercup: 0.3,
};

export const COMP_BUCKET_LABEL: Record<CompBucket, string> = {
  domestic: "Чемпионаты",
  league_cup: "League Cups",
  ucl: "UCL",
  el: "EL",
  uecl: "UECL",
  national_cup: "National Cups",
  supercup: "SuperCups",
};

/** Short labels for live/results player breakdowns (John Doe 16 (8 x 1.5 UCL)). */
export const COMP_BUCKET_SHORT: Record<CompBucket, string> = {
  domestic: "LGE",
  league_cup: "LCUP",
  ucl: "UCL",
  el: "EL",
  uecl: "UECL",
  national_cup: "CUP",
  supercup: "SUPER",
};

export function compShortForAfLeague(
  afLeagueId: number | null | undefined,
): string {
  if (afLeagueId == null || !Number.isFinite(afLeagueId)) return "COMP";
  const bucket = classifyAfLeague(afLeagueId);
  return bucket ? COMP_BUCKET_SHORT[bucket] : "COMP";
}

const AF_LEAGUE_BUCKET: Record<number, CompBucket> = {
  // Domestic
  39: "domestic",
  140: "domestic",
  135: "domestic",
  78: "domestic",
  // League cup (EFL)
  48: "league_cup",
  // Europe
  2: "ucl",
  3: "el",
  848: "uecl",
  // National cups
  45: "national_cup", // FA Cup
  143: "national_cup", // Copa del Rey
  137: "national_cup", // Coppa Italia
  81: "national_cup", // DFB-Pokal
  // Super cups
  528: "supercup", // Community Shield
  556: "supercup", // Supercopa de España
  547: "supercup", // Supercoppa Italiana
  529: "supercup", // DFL-Supercup
  531: "supercup", // UEFA Super Cup
};

/** Competition ids included in the season sim multipliers. */
export const SCOPED_AF_LEAGUE_IDS: readonly number[] = Object.keys(AF_LEAGUE_BUCKET).map(
  (k) => Number(k),
);

export function classifyAfLeague(afLeagueId: number): CompBucket | null {
  return AF_LEAGUE_BUCKET[afLeagueId] ?? null;
}

/** Competition coefficient for a fixture; unknown comps → 1. */
export function compMultiplierForAfLeague(
  afLeagueId: number | null | undefined,
): number {
  if (afLeagueId == null || !Number.isFinite(afLeagueId)) return 1;
  const bucket = classifyAfLeague(afLeagueId);
  if (!bucket) return 1;
  return COMP_MULTIPLIER[bucket];
}

export function afPositionToLine(position: string | null | undefined): FantasyLine {
  const raw = (position || "").trim();
  const p = raw.toLowerCase();
  if (!p) return "MID";
  // API-Football fixture stats often use single-letter codes.
  if (p === "g" || p.startsWith("g") || p.includes("goal")) return "GKP";
  if (p === "d" || p.startsWith("d") || p.includes("defend")) return "DEF";
  if (p === "f" || p === "a" || p.includes("attack") || p.includes("forward")) return "FWD";
  if (p === "m" || p.startsWith("m") || p.includes("mid")) return "MID";
  return "MID";
}

export type SeasonStatInput = {
  appearances: number;
  lineups: number;
  minutes: number;
  goals: number;
  assists: number;
  conceded: number;
  saves: number;
  yellow: number;
  yellowred: number;
  red: number;
  penMissed: number;
  penSaved: number;
  position: string | null;
};

/** Raw FPTS for one competition block (before multiplier). CS omitted. */
export function rawFptsFromSeasonStats(stat: SeasonStatInput, line?: FantasyLine): number {
  const fantasy = line ?? afPositionToLine(stat.position);
  const apps = Math.max(0, stat.appearances);
  const lineups = Math.min(Math.max(0, stat.lineups), apps);
  const subs = Math.max(0, apps - lineups);
  const minutes = Math.max(0, stat.minutes);

  let pts = 0;
  // Starters assumed ≥60′; subs get sub appearance.
  pts += lineups * APPEARANCE_60_PTS + subs * APPEARANCE_SUB_PTS;

  // Full-game bonus (MID/FWD): approximate via floor(minutes/90) capped by lineups.
  if (FULL_GAME_PTS[fantasy] > 0) {
    const fullGames = Math.min(lineups, Math.floor(minutes / 90));
    pts += fullGames * FULL_GAME_PTS[fantasy];
  }

  pts += Math.max(0, stat.goals) * GOAL_PTS[fantasy];
  pts += Math.max(0, stat.assists) * ASSIST_PTS;

  // CS awarded separately from finished fixtures (see aggregateSeasonScores opts).

  if (fantasy === "GKP") {
    pts += Math.max(0, stat.penSaved) * PENALTY_SAVE_PTS;
    pts += Math.floor(Math.max(0, stat.saves) / SAVES_PER_POINT);
  }

  pts += Math.max(0, stat.penMissed) * PENALTY_MISS_PTS;

  if (fantasy === "GKP" || fantasy === "DEF") {
    pts -= Math.floor(Math.max(0, stat.conceded) / GOALS_CONCEDED_PER_POINT);
  }

  pts += Math.max(0, stat.yellow) * YELLOW_CARD_PTS;
  // Second yellow → red: count yellowred as red if red field is 0.
  const reds = Math.max(0, stat.red) + Math.max(0, stat.yellowred);
  pts += reds * RED_CARD_PTS;

  return Math.round(pts * 100) / 100;
}

export function emptyBreakdown(): Record<CompBucket, number> {
  return {
    domestic: 0,
    league_cup: 0,
    ucl: 0,
    el: 0,
    uecl: 0,
    national_cup: 0,
    supercup: 0,
  };
}

export type SeasonPlayerScore = {
  af_player_id: number;
  name: string;
  photo: string | null;
  fantasy_line: FantasyLine;
  club_name: string;
  af_team_id: number | null;
  league_id: string | null;
  league_label: string | null;
  total: number;
  raw_total: number;
  breakdown: Record<CompBucket, number>;
  /** Appearances in scoped competitions (player). */
  player_matches: number;
  /** Alias of player_matches. */
  player_apps: number;
  /**
   * Club fixtures in scoped comps (finished AF fixtures when available;
   * else Σ max(appearances) across squad by competition).
   */
  club_matches: number;
  /** Sum of weighted FPTS of all players while at this club (debug / future use). */
  club_total_pts: number;
  /** total / club_matches — player's points per club fixture (0 if no club matches). */
  ppg_club: number;
  /** total / player_matches (0 if no matches). */
  ppg_player: number;
  /** Clean sheets awarded (60′+ in a 0-conceded fixture). */
  clean_sheets: number;
};

export type SeasonScorePayload = {
  season: string;
  season_year: number;
  generated_at: string;
  source: string;
  notes: string[];
  multipliers: Record<CompBucket, number>;
  bucket_labels: Record<CompBucket, string>;
  teams_synced: number;
  player_count: number;
  players: SeasonPlayerScore[];
  cs_meta?: {
    cs_team_fixtures: number;
    fixtures_with_stats: number;
    fixtures_missing_stats: number;
    cs_awards: number;
  };
  /** Scatter X-axis floor; 2025/26 uses 34, in-progress seasons use 0. */
  chart_min_x?: number;
  /** First GW included in totals (2026/27 skips GW1). */
  gw_min?: number;
};

/** One player’s CS count in a competition (60′+ on a clean-sheet team). */
export type CleanSheetCredit = {
  af_player_id: number;
  af_team_id: number;
  af_league_id: number;
  clean_sheets: number;
  position?: string | null;
};

export type AggregateSeasonOpts = {
  /** Finished fixture counts per Top-4 club (scoped comps). */
  clubMatchCounts?: Map<number, number> | Record<number, number>;
  /** CS awards from fixture player minutes. */
  csCredits?: CleanSheetCredit[];
};

export type RawSeasonRow = {
  af_player_id: number;
  player_name: string;
  photo: string | null;
  af_team_id: number;
  team_name: string;
  af_league_id: number;
  league_name: string;
  position: string | null;
  appearances: number;
  lineups: number;
  minutes: number;
  goals: number;
  assists: number;
  conceded: number;
  saves: number;
  yellow: number;
  yellowred: number;
  red: number;
  pen_missed: number;
  pen_saved: number;
  /** Domestic Top-4 league of the club this row was fetched under. */
  home_league_id: string;
  home_league_label: string;
};

function n(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function aggregateSeasonScores(
  rows: RawSeasonRow[],
  opts: AggregateSeasonOpts = {},
): SeasonPlayerScore[] {
  type Acc = {
    af_player_id: number;
    name: string;
    photo: string | null;
    lineVotes: Record<FantasyLine, number>;
    breakdown: Record<CompBucket, number>;
    raw_total: number;
    total: number;
    player_matches: number;
    clean_sheets: number;
    /** minutes by club for primary club pick */
    clubMinutes: Map<number, { name: string; minutes: number; league_id: string; league_label: string }>;
  };

  const byPlayer = new Map<number, Acc>();
  /** team → af_league_id → max appearances in that competition (fallback club fixtures). */
  const clubMaxAppsByComp = new Map<number, Map<number, number>>();
  /** team → Σ weighted FPTS of all players while at that club. */
  const clubTotalPts = new Map<number, number>();

  const ensureAcc = (playerId: number, name: string, photo: string | null): Acc => {
    let acc = byPlayer.get(playerId);
    if (!acc) {
      acc = {
        af_player_id: playerId,
        name,
        photo,
        lineVotes: { GKP: 0, DEF: 0, MID: 0, FWD: 0 },
        breakdown: emptyBreakdown(),
        raw_total: 0,
        total: 0,
        player_matches: 0,
        clean_sheets: 0,
        clubMinutes: new Map(),
      };
      byPlayer.set(playerId, acc);
    }
    return acc;
  };

  for (const row of rows) {
    const bucket = classifyAfLeague(row.af_league_id);
    if (!bucket) continue;

    const apps = Math.max(0, n(row.appearances));
    if (apps > 0) {
      let byComp = clubMaxAppsByComp.get(row.af_team_id);
      if (!byComp) {
        byComp = new Map();
        clubMaxAppsByComp.set(row.af_team_id, byComp);
      }
      byComp.set(row.af_league_id, Math.max(byComp.get(row.af_league_id) ?? 0, apps));
    }

    if (row.appearances <= 0 && row.minutes <= 0 && row.goals <= 0) continue;

    const line = afPositionToLine(row.position);
    const raw = rawFptsFromSeasonStats(
      {
        appearances: row.appearances,
        lineups: row.lineups,
        minutes: row.minutes,
        goals: row.goals,
        assists: row.assists,
        conceded: row.conceded,
        saves: row.saves,
        yellow: row.yellow,
        yellowred: row.yellowred,
        red: row.red,
        penMissed: row.pen_missed,
        penSaved: row.pen_saved,
        position: row.position,
      },
      line,
    );
    if (raw === 0) continue;

    const weighted = Math.round(raw * COMP_MULTIPLIER[bucket] * 100) / 100;
    clubTotalPts.set(
      row.af_team_id,
      Math.round(((clubTotalPts.get(row.af_team_id) ?? 0) + weighted) * 100) / 100,
    );

    const acc = ensureAcc(row.af_player_id, row.player_name, row.photo);
    acc.breakdown[bucket] = Math.round((acc.breakdown[bucket] + weighted) * 100) / 100;
    acc.raw_total = Math.round((acc.raw_total + raw) * 100) / 100;
    acc.total = Math.round((acc.total + weighted) * 100) / 100;
    acc.player_matches += apps;
    acc.lineVotes[line] += row.minutes || row.appearances || 1;
    if (row.photo && !acc.photo) acc.photo = row.photo;
    if (row.player_name) acc.name = row.player_name;

    const club = acc.clubMinutes.get(row.af_team_id);
    const addMin = row.minutes || 0;
    if (club) {
      club.minutes += addMin;
    } else {
      acc.clubMinutes.set(row.af_team_id, {
        name: row.team_name,
        minutes: addMin,
        league_id: row.home_league_id,
        league_label: row.home_league_label,
      });
    }
  }

  for (const credit of opts.csCredits || []) {
    const bucket = classifyAfLeague(credit.af_league_id);
    if (!bucket) continue;
    const cs = Math.max(0, Math.floor(n(credit.clean_sheets)));
    if (cs <= 0) continue;
    const acc = byPlayer.get(credit.af_player_id);
    if (!acc) continue; // only award CS to players already in season pool

    let line: FantasyLine = afPositionToLine(credit.position);
    if (!credit.position) {
      // Fall back to season line votes (null AF position must not become MID by default).
      let best: FantasyLine = "MID";
      let bestVote = -1;
      for (const L of ["GKP", "DEF", "MID", "FWD"] as FantasyLine[]) {
        if (acc.lineVotes[L] > bestVote) {
          bestVote = acc.lineVotes[L];
          best = L;
        }
      }
      line = best;
    }

    const rawCs = cs * CS_PTS[line];
    // Still record CS appearances for FWD (0 pts) for transparency.
    acc.clean_sheets += cs;
    if (rawCs === 0) continue;

    const weighted = Math.round(rawCs * COMP_MULTIPLIER[bucket] * 100) / 100;
    acc.breakdown[bucket] = Math.round((acc.breakdown[bucket] + weighted) * 100) / 100;
    acc.raw_total = Math.round((acc.raw_total + rawCs) * 100) / 100;
    acc.total = Math.round((acc.total + weighted) * 100) / 100;
    clubTotalPts.set(
      credit.af_team_id,
      Math.round(((clubTotalPts.get(credit.af_team_id) ?? 0) + weighted) * 100) / 100,
    );
  }

  const clubMatches = new Map<number, number>();
  for (const [teamId, byComp] of clubMaxAppsByComp) {
    let sum = 0;
    for (const maxApps of byComp.values()) sum += maxApps;
    clubMatches.set(teamId, sum);
  }
  const fixtureCounts = opts.clubMatchCounts;
  if (fixtureCounts) {
    const entries =
      fixtureCounts instanceof Map
        ? fixtureCounts.entries()
        : Object.entries(fixtureCounts).map(([k, v]) => [Number(k), v] as const);
    for (const [teamId, count] of entries) {
      if (count > 0) clubMatches.set(teamId, count);
    }
  }

  const out: SeasonPlayerScore[] = [];
  for (const acc of byPlayer.values()) {
    if (acc.total === 0) continue;
    let bestLine: FantasyLine = "MID";
    let bestVote = -1;
    for (const line of ["GKP", "DEF", "MID", "FWD"] as FantasyLine[]) {
      if (acc.lineVotes[line] > bestVote) {
        bestVote = acc.lineVotes[line];
        bestLine = line;
      }
    }
    let bestClub: {
      id: number;
      name: string;
      league_id: string;
      league_label: string;
      minutes: number;
    } | null = null;
    for (const [id, c] of acc.clubMinutes) {
      if (!bestClub || c.minutes > bestClub.minutes) {
        bestClub = {
          id,
          name: c.name,
          league_id: c.league_id,
          league_label: c.league_label,
          minutes: c.minutes,
        };
      }
    }
    const teamId = bestClub?.id ?? null;
    const cMatches = teamId != null ? (clubMatches.get(teamId) ?? 0) : 0;
    const cPts = teamId != null ? (clubTotalPts.get(teamId) ?? 0) : 0;
    const pMatches = acc.player_matches;
    out.push({
      af_player_id: acc.af_player_id,
      name: acc.name,
      photo: acc.photo,
      fantasy_line: bestLine,
      club_name: bestClub?.name ?? "—",
      af_team_id: teamId,
      league_id: bestClub?.league_id ?? null,
      league_label: bestClub?.league_label ?? null,
      total: acc.total,
      raw_total: acc.raw_total,
      breakdown: acc.breakdown,
      player_matches: pMatches,
      player_apps: pMatches,
      club_matches: cMatches,
      club_total_pts: cPts,
      ppg_player: pMatches > 0 ? Math.round((acc.total / pMatches) * 100) / 100 : 0,
      ppg_club: cMatches > 0 ? Math.round((acc.total / cMatches) * 100) / 100 : 0,
      clean_sheets: acc.clean_sheets,
    });
  }

  out.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  return out;
}

export function seasonNotes(csMeta?: SeasonScorePayload["cs_meta"]): string[] {
  const notes = [
    "Источник: API-Football season stats (`/players?team=&season=2025`) по клубам Топ-4.",
    "Очки = сырые FPTS × множитель турнира. Бонус +20% за идеальную позицию не применяется (нет составов GW).",
    "Сухие матчи (CS): GKP/DEF +4, MID +1 при ≥60′ и 0 пропущенных; из finished fixtures + `/fixtures/players`, затем × множитель турнира.",
    "Полный матч (MID/FWD +1): оценка floor(minutes/90), не больше lineups.",
    "Старт (≥60′): lineups ×2; выходы на замену: (appearances − lineups) ×1.",
    "Матчи клуба: число finished fixtures клуба в чемпионате + кубках + Европе из сима (fallback: Σ max appearances состава).",
    "Очки/игры клуба = Σ очков футболиста ÷ матчи клуба; очки/игры футболиста = Σ очков ÷ матчи игрока.",
    "Club World Cup / friendlies и прочие турниры вне таблицы множителей не считаются.",
  ];
  if (csMeta) {
    notes.splice(
      3,
      0,
      `CS покрытие: ${csMeta.fixtures_with_stats}/${csMeta.cs_team_fixtures} матчей с сухим счётом имеют player stats` +
        (csMeta.fixtures_missing_stats
          ? ` (${csMeta.fixtures_missing_stats} без статистики — CS там не начислены)`
          : "") +
        `. Начислено CS-наград: ${csMeta.cs_awards}.`,
    );
  }
  return notes;
}
