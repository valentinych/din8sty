/**
 * Top-4 «Сезон 2026/27» from stored GW fixture stats (GW2+).
 *
 * Same payload shape as the 2025/26 AF season cache, scored with live
 * on-pitch FPTS (no +20% role bonus — this is a player table, not XIs).
 */
import type Database from "better-sqlite3";
import { excludeIgnoredFixturesWhere } from "./fixturesFilter.js";
import { type FantasyLine } from "./primerLineups.js";
import { TOP4_IDS, TOP4_LEAGUE_LABEL, type Top4LeagueId } from "./top4League.js";
import {
  appearanceMinutes,
  onPitchFptsInputs,
  teamGoalsAgainstFromScore,
  type AfMatchEvent,
} from "./top4OnPitch.js";
import {
  RESULTS_MIN_GW,
  ensureTop4GwResultsSchema,
  penWonAssistCounts,
  rawFptsFromMatchStat,
  syncFinishedGwFixtureStats,
} from "./top4GwResults.js";
import {
  COMP_BUCKET_LABEL,
  COMP_MULTIPLIER,
  SCOPED_AF_LEAGUE_IDS,
  classifyAfLeague,
  emptyBreakdown,
  afPositionToLine,
  type CompBucket,
  type SeasonPlayerScore,
  type SeasonScorePayload,
} from "./top4SeasonFpts.js";

export const TOP4_CURRENT_SEASON_YEAR = 2026;
export const TOP4_CURRENT_SEASON_LABEL = "2026/27";
export const TOP4_CURRENT_SEASON_SLUG = "2026-27";

const FINISHED = new Set(["FT", "AET", "PEN"]);

export function isCurrentTop4SeasonSlug(slug: string): boolean {
  const s = slug.trim().toLowerCase().replace(/\s+/g, "");
  return (
    s === TOP4_CURRENT_SEASON_SLUG ||
    s === "2026/27" ||
    s === "2026/2027" ||
    s === "2627" ||
    s === "season-2026" ||
    s === "season2627"
  );
}

type ClubInfo = {
  name: string;
  league_id: string;
  league_label: string;
};

type GwStatRow = {
  af_fixture_id: number;
  af_team_id: number;
  af_player_id: number;
  player_name: string;
  position: string | null;
  minutes: number;
  goals: number;
  assists: number;
  saves: number;
  yellow: number;
  red: number;
  penWon: number;
  penScored: number;
  penMissed: number;
  penSaved: number;
  substitute: number;
  af_league_id: number;
  status: string;
  home_af_id: number;
  away_af_id: number;
  home_goals: number | null;
  away_goals: number | null;
  events_synced: number;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function loadTop4Clubs(db: Database.Database): Map<number, ClubInfo> {
  const has = db
    .prepare(
      `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'club_af_map'`,
    )
    .get() as { ok: number } | undefined;
  if (!has) return new Map();
  const ph = TOP4_IDS.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT m.af_team_id, c.name, c.short_name, c.league_id
       FROM club_af_map m
       JOIN clubs c ON c.id = m.club_id
       WHERE c.league_id IN (${ph})`,
    )
    .all(...TOP4_IDS) as Array<{
    af_team_id: number;
    name: string;
    short_name: string | null;
    league_id: string;
  }>;
  const out = new Map<number, ClubInfo>();
  for (const r of rows) {
    const lid = r.league_id as Top4LeagueId;
    out.set(Number(r.af_team_id), {
      name: (r.short_name && r.short_name.trim()) || r.name || "—",
      league_id: r.league_id,
      league_label: TOP4_LEAGUE_LABEL[lid] ?? r.league_id,
    });
  }
  return out;
}

function loadFinishedStats(
  db: Database.Database,
  gwMin: number,
  top4Ids: number[],
): GwStatRow[] {
  if (!top4Ids.length) return [];
  const scopedPh = SCOPED_AF_LEAGUE_IDS.map(() => "?").join(",");
  const teamPh = top4Ids.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT s.af_fixture_id, s.af_team_id, s.af_player_id, s.player_name,
              s.position, s.minutes, s.goals, s.assists, s.saves,
              s.yellow, s.red,
              s.pen_won AS penWon, s.pen_scored AS penScored,
              s.pen_missed AS penMissed, s.pen_saved AS penSaved,
              s.substitute, f.af_league_id, f.status,
              f.home_af_id, f.away_af_id, f.home_goals, f.away_goals,
              COALESCE(sync.events_synced, 0) AS events_synced
       FROM af_gw_player_stats s
       JOIN fixtures f ON f.id = s.af_fixture_id
       LEFT JOIN af_gw_fixture_sync sync ON sync.af_fixture_id = s.af_fixture_id
       WHERE f.season = ?
         AND f.gameweek >= ?
         AND UPPER(COALESCE(f.status, '')) IN ('FT','AET','PEN')
         AND f.af_league_id IN (${scopedPh})
         AND s.af_team_id IN (${teamPh})
         AND ${excludeIgnoredFixturesWhere("f")}`,
    )
    .all(TOP4_CURRENT_SEASON_YEAR, gwMin, ...SCOPED_AF_LEAGUE_IDS, ...top4Ids) as GwStatRow[];
}

function loadFinishedEvents(
  db: Database.Database,
  gwMin: number,
): Map<number, AfMatchEvent[]> {
  const scopedPh = SCOPED_AF_LEAGUE_IDS.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT e.af_fixture_id, e.elapsed, e.extra, e.team_id, e.player_id,
              e.assist_id, e.type, e.detail
       FROM af_gw_fixture_events e
       JOIN fixtures f ON f.id = e.af_fixture_id
       WHERE f.season = ?
         AND f.gameweek >= ?
         AND UPPER(COALESCE(f.status, '')) IN ('FT','AET','PEN')
         AND f.af_league_id IN (${scopedPh})
         AND ${excludeIgnoredFixturesWhere("f")}
       ORDER BY e.af_fixture_id, e.seq`,
    )
    .all(TOP4_CURRENT_SEASON_YEAR, gwMin, ...SCOPED_AF_LEAGUE_IDS) as Array<
    AfMatchEvent & { af_fixture_id: number }
  >;
  const map = new Map<number, AfMatchEvent[]>();
  for (const r of rows) {
    const list = map.get(r.af_fixture_id) ?? [];
    list.push({
      elapsed: r.elapsed,
      extra: r.extra,
      team_id: r.team_id,
      player_id: r.player_id,
      assist_id: r.assist_id,
      type: r.type,
      detail: r.detail,
    });
    map.set(r.af_fixture_id, list);
  }
  return map;
}

function buildClubMatchCounts(
  db: Database.Database,
  gwMin: number,
  top4: Set<number>,
): Map<number, number> {
  const scopedPh = SCOPED_AF_LEAGUE_IDS.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT f.home_af_id, f.away_af_id, f.status, f.af_league_id
       FROM fixtures f
       WHERE f.season = ?
         AND f.gameweek >= ?
         AND UPPER(COALESCE(f.status, '')) IN ('FT','AET','PEN')
         AND f.af_league_id IN (${scopedPh})
         AND ${excludeIgnoredFixturesWhere("f")}`,
    )
    .all(TOP4_CURRENT_SEASON_YEAR, gwMin, ...SCOPED_AF_LEAGUE_IDS) as Array<{
    home_af_id: number;
    away_af_id: number;
    status: string;
    af_league_id: number;
  }>;
  const counts = new Map<number, number>();
  for (const r of rows) {
    if (!classifyAfLeague(r.af_league_id)) continue;
    if (!FINISHED.has(String(r.status || "").toUpperCase())) continue;
    if (top4.has(r.home_af_id)) {
      counts.set(r.home_af_id, (counts.get(r.home_af_id) ?? 0) + 1);
    }
    if (top4.has(r.away_af_id)) {
      counts.set(r.away_af_id, (counts.get(r.away_af_id) ?? 0) + 1);
    }
  }
  return counts;
}

function buildCsMeta(
  db: Database.Database,
  gwMin: number,
  top4: Set<number>,
  csAwards: number,
): SeasonScorePayload["cs_meta"] {
  const scopedPh = SCOPED_AF_LEAGUE_IDS.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT f.id AS af_fixture_id, f.home_af_id, f.away_af_id,
              f.home_goals, f.away_goals, COALESCE(sync.has_stats, 0) AS has_stats
       FROM fixtures f
       LEFT JOIN af_gw_fixture_sync sync ON sync.af_fixture_id = f.id
       WHERE f.season = ?
         AND f.gameweek >= ?
         AND UPPER(COALESCE(f.status, '')) IN ('FT','AET','PEN')
         AND f.af_league_id IN (${scopedPh})
         AND ${excludeIgnoredFixturesWhere("f")}`,
    )
    .all(TOP4_CURRENT_SEASON_YEAR, gwMin, ...SCOPED_AF_LEAGUE_IDS) as Array<{
    af_fixture_id: number;
    home_af_id: number;
    away_af_id: number;
    home_goals: number | null;
    away_goals: number | null;
    has_stats: number;
  }>;
  const needs: Array<{ has_stats: number }> = [];
  const seen = new Set<number>();
  for (const r of rows) {
    if (r.home_goals == null || r.away_goals == null) continue;
    const csHome = top4.has(r.home_af_id) && r.away_goals === 0;
    const csAway = top4.has(r.away_af_id) && r.home_goals === 0;
    if (!csHome && !csAway) continue;
    if (seen.has(r.af_fixture_id)) continue;
    seen.add(r.af_fixture_id);
    needs.push({ has_stats: r.has_stats });
  }
  const withStats = needs.filter((n) => n.has_stats).length;
  return {
    cs_team_fixtures: needs.length,
    fixtures_with_stats: withStats,
    fixtures_missing_stats: needs.length - withStats,
    cs_awards: csAwards,
  };
}

function currentSeasonNotes(csMeta?: SeasonScorePayload["cs_meta"]): string[] {
  const notes = [
    `Источник: AF fixture stats текущего сезона (GW${RESULTS_MIN_GW}+, таблица af_gw_player_stats).`,
    "Очки = сырые FPTS матча × множитель турнира. Бонус +20% за идеальную позицию не применяется.",
    "Сухие матчи (CS): GKP/DEF +4, MID +1 при ≥60′ regular time и 0 пропущенных на поле; затем × множитель турнира.",
    `GW1 не учитывается.`,
    "Полный матч (MID/FWD +1): minutes ≥ 90.",
    "Старт (≥60′): +2; меньше 60′: +1.",
    `Матчи клуба: finished fixtures клуба в чемпионате + кубках + Европе с GW${RESULTS_MIN_GW}.`,
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

function aggregateCurrentSeason(
  stats: GwStatRow[],
  eventsByFixture: Map<number, AfMatchEvent[]>,
  clubs: Map<number, ClubInfo>,
  clubMatchCounts: Map<number, number>,
): { players: SeasonPlayerScore[]; csAwards: number } {
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
    clubMinutes: Map<
      number,
      { name: string; minutes: number; league_id: string; league_label: string }
    >;
  };

  const byPlayer = new Map<number, Acc>();
  const clubTotalPts = new Map<number, number>();
  let csAwards = 0;

  const byFixture = new Map<number, GwStatRow[]>();
  for (const st of stats) {
    const list = byFixture.get(st.af_fixture_id) ?? [];
    list.push(st);
    byFixture.set(st.af_fixture_id, list);
  }

  for (const [fid, rows] of byFixture) {
    const events = eventsByFixture.get(fid) ?? [];
    const eventsSynced = rows.some((r) => Number(r.events_synced) === 1);
    const penAssists = penWonAssistCounts(rows, events, eventsSynced);

    for (const st of rows) {
      const club = clubs.get(st.af_team_id);
      if (!club) continue;
      const bucket = classifyAfLeague(st.af_league_id);
      if (!bucket) continue;
      const pitch = onPitchFptsInputs({
        events,
        eventsSynced,
        playerId: st.af_player_id,
        teamId: st.af_team_id,
        isSubstitute: Number(st.substitute) === 1,
        finished: true,
        regularNow: 90,
        scoreGoalsAgainst: teamGoalsAgainstFromScore(
          st.af_team_id,
          st.home_af_id,
          st.away_af_id,
          st.home_goals,
          st.away_goals,
        ),
      });
      const minutes = appearanceMinutes({
        afMinutes: st.minutes,
        regularMinutes: pitch.regularMinutes,
        isSubstitute: Number(st.substitute) === 1,
        playerId: st.af_player_id,
        events,
      });
      if (minutes <= 0) continue;
      const line = afPositionToLine(st.position);
      const raw = rawFptsFromMatchStat(
        {
          minutes,
          regularMinutes: pitch.regularMinutes,
          goals: st.goals,
          assists: st.assists + (penAssists.get(st.af_player_id) ?? 0),
          conceded: pitch.conceded,
          saves: st.saves,
          yellow: st.yellow,
          red: st.red,
          penMissed: st.penMissed,
          penSaved: st.penSaved,
        },
        line,
      );
      const csAwarded =
        pitch.regularMinutes != null &&
        pitch.regularMinutes >= 60 &&
        pitch.conceded === 0;
      if (raw === 0 && !csAwarded) continue;

      const weighted = round2(raw * COMP_MULTIPLIER[bucket]);

      let acc = byPlayer.get(st.af_player_id);
      if (!acc) {
        acc = {
          af_player_id: st.af_player_id,
          name: st.player_name || "—",
          photo: null,
          lineVotes: { GKP: 0, DEF: 0, MID: 0, FWD: 0 },
          breakdown: emptyBreakdown(),
          raw_total: 0,
          total: 0,
          player_matches: 0,
          clean_sheets: 0,
          clubMinutes: new Map(),
        };
        byPlayer.set(st.af_player_id, acc);
      }
      acc.breakdown[bucket] = round2(acc.breakdown[bucket] + weighted);
      acc.raw_total = round2(acc.raw_total + raw);
      acc.total = round2(acc.total + weighted);
      acc.player_matches += 1;
      acc.lineVotes[line] += minutes;
      if (st.player_name) acc.name = st.player_name;
      if (csAwarded) {
        acc.clean_sheets += 1;
        csAwards += 1;
      }

      const prev = acc.clubMinutes.get(st.af_team_id);
      if (prev) prev.minutes += minutes;
      else {
        acc.clubMinutes.set(st.af_team_id, {
          name: club.name,
          minutes,
          league_id: club.league_id,
          league_label: club.league_label,
        });
      }
      clubTotalPts.set(
        st.af_team_id,
        round2((clubTotalPts.get(st.af_team_id) ?? 0) + weighted),
      );
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
    } | null = null;
    let bestMin = -1;
    for (const [id, c] of acc.clubMinutes) {
      if (c.minutes > bestMin) {
        bestMin = c.minutes;
        bestClub = {
          id,
          name: c.name,
          league_id: c.league_id,
          league_label: c.league_label,
        };
      }
    }
    const teamId = bestClub?.id ?? null;
    const cMatches = teamId != null ? (clubMatchCounts.get(teamId) ?? 0) : 0;
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
      ppg_player: pMatches > 0 ? round2(acc.total / pMatches) : 0,
      ppg_club: cMatches > 0 ? round2(acc.total / cMatches) : 0,
      clean_sheets: acc.clean_sheets,
    });
  }
  out.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  return { players: out, csAwards };
}

export async function buildTop4CurrentSeasonPayload(
  db: Database.Database,
  opts?: { syncLimit?: number },
): Promise<SeasonScorePayload> {
  ensureTop4GwResultsSchema(db);
  const gwMin = RESULTS_MIN_GW;
  if (opts?.syncLimit) {
    await syncFinishedGwFixtureStats(db, {
      gwMin,
      limit: opts.syncLimit,
    });
  }

  const clubs = loadTop4Clubs(db);
  const top4Ids = [...clubs.keys()];
  const top4Set = new Set(top4Ids);
  const stats = loadFinishedStats(db, gwMin, top4Ids);
  const events = loadFinishedEvents(db, gwMin);
  const clubMatchCounts = buildClubMatchCounts(db, gwMin, top4Set);
  const { players, csAwards } = aggregateCurrentSeason(
    stats,
    events,
    clubs,
    clubMatchCounts,
  );
  const csMeta = buildCsMeta(db, gwMin, top4Set, csAwards);

  return {
    season: TOP4_CURRENT_SEASON_LABEL,
    season_year: TOP4_CURRENT_SEASON_YEAR,
    generated_at: new Date().toISOString(),
    source: "af_gw_player_stats (GW2+ finished fixtures)",
    notes: currentSeasonNotes(csMeta),
    multipliers: { ...COMP_MULTIPLIER },
    bucket_labels: { ...COMP_BUCKET_LABEL },
    teams_synced: clubs.size,
    player_count: players.length,
    players,
    cs_meta: csMeta,
    chart_min_x: 0,
    gw_min: gwMin,
  };
}
