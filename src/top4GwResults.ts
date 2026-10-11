/**
 * Top-4 GW results: FPTS from saved lineups × API-Football fixture stats.
 *
 * Scoring (same weights as primerLineups / season tab):
 *  - Raw FPTS per finished scoped fixture (appearance, goals, CS, …)
 *  - CS: 60′+ regular time (no stoppage) and 0 goals conceded while on pitch
 *  - Conceded −1/2 (GKP/DEF): goals against while on pitch, not player.conceded
 *  - × competition multiplier (COMP_MULTIPLIER)
 *  - × 1.2 if assigned role = player's primary (detail_role)
 *  - Auto-sub as soon as the starter has 0' this GW, their club has no
 *    remaining GW games (FT / cancelled / postponed), stats for finished
 *    matches are in, and a bench cover is unique — do not wait for the rest
 *    of the gameweek. Skip bench players whose own DNP is already certain.
 *  - Penalty won (AF penalty.won) = assist +3 if a teammate converted it
 *  - No saved lineup → null (UI shows ·); empty XI totals 0
 */
import type Database from "better-sqlite3";
import {
  afErrorIsPlan,
  afErrorIsQuota,
  fixtureEvents,
  fixturePlayers,
  fixturesByIds,
  fixturesLive,
  fixturesOnDate,
  type AfFixture,
  type AfFixtureEvent,
} from "./apiFootball.js";
import {
  appearanceMinutes,
  derivePlayerStatsFromEvents,
  isConvertedPenalty,
  onPitchFptsInputs,
  teamGoalsAgainstFromScore,
  type AfMatchEvent,
  type AfNamedMatchEvent,
} from "./top4OnPitch.js";
import { excludeIgnoredFixturesWhere } from "./fixturesFilter.js";
import { gameweekFromKickoff, gameweekRange } from "./gameweeks.js";
import { AF_SEASON } from "./leagues.js";
import {
  FORMATIONS,
  primaryRole,
  type FormationTemplate,
} from "./primerDraft.js";
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
  fantasyLineFromRole,
  type FantasyLine,
} from "./primerLineups.js";
import {
  COMP_MULTIPLIER,
  SCOPED_AF_LEAGUE_IDS,
  compMultiplierForAfLeague,
  compShortForAfLeague,
} from "./top4SeasonFpts.js";
import {
  formationById,
  parseSlotsJson,
  pickBenchCover,
  PRIMARY_POSITION_XPTS_BONUS,
  type ParsedLineupSlots,
} from "./userLineups.js";
import type { PlayerPositionFields } from "./positions.js";
import { getTop4SquadsPublic } from "./top4LiveDraft.js";
import { listTop4RegistrationsFull } from "./top4Consigliere.js";

export const RESULTS_MIN_GW = 2;

const FINISHED = new Set(["FT", "AET", "PEN"]);
const LIVE_STATUSES = new Set([
  "1H",
  "2H",
  "HT",
  "ET",
  "BT",
  "P",
  "LIVE",
  "INT",
]);
const SKIP_STATUSES = new Set(["CANC", "PST", "ABD", "AWD", "WO"]);
const LIVE_STATS_RESYNC_MS = 90_000;
const LIVE_SYNC_GAP_MS = 60_000;
/** After AF daily-quota / rate-limit errors, do not poll again for this long. */
const LIVE_SYNC_QUOTA_BACKOFF_MS = 15 * 60_000;

export type MatchStatInput = {
  minutes: number;
  /** Regular-time minutes on pitch (0–90). Null = unknown; required for CS. */
  regularMinutes?: number | null;
  goals: number;
  assists: number;
  /** Goals conceded while on the pitch. Null = unknown (no CS / no penalty). */
  conceded: number | null;
  saves: number;
  yellow: number;
  red: number;
  penMissed: number;
  penSaved: number;
};

export type Top4ResultsTeam = {
  team_id: number;
  code: string | null;
  name: string;
  logo_url: string | null;
  total: number;
  byGw: Record<string, number | null>;
};

export type Top4ResultsPayload = {
  gws: number[];
  current_gw: number;
  teams: Top4ResultsTeam[];
  notes: string[];
  multipliers: typeof COMP_MULTIPLIER;
  sync?: { fetched: number; pending: number };
};

export type FptsBreakdownKey =
  | "minutes60"
  | "minutesSub"
  | "fullGame"
  | "goal"
  | "assist"
  | "cs"
  | "penSave"
  | "saves"
  | "penMiss"
  | "conceded"
  | "yellow"
  | "red"
  | "dnp";

export type Top4FptsLine = {
  key: FptsBreakdownKey;
  pts: number;
  count?: number;
  detail?: string;
};

export type Top4LiveMatchInfo = {
  id: number;
  date: string | null;
  status: string;
  home: string;
  away: string;
  home_goals: number | null;
  away_goals: number | null;
  ha: "H" | "A";
};

export type Top4LiveMatchPart = {
  raw: number;
  multiplier: number;
  comp: string;
  pts: number;
  lines: Top4FptsLine[];
  match?: Top4LiveMatchInfo;
};

export type Top4LiveUpcoming = {
  date: string;
  ha: "H" | "A";
  status?: string;
};

export type Top4LivePlayer = {
  id: string;
  name: string;
  kind: "xi" | "bench";
  /** Assigned GW slot role (GK, CB, CF, …) for XI and bench. */
  position: string | null;
  club_crest: string | null;
  club_name: string | null;
  counts: boolean;
  auto_sub: boolean;
  /** Outgoing starter shown on the bench after auto-sub. */
  auto_sub_out?: boolean;
  /** Starter this player replaced (incoming XI). */
  auto_sub_from?: string | null;
  /** Bench player who replaced them (outgoing on bench). */
  auto_sub_for?: string | null;
  total: number;
  role_bonus: boolean;
  parts: Top4LiveMatchPart[];
  /** Club has a GW fixture in LIVE_STATUSES (1H, 2H, HT, …). */
  match_live: boolean;
  /** Club GW fixtures not yet kicked off (compact kickoff next to FPTS). */
  upcoming: Top4LiveUpcoming[];
};

export type Top4LiveTeam = {
  team_id: number;
  code: string | null;
  name: string;
  logo_url: string | null;
  total: number | null;
  players: Top4LivePlayer[];
};

export type Top4TeamGwResult = Top4LiveTeam & {
  gw: number;
  gw_label: string;
  formation: string | null;
};

export type Top4LiveStandingPayload = {
  gw: number;
  gw_label: string;
  current_gw: number;
  teams: Top4LiveTeam[];
  multipliers: typeof COMP_MULTIPLIER;
  updated_at: string;
  /** Last successful AF GW stats write (ISO). Null if this GW was never synced. */
  synced_at: string | null;
  sync?: { fetched: number; pending: number };
};

type PlayerRow = PlayerPositionFields & {
  id: string;
  name: string;
  club_id: string;
  club_crest: string | null;
  club_name: string | null;
};

type AfGwStatRow = {
  af_fixture_id: number;
  af_team_id: number;
  af_player_id: number;
  player_name: string;
  af_league_id: number;
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
  status: string;
  home_af_id: number;
  away_af_id: number;
  home_goals: number | null;
  away_goals: number | null;
  elapsed: number | null;
  events_synced: number;
};

function nz(n: number | null | undefined): number {
  return Number.isFinite(n as number) ? Math.max(0, Number(n)) : 0;
}

export type PenWonStat = {
  af_player_id: number;
  af_team_id: number;
  penWon: number;
  penScored: number;
};

/**
 * Extra assists from a won penalty that a teammate converted.
 * Winner === taker is consumed (already has the goal). Missed pens: no assist.
 * If leftover won > converted pens needing a non-taker, skip (ambiguous).
 */
export function penWonAssistCounts(
  stats: PenWonStat[],
  events: AfMatchEvent[],
  eventsSynced: boolean,
): Map<number, number> {
  const out = new Map<number, number>();
  const byTeam = new Map<number, PenWonStat[]>();
  for (const s of stats) {
    const list = byTeam.get(s.af_team_id) ?? [];
    list.push(s);
    byTeam.set(s.af_team_id, list);
  }

  for (const [teamId, teamStats] of byTeam) {
    const remaining = new Map<number, number>();
    for (const s of teamStats) {
      remaining.set(s.af_player_id, nz(s.penWon));
    }

    const scoredTakers: number[] = [];
    if (eventsSynced) {
      for (const ev of events) {
        if (!isConvertedPenalty(ev) || ev.team_id !== teamId) continue;
        scoredTakers.push(ev.player_id ?? -1);
      }
    } else {
      for (const s of teamStats) {
        for (let i = 0; i < nz(s.penScored); i++) {
          scoredTakers.push(s.af_player_id);
        }
      }
    }

    let needing = 0;
    for (const taker of scoredTakers) {
      const w = remaining.get(taker) ?? 0;
      if (w > 0) remaining.set(taker, w - 1);
      else needing += 1;
    }
    if (needing <= 0) continue;

    let leftover = 0;
    for (const n of remaining.values()) leftover += Math.max(0, n);
    if (leftover <= 0 || leftover > needing) continue;
    for (const [id, n] of remaining) {
      if (n > 0) out.set(id, n);
    }
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function pushFptsLine(
  lines: Top4FptsLine[],
  key: FptsBreakdownKey,
  pts: number,
  extra?: { count?: number; detail?: string },
): void {
  if (pts === 0) return;
  const row: Top4FptsLine = { key, pts: round2(pts) };
  if (extra?.count != null && extra.count > 0) row.count = extra.count;
  if (extra?.detail) row.detail = extra.detail;
  lines.push(row);
}

/** Raw FPTS components for one fixture (same weights as `rawFptsFromMatchStat`). */
export function rawFptsBreakdown(
  stat: MatchStatInput,
  line: FantasyLine,
): { pts: number; lines: Top4FptsLine[] } {
  const minutes = Math.max(0, stat.minutes);
  if (minutes <= 0) {
    return { pts: 0, lines: [{ key: "dnp", pts: 0, detail: "0'" }] };
  }

  const lines: Top4FptsLine[] = [];
  let pts = 0;

  if (minutes >= 60) {
    pts += APPEARANCE_60_PTS;
    pushFptsLine(lines, "minutes60", APPEARANCE_60_PTS, {
      detail: `${minutes}'`,
    });
  } else {
    pts += APPEARANCE_SUB_PTS;
    pushFptsLine(lines, "minutesSub", APPEARANCE_SUB_PTS, {
      detail: `${minutes}'`,
    });
  }
  if (FULL_GAME_PTS[line] > 0 && minutes >= 90) {
    pts += FULL_GAME_PTS[line];
    pushFptsLine(lines, "fullGame", FULL_GAME_PTS[line]);
  }
  const goals = nz(stat.goals);
  if (goals > 0) {
    const gpts = goals * GOAL_PTS[line];
    pts += gpts;
    pushFptsLine(lines, "goal", gpts, { count: goals });
  }
  const assists = nz(stat.assists);
  if (assists > 0) {
    const apts = assists * ASSIST_PTS;
    pts += apts;
    pushFptsLine(lines, "assist", apts, { count: assists });
  }
  const regular =
    stat.regularMinutes == null ? null : Math.max(0, stat.regularMinutes);
  const concededOnPitch = stat.conceded;
  if (
    regular != null &&
    regular >= 60 &&
    concededOnPitch === 0 &&
    CS_PTS[line] > 0
  ) {
    pts += CS_PTS[line];
    pushFptsLine(lines, "cs", CS_PTS[line]);
  }
  if (line === "GKP") {
    const penSaved = nz(stat.penSaved);
    if (penSaved > 0) {
      const ppts = penSaved * PENALTY_SAVE_PTS;
      pts += ppts;
      pushFptsLine(lines, "penSave", ppts, { count: penSaved });
    }
    const saves = nz(stat.saves);
    const savePts = Math.floor(saves / SAVES_PER_POINT);
    if (savePts > 0) {
      pts += savePts;
      pushFptsLine(lines, "saves", savePts, { count: saves });
    }
  }
  const penMissed = nz(stat.penMissed);
  if (penMissed > 0) {
    const mpts = penMissed * PENALTY_MISS_PTS;
    pts += mpts;
    pushFptsLine(lines, "penMiss", mpts, { count: penMissed });
  }
  if (line === "GKP" || line === "DEF") {
    const conceded = concededOnPitch == null ? 0 : nz(concededOnPitch);
    const cpts = -Math.floor(conceded / GOALS_CONCEDED_PER_POINT);
    if (cpts !== 0) {
      pts += cpts;
      pushFptsLine(lines, "conceded", cpts, { count: conceded });
    }
  }
  const yellow = nz(stat.yellow);
  if (yellow > 0) {
    const ypts = yellow * YELLOW_CARD_PTS;
    pts += ypts;
    pushFptsLine(lines, "yellow", ypts, { count: yellow });
  }
  const red = nz(stat.red);
  if (red > 0) {
    const rpts = red * RED_CARD_PTS;
    pts += rpts;
    pushFptsLine(lines, "red", rpts, { count: red });
  }
  return { pts: round2(pts), lines };
}

export function rawFptsFromMatchStat(
  stat: MatchStatInput,
  line: FantasyLine,
): number {
  return rawFptsBreakdown(stat, line).pts;
}

function isPrimaryRoleMatch(
  primary: string | null | undefined,
  assignedRole: string | null | undefined,
): boolean {
  if (!primary || !assignedRole) return false;
  const a = primary.toUpperCase() === "ST" ? "CF" : primary.toUpperCase();
  const b =
    assignedRole.toUpperCase() === "ST" ? "CF" : assignedRole.toUpperCase();
  return a === b;
}

export function applyIdealBonus(
  raw: number,
  primary: string | null | undefined,
  assignedRole: string | null | undefined,
): number {
  if (!isPrimaryRoleMatch(primary, assignedRole)) return raw;
  return round2(raw * PRIMARY_POSITION_XPTS_BONUS);
}

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
    .replace(/\s+/g, " ")
    .trim();
}

export function ensureTop4GwResultsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS af_gw_player_stats (
      af_fixture_id INTEGER NOT NULL,
      af_team_id INTEGER NOT NULL,
      af_player_id INTEGER NOT NULL,
      player_name TEXT NOT NULL,
      minutes INTEGER NOT NULL DEFAULT 0,
      position TEXT,
      substitute INTEGER NOT NULL DEFAULT 0,
      goals INTEGER NOT NULL DEFAULT 0,
      assists INTEGER NOT NULL DEFAULT 0,
      conceded INTEGER NOT NULL DEFAULT 0,
      saves INTEGER NOT NULL DEFAULT 0,
      yellow INTEGER NOT NULL DEFAULT 0,
      red INTEGER NOT NULL DEFAULT 0,
      pen_missed INTEGER NOT NULL DEFAULT 0,
      pen_saved INTEGER NOT NULL DEFAULT 0,
      pen_won INTEGER NOT NULL DEFAULT 0,
      pen_scored INTEGER NOT NULL DEFAULT 0,
      synced_at TEXT NOT NULL,
      PRIMARY KEY (af_fixture_id, af_team_id, af_player_id)
    );
    CREATE INDEX IF NOT EXISTS af_gw_ps_fixture
      ON af_gw_player_stats(af_fixture_id);
    CREATE TABLE IF NOT EXISTS af_gw_fixture_sync (
      af_fixture_id INTEGER PRIMARY KEY,
      has_stats INTEGER NOT NULL,
      synced_at TEXT NOT NULL,
      is_final INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS af_gw_fixture_events (
      af_fixture_id INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      elapsed INTEGER NOT NULL,
      extra INTEGER,
      team_id INTEGER,
      player_id INTEGER,
      assist_id INTEGER,
      type TEXT NOT NULL,
      detail TEXT,
      PRIMARY KEY (af_fixture_id, seq)
    );
    CREATE INDEX IF NOT EXISTS af_gw_ev_fixture
      ON af_gw_fixture_events(af_fixture_id);
  `);
  const syncCols = db
    .prepare(`PRAGMA table_info(af_gw_fixture_sync)`)
    .all() as Array<{ name: string }>;
  if (!syncCols.some((c) => c.name === "is_final")) {
    db.exec(
      `ALTER TABLE af_gw_fixture_sync ADD COLUMN is_final INTEGER NOT NULL DEFAULT 0`,
    );
    // Old rows were only written for finished fixtures.
    db.exec(`UPDATE af_gw_fixture_sync SET is_final = 1 WHERE has_stats = 1`);
  }
  if (!syncCols.some((c) => c.name === "events_synced")) {
    db.exec(
      `ALTER TABLE af_gw_fixture_sync ADD COLUMN events_synced INTEGER NOT NULL DEFAULT 0`,
    );
  }
  const fixCols = db
    .prepare(`PRAGMA table_info(fixtures)`)
    .all() as Array<{ name: string }>;
  if (fixCols.length && !fixCols.some((c) => c.name === "elapsed")) {
    db.exec(`ALTER TABLE fixtures ADD COLUMN elapsed INTEGER`);
  }
  const statCols = db
    .prepare(`PRAGMA table_info(af_gw_player_stats)`)
    .all() as Array<{ name: string }>;
  let addedPenCols = false;
  if (!statCols.some((c) => c.name === "pen_won")) {
    db.exec(
      `ALTER TABLE af_gw_player_stats ADD COLUMN pen_won INTEGER NOT NULL DEFAULT 0`,
    );
    addedPenCols = true;
  }
  if (!statCols.some((c) => c.name === "pen_scored")) {
    db.exec(
      `ALTER TABLE af_gw_player_stats ADD COLUMN pen_scored INTEGER NOT NULL DEFAULT 0`,
    );
    addedPenCols = true;
  }
  if (addedPenCols) {
    db.exec(`
      UPDATE af_gw_fixture_sync SET is_final = 0
      WHERE af_fixture_id IN (
        SELECT DISTINCT af_fixture_id FROM af_gw_fixture_events
        WHERE lower(coalesce(detail, '')) LIKE '%penalty%'
      )
    `);
  }
  // Empty `/fixtures/players` used to set is_final=1 (common in early cups).
  db.exec(`UPDATE af_gw_fixture_sync SET is_final = 0 WHERE COALESCE(has_stats, 0) = 0`);
  // AF player minutes often freeze before subst rows update. Un-finalize
  // those fixtures and patch minutes from already-stored events.
  db.exec(`
    UPDATE af_gw_fixture_sync SET is_final = 0
    WHERE af_fixture_id IN (
      SELECT DISTINCT e.af_fixture_id
      FROM af_gw_fixture_events e
      LEFT JOIN af_gw_player_stats s
        ON s.af_fixture_id = e.af_fixture_id AND s.af_player_id = e.assist_id
      WHERE lower(e.type) IN ('subst', 'substitution')
        AND e.assist_id IS NOT NULL AND e.assist_id != 0
        AND COALESCE(s.minutes, 0) <= 0
    )
  `);
  patchPlayerStatsFromStoredEvents(db);
}

type FixtureNeed = {
  af_fixture_id: number;
  af_league_id: number;
  gameweek: number;
  status: string;
  date: string;
  elapsed: number | null;
};

function listScopedFixtures(
  db: Database.Database,
  gwMin: number,
  gwMax: number,
): FixtureNeed[] {
  const scoped = SCOPED_AF_LEAGUE_IDS.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT f.id AS af_fixture_id, f.af_league_id, f.gameweek, f.status, f.date,
              f.elapsed
       FROM fixtures f
       WHERE f.season = ?
         AND f.gameweek >= ? AND f.gameweek <= ?
         AND f.af_league_id IN (${scoped})
         AND ${excludeIgnoredFixturesWhere("f")}
       ORDER BY f.gameweek, f.date`,
    )
    .all(AF_SEASON, gwMin, gwMax, ...SCOPED_AF_LEAGUE_IDS) as FixtureNeed[];
}

type SyncStatusRow = {
  has_stats: number;
  synced_at: string;
  is_final: number;
  events_synced: number;
};

function fixtureIsFinished(status: string | null | undefined): boolean {
  return FINISHED.has(String(status || "").toUpperCase());
}

function fixtureStatusIsInProgress(status: string | null | undefined): boolean {
  return LIVE_STATUSES.has(String(status || "").toUpperCase());
}

function clubHasInProgressMatch(
  clubMeta: Map<number, ClubGwMeta>,
  afTeamId: number | undefined,
): boolean {
  if (afTeamId == null) return false;
  const meta = clubMeta.get(afTeamId);
  return !!meta?.fixtures.some((f) => fixtureStatusIsInProgress(f.status));
}

function fixtureIsLiveOrStarted(
  status: string | null | undefined,
  date: string | null | undefined,
  nowMs: number,
): boolean {
  const st = String(status || "").toUpperCase();
  if (SKIP_STATUSES.has(st) || FINISHED.has(st)) return false;
  if (LIVE_STATUSES.has(st)) return true;
  const t = Date.parse(String(date || ""));
  return Number.isFinite(t) && t <= nowMs;
}

function fixtureHasKickedOff(
  status: string | null | undefined,
  date: string | null | undefined,
  nowMs: number,
): boolean {
  const st = String(status || "").toUpperCase();
  if (SKIP_STATUSES.has(st)) return false;
  if (FINISHED.has(st)) return true;
  return fixtureIsLiveOrStarted(status, date, nowMs);
}

function fixtureIsUpcomingKickoff(
  status: string | null | undefined,
  date: string | null | undefined,
  nowMs: number,
): boolean {
  const st = String(status || "").toUpperCase();
  if (FINISHED.has(st) || LIVE_STATUSES.has(st)) return false;
  if (st === "CANC" || st === "ABD" || st === "AWD" || st === "WO") return false;
  // Stale NS (kickoff passed but AF status never refreshed) must stay
  // upcoming — otherwise live shows fake 0' DNP for the whole squad.
  if (st === "NS" || st === "TBD") return true;
  const t = Date.parse(String(date || ""));
  if (Number.isFinite(t)) return t > nowMs;
  return st === "PST";
}

function shouldFetchGwStats(
  f: FixtureNeed,
  syncRow: SyncStatusRow | undefined,
  opts: { includeLive: boolean; force: boolean; minResyncMs: number },
  nowMs: number,
): boolean {
  const st = String(f.status || "").toUpperCase();
  if (SKIP_STATUSES.has(st)) return false;
  const finished = FINISHED.has(st);
  const live = fixtureIsLiveOrStarted(f.status, f.date, nowMs);
  if (!finished && !live) return false;
  if (!opts.includeLive && !finished) return false;
  if (opts.force) return true;
  if (finished) {
    // Only skip when we actually stored player rows. Empty AF coverage
    // (early cups vs amateurs) must keep retrying / fall back to events.
    if (
      syncRow &&
      Number(syncRow.is_final) === 1 &&
      Number(syncRow.has_stats) === 1
    ) {
      return false;
    }
    if (!syncRow) return true;
    const syncedAt = Date.parse(syncRow.synced_at);
    return !Number.isFinite(syncedAt) || nowMs - syncedAt >= opts.minResyncMs;
  }
  if (!syncRow) return true;
  const syncedAt = Date.parse(syncRow.synced_at);
  return !Number.isFinite(syncedAt) || nowMs - syncedAt >= opts.minResyncMs;
}

function shouldFetchGwEvents(
  f: FixtureNeed,
  syncRow: SyncStatusRow | undefined,
  opts: { includeLive: boolean; force: boolean; minResyncMs: number },
  nowMs: number,
): boolean {
  const st = String(f.status || "").toUpperCase();
  if (SKIP_STATUSES.has(st)) return false;
  const finished = FINISHED.has(st);
  const live = fixtureIsLiveOrStarted(f.status, f.date, nowMs);
  if (!finished && !live) return false;
  if (!opts.includeLive && !finished) return false;
  if (opts.force) return true;
  if (finished) return !syncRow || Number(syncRow.events_synced) !== 1;
  if (!syncRow) return true;
  const syncedAt = Date.parse(syncRow.synced_at);
  return !Number.isFinite(syncedAt) || nowMs - syncedAt >= opts.minResyncMs;
}

function namedEventsFromAf(events: AfFixtureEvent[]): AfNamedMatchEvent[] {
  return events.map((ev) => ({
    elapsed: nz(ev.time?.elapsed),
    extra: ev.time?.extra ?? null,
    team_id: ev.team?.id ?? null,
    player_id: ev.player?.id ?? null,
    assist_id: ev.assist?.id ?? null,
    type: ev.type || "",
    detail: ev.detail ?? null,
    player_name: ev.player?.name ?? null,
    assist_name: ev.assist?.name ?? null,
  }));
}

function fixtureNeedRegularNow(need: FixtureNeed): number | null {
  const status = String(need.status || "").toUpperCase();
  if (FINISHED.has(status)) return 90;
  if (status === "HT") {
    return need.elapsed == null ? 45 : Math.min(45, Math.max(0, need.elapsed));
  }
  if (need.elapsed == null) return null;
  return Math.max(0, need.elapsed);
}

function isSubstType(type: string | null | undefined): boolean {
  const t = String(type || "").toLowerCase();
  return t === "subst" || t === "substitution";
}

function substInsHaveMinutes(
  events: AfMatchEvent[],
  minutesByPlayer: Map<number, number>,
): boolean {
  for (const ev of events) {
    if (!isSubstType(ev.type) || ev.assist_id == null || ev.assist_id <= 0) {
      continue;
    }
    if ((minutesByPlayer.get(ev.assist_id) ?? 0) <= 0) return false;
  }
  return true;
}

type OverlayInsertFn = (row: {
  af_fixture_id: number;
  af_team_id: number;
  af_player_id: number;
  player_name: string;
  minutes: number;
  position: string | null;
  substitute: number;
  goals: number;
  assists: number;
  conceded: number;
  saves: number;
  yellow: number;
  red: number;
  pen_missed: number;
  pen_saved: number;
  pen_won: number;
  pen_scored: number;
  synced_at: string;
}) => void;

function overlayPlayerStatsFromEvents(
  db: Database.Database,
  fixtureId: number,
  events: AfNamedMatchEvent[],
  opts: { finished: boolean; regularNow: number | null; syncedAt: string },
  insert: OverlayInsertFn,
): void {
  if (!events.length) return;
  const derived = derivePlayerStatsFromEvents(events, {
    finished: opts.finished,
    regularNow: opts.regularNow,
  });
  if (!derived.length) return;
  const existing = db
    .prepare(
      `SELECT af_player_id, af_team_id, player_name, minutes, position,
              substitute, goals, assists, conceded, saves, yellow, red,
              pen_missed, pen_saved, pen_won, pen_scored
       FROM af_gw_player_stats WHERE af_fixture_id = ?`,
    )
    .all(fixtureId) as Array<{
    af_player_id: number;
    af_team_id: number;
    player_name: string;
    minutes: number;
    position: string | null;
    substitute: number;
    goals: number;
    assists: number;
    conceded: number;
    saves: number;
    yellow: number;
    red: number;
    pen_missed: number;
    pen_saved: number;
    pen_won: number;
    pen_scored: number;
  }>;
  const byId = new Map(existing.map((r) => [r.af_player_id, r]));
  const minutesByPlayer = new Map<number, number>();
  for (const r of existing) minutesByPlayer.set(r.af_player_id, r.minutes);

  for (const row of derived) {
    const cur = byId.get(row.af_player_id);
    const name = (row.player_name || cur?.player_name || "").trim();
    if (!cur && !name) continue;
    const minutes = Math.max(cur?.minutes ?? 0, row.minutes);
    const goals = Math.max(cur?.goals ?? 0, row.goals);
    const assists = Math.max(cur?.assists ?? 0, row.assists);
    const yellow = Math.max(cur?.yellow ?? 0, row.yellow);
    const red = Math.max(cur?.red ?? 0, row.red);
    const substitute = row.substitute === 1 || (cur?.substitute ?? 0) === 1 ? 1 : 0;
    const changed =
      !cur ||
      minutes > cur.minutes ||
      goals > cur.goals ||
      assists > cur.assists ||
      yellow > cur.yellow ||
      red > cur.red ||
      substitute > cur.substitute;
    if (!changed) {
      minutesByPlayer.set(row.af_player_id, minutes);
      continue;
    }
    insert({
      af_fixture_id: fixtureId,
      af_team_id: cur?.af_team_id ?? row.af_team_id,
      af_player_id: row.af_player_id,
      player_name: name,
      minutes,
      position: cur?.position ?? null,
      substitute,
      goals,
      assists,
      conceded: cur?.conceded ?? 0,
      saves: cur?.saves ?? 0,
      yellow,
      red,
      pen_missed: cur?.pen_missed ?? 0,
      pen_saved: cur?.pen_saved ?? 0,
      pen_won: cur?.pen_won ?? 0,
      pen_scored: cur?.pen_scored ?? 0,
      synced_at: opts.syncedAt,
    });
    minutesByPlayer.set(row.af_player_id, minutes);
  }

  const isFinal =
    opts.finished && substInsHaveMinutes(events, minutesByPlayer) ? 1 : 0;
  const hasStats = minutesByPlayer.size > 0 ? 1 : 0;
  db.prepare(
    `INSERT INTO af_gw_fixture_sync (af_fixture_id, has_stats, synced_at, is_final, events_synced)
     VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(af_fixture_id) DO UPDATE SET
       has_stats = CASE
         WHEN excluded.has_stats > af_gw_fixture_sync.has_stats THEN excluded.has_stats
         ELSE af_gw_fixture_sync.has_stats
       END,
       is_final = excluded.is_final`,
  ).run(fixtureId, hasStats, opts.syncedAt, isFinal);
}

function playerStatsInsert(db: Database.Database): OverlayInsertFn {
  const insert = db.prepare(
    `INSERT INTO af_gw_player_stats (
       af_fixture_id, af_team_id, af_player_id, player_name,
       minutes, position, substitute, goals, assists, conceded, saves,
       yellow, red, pen_missed, pen_saved, pen_won, pen_scored, synced_at
     ) VALUES (
       @af_fixture_id, @af_team_id, @af_player_id, @player_name,
       @minutes, @position, @substitute, @goals, @assists, @conceded, @saves,
       @yellow, @red, @pen_missed, @pen_saved, @pen_won, @pen_scored, @synced_at
     )
     ON CONFLICT(af_fixture_id, af_team_id, af_player_id) DO UPDATE SET
       player_name = excluded.player_name,
       minutes = excluded.minutes,
       position = COALESCE(excluded.position, af_gw_player_stats.position),
       substitute = excluded.substitute,
       goals = excluded.goals,
       assists = excluded.assists,
       yellow = excluded.yellow,
       red = excluded.red,
       synced_at = excluded.synced_at`,
  );
  return (row) => insert.run(row);
}

function patchPlayerStatsFromStoredEvents(db: Database.Database): void {
  const fixtures = db
    .prepare(
      `SELECT DISTINCT e.af_fixture_id AS id, f.status, f.elapsed
       FROM af_gw_fixture_events e
       JOIN fixtures f ON f.id = e.af_fixture_id
       LEFT JOIN af_gw_player_stats s
         ON s.af_fixture_id = e.af_fixture_id AND s.af_player_id = e.assist_id
       WHERE lower(e.type) IN ('subst', 'substitution')
         AND e.assist_id IS NOT NULL AND e.assist_id != 0
         AND COALESCE(s.minutes, 0) <= 0`,
    )
    .all() as Array<{ id: number; status: string; elapsed: number | null }>;
  if (!fixtures.length) return;
  const insert = playerStatsInsert(db);
  const loadEvents = db.prepare(
    `SELECT elapsed, extra, team_id, player_id, assist_id, type, detail
     FROM af_gw_fixture_events WHERE af_fixture_id = ? ORDER BY seq`,
  );
  const now = new Date().toISOString();
  const run = db.transaction(() => {
    for (const f of fixtures) {
      const events = loadEvents.all(f.id) as AfNamedMatchEvent[];
      overlayPlayerStatsFromEvents(
        db,
        f.id,
        events,
        {
          finished: fixtureIsFinished(f.status),
          regularNow: fixtureNeedRegularNow({
            af_fixture_id: f.id,
            af_league_id: 0,
            gameweek: 0,
            status: f.status,
            date: "",
            elapsed: f.elapsed,
          }),
          syncedAt: now,
        },
        insert,
      );
    }
  });
  run();
}

async function fetchAndStoreFixturePlayers(
  db: Database.Database,
  needs: FixtureNeed[],
): Promise<number> {
  const clear = db.prepare(
    `DELETE FROM af_gw_player_stats WHERE af_fixture_id = ?`,
  );
  const insert = db.prepare(
    `INSERT INTO af_gw_player_stats (
       af_fixture_id, af_team_id, af_player_id, player_name,
       minutes, position, substitute, goals, assists, conceded, saves,
       yellow, red, pen_missed, pen_saved, pen_won, pen_scored, synced_at
     ) VALUES (
       @af_fixture_id, @af_team_id, @af_player_id, @player_name,
       @minutes, @position, @substitute, @goals, @assists, @conceded, @saves,
       @yellow, @red, @pen_missed, @pen_saved, @pen_won, @pen_scored, @synced_at
     )
     ON CONFLICT(af_fixture_id, af_team_id, af_player_id) DO UPDATE SET
       player_name = excluded.player_name,
       minutes = excluded.minutes,
       position = excluded.position,
       substitute = excluded.substitute,
       goals = excluded.goals,
       assists = excluded.assists,
       conceded = excluded.conceded,
       saves = excluded.saves,
       yellow = excluded.yellow,
       red = excluded.red,
       pen_missed = excluded.pen_missed,
       pen_saved = excluded.pen_saved,
       pen_won = excluded.pen_won,
       pen_scored = excluded.pen_scored,
       synced_at = excluded.synced_at`,
  );
  const statusUpsert = db.prepare(
    `INSERT INTO af_gw_fixture_sync (af_fixture_id, has_stats, synced_at, is_final, events_synced)
     VALUES (?, ?, ?, ?, COALESCE((SELECT events_synced FROM af_gw_fixture_sync WHERE af_fixture_id = ?), 0))
     ON CONFLICT(af_fixture_id) DO UPDATE SET
       has_stats = excluded.has_stats,
       synced_at = excluded.synced_at,
       is_final = excluded.is_final`,
  );
  const countStats = db.prepare(
    `SELECT COUNT(*) AS n FROM af_gw_player_stats WHERE af_fixture_id = ?`,
  );

  const insertDerived = (
    fixtureId: number,
    rows: ReturnType<typeof derivePlayerStatsFromEvents>,
    syncedAt: string,
  ) => {
    for (const row of rows) {
      insert.run({
        af_fixture_id: fixtureId,
        af_team_id: row.af_team_id,
        af_player_id: row.af_player_id,
        player_name: row.player_name,
        minutes: row.minutes,
        position: null,
        substitute: row.substitute,
        goals: row.goals,
        assists: row.assists,
        conceded: 0,
        saves: 0,
        yellow: row.yellow,
        red: row.red,
        pen_missed: 0,
        pen_saved: 0,
        pen_won: 0,
        pen_scored: 0,
        synced_at: syncedAt,
      });
    }
  };

  let fetched = 0;
  for (const need of needs) {
    const now = new Date().toISOString();
    try {
      const { response } = await fixturePlayers(need.af_fixture_id);
      const teams = response || [];
      const hasAf = teams.some((t) => (t.players || []).length > 0);
      if (hasAf) {
        db.transaction(() => {
          clear.run(need.af_fixture_id);
          for (const t of teams) {
            for (const p of t.players || []) {
              const st = p.statistics?.[0];
              insert.run({
                af_fixture_id: need.af_fixture_id,
                af_team_id: t.team.id,
                af_player_id: p.player.id,
                player_name: p.player.name || "",
                minutes: nz(st?.games?.minutes),
                position: st?.games?.position ?? null,
                substitute: st?.games?.substitute ? 1 : 0,
                goals: nz(st?.goals?.total),
                assists: nz(st?.goals?.assists),
                conceded: nz(st?.goals?.conceded),
                saves: nz(st?.goals?.saves),
                yellow: nz(st?.cards?.yellow),
                red: nz(st?.cards?.red),
                pen_missed: nz(st?.penalty?.missed),
                pen_saved: nz(st?.penalty?.saved),
                pen_won: nz(st?.penalty?.won),
                pen_scored: nz(st?.penalty?.scored),
                synced_at: now,
              });
            }
          }
          // Never freeze FT on AF minutes alone — subst rows often lag.
          statusUpsert.run(
            need.af_fixture_id,
            1,
            now,
            0,
            need.af_fixture_id,
          );
          const storedEvents = db
            .prepare(
              `SELECT elapsed, extra, team_id, player_id, assist_id, type, detail
               FROM af_gw_fixture_events WHERE af_fixture_id = ? ORDER BY seq`,
            )
            .all(need.af_fixture_id) as AfNamedMatchEvent[];
          overlayPlayerStatsFromEvents(
            db,
            need.af_fixture_id,
            storedEvents,
            {
              finished: fixtureIsFinished(need.status),
              regularNow: fixtureNeedRegularNow(need),
              syncedAt: now,
            },
            playerStatsInsert(db),
          );
        })();
      } else {
        let derived: ReturnType<typeof derivePlayerStatsFromEvents> = [];
        try {
          const { response: evRes } = await fixtureEvents(need.af_fixture_id);
          derived = derivePlayerStatsFromEvents(namedEventsFromAf(evRes || []), {
            finished: fixtureIsFinished(need.status),
            regularNow: fixtureNeedRegularNow(need),
          });
        } catch (err) {
          if (afErrorIsQuota(err)) throw err;
          derived = [];
        }
        const existing = (
          countStats.get(need.af_fixture_id) as { n: number } | undefined
        )?.n ?? 0;
        if (derived.length) {
          db.transaction(() => {
            clear.run(need.af_fixture_id);
            insertDerived(need.af_fixture_id, derived, now);
            statusUpsert.run(
              need.af_fixture_id,
              1,
              now,
              0,
              need.af_fixture_id,
            );
          })();
        } else {
          statusUpsert.run(
            need.af_fixture_id,
            existing > 0 ? 1 : 0,
            now,
            0,
            need.af_fixture_id,
          );
        }
      }
      fetched += 1;
    } catch (err) {
      fetched += 1;
      try {
        const existing = (
          countStats.get(need.af_fixture_id) as { n: number } | undefined
        )?.n ?? 0;
        statusUpsert.run(
          need.af_fixture_id,
          existing > 0 ? 1 : 0,
          now,
          0,
          need.af_fixture_id,
        );
      } catch {
        /* schema race */
      }
      if (afErrorIsQuota(err)) throw err;
    }
  }
  return fetched;
}

async function fetchAndStoreFixtureEvents(
  db: Database.Database,
  fixtureIds: number[],
): Promise<number> {
  const clear = db.prepare(
    `DELETE FROM af_gw_fixture_events WHERE af_fixture_id = ?`,
  );
  const insert = db.prepare(
    `INSERT INTO af_gw_fixture_events (
       af_fixture_id, seq, elapsed, extra, team_id, player_id, assist_id, type, detail
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const mark = db.prepare(
    `INSERT INTO af_gw_fixture_sync (af_fixture_id, has_stats, synced_at, is_final, events_synced)
     VALUES (?, 0, ?, 0, 1)
     ON CONFLICT(af_fixture_id) DO UPDATE SET events_synced = 1`,
  );
  const fixGet = db.prepare(
    `SELECT status, elapsed FROM fixtures WHERE id = ?`,
  );
  const overlayInsert = playerStatsInsert(db);

  let fetched = 0;
  for (const id of fixtureIds) {
    const now = new Date().toISOString();
    try {
      const { response } = await fixtureEvents(id);
      const events = response || [];
      const named = namedEventsFromAf(events);
      const fix = fixGet.get(id) as
        | { status: string; elapsed: number | null }
        | undefined;
      db.transaction(() => {
        clear.run(id);
        events.forEach((ev, seq) => {
          insert.run(
            id,
            seq,
            nz(ev.time?.elapsed),
            ev.time?.extra ?? null,
            ev.team?.id ?? null,
            ev.player?.id ?? null,
            ev.assist?.id ?? null,
            ev.type || "",
            ev.detail ?? null,
          );
        });
        mark.run(id, now);
        overlayPlayerStatsFromEvents(
          db,
          id,
          named,
          {
            finished: fixtureIsFinished(fix?.status),
            regularNow: fixtureNeedRegularNow({
              af_fixture_id: id,
              af_league_id: 0,
              gameweek: 0,
              status: fix?.status || "",
              date: "",
              elapsed: fix?.elapsed ?? null,
            }),
            syncedAt: now,
          },
          overlayInsert,
        );
      })();
      fetched += 1;
    } catch (err) {
      fetched += 1;
      if (afErrorIsQuota(err)) throw err;
    }
  }
  return fetched;
}

function applyAfFixtureStatuses(
  db: Database.Database,
  rows: AfFixture[] | undefined,
): number {
  if (!rows?.length) return 0;
  const upd = db.prepare(
    `UPDATE fixtures
     SET status = ?, home_goals = ?, away_goals = ?, elapsed = ?
     WHERE id = ?`,
  );
  let n = 0;
  db.transaction(() => {
    for (const row of rows) {
      const id = row.fixture?.id;
      if (!id) continue;
      const info = upd.run(
        row.fixture.status?.short ?? null,
        row.goals?.home ?? null,
        row.goals?.away ?? null,
        row.fixture.status?.elapsed ?? null,
        id,
      );
      n += Number(info.changes) || 0;
    }
  })();
  return n;
}

async function refreshFixtureStatusesViaLiveDate(
  db: Database.Database,
  candidates: FixtureNeed[],
): Promise<void> {
  try {
    const { response } = await fixturesLive();
    applyAfFixtureStatuses(db, response);
  } catch (err) {
    if (afErrorIsQuota(err)) throw err;
    console.warn(
      "AF live fixtures:",
      err instanceof Error ? err.message : err,
    );
  }

  const stillNs = new Set(
    (
      db
        .prepare(
          `SELECT id FROM fixtures
           WHERE id IN (${candidates.map(() => "?").join(",")})
             AND UPPER(COALESCE(status, '')) IN ('NS', 'TBD', '')`,
        )
        .all(...candidates.map((c) => c.af_fixture_id)) as Array<{ id: number }>
    ).map((r) => r.id),
  );
  if (!stillNs.size) return;

  const dates = [
    ...new Set(
      candidates
        .filter((c) => stillNs.has(c.af_fixture_id))
        .map((c) => String(c.date || "").slice(0, 10))
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
    ),
  ];
  for (const date of dates) {
    try {
      const { response } = await fixturesOnDate(date);
      applyAfFixtureStatuses(db, response);
    } catch (err) {
      if (afErrorIsQuota(err)) throw err;
      console.warn(
        "AF fixtures date",
        date,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

async function refreshFixtureStatuses(
  db: Database.Database,
  fixtures: FixtureNeed[],
  limit = 20,
): Promise<void> {
  ensureTop4GwResultsSchema(db);
  const nowMs = Date.now();
  const candidates = fixtures.filter((f) => {
    const st = String(f.status || "").toUpperCase();
    if (SKIP_STATUSES.has(st) || FINISHED.has(st)) return false;
    const t = Date.parse(f.date);
    return Number.isFinite(t) && t <= nowMs + 5 * 60 * 1000;
  });
  if (!candidates.length) return;

  // Mega/Pro: one `ids` call for the exact GW candidates (includes just-FT).
  // Free-plan `plan` error → live=all + date (ids is Pro-only).
  const slice = candidates.slice(0, Math.max(1, limit));
  try {
    const { response } = await fixturesByIds(slice.map((c) => c.af_fixture_id));
    applyAfFixtureStatuses(db, response);
    return;
  } catch (err) {
    if (afErrorIsQuota(err)) throw err;
    if (!afErrorIsPlan(err)) {
      console.warn(
        "AF fixtures ids:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  await refreshFixtureStatusesViaLiveDate(db, candidates);
}

/** Upsert AF fixture player stats; returns how many fixtures were fetched. */
export async function syncGwFixtureStats(
  db: Database.Database,
  opts?: {
    gwMin?: number;
    gwMax?: number;
    limit?: number;
    force?: boolean;
    includeLive?: boolean;
    minResyncMs?: number;
  },
): Promise<{ fetched: number; pending: number }> {
  ensureTop4GwResultsSchema(db);
  const gwMin = opts?.gwMin ?? RESULTS_MIN_GW;
  const currentGw = gameweekFromKickoff(new Date());
  const gwMax = opts?.gwMax ?? Math.max(gwMin, currentGw);
  const limit = opts?.limit ?? 40;
  const force = Boolean(opts?.force);
  const includeLive = Boolean(opts?.includeLive);
  const minResyncMs = opts?.minResyncMs ?? LIVE_STATS_RESYNC_MS;
  const nowMs = Date.now();

  let fixtures = listScopedFixtures(db, gwMin, gwMax);
  // Past kickoffs still stored as NS never get FT stats (results sync
  // skips non-FT). Refresh statuses first so Thursday cups survive Friday GW rollover.
  await refreshFixtureStatuses(db, fixtures, limit);
  fixtures = listScopedFixtures(db, gwMin, gwMax);
  const statusGet = db.prepare(
    `SELECT has_stats, synced_at, COALESCE(is_final, 0) AS is_final,
            COALESCE(events_synced, 0) AS events_synced
     FROM af_gw_fixture_sync WHERE af_fixture_id = ?`,
  );
  const syncOpts = { includeLive, force, minResyncMs };
  const playerNeeds = fixtures.filter((f) =>
    shouldFetchGwStats(
      f,
      statusGet.get(f.af_fixture_id) as SyncStatusRow | undefined,
      syncOpts,
      nowMs,
    ),
  );
  const eventNeeds = fixtures.filter((f) =>
    shouldFetchGwEvents(
      f,
      statusGet.get(f.af_fixture_id) as SyncStatusRow | undefined,
      syncOpts,
      nowMs,
    ),
  );

  const playerSlice = playerNeeds.slice(0, limit);
  const fetchedPlayers = await fetchAndStoreFixturePlayers(db, playerSlice);
  const playerIds = new Set(playerSlice.map((f) => f.af_fixture_id));
  const eventOnly = eventNeeds
    .filter((f) => !playerIds.has(f.af_fixture_id))
    .slice(0, Math.max(0, limit - playerSlice.length));
  const eventIds = [
    ...playerSlice.map((f) => f.af_fixture_id),
    ...eventOnly.map((f) => f.af_fixture_id),
  ];
  const fetchedEvents = eventIds.length
    ? await fetchAndStoreFixtureEvents(db, eventIds)
    : 0;
  const fetched = fetchedPlayers + fetchedEvents;
  const pending = Math.max(
    0,
    playerNeeds.length - playerSlice.length + eventNeeds.length - eventIds.length,
  );
  return { fetched, pending };
}

/** Upsert AF fixture player stats; returns how many fixtures were fetched. */
export async function syncFinishedGwFixtureStats(
  db: Database.Database,
  opts?: { gwMin?: number; gwMax?: number; limit?: number; force?: boolean },
): Promise<{ fetched: number; pending: number }> {
  return syncGwFixtureStats(db, { ...opts, includeLive: false });
}

function loadClubAfMap(db: Database.Database): Map<string, number> {
  const map = new Map<string, number>();
  const rows = db
    .prepare(`SELECT club_id, af_team_id FROM club_af_map`)
    .all() as Array<{ club_id: string; af_team_id: number }>;
  for (const r of rows) map.set(String(r.club_id), Number(r.af_team_id));
  return map;
}

function loadPlayersById(
  db: Database.Database,
  ids: string[],
): Map<string, PlayerRow> {
  const out = new Map<string, PlayerRow>();
  if (!ids.length) return out;
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.club_id, p.position, p.detail_role, p.detail_label,
              p.side_role, c.crest_url AS club_crest,
              c.short_name AS club_short, c.name AS club_full
       FROM players p
       LEFT JOIN clubs c ON c.id = p.club_id
       WHERE p.id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids) as Array<
      PlayerRow & { club_short: string | null; club_full: string | null }
    >;
  for (const r of rows) {
    const crest =
      r.club_crest != null && String(r.club_crest).trim()
        ? String(r.club_crest).trim()
        : null;
    const clubName =
      (r.club_short && String(r.club_short).trim()) ||
      (r.club_full && String(r.club_full).trim()) ||
      null;
    out.set(String(r.id), { ...r, club_crest: crest, club_name: clubName });
  }
  return out;
}

function loadGwStats(
  db: Database.Database,
  gw: number,
): AfGwStatRow[] {
  return loadGwStatsRange(db, gw, gw);
}

function loadGwStatsRange(
  db: Database.Database,
  gwMin: number,
  gwMax: number,
): AfGwStatRow[] {
  const scoped = SCOPED_AF_LEAGUE_IDS.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT s.af_fixture_id, s.af_team_id, s.af_player_id, s.player_name,
              s.minutes, s.goals, s.assists, s.saves,
              s.yellow, s.red,
              s.pen_won AS penWon, s.pen_scored AS penScored,
              s.pen_missed AS penMissed, s.pen_saved AS penSaved,
              s.substitute, f.af_league_id, f.status,
              f.home_af_id, f.away_af_id, f.home_goals, f.away_goals,
              f.elapsed,
              COALESCE(sync.events_synced, 0) AS events_synced
       FROM af_gw_player_stats s
       JOIN fixtures f ON f.id = s.af_fixture_id
       LEFT JOIN af_gw_fixture_sync sync ON sync.af_fixture_id = s.af_fixture_id
       WHERE f.gameweek >= ?
         AND f.gameweek <= ?
         AND f.season = ?
         AND f.af_league_id IN (${scoped})
         AND ${excludeIgnoredFixturesWhere("f")}`,
    )
    .all(gwMin, gwMax, AF_SEASON, ...SCOPED_AF_LEAGUE_IDS) as AfGwStatRow[];
}

function loadGwEvents(
  db: Database.Database,
  gw: number,
): Map<number, AfMatchEvent[]> {
  return loadGwEventsRange(db, gw, gw);
}

function loadGwEventsRange(
  db: Database.Database,
  gwMin: number,
  gwMax: number,
): Map<number, AfMatchEvent[]> {
  const scoped = SCOPED_AF_LEAGUE_IDS.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT e.af_fixture_id, e.elapsed, e.extra, e.team_id, e.player_id,
              e.assist_id, e.type, e.detail
       FROM af_gw_fixture_events e
       JOIN fixtures f ON f.id = e.af_fixture_id
       WHERE f.gameweek >= ?
         AND f.gameweek <= ?
         AND f.season = ?
         AND f.af_league_id IN (${scoped})
         AND ${excludeIgnoredFixturesWhere("f")}
       ORDER BY e.af_fixture_id, e.seq`,
    )
    .all(gwMin, gwMax, AF_SEASON, ...SCOPED_AF_LEAGUE_IDS) as Array<
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

function fixtureRegularNow(st: AfGwStatRow): number | null {
  const status = String(st.status || "").toUpperCase();
  if (FINISHED.has(status)) return 90;
  if (status === "HT") {
    return st.elapsed == null ? 45 : Math.min(45, Math.max(0, st.elapsed));
  }
  if (st.elapsed == null) return null;
  return Math.max(0, st.elapsed);
}

function statAppearanceMinutes(
  st: AfGwStatRow,
  events: AfMatchEvent[],
): number {
  const pitch = onPitchFptsInputs({
    events,
    eventsSynced: Number(st.events_synced) === 1,
    playerId: st.af_player_id,
    teamId: st.af_team_id,
    isSubstitute: Number(st.substitute) === 1,
    finished: fixtureIsFinished(st.status),
    regularNow: fixtureRegularNow(st),
    scoreGoalsAgainst: teamGoalsAgainstFromScore(
      st.af_team_id,
      st.home_af_id,
      st.away_af_id,
      st.home_goals,
      st.away_goals,
    ),
  });
  return appearanceMinutes({
    afMinutes: st.minutes,
    regularMinutes: pitch.regularMinutes,
    isSubstitute: Number(st.substitute) === 1,
    playerId: st.af_player_id,
    events,
  });
}

type ClubGwFixture = {
  af_fixture_id: number;
  af_league_id: number;
  status: string;
  finished: boolean;
  date: string | null;
  home_af_id: number;
  away_af_id: number;
  home_name: string;
  away_name: string;
  home_goals: number | null;
  away_goals: number | null;
};

type ClubGwMeta = {
  fixtures: ClubGwFixture[];
  allFinished: boolean;
};

function loadClubGwMeta(
  db: Database.Database,
  gw: number,
): Map<number, ClubGwMeta> {
  const scoped = SCOPED_AF_LEAGUE_IDS.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT f.id AS af_fixture_id, f.af_league_id, f.status, f.date,
              f.home_af_id, f.away_af_id, f.home_name, f.away_name,
              f.home_goals, f.away_goals
       FROM fixtures f
       WHERE f.gameweek = ? AND f.season = ?
         AND f.af_league_id IN (${scoped})
         AND ${excludeIgnoredFixturesWhere("f")}
       ORDER BY f.date`,
    )
    .all(gw, AF_SEASON, ...SCOPED_AF_LEAGUE_IDS) as Array<{
    af_fixture_id: number;
    af_league_id: number;
    status: string;
    date: string | null;
    home_af_id: number;
    away_af_id: number;
    home_name: string | null;
    away_name: string | null;
    home_goals: number | null;
    away_goals: number | null;
  }>;

  const map = new Map<number, ClubGwMeta>();
  const add = (afTeamId: number, row: (typeof rows)[0]) => {
    const finished = FINISHED.has(String(row.status || "").toUpperCase());
    let meta = map.get(afTeamId);
    if (!meta) {
      meta = { fixtures: [], allFinished: true };
      map.set(afTeamId, meta);
    }
    meta.fixtures.push({
      af_fixture_id: row.af_fixture_id,
      af_league_id: row.af_league_id,
      status: row.status,
      finished,
      date: row.date ? String(row.date) : null,
      home_af_id: row.home_af_id,
      away_af_id: row.away_af_id,
      home_name: row.home_name ? String(row.home_name) : "",
      away_name: row.away_name ? String(row.away_name) : "",
      home_goals: row.home_goals,
      away_goals: row.away_goals,
    });
    if (!finished) meta.allFinished = false;
  };
  for (const r of rows) {
    add(Number(r.home_af_id), r);
    add(Number(r.away_af_id), r);
  }
  return map;
}

/** NS / live / suspended: starter might still play. PST/CANC/FT are done. */
function clubHasRemainingGwGames(meta: ClubGwMeta | undefined): boolean {
  if (!meta?.fixtures.length) return false;
  return meta.fixtures.some((fx) => {
    const st = String(fx.status || "").toUpperCase();
    if (FINISHED.has(st) || SKIP_STATUSES.has(st)) return false;
    return true;
  });
}

/** Stats rows exist for every FT fixture — 0' is DNP, not "not synced yet". */
function clubFinishedGwStatsReady(
  meta: ClubGwMeta | undefined,
  afTeamId: number | undefined,
  stats: AfGwStatRow[],
): boolean {
  if (!meta?.fixtures.length) return true;
  if (afTeamId == null) return false;
  const played = meta.fixtures.filter((fx) =>
    FINISHED.has(String(fx.status || "").toUpperCase()),
  );
  if (!played.length) return true;
  return played.every((fx) =>
    stats.some(
      (s) => s.af_fixture_id === fx.af_fixture_id && s.af_team_id === afTeamId,
    ),
  );
}

/**
 * AF often shortens names (`H. Kane`, `N. Paz`) vs TM full names (`Harry Kane`,
 * `Nico Paz`). Last-name-only matches stay gated at 4+ letters to avoid `Lee` /
 * `Kim` collisions; initials (`N`/`Nico`) unlock short surnames per fixture.
 */
function afStatNameMatches(playerName: string, statName: string): boolean {
  const want = normName(playerName);
  const got = normName(statName);
  if (!want || !got) return false;
  if (want === got) return true;
  if (got.includes(want) || want.includes(got)) return true;
  const wantTok = want.split(" ").filter((t) => t.length > 0);
  const gotTok = got.split(" ").filter((t) => t.length > 0);
  const last = wantTok[wantTok.length - 1];
  if (!last || !gotTok.includes(last)) return false;
  const wFirst = wantTok.length >= 2 ? wantTok[0] : "";
  const gFirst = gotTok.length >= 2 ? gotTok[0] : "";
  if (!wFirst || !gFirst) return last.length >= 4;
  if (wFirst === gFirst) return true;
  return (
    wFirst[0] === gFirst[0] && (wFirst.length === 1 || gFirst.length === 1)
  );
}

function matchAfStatsForPlayer(
  player: PlayerRow,
  afTeamId: number | undefined,
  stats: AfGwStatRow[],
): AfGwStatRow[] {
  if (!afTeamId) return [];
  const teamStats = stats.filter((s) => s.af_team_id === afTeamId);
  if (!teamStats.length) return [];
  const want = player.name;
  if (!normName(want)) return [];

  const byFix = new Map<number, AfGwStatRow[]>();
  for (const s of teamStats) {
    const list = byFix.get(s.af_fixture_id) ?? [];
    list.push(s);
    byFix.set(s.af_fixture_id, list);
  }

  const out: AfGwStatRow[] = [];
  for (const rows of byFix.values()) {
    const hits = rows.filter((r) => afStatNameMatches(want, r.player_name));
    if (!hits.length) continue;
    const exact = hits.find((r) => normName(r.player_name) === normName(want));
    out.push(exact ?? hits[0]);
  }
  return out;
}

function clubSide(
  afTeamId: number | undefined,
  homeAfId: number,
): "H" | "A" {
  return afTeamId != null && afTeamId === homeAfId ? "H" : "A";
}

function matchInfoFromClubFix(
  fx: ClubGwFixture,
  afTeamId: number | undefined,
): Top4LiveMatchInfo {
  return {
    id: fx.af_fixture_id,
    date: fx.date,
    status: String(fx.status || ""),
    home: fx.home_name,
    away: fx.away_name,
    home_goals: fx.home_goals,
    away_goals: fx.away_goals,
    ha: clubSide(afTeamId, fx.home_af_id),
  };
}

function matchInfoFromStat(
  st: AfGwStatRow,
  fx?: ClubGwFixture,
): Top4LiveMatchInfo {
  return {
    id: st.af_fixture_id,
    date: fx?.date ?? null,
    status: String(st.status || fx?.status || ""),
    home: fx?.home_name || "",
    away: fx?.away_name || "",
    home_goals: st.home_goals ?? fx?.home_goals ?? null,
    away_goals: st.away_goals ?? fx?.away_goals ?? null,
    ha: clubSide(st.af_team_id, st.home_af_id),
  };
}

function dnpPart(fx: ClubGwFixture, afTeamId: number | undefined): Top4LiveMatchPart {
  const multiplier = compMultiplierForAfLeague(fx.af_league_id);
  return {
    raw: 0,
    multiplier,
    comp: compShortForAfLeague(fx.af_league_id),
    pts: 0,
    lines: [{ key: "dnp", pts: 0, detail: "0'" }],
    match: matchInfoFromClubFix(fx, afTeamId),
  };
}

function upcomingKickoffs(
  fixtures: ClubGwFixture[],
  afTeamId: number | undefined,
  nowMs: number,
): Top4LiveUpcoming[] {
  const out: Top4LiveUpcoming[] = [];
  for (const fx of fixtures) {
    if (!fx.date || !fixtureIsUpcomingKickoff(fx.status, fx.date, nowMs)) continue;
    out.push({
      date: fx.date,
      ha: clubSide(afTeamId, fx.home_af_id),
      status: String(fx.status || ""),
    });
  }
  return out;
}

function scorePlayerBreakdown(
  player: PlayerRow,
  assignedRole: string | null,
  afTeamId: number | undefined,
  stats: AfGwStatRow[],
  eventsByFixture: Map<number, AfMatchEvent[]>,
  opts?: { applyRoleBonus?: boolean; clubFixtures?: ClubGwFixture[] },
): {
  total: number;
  roleBonus: boolean;
  parts: Top4LiveMatchPart[];
} {
  const applyBonus = opts?.applyRoleBonus !== false;
  const clubFixtures = opts?.clubFixtures ?? [];
  const matched = matchAfStatsForPlayer(player, afTeamId, stats);
  const roleBonus =
    applyBonus && isPrimaryRoleMatch(primaryRole(player), assignedRole);
  const line = fantasyLineFromRole(assignedRole || primaryRole(player));
  const parts: Top4LiveMatchPart[] = [];
  let total = 0;
  const penAssistByFixture = new Map<number, Map<number, number>>();
  const nowMs = Date.now();
  const matchedByFix = new Map<number, AfGwStatRow>();
  for (const st of matched) matchedByFix.set(st.af_fixture_id, st);
  const fxById = new Map<number, ClubGwFixture>();
  for (const fx of clubFixtures) fxById.set(fx.af_fixture_id, fx);

  const partFromStat = (st: AfGwStatRow, fx?: ClubGwFixture): Top4LiveMatchPart => {
    const events = eventsByFixture.get(st.af_fixture_id) ?? [];
    const eventsSynced = Number(st.events_synced) === 1;
    const pitch = onPitchFptsInputs({
      events,
      eventsSynced,
      playerId: st.af_player_id,
      teamId: st.af_team_id,
      isSubstitute: Number(st.substitute) === 1,
      finished: fixtureIsFinished(st.status),
      regularNow: fixtureRegularNow(st),
      scoreGoalsAgainst: teamGoalsAgainstFromScore(
        st.af_team_id,
        st.home_af_id,
        st.away_af_id,
        st.home_goals,
        st.away_goals,
      ),
    });
    let penAssists = penAssistByFixture.get(st.af_fixture_id);
    if (!penAssists) {
      const fixtureStats = stats.filter(
        (s) => s.af_fixture_id === st.af_fixture_id,
      );
      penAssists = penWonAssistCounts(fixtureStats, events, eventsSynced);
      penAssistByFixture.set(st.af_fixture_id, penAssists);
    }
    const scored = rawFptsBreakdown(
      {
        minutes: appearanceMinutes({
          afMinutes: st.minutes,
          regularMinutes: pitch.regularMinutes,
          isSubstitute: Number(st.substitute) === 1,
          playerId: st.af_player_id,
          events,
        }),
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
    const multiplier = compMultiplierForAfLeague(st.af_league_id);
    const weighted = round2(scored.pts * multiplier);
    const pts = applyBonus
      ? applyIdealBonus(weighted, primaryRole(player), assignedRole)
      : weighted;
    return {
      raw: scored.pts,
      multiplier,
      comp: compShortForAfLeague(st.af_league_id),
      pts,
      lines: scored.lines.length
        ? scored.lines
        : [{ key: "dnp", pts: 0, detail: "0'" }],
      match: matchInfoFromStat(st, fx),
    };
  };

  const seen = new Set<number>();
  for (const fx of clubFixtures) {
    seen.add(fx.af_fixture_id);
    const st = matchedByFix.get(fx.af_fixture_id);
    const events = eventsByFixture.get(fx.af_fixture_id) ?? [];
    const played = st ? statAppearanceMinutes(st, events) : 0;
    if (st && played > 0) {
      const part = partFromStat(st, fx);
      parts.push(part);
      total += part.pts;
      continue;
    }
    const started =
      fixtureIsFinished(fx.status) || fixtureStatusIsInProgress(fx.status);
    if (started) parts.push(dnpPart(fx, afTeamId));
  }
  for (const st of matched) {
    if (seen.has(st.af_fixture_id)) continue;
    if (
      !fixtureHasKickedOff(st.status, fxById.get(st.af_fixture_id)?.date, nowMs)
    ) {
      continue;
    }
    const part = partFromStat(st, fxById.get(st.af_fixture_id));
    parts.push(part);
    total += part.pts;
  }
  return { total: round2(total), roleBonus, parts };
}

/** Last N finished club matches used for lineup Form. */
export const FORM_LAST_N = 5;

export type PlayerForm = {
  form: number | null;
  form_n: number;
};

type FormPlayerInput = {
  id: string;
  name: string;
  club_id: string | number;
  position?: string | null;
  detail_role?: string | null;
  detail_label?: string | null;
  side_role?: string | null;
};

function loadRecentFinishedClubFixtures(
  db: Database.Database,
  afTeamIds: number[],
  n: number,
): Map<number, ClubGwFixture[]> {
  const out = new Map<number, ClubGwFixture[]>();
  if (!afTeamIds.length || n <= 0) return out;
  const scoped = SCOPED_AF_LEAGUE_IDS.map(() => "?").join(",");
  const teamPh = afTeamIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT f.id AS af_fixture_id, f.af_league_id, f.status, f.date,
              f.home_af_id, f.away_af_id, f.home_name, f.away_name,
              f.home_goals, f.away_goals
       FROM fixtures f
       WHERE f.season = ?
         AND f.gameweek >= 1
         AND (f.home_af_id IN (${teamPh}) OR f.away_af_id IN (${teamPh}))
         AND UPPER(COALESCE(f.status, '')) IN ('FT','AET','PEN')
         AND f.af_league_id IN (${scoped})
         AND ${excludeIgnoredFixturesWhere("f")}
       ORDER BY f.date DESC`,
    )
    .all(AF_SEASON, ...afTeamIds, ...afTeamIds, ...SCOPED_AF_LEAGUE_IDS) as Array<{
    af_fixture_id: number;
    af_league_id: number;
    status: string;
    date: string | null;
    home_af_id: number;
    away_af_id: number;
    home_name: string | null;
    away_name: string | null;
    home_goals: number | null;
    away_goals: number | null;
  }>;

  const wanted = new Set(afTeamIds);
  for (const row of rows) {
    const fx: ClubGwFixture = {
      af_fixture_id: row.af_fixture_id,
      af_league_id: row.af_league_id,
      status: row.status,
      finished: true,
      date: row.date ? String(row.date) : null,
      home_af_id: row.home_af_id,
      away_af_id: row.away_af_id,
      home_name: row.home_name ? String(row.home_name) : "",
      away_name: row.away_name ? String(row.away_name) : "",
      home_goals: row.home_goals,
      away_goals: row.away_goals,
    };
    for (const teamId of [Number(row.home_af_id), Number(row.away_af_id)]) {
      if (!wanted.has(teamId)) continue;
      const list = out.get(teamId) ?? [];
      if (list.length >= n) continue;
      list.push(fx);
      out.set(teamId, list);
    }
  }
  return out;
}

function loadStatsForFixtureIds(
  db: Database.Database,
  fixtureIds: number[],
): AfGwStatRow[] {
  if (!fixtureIds.length) return [];
  const ph = fixtureIds.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT s.af_fixture_id, s.af_team_id, s.af_player_id, s.player_name,
              s.minutes, s.goals, s.assists, s.saves,
              s.yellow, s.red,
              s.pen_won AS penWon, s.pen_scored AS penScored,
              s.pen_missed AS penMissed, s.pen_saved AS penSaved,
              s.substitute, f.af_league_id, f.status,
              f.home_af_id, f.away_af_id, f.home_goals, f.away_goals,
              f.elapsed,
              COALESCE(sync.events_synced, 0) AS events_synced
       FROM af_gw_player_stats s
       JOIN fixtures f ON f.id = s.af_fixture_id
       LEFT JOIN af_gw_fixture_sync sync ON sync.af_fixture_id = s.af_fixture_id
       WHERE s.af_fixture_id IN (${ph})`,
    )
    .all(...fixtureIds) as AfGwStatRow[];
}

function loadEventsForFixtureIds(
  db: Database.Database,
  fixtureIds: number[],
): Map<number, AfMatchEvent[]> {
  const map = new Map<number, AfMatchEvent[]>();
  if (!fixtureIds.length) return map;
  const ph = fixtureIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT e.af_fixture_id, e.elapsed, e.extra, e.team_id, e.player_id,
              e.assist_id, e.type, e.detail
       FROM af_gw_fixture_events e
       WHERE e.af_fixture_id IN (${ph})
       ORDER BY e.af_fixture_id, e.seq`,
    )
    .all(...fixtureIds) as Array<AfMatchEvent & { af_fixture_id: number }>;
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

/**
 * Form = mean realized FPTS over the last 5 finished matches of the player's
 * current club (scoped comps, competition multipliers, no ×1.2). DNP / missing
 * stats on an FT match count as 0. Fewer than 5 → mean of those N.
 */
export function computeRosterForm(
  db: Database.Database,
  players: FormPlayerInput[],
): Map<string, PlayerForm> {
  const out = new Map<string, PlayerForm>();
  const empty = (): PlayerForm => ({ form: null, form_n: 0 });
  if (!players.length) return out;

  const clubAf = loadClubAfMap(db);
  const afTeamIds = [
    ...new Set(
      players
        .map((p) => clubAf.get(String(p.club_id)))
        .filter((id): id is number => id != null && Number.isFinite(id)),
    ),
  ];
  if (!afTeamIds.length) {
    for (const p of players) out.set(String(p.id), empty());
    return out;
  }

  const fixturesByTeam = loadRecentFinishedClubFixtures(
    db,
    afTeamIds,
    FORM_LAST_N,
  );
  const fixtureIds = [
    ...new Set(
      [...fixturesByTeam.values()].flat().map((fx) => fx.af_fixture_id),
    ),
  ];
  const stats = loadStatsForFixtureIds(db, fixtureIds);
  const eventsByFixture = loadEventsForFixtureIds(db, fixtureIds);
  const statsByTeam = new Map<number, AfGwStatRow[]>();
  for (const s of stats) {
    const list = statsByTeam.get(s.af_team_id) ?? [];
    list.push(s);
    statsByTeam.set(s.af_team_id, list);
  }

  for (const p of players) {
    const id = String(p.id);
    const afTeamId = clubAf.get(String(p.club_id));
    const fixtures = afTeamId != null ? fixturesByTeam.get(afTeamId) ?? [] : [];
    if (!fixtures.length || afTeamId == null) {
      out.set(id, empty());
      continue;
    }
    const formFixIds = new Set(fixtures.map((fx) => fx.af_fixture_id));
    const teamStats = (statsByTeam.get(afTeamId) ?? []).filter((s) =>
      formFixIds.has(s.af_fixture_id),
    );
    const playerRow: PlayerRow = {
      id,
      name: p.name,
      club_id: String(p.club_id),
      club_crest: null,
      club_name: null,
      position: p.position ?? null,
      detail_role: p.detail_role ?? null,
      detail_label: p.detail_label ?? null,
      side_role: p.side_role ?? null,
    };
    const role = primaryRole(playerRow);
    const scored = scorePlayerBreakdown(
      playerRow,
      role,
      afTeamId,
      teamStats,
      eventsByFixture,
      { applyRoleBonus: false, clubFixtures: fixtures },
    );
    const n = scored.parts.length;
    if (!n) {
      out.set(id, empty());
      continue;
    }
    const sum = scored.parts.reduce((acc, part) => acc + part.pts, 0);
    out.set(id, { form: round2(sum / n), form_n: n });
  }
  return out;
}

const LINE_SAMPLE_ROLE: Record<FantasyLine, string> = {
  GKP: "GK",
  DEF: "CB",
  MID: "CM",
  FWD: "CF",
};

const FANTASY_LINES: FantasyLine[] = ["GKP", "DEF", "MID", "FWD"];

/** Per-player GW FPTS for the lineup editor (current or past GW). */
export type RosterGwFpts = {
  /** TM primary line, competition multipliers, no ×1.2 (squad «Набрал»). */
  scored: number;
  GKP: number;
  DEF: number;
  MID: number;
  FWD: number;
};

function emptyRosterGwFpts(): RosterGwFpts {
  return { scored: 0, GKP: 0, DEF: 0, MID: 0, FWD: 0 };
}

function formPlayerRow(p: FormPlayerInput): PlayerRow {
  return {
    id: String(p.id),
    name: p.name,
    club_id: String(p.club_id),
    club_crest: null,
    club_name: null,
    position: p.position ?? null,
    detail_role: p.detail_role ?? null,
    detail_label: p.detail_label ?? null,
    side_role: p.side_role ?? null,
  };
}

/**
 * Realized FPTS in one GW, by fantasy line (no ×1.2). `scored` is the TM
 * primary line — same as squad «Набрал» for that week. XI «Принёс» is the
 * assigned-slot line, with ×1.2 applied on the client when the slot is primary.
 */
export function computeRosterGwFpts(
  db: Database.Database,
  gw: number,
  players: FormPlayerInput[],
): Map<string, RosterGwFpts> {
  ensureTop4GwResultsSchema(db);
  const out = new Map<string, RosterGwFpts>();
  if (!players.length || !Number.isFinite(gw) || gw < 1) {
    for (const p of players) out.set(String(p.id), emptyRosterGwFpts());
    return out;
  }

  const clubAf = loadClubAfMap(db);
  const stats = loadGwStats(db, gw);
  const eventsByFixture = loadGwEvents(db, gw);
  const clubMeta = loadClubGwMeta(db, gw);
  const statsByTeam = new Map<number, AfGwStatRow[]>();
  for (const s of stats) {
    const list = statsByTeam.get(s.af_team_id) ?? [];
    list.push(s);
    statsByTeam.set(s.af_team_id, list);
  }

  for (const p of players) {
    const id = String(p.id);
    const afTeamId = clubAf.get(String(p.club_id));
    if (afTeamId == null) {
      out.set(id, emptyRosterGwFpts());
      continue;
    }
    const playerRow = formPlayerRow(p);
    const teamStats = statsByTeam.get(afTeamId) ?? [];
    const clubFixtures = clubMeta.get(afTeamId)?.fixtures ?? [];
    const byLine = emptyRosterGwFpts();
    for (const line of FANTASY_LINES) {
      const scored = scorePlayerBreakdown(
        playerRow,
        LINE_SAMPLE_ROLE[line],
        afTeamId,
        teamStats,
        eventsByFixture,
        { applyRoleBonus: false, clubFixtures },
      );
      byLine[line] = scored.total;
    }
    byLine.scored = byLine[fantasyLineFromRole(primaryRole(playerRow))];
    out.set(id, byLine);
  }
  return out;
}

/** True once any scoped club fixture in this GW has kicked off. */
export function top4GwHasKickedOff(
  db: Database.Database,
  gw: number,
): boolean {
  if (!Number.isFinite(gw) || gw < 1) return false;
  const nowMs = Date.now();
  for (const club of loadClubGwMeta(db, gw).values()) {
    for (const fx of club.fixtures) {
      if (fixtureHasKickedOff(fx.status, fx.date, nowMs)) return true;
    }
  }
  return false;
}

function playerMinutesInGw(
  player: PlayerRow,
  afTeamId: number | undefined,
  stats: AfGwStatRow[],
  eventsByFixture: Map<number, AfMatchEvent[]>,
): number {
  return matchAfStatsForPlayer(player, afTeamId, stats).reduce((s, r) => {
    const events = eventsByFixture.get(r.af_fixture_id) ?? [];
    return s + statAppearanceMinutes(r, events);
  }, 0);
}

function xiSlotPosition(
  assignedRole: string | null,
  formationSlot: readonly string[] | undefined,
): string | null {
  const role = assignedRole?.trim();
  if (role) return role;
  const fallback = formationSlot?.[0];
  return fallback ? String(fallback) : null;
}

/** Keep a bench player as cover unless their DNP this GW is already certain. */
function benchPlayerEligibleForCover(
  player: PlayerRow,
  clubAf: Map<string, number>,
  stats: AfGwStatRow[],
  clubMeta: Map<number, ClubGwMeta>,
  eventsByFixture: Map<number, AfMatchEvent[]>,
): boolean {
  const afTeamId = clubAf.get(player.club_id);
  if (playerMinutesInGw(player, afTeamId, stats, eventsByFixture) > 0) {
    return true;
  }
  const meta = afTeamId != null ? clubMeta.get(afTeamId) : undefined;
  if (clubHasRemainingGwGames(meta)) return true;
  if (!clubFinishedGwStatsReady(meta, afTeamId, stats)) return true;
  return false;
}

function scoreLineupGwDetailed(
  formation: FormationTemplate,
  parsed: ParsedLineupSlots,
  playersById: Map<string, PlayerRow>,
  clubAf: Map<string, number>,
  stats: AfGwStatRow[],
  clubMeta: Map<number, ClubGwMeta>,
  includeBench: boolean,
  eventsByFixture: Map<number, AfMatchEvent[]>,
): { total: number; players: Top4LivePlayer[] } {
  const usedBench = new Set<number>();
  const xiPlayers: Top4LivePlayer[] = [];
  const satDown: Top4LivePlayer[] = [];
  let total = 0;
  const nowMs = Date.now();

  const clubFx = (afTeamId: number | undefined): ClubGwFixture[] =>
    afTeamId != null ? clubMeta.get(afTeamId)?.fixtures ?? [] : [];

  for (let i = 0; i < formation.slots.length; i++) {
    const starterId = parsed.slots[i] ?? null;
    const assignedRole = parsed.roles[i] ?? null;
    const slot = formation.slots[i];

    let scorer: PlayerRow | null = starterId
      ? playersById.get(starterId) ?? null
      : null;
    let role = assignedRole;
    let autoSub = false;
    let outgoing: PlayerRow | null = null;

    if (scorer) {
      const afTeamId = clubAf.get(scorer.club_id);
      const mins = playerMinutesInGw(scorer, afTeamId, stats, eventsByFixture);
      const meta = afTeamId != null ? clubMeta.get(afTeamId) : undefined;
      // Sub as soon as DNP is certain (no remaining GW games, stats in) and
      // pickBenchCover names the replacement — not after the whole GW ends.
      if (
        mins <= 0 &&
        !clubHasRemainingGwGames(meta) &&
        clubFinishedGwStatsReady(meta, afTeamId, stats)
      ) {
        const benchPlayers = parsed.bench.map((id, bi) => {
          if (id == null || usedBench.has(bi)) return null;
          const p = playersById.get(id) ?? null;
          if (!p) return null;
          if (
            !benchPlayerEligibleForCover(
              p,
              clubAf,
              stats,
              clubMeta,
              eventsByFixture,
            )
          ) {
            return null;
          }
          return p;
        });
        const cover = pickBenchCover(slot, benchPlayers);
        if (cover) {
          usedBench.add(cover.benchIndex);
          const benchId = parsed.bench[cover.benchIndex];
          outgoing = scorer;
          scorer = benchId ? playersById.get(benchId) ?? null : null;
          role = cover.matchedRole;
          autoSub = true;
        } else {
          scorer = null;
        }
      }
    }

    if (!scorer) continue;
    const afTeamId = clubAf.get(scorer.club_id);
    const fixtures = clubFx(afTeamId);
    const scored = scorePlayerBreakdown(
      scorer,
      role,
      afTeamId,
      stats,
      eventsByFixture,
      { clubFixtures: fixtures },
    );
    total += scored.total;
    xiPlayers.push({
      id: scorer.id,
      name: scorer.name,
      kind: "xi",
      position: xiSlotPosition(assignedRole, slot),
      club_crest: scorer.club_crest ?? null,
      club_name: scorer.club_name ?? null,
      counts: true,
      auto_sub: autoSub,
      auto_sub_from: autoSub ? outgoing?.name ?? null : null,
      total: scored.total,
      role_bonus: scored.roleBonus,
      parts: scored.parts,
      match_live: clubHasInProgressMatch(clubMeta, afTeamId),
      upcoming: upcomingKickoffs(fixtures, afTeamId, nowMs),
    });

    if (includeBench && outgoing) {
      const outAfTeamId = clubAf.get(outgoing.club_id);
      const outFixtures = clubFx(outAfTeamId);
      const outScored = scorePlayerBreakdown(
        outgoing,
        assignedRole,
        outAfTeamId,
        stats,
        eventsByFixture,
        { clubFixtures: outFixtures },
      );
      satDown.push({
        id: outgoing.id,
        name: outgoing.name,
        kind: "bench",
        position: xiSlotPosition(assignedRole, slot),
        club_crest: outgoing.club_crest ?? null,
        club_name: outgoing.club_name ?? null,
        counts: false,
        auto_sub: false,
        auto_sub_out: true,
        auto_sub_for: scorer.name,
        total: outScored.total,
        role_bonus: outScored.roleBonus,
        parts: outScored.parts,
        match_live: clubHasInProgressMatch(clubMeta, outAfTeamId),
        upcoming: upcomingKickoffs(outFixtures, outAfTeamId, nowMs),
      });
    }
  }

  const benchPlayers: Top4LivePlayer[] = [];
  if (includeBench) {
    for (let bi = 0; bi < parsed.bench.length; bi++) {
      if (usedBench.has(bi)) continue;
      const id = parsed.bench[bi];
      if (!id) continue;
      const player = playersById.get(id);
      if (!player) continue;
      const role = parsed.benchRoles[bi] ?? null;
      const afTeamId = clubAf.get(player.club_id);
      const fixtures = clubFx(afTeamId);
      const scored = scorePlayerBreakdown(
        player,
        role,
        afTeamId,
        stats,
        eventsByFixture,
        { clubFixtures: fixtures },
      );
      benchPlayers.push({
        id: player.id,
        name: player.name,
        kind: "bench",
        position:
          role?.trim() || primaryRole(player) || (bi === 0 ? "GK" : null),
        club_crest: player.club_crest ?? null,
        club_name: player.club_name ?? null,
        counts: false,
        auto_sub: false,
        total: scored.total,
        role_bonus: scored.roleBonus,
        parts: scored.parts,
        match_live: clubHasInProgressMatch(clubMeta, afTeamId),
        upcoming: upcomingKickoffs(fixtures, afTeamId, nowMs),
      });
    }
  }

  return {
    total: round2(total),
    players: [...xiPlayers, ...satDown, ...benchPlayers],
  };
}

function scoreLineupGw(
  formation: FormationTemplate,
  parsed: ParsedLineupSlots,
  playersById: Map<string, PlayerRow>,
  clubAf: Map<string, number>,
  stats: AfGwStatRow[],
  clubMeta: Map<number, ClubGwMeta>,
  eventsByFixture: Map<number, AfMatchEvent[]>,
): number {
  return scoreLineupGwDetailed(
    formation,
    parsed,
    playersById,
    clubAf,
    stats,
    clubMeta,
    false,
    eventsByFixture,
  ).total;
}

function resolveGws(db: Database.Database): number[] {
  const currentGw = Math.max(1, gameweekFromKickoff(new Date()));
  const lineupMax = (
    db
      .prepare(
        `SELECT MAX(gw) AS m FROM top4_lineups WHERE gw >= ?`,
      )
      .get(RESULTS_MIN_GW) as { m: number | null } | undefined
  )?.m;
  const finishedMax = (
    db
      .prepare(
        `SELECT MAX(gameweek) AS m FROM fixtures
         WHERE season = ? AND gameweek >= ?
           AND status IN ('FT','AET','PEN')`,
      )
      .get(AF_SEASON, RESULTS_MIN_GW) as { m: number | null } | undefined
  )?.m;

  const maxGw = Math.max(
    RESULTS_MIN_GW,
    currentGw >= RESULTS_MIN_GW ? currentGw : RESULTS_MIN_GW,
    Number(lineupMax) || RESULTS_MIN_GW,
    Number(finishedMax) || RESULTS_MIN_GW,
  );
  const gws: number[] = [];
  for (let g = RESULTS_MIN_GW; g <= maxGw; g++) gws.push(g);
  return gws;
}

export function computeTop4Results(
  db: Database.Database,
): Omit<Top4ResultsPayload, "sync"> {
  ensureTop4GwResultsSchema(db);
  const gws = resolveGws(db);
  const currentGw = gameweekFromKickoff(new Date());
  const clubAf = loadClubAfMap(db);
  const squads = getTop4SquadsPublic(db);
  const regs = listTop4RegistrationsFull(db);
  const codeByEmail = new Map(
    regs.map((r) => [
      r.email.toLowerCase(),
      r.team_code?.trim()?.toUpperCase() || null,
    ]),
  );
  const nameByEmail = new Map(
    regs.map((r) => [
      r.email.toLowerCase(),
      r.team_name?.trim() || r.name || r.email,
    ]),
  );
  const logoByEmail = new Map(
    regs.map((r) => [
      r.email.toLowerCase(),
      r.logo_url?.trim() || null,
    ]),
  );

  const teamsSrc =
    squads.teams.length > 0
      ? squads.teams.map((t) => ({
          team_id: t.team_id,
          email: t.email,
          name:
            nameByEmail.get(String(t.email || "").toLowerCase()) ||
            t.team_name ||
            `Team ${t.team_id}`,
          code:
            codeByEmail.get(String(t.email || "").toLowerCase()) ||
            t.team_code ||
            null,
          logo_url:
            logoByEmail.get(String(t.email || "").toLowerCase()) ||
            t.logo_url ||
            null,
        }))
      : regs.map((r, i) => ({
          team_id: i + 1,
          email: r.email,
          name: r.team_name,
          code: r.team_code,
          logo_url: r.logo_url ?? null,
        }));

  // Prefer draft slot team_ids from lottery when available.
  const lineupTeamIds = (
    db.prepare(`SELECT DISTINCT team_id FROM top4_lineups`).all() as Array<{
      team_id: number;
    }>
  ).map((r) => r.team_id);

  const teams: Top4ResultsTeam[] = teamsSrc.map((t) => {
    const byGw: Record<string, number | null> = {};
    for (const gw of gws) byGw[String(gw)] = null;
    return {
      team_id: t.team_id,
      code: t.code ?? null,
      name: t.name,
      logo_url: t.logo_url ?? null,
      total: 0,
      byGw,
    };
  });

  // If squads empty but lineups exist, still show lineup teams.
  if (!teams.length && lineupTeamIds.length) {
    for (const id of lineupTeamIds) {
      teams.push({
        team_id: id,
        code: null,
        name: `Team ${id}`,
        logo_url: null,
        total: 0,
        byGw: Object.fromEntries(gws.map((g) => [String(g), null])),
      });
    }
  }

  const lineupStmt = db.prepare(
    `SELECT team_id, gw, formation, slots_json FROM top4_lineups
     WHERE gw >= ? AND gw <= ?`,
  );
  const lineupRows = lineupStmt.all(
    RESULTS_MIN_GW,
    gws[gws.length - 1] ?? RESULTS_MIN_GW,
  ) as Array<{
    team_id: number;
    gw: number;
    formation: string;
    slots_json: string;
  }>;

  const allPlayerIds = new Set<string>();
  const parsedByKey = new Map<
    string,
    { formation: FormationTemplate; parsed: ParsedLineupSlots }
  >();
  for (const row of lineupRows) {
    const formation =
      formationById(row.formation, FORMATIONS) ??
      FORMATIONS.find((f) => f.id === row.formation) ??
      null;
    if (!formation) continue;
    const parsed = parseSlotsJson(row.slots_json);
    parsedByKey.set(`${row.team_id}:${row.gw}`, { formation, parsed });
    for (const id of [...parsed.slots, ...parsed.bench]) {
      if (id) allPlayerIds.add(id);
    }
  }
  const playersById = loadPlayersById(db, [...allPlayerIds]);

  for (const gw of gws) {
    const stats = loadGwStats(db, gw);
    const eventsByFixture = loadGwEvents(db, gw);
    const clubMeta = loadClubGwMeta(db, gw);
    for (const team of teams) {
      const packed = parsedByKey.get(`${team.team_id}:${gw}`);
      if (!packed) {
        team.byGw[String(gw)] = null;
        continue;
      }
      const pts = scoreLineupGw(
        packed.formation,
        packed.parsed,
        playersById,
        clubAf,
        stats,
        clubMeta,
        eventsByFixture,
      );
      team.byGw[String(gw)] = pts;
    }
  }

  for (const team of teams) {
    let sum = 0;
    for (const gw of gws) {
      const v = team.byGw[String(gw)];
      if (typeof v === "number") sum += v;
    }
    team.total = round2(sum);
  }

  teams.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return String(a.code || a.name).localeCompare(String(b.code || b.name));
  });

  const notes = [
    `Очки с GW${RESULTS_MIN_GW}: сохранённый XI (+ автозамены) × FPTS × множитель турнира; +20% за идеальную позицию.`,
    "Нет сохранённого состава за GW → «·» (не 0). 0 = состав есть, очков нет / матчи ещё не сыграны.",
    "Учитываются только завершённые матчи scoped-турниров (чемпионаты, кубки, Европа, суперкубки). Товарищеские — нет.",
    `Текущий тур: GW${currentGw} (${gameweekRange(currentGw).label}).`,
  ];

  return {
    gws,
    current_gw: currentGw,
    teams,
    notes,
    multipliers: { ...COMP_MULTIPLIER },
  };
}

export async function buildTop4ResultsPayload(
  db: Database.Database,
  opts?: { syncLimit?: number },
): Promise<Top4ResultsPayload> {
  const sync = await syncFinishedGwFixtureStats(db, {
    limit: opts?.syncLimit ?? 20,
  });
  const base = computeTop4Results(db);
  return { ...base, sync };
}

type StandingTeamSrc = {
  team_id: number;
  email: string;
  name: string;
  code: string | null;
  logo_url: string | null;
};

function loadStandingTeamSources(db: Database.Database): StandingTeamSrc[] {
  const squads = getTop4SquadsPublic(db);
  const regs = listTop4RegistrationsFull(db);
  const codeByEmail = new Map(
    regs.map((r) => [
      r.email.toLowerCase(),
      r.team_code?.trim()?.toUpperCase() || null,
    ]),
  );
  const nameByEmail = new Map(
    regs.map((r) => [
      r.email.toLowerCase(),
      r.team_name?.trim() || r.name || r.email,
    ]),
  );
  const logoByEmail = new Map(
    regs.map((r) => [
      r.email.toLowerCase(),
      r.logo_url?.trim() || null,
    ]),
  );

  if (squads.teams.length > 0) {
    return squads.teams.map((t) => ({
      team_id: t.team_id,
      email: t.email,
      name:
        nameByEmail.get(String(t.email || "").toLowerCase()) ||
        t.team_name ||
        `Team ${t.team_id}`,
      code:
        codeByEmail.get(String(t.email || "").toLowerCase()) ||
        t.team_code ||
        null,
      logo_url:
        logoByEmail.get(String(t.email || "").toLowerCase()) ||
        t.logo_url ||
        null,
    }));
  }
  return regs.map((r, i) => ({
    team_id: i + 1,
    email: r.email,
    name: r.team_name,
    code: r.team_code ?? null,
    logo_url: r.logo_url ?? null,
  }));
}

function lineupFormation(
  formationId: string,
): FormationTemplate | null {
  return (
    formationById(formationId, FORMATIONS) ??
    FORMATIONS.find((f) => f.id === formationId) ??
    null
  );
}

/** XI + bench FPTS for one saved lineup in one GW (same math as results / live). */
export function computeTop4TeamGwResult(
  db: Database.Database,
  teamId: number,
  gw: number,
): Top4TeamGwResult | null {
  ensureTop4GwResultsSchema(db);
  if (!Number.isFinite(teamId) || teamId < 1) return null;
  if (!Number.isFinite(gw) || gw < RESULTS_MIN_GW || gw > 60) return null;

  let src = loadStandingTeamSources(db).find((t) => t.team_id === teamId);
  if (!src) {
    const hasLineup = db
      .prepare(`SELECT 1 AS ok FROM top4_lineups WHERE team_id = ? LIMIT 1`)
      .get(teamId) as { ok: number } | undefined;
    if (!hasLineup) return null;
    src = {
      team_id: teamId,
      email: "",
      name: `Team ${teamId}`,
      code: null,
      logo_url: null,
    };
  }

  const empty: Top4TeamGwResult = {
    team_id: src.team_id,
    code: src.code ?? null,
    name: src.name,
    logo_url: src.logo_url ?? null,
    total: null,
    players: [],
    gw,
    gw_label: gameweekRange(gw).label,
    formation: null,
  };

  const row = db
    .prepare(
      `SELECT formation, slots_json FROM top4_lineups WHERE team_id = ? AND gw = ?`,
    )
    .get(teamId, gw) as { formation: string; slots_json: string } | undefined;
  if (!row) return empty;

  const formation = lineupFormation(row.formation);
  if (!formation) return empty;

  const parsed = parseSlotsJson(row.slots_json);
  const ids = [...parsed.slots, ...parsed.bench].filter(
    (id): id is string => Boolean(id),
  );
  const playersById = loadPlayersById(db, ids);
  const scored = scoreLineupGwDetailed(
    formation,
    parsed,
    playersById,
    loadClubAfMap(db),
    loadGwStats(db, gw),
    loadClubGwMeta(db, gw),
    true,
    loadGwEvents(db, gw),
  );
  return {
    ...empty,
    formation: formation.id,
    total: scored.total,
    players: scored.players,
  };
}

/** Latest AF stats `synced_at` for this GW (fixture_sync or player_stats). */
function lastGwAfStatsSyncedAt(
  db: Database.Database,
  gw: number,
): string | null {
  const scoped = SCOPED_AF_LEAGUE_IDS.map(() => "?").join(",");
  const params = [AF_SEASON, gw, ...SCOPED_AF_LEAGUE_IDS];
  const row = db
    .prepare(
      `SELECT MAX(synced_at) AS synced_at FROM (
         SELECT s.synced_at
         FROM af_gw_fixture_sync s
         INNER JOIN fixtures f ON f.id = s.af_fixture_id
         WHERE f.season = ?
           AND f.gameweek = ?
           AND f.af_league_id IN (${scoped})
           AND ${excludeIgnoredFixturesWhere("f")}
         UNION ALL
         SELECT s.synced_at
         FROM af_gw_player_stats s
         INNER JOIN fixtures f ON f.id = s.af_fixture_id
         WHERE f.season = ?
           AND f.gameweek = ?
           AND f.af_league_id IN (${scoped})
           AND ${excludeIgnoredFixturesWhere("f")}
       ) t`,
    )
    .get(...params, ...params) as { synced_at: string | null } | undefined;
  const v = row?.synced_at;
  return v && String(v).trim() ? String(v) : null;
}

export function computeTop4LiveStanding(
  db: Database.Database,
): Omit<Top4LiveStandingPayload, "sync" | "synced_at"> {
  ensureTop4GwResultsSchema(db);
  const gw = Math.max(1, gameweekFromKickoff(new Date()));
  const clubAf = loadClubAfMap(db);
  let teamsSrc = loadStandingTeamSources(db);

  if (!teamsSrc.length) {
    const lineupTeamIds = (
      db.prepare(`SELECT DISTINCT team_id FROM top4_lineups`).all() as Array<{
        team_id: number;
      }>
    ).map((r) => r.team_id);
    teamsSrc = lineupTeamIds.map((id) => ({
      team_id: id,
      email: "",
      name: `Team ${id}`,
      code: null,
      logo_url: null,
    }));
  }

  const lineupRows = db
    .prepare(
      `SELECT team_id, formation, slots_json FROM top4_lineups WHERE gw = ?`,
    )
    .all(gw) as Array<{
    team_id: number;
    formation: string;
    slots_json: string;
  }>;

  const parsedByTeam = new Map<
    number,
    { formation: FormationTemplate; parsed: ParsedLineupSlots }
  >();
  const allPlayerIds = new Set<string>();
  for (const row of lineupRows) {
    const formation =
      formationById(row.formation, FORMATIONS) ??
      FORMATIONS.find((f) => f.id === row.formation) ??
      null;
    if (!formation) continue;
    const parsed = parseSlotsJson(row.slots_json);
    parsedByTeam.set(row.team_id, { formation, parsed });
    for (const id of [...parsed.slots, ...parsed.bench]) {
      if (id) allPlayerIds.add(id);
    }
  }
  const playersById = loadPlayersById(db, [...allPlayerIds]);
  const stats = loadGwStats(db, gw);
  const eventsByFixture = loadGwEvents(db, gw);
  const clubMeta = loadClubGwMeta(db, gw);

  const teams: Top4LiveTeam[] = teamsSrc.map((t) => {
    const packed = parsedByTeam.get(t.team_id);
    if (!packed) {
      return {
        team_id: t.team_id,
        code: t.code ?? null,
        name: t.name,
        logo_url: t.logo_url ?? null,
        total: null,
        players: [],
      };
    }
    const scored = scoreLineupGwDetailed(
      packed.formation,
      packed.parsed,
      playersById,
      clubAf,
      stats,
      clubMeta,
      true,
      eventsByFixture,
    );
    return {
      team_id: t.team_id,
      code: t.code ?? null,
      name: t.name,
      logo_url: t.logo_url ?? null,
      total: scored.total,
      players: scored.players,
    };
  });

  teams.sort((a, b) => {
    const av = a.total == null ? -Infinity : a.total;
    const bv = b.total == null ? -Infinity : b.total;
    if (bv !== av) return bv - av;
    return String(a.code || a.name).localeCompare(String(b.code || b.name));
  });

  return {
    gw,
    gw_label: gameweekRange(gw).label,
    current_gw: gw,
    teams,
    multipliers: { ...COMP_MULTIPLIER },
    updated_at: new Date().toISOString(),
  };
}

let liveSyncLock: Promise<{ fetched: number; pending: number }> | null = null;
let lastLiveSyncAt = 0;
let liveSyncSkipUntil = 0;
let lastLiveSync = { fetched: 0, pending: 0 };

/** Bypass 60s / quota backoff — refresh statuses + fetch live/FT stats now. */
export async function forceLiveGwStatsSync(
  db: Database.Database,
  opts?: { syncLimit?: number },
): Promise<{ fetched: number; pending: number }> {
  liveSyncSkipUntil = 0;
  lastLiveSyncAt = 0;
  ensureTop4GwResultsSchema(db);
  const gw = Math.max(1, gameweekFromKickoff(new Date()));
  const fixtures = listScopedFixtures(db, gw, gw);
  await refreshFixtureStatuses(db, fixtures, opts?.syncLimit ?? 80);
  const result = await syncGwFixtureStats(db, {
    gwMin: gw,
    gwMax: gw,
    includeLive: true,
    force: true,
    limit: opts?.syncLimit ?? 80,
  });
  lastLiveSync = result;
  lastLiveSyncAt = Date.now();
  return result;
}

/** Shared 60s AF live-stats throttle (live standing + index FP). */
export async function ensureLiveGwStatsSynced(
  db: Database.Database,
  opts?: { syncLimit?: number },
): Promise<{ fetched: number; pending: number }> {
  ensureTop4GwResultsSchema(db);
  const now = Date.now();
  const gw = Math.max(1, gameweekFromKickoff(new Date()));
  if (now < liveSyncSkipUntil) return lastLiveSync;
  if (now - lastLiveSyncAt < LIVE_SYNC_GAP_MS) return lastLiveSync;
  const pending =
    liveSyncLock ??
    (liveSyncLock = (async () => {
      const fixtures = listScopedFixtures(db, gw, gw);
      await refreshFixtureStatuses(db, fixtures, opts?.syncLimit ?? 20);
      return syncGwFixtureStats(db, {
        gwMin: gw,
        gwMax: gw,
        includeLive: true,
        limit: opts?.syncLimit ?? 20,
      });
    })().finally(() => {
      liveSyncLock = null;
    }));
  try {
    lastLiveSync = await pending;
    lastLiveSyncAt = Date.now();
  } catch (err) {
    lastLiveSyncAt = Date.now();
    if (afErrorIsQuota(err)) {
      liveSyncSkipUntil = Date.now() + LIVE_SYNC_QUOTA_BACKOFF_MS;
      console.warn(
        "AF live sync quota; backing off 15m:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  return lastLiveSync;
}

export async function buildTop4LiveStandingPayload(
  db: Database.Database,
  opts?: { syncLimit?: number },
): Promise<Top4LiveStandingPayload> {
  await ensureLiveGwStatsSynced(db, opts);
  const base = computeTop4LiveStanding(db);
  return {
    ...base,
    sync: lastLiveSync,
    synced_at: lastGwAfStatsSyncedAt(db, base.gw),
  };
}

/**
 * Season scored FPTS at the player's TM primary position (2026/27, GW2+).
 * Same live weights and competition multipliers as squad «Набрал», no ×1.2.
 */
export function computeIndexPrimaryFpByPlayerId(
  db: Database.Database,
  gw?: number,
): Map<string, number> {
  ensureTop4GwResultsSchema(db);
  const currentGw = Math.max(1, gameweekFromKickoff(new Date()));
  const gwMin = RESULTS_MIN_GW;
  const gwMax = gw ?? Math.max(currentGw, gwMin);
  const clubAf = loadClubAfMap(db);
  const stats = loadGwStatsRange(db, gwMin, gwMax);
  const eventsByFixture = loadGwEventsRange(db, gwMin, gwMax);
  const out = new Map<string, number>();
  if (!stats.length) return out;

  const afTeamsWithStats = new Set(stats.map((s) => s.af_team_id));
  const wantedClubs = new Set<string>();
  for (const [clubId, afId] of clubAf) {
    if (afTeamsWithStats.has(afId)) wantedClubs.add(clubId);
  }
  if (!wantedClubs.size) return out;

  const players = db
    .prepare(
      `SELECT p.id, p.name, p.club_id, p.position, p.detail_role, p.detail_label,
              p.side_role
       FROM players p`,
    )
    .all() as PlayerRow[];

  const statsByTeam = new Map<number, AfGwStatRow[]>();
  for (const s of stats) {
    const list = statsByTeam.get(s.af_team_id) ?? [];
    list.push(s);
    statsByTeam.set(s.af_team_id, list);
  }

  for (const player of players) {
    const clubId = String(player.club_id || "");
    if (!wantedClubs.has(clubId)) continue;
    const afTeamId = clubAf.get(clubId);
    if (afTeamId == null) continue;
    const teamStats = statsByTeam.get(afTeamId);
    if (!teamStats?.length) continue;
    const role = primaryRole(player);
    const scored = scorePlayerBreakdown(
      player,
      role,
      afTeamId,
      teamStats,
      eventsByFixture,
      { applyRoleBonus: false },
    );
    if (scored.total !== 0) out.set(String(player.id), scored.total);
  }
  return out;
}

let indexFpCache: {
  sig: string;
  map: Map<string, number>;
} | null = null;

function indexFpCacheSig(db: Database.Database, gw: number): string {
  const n = db
    .prepare(`SELECT COUNT(*) AS c FROM af_gw_player_stats`)
    .get() as { c: number };
  return `${gw}|${lastLiveSyncAt}|${n.c}`;
}

/** Cached season scored FPTS for the player index (GW2+ of the current season). */
export async function getIndexGwFpMap(
  db: Database.Database,
  opts?: { sync?: boolean; syncLimit?: number },
): Promise<{ gw: number; fp: Map<string, number> }> {
  const gw = Math.max(1, gameweekFromKickoff(new Date()));
  if (opts?.sync !== false) {
    await ensureLiveGwStatsSynced(db, { syncLimit: opts?.syncLimit ?? 20 });
  }
  const sig = indexFpCacheSig(db, gw);
  if (indexFpCache && indexFpCache.sig === sig) {
    return { gw, fp: indexFpCache.map };
  }
  const map = computeIndexPrimaryFpByPlayerId(db);
  indexFpCache = { sig, map };
  return { gw, fp: map };
}

export type SquadSeasonFpts = {
  /** Sum of XI-slot FPTS (slot line, ×1.2 if slot = TM primary). Bench excluded. */
  brought: number;
  /** Season scored FPTS at TM primary (multipliers, no ×1.2). Same as index FP. */
  scored: number;
};

let squadsFptsCache: {
  sig: string;
  map: Map<string, SquadSeasonFpts>;
} | null = null;

function squadsFptsCacheSig(db: Database.Database, gw: number): string {
  const stats = db
    .prepare(`SELECT COUNT(*) AS c FROM af_gw_player_stats`)
    .get() as { c: number };
  const lineups = db
    .prepare(
      `SELECT COUNT(*) AS c, COALESCE(MAX(updated_at), '') AS u
       FROM top4_lineups WHERE gw >= ?`,
    )
    .get(RESULTS_MIN_GW) as { c: number; u: string };
  return `${gw}|${lastLiveSyncAt}|${stats.c}|${lineups.c}|${lineups.u}`;
}

function squadSeasonGws(db: Database.Database): number[] {
  const currentGw = Math.max(1, gameweekFromKickoff(new Date()));
  const gws = resolvePlayedGws(db).filter((g) => g >= RESULTS_MIN_GW);
  if (currentGw >= RESULTS_MIN_GW && !gws.includes(currentGw)) gws.push(currentGw);
  gws.sort((a, b) => a - b);
  return gws;
}

/**
 * Season-to-date FPTS per drafted player (GW2+).
 * scored = index primary FP; brought = sum of starting-XI slot FPTS only.
 */
export function computeTop4SquadsSeasonFpts(
  db: Database.Database,
): Map<string, SquadSeasonFpts> {
  ensureTop4GwResultsSchema(db);
  const gw = Math.max(1, gameweekFromKickoff(new Date()));
  const sig = squadsFptsCacheSig(db, gw);
  if (squadsFptsCache && squadsFptsCache.sig === sig) {
    return squadsFptsCache.map;
  }

  const squads = getTop4SquadsPublic(db);
  const out = new Map<string, SquadSeasonFpts>();
  const rosterById = new Map<
    string,
    { name: string; club_id: string; club_name: string | null }
  >();
  for (const team of squads.teams) {
    for (const p of team.players) {
      const id = String(p.id);
      rosterById.set(id, {
        name: p.name,
        club_id: p.club_id,
        club_name: p.club_name || null,
      });
      out.set(id, { brought: 0, scored: 0 });
    }
  }

  if (!out.size) {
    squadsFptsCache = { sig, map: out };
    return out;
  }

  const scoredMap = computeIndexPrimaryFpByPlayerId(db);
  for (const [id, row] of out) {
    row.scored = round2(scoredMap.get(id) ?? 0);
  }

  const gws = squadSeasonGws(db);
  if (!out.size || !gws.length) {
    squadsFptsCache = { sig, map: out };
    return out;
  }

  const gwMin = gws[0];
  const gwMax = gws[gws.length - 1];
  const lineupRows = db
    .prepare(
      `SELECT team_id, gw, slots_json FROM top4_lineups
       WHERE gw >= ? AND gw <= ?`,
    )
    .all(gwMin, gwMax) as Array<{ team_id: number; gw: number; slots_json: string }>;
  const parsedByKey = new Map<string, ParsedLineupSlots>();
  for (const row of lineupRows) {
    parsedByKey.set(
      `${row.team_id}:${row.gw}`,
      parseSlotsJson(row.slots_json),
    );
  }

  const playerIds = [...out.keys()];
  const playersById = loadPlayersById(db, playerIds);
  const clubAf = loadClubAfMap(db);

  for (const gwId of gws) {
    const stats = loadGwStats(db, gwId);
    const eventsByFixture = loadGwEvents(db, gwId);
    const clubMeta = loadClubGwMeta(db, gwId);
    for (const team of squads.teams) {
      const parsed = parsedByKey.get(`${team.team_id}:${gwId}`);
      if (!parsed) continue;
      for (let i = 0; i < parsed.slots.length; i++) {
        const slotId = parsed.slots[i];
        if (slotId == null) continue;
        const id = String(slotId);
        const cur = out.get(id);
        if (!cur) continue;
        const roster = rosterById.get(id);
        const row = playersById.get(id);
        const player: PlayerRow = row ?? {
          id,
          name: roster?.name ?? id,
          club_id: roster?.club_id ?? "",
          position: null,
          detail_role: null,
          detail_label: null,
          side_role: null,
          club_crest: null,
          club_name: roster?.club_name ?? null,
        };
        const assignedRole = parsed.roles[i] ?? null;
        const afTeamId = clubAf.get(player.club_id);
        const clubFixtures =
          afTeamId != null ? clubMeta.get(afTeamId)?.fixtures ?? [] : [];
        const counted = scorePlayerBreakdown(
          player,
          assignedRole,
          afTeamId,
          stats,
          eventsByFixture,
          { clubFixtures },
        );
        cur.brought = round2(cur.brought + counted.total);
      }
    }
  }

  squadsFptsCache = { sig, map: out };
  return out;
}

export type Top4MySquadGwCell = {
  fpts: number;
  /** Counted toward team FPTS this GW (saved XI slot or auto-sub). */
  xi: boolean;
  role_bonus: boolean;
  parts: Top4LiveMatchPart[];
};

export type Top4MySquadPlayer = {
  id: string;
  name: string;
  position: string | null;
  club_crest: string | null;
  club_name: string | null;
  byGw: Record<string, Top4MySquadGwCell>;
  /** Sum of XI-week FPTS as counted for the team (slot ×1.2 when primary). */
  brought: number;
  /** Sum of GW FPTS with competition multipliers, without ×1.2. */
  scored: number;
};

export type Top4MySquadPayload = {
  team: {
    id: number;
    name: string;
    code: string | null;
    logo_url: string | null;
  };
  gws: number[];
  current_gw: number;
  players: Top4MySquadPlayer[];
};

/** Gameweeks that already have a finished scoped match — no empty future GWs. */
function resolvePlayedGws(db: Database.Database): number[] {
  ensureTop4GwResultsSchema(db);
  const scoped = SCOPED_AF_LEAGUE_IDS.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT DISTINCT f.gameweek AS gw FROM fixtures f
       WHERE f.season = ?
         AND f.gameweek IS NOT NULL
         AND f.gameweek >= 1
         AND f.af_league_id IN (${scoped})
         AND ${excludeIgnoredFixturesWhere("f")}
         AND UPPER(COALESCE(f.status, '')) IN ('FT','AET','PEN')
       ORDER BY f.gameweek ASC`,
    )
    .all(AF_SEASON, ...SCOPED_AF_LEAGUE_IDS) as Array<{ gw: number }>;
  const seen = new Set<number>();
  const gws: number[] = [];
  for (const row of rows) {
    const gw = Number(row.gw);
    if (!Number.isInteger(gw) || gw < 1 || seen.has(gw)) continue;
    seen.add(gw);
    gws.push(gw);
  }
  return gws;
}

function countedXiByPlayerId(
  formation: FormationTemplate,
  parsed: ParsedLineupSlots,
  playersById: Map<string, PlayerRow>,
  clubAf: Map<string, number>,
  stats: AfGwStatRow[],
  clubMeta: Map<number, ClubGwMeta>,
  eventsByFixture: Map<number, AfMatchEvent[]>,
): Map<string, Top4LivePlayer> {
  const scored = scoreLineupGwDetailed(
    formation,
    parsed,
    playersById,
    clubAf,
    stats,
    clubMeta,
    false,
    eventsByFixture,
  );
  const out = new Map<string, Top4LivePlayer>();
  for (const p of scored.players) {
    if (p.kind !== "xi" || p.counts === false) continue;
    out.set(String(p.id), p);
  }
  return out;
}

export function computeTop4MySquad(
  db: Database.Database,
  teamId: number,
): Top4MySquadPayload | null {
  ensureTop4GwResultsSchema(db);
  const squads = getTop4SquadsPublic(db);
  const team = squads.teams.find((t) => t.team_id === teamId);
  if (!team) return null;

  const roster = team.players.filter((p) => !p.replaced);
  const gws = resolvePlayedGws(db);
  const currentGw = Math.max(1, gameweekFromKickoff(new Date()));
  const clubAf = loadClubAfMap(db);
  const playerIds = roster.map((p) => String(p.id));

  const gwMin = gws[0] ?? 1;
  const gwMax = gws[gws.length - 1] ?? gwMin;
  const lineupRows = gws.length
    ? (db
        .prepare(
          `SELECT gw, formation, slots_json FROM top4_lineups
           WHERE team_id = ? AND gw >= ? AND gw <= ?`,
        )
        .all(teamId, gwMin, gwMax) as Array<{
        gw: number;
        formation: string;
        slots_json: string;
      }>)
    : [];
  const parsedByGw = new Map<
    number,
    { formation: FormationTemplate; parsed: ParsedLineupSlots }
  >();
  const lineupIds = new Set<string>(playerIds);
  for (const row of lineupRows) {
    const formation = lineupFormation(row.formation);
    if (!formation) continue;
    const parsed = parseSlotsJson(row.slots_json);
    parsedByGw.set(Number(row.gw), { formation, parsed });
    for (const id of [...parsed.slots, ...parsed.bench]) {
      if (id) lineupIds.add(id);
    }
  }
  const playersById = loadPlayersById(db, [...lineupIds]);

  const statsByGw = new Map<number, AfGwStatRow[]>();
  const eventsByGw = new Map<number, Map<number, AfMatchEvent[]>>();
  const clubMetaByGw = new Map<number, Map<number, ClubGwMeta>>();
  const countedByGw = new Map<number, Map<string, Top4LivePlayer>>();
  for (const gw of gws) {
    const stats = loadGwStats(db, gw);
    const eventsByFixture = loadGwEvents(db, gw);
    const clubMeta = loadClubGwMeta(db, gw);
    statsByGw.set(gw, stats);
    eventsByGw.set(gw, eventsByFixture);
    clubMetaByGw.set(gw, clubMeta);
    const packed = parsedByGw.get(gw);
    if (!packed) continue;
    countedByGw.set(
      gw,
      countedXiByPlayerId(
        packed.formation,
        packed.parsed,
        playersById,
        clubAf,
        stats,
        clubMeta,
        eventsByFixture,
      ),
    );
  }

  const players: Top4MySquadPlayer[] = roster.map((rp) => {
    const id = String(rp.id);
    const row = playersById.get(id);
    const byGw: Record<string, Top4MySquadGwCell> = {};
    let brought = 0;
    let scored = 0;
    const player: PlayerRow = row ?? {
      id,
      name: rp.name,
      club_id: rp.club_id,
      position: null,
      detail_role: null,
      detail_label: null,
      side_role: null,
      club_crest: null,
      club_name: rp.club_name || null,
    };

    for (const gw of gws) {
      const afTeamId = clubAf.get(player.club_id);
      const stats = statsByGw.get(gw) ?? [];
      const eventsByFixture = eventsByGw.get(gw) ?? new Map();
      const clubFixtures =
        afTeamId != null
          ? clubMetaByGw.get(gw)?.get(afTeamId)?.fixtures ?? []
          : [];
      const counted = countedByGw.get(gw)?.get(id) ?? null;
      const earned = scorePlayerBreakdown(
        player,
        primaryRole(player),
        afTeamId,
        stats,
        eventsByFixture,
        { applyRoleBonus: false, clubFixtures },
      );
      const cell: Top4MySquadGwCell = counted
        ? {
            fpts: counted.total,
            xi: true,
            role_bonus: counted.role_bonus,
            parts: counted.parts,
          }
        : {
            fpts: earned.total,
            xi: false,
            role_bonus: false,
            parts: earned.parts,
          };
      byGw[String(gw)] = cell;
      if (counted) brought += counted.total;
      scored += earned.total;
    }

    return {
      id,
      name: row?.name || rp.name,
      position: rp.position_display || primaryRole(player) || null,
      club_crest: row?.club_crest ?? null,
      club_name: row?.club_name || rp.club_name || null,
      byGw,
      brought: round2(brought),
      scored: round2(scored),
    };
  });

  return {
    team: {
      id: team.team_id,
      name: team.team_name,
      code: team.team_code ?? null,
      logo_url: team.logo_url ?? null,
    },
    gws,
    current_gw: currentGw,
    players,
  };
}

export async function buildTop4MySquadPayload(
  db: Database.Database,
  teamId: number,
  opts?: { syncLimit?: number },
): Promise<Top4MySquadPayload | null> {
  await syncFinishedGwFixtureStats(db, { limit: opts?.syncLimit ?? 25 });
  const gws = resolvePlayedGws(db);
  const currentGw = Math.max(1, gameweekFromKickoff(new Date()));
  if (gws.includes(currentGw)) {
    await ensureLiveGwStatsSynced(db, { syncLimit: opts?.syncLimit ?? 20 });
  }
  return computeTop4MySquad(db, teamId);
}
