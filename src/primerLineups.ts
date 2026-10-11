/**
 * Per-GW fantasy XI + bench selection for primer draft teams.
 *
 * Expected points (xPts) heuristic — transparent, not a full model:
 *  - No club fixture in the GW → xPts = 0 (only used if no alternative).
 *  - Club has 2+ fixtures in the GW (league + cups + Europe, etc.) → run the
 *    heuristic once per fixture and sum (appearance / goals / etc. additively).
 *  - Selected starters are assumed to play ≥60' → 2 appearance pts.
 *  - Rating factor r = clamp((fm_rating − 55) / 35, 0.05, 1).
 *  - Home ×1.10 on goals / assists / CS; away baseline.
 *  - Goals / assists / CS / conceded / cards / saves / pen save|miss scaled by
 *    fantasy line (GKP/DEF/MID/FWD) and exported scoring table weights.
 *  - Full-game bonus (+1) only for MID/FWD, rated by r.
 *  - Sub appearance (<60′) is in the table but not used here (starters ≥60′).
 *
 * XI: try each formation template, assign squad to slots maximizing Σ xPts.
 * Bench: next-best 7 among remaining by xPts, with exactly 1 GK.
 */
import { playerMatchesRoleFilter, type PlayerPositionFields } from "./positions.js";
import {
  FORMATIONS,
  primaryRole,
  type DraftPlayer,
  type FormationTemplate,
  type SlotRoles,
} from "./primerDraft.js";
import { formatHaOpponent } from "./clubCode.js";

export type FantasyLine = "GKP" | "DEF" | "MID" | "FWD";

export type ClubFixtureCtx = {
  isHome: boolean;
  /** Compact 3-letter (or derived) code for pitch chips. */
  opponent: string | null;
  /** Full fixture club name for pool / list UI. */
  opponentName?: string | null;
  /** API-Football competition id (for Top-4/Top-8 multipliers). */
  afLeagueId?: number | null;
};

/** club_id → gameweek → all fixtures that GW (league, cups, Europe, …). */
export type ClubGwFixtures = Map<string, Map<number, ClubFixtureCtx[]>>;

export type LineupSlotPlayer = {
  id: string;
  name: string;
  club_id: string;
  club_name: string;
  league_id: string;
  league_name: string;
  position_display: string;
  fm_rating: number;
  market_value_eur: number;
  wage_pw: number;
  portrait_url: string | null;
  fantasy_line: FantasyLine;
  xPts: number;
  is_home: boolean | null;
  opponent: string | null;
  slot_roles?: readonly string[];
};

export type GwLineup = {
  gw: number;
  formation: string;
  formation_label: string;
  xi: LineupSlotPlayer[];
  bench: LineupSlotPlayer[];
  xPtsTotal: number;
};

export const FANTASY_LINE_BY_ROLE: Record<string, FantasyLine> = {
  GK: "GKP",
  LB: "DEF",
  CB: "DEF",
  RB: "DEF",
  LWB: "DEF",
  RWB: "DEF",
  DEF: "DEF",
  DM: "MID",
  CM: "MID",
  AM: "MID",
  LM: "MID",
  RM: "MID",
  MID: "MID",
  LW: "FWD",
  RW: "FWD",
  SS: "FWD",
  CF: "FWD",
  ATT: "FWD",
};

/** Fantasy line from an assigned / matched TM role (GK, CB, CM, …). */
export function fantasyLineFromRole(
  role: string | null | undefined,
): FantasyLine {
  const r = String(role || "")
    .trim()
    .toUpperCase();
  if (r && FANTASY_LINE_BY_ROLE[r]) return FANTASY_LINE_BY_ROLE[r];
  return "MID";
}

/** Official FPTS weights by fantasy line (empty = 0 / N/A). */
export const APPEARANCE_60_PTS = 2;
export const APPEARANCE_SUB_PTS = 1;
export const FULL_GAME_PTS: Record<FantasyLine, number> = {
  GKP: 0,
  DEF: 0,
  MID: 1,
  FWD: 1,
};
export const GOAL_PTS: Record<FantasyLine, number> = {
  GKP: 6,
  DEF: 6,
  MID: 5,
  FWD: 4,
};
export const ASSIST_PTS = 3;
export const CS_PTS: Record<FantasyLine, number> = {
  GKP: 4,
  DEF: 4,
  MID: 1,
  FWD: 0,
};
export const PENALTY_SAVE_PTS = 5;
export const SAVES_PER_POINT = 3;
export const PENALTY_MISS_PTS = -2;
export const GOALS_CONCEDED_PER_POINT = 2;
export const YELLOW_CARD_PTS = -1;
export const RED_CARD_PTS = -3;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function fantasyLine(p: PlayerPositionFields): FantasyLine {
  const role = primaryRole(p);
  if (role && FANTASY_LINE_BY_ROLE[role]) return FANTASY_LINE_BY_ROLE[role];
  return "MID";
}

function playerMatchesSlot(p: PlayerPositionFields, slot: SlotRoles): boolean {
  return slot.some((role) => playerMatchesRoleFilter(p, role));
}

function isGk(p: PlayerPositionFields): boolean {
  return fantasyLine(p) === "GKP" || primaryRole(p) === "GK";
}

/**
 * Expected fantasy points if the player starts and plays ≥60' in one fixture.
 * Returns 0 when fixture is missing.
 */
export function estimateXPts(
  player: DraftPlayer,
  fixture: ClubFixtureCtx | null | undefined,
): number {
  if (!fixture) return 0;

  const line = fantasyLine(player);
  const r = clamp((player.fm_rating - 55) / 35, 0.05, 1);
  const homeMul = fixture.isHome ? 1.1 : 1.0;

  // Appearance ≥60' (starters assumed to clear the threshold)
  let pts = APPEARANCE_60_PTS;

  // Full-game bonus (MID/FWD only)
  if (FULL_GAME_PTS[line] > 0) {
    pts += (0.5 + 0.4 * r) * FULL_GAME_PTS[line];
  }

  // Goals
  const goalRateBase =
    line === "FWD" ? 0.28 : line === "MID" ? 0.14 : line === "DEF" ? 0.04 : 0.01;
  pts += goalRateBase * r * homeMul * GOAL_PTS[line];

  // Assists
  const assistRateBase =
    line === "FWD" ? 0.12 : line === "MID" ? 0.16 : line === "DEF" ? 0.06 : 0.01;
  pts += assistRateBase * r * homeMul * ASSIST_PTS;

  // Clean sheet
  const csBase = line === "GKP" || line === "DEF" ? 0.32 : line === "MID" ? 0.28 : 0;
  pts += csBase * (0.55 + 0.45 * r) * homeMul * CS_PTS[line];

  // GKP saves: every SAVES_PER_POINT ≈ 1 pt; expect ~2–4 saves
  if (line === "GKP") {
    pts += (2.2 + 1.2 * r) / SAVES_PER_POINT;
    // Rare penalty save
    pts += 0.03 * PENALTY_SAVE_PTS;
  }

  // Conceded: −1 every GOALS_CONCEDED_PER_POINT (GKP/DEF)
  if (line === "GKP" || line === "DEF") {
    const goalsAgainst = (1.4 - 0.35 * r) * (fixture.isHome ? 0.9 : 1.1);
    pts -= goalsAgainst / GOALS_CONCEDED_PER_POINT;
  }

  // Cards + rare penalty miss (weights from scoring table)
  const ycRate = 0.12 + 0.06 * (1 - r);
  const rcRate = 0.012 + 0.008 * (1 - r);
  pts += ycRate * YELLOW_CARD_PTS + rcRate * RED_CARD_PTS;
  pts += 0.015 * PENALTY_MISS_PTS;

  return Math.round(pts * 100) / 100;
}

/**
 * Sum per-fixture xPts across all club matches in the GW.
 * Optional `fixtureMultiplier` applies a competition coefficient per fixture
 * (Top-4 / Top-8 season scoring) before summing.
 */
export function estimateXPtsForGw(
  player: DraftPlayer,
  fixtures: readonly ClubFixtureCtx[] | null | undefined,
  fixtureMultiplier?: (fx: ClubFixtureCtx) => number,
): number {
  if (!fixtures || fixtures.length === 0) return 0;
  let total = 0;
  for (const fx of fixtures) {
    const raw = estimateXPts(player, fx);
    const mult = fixtureMultiplier ? fixtureMultiplier(fx) : 1;
    total += raw * mult;
  }
  return Math.round(total * 100) / 100;
}

function fixtureDisplay(
  fixtures: readonly ClubFixtureCtx[],
): { is_home: boolean | null; opponent: string | null } {
  if (fixtures.length === 0) return { is_home: null, opponent: null };
  if (fixtures.length === 1) {
    return { is_home: fixtures[0].isHome, opponent: fixtures[0].opponent };
  }
  // Multi-match: encode all venues in opponent; UI shows the string as-is.
  const label = fixtures
    .map((fx) => formatHaOpponent(fx.isHome, fx.opponent))
    .join(" / ");
  return { is_home: null, opponent: label };
}

type ScoredPlayer = DraftPlayer & {
  xPts: number;
  is_home: boolean | null;
  opponent: string | null;
  fantasy_line: FantasyLine;
};

function toLineupPlayer(
  p: ScoredPlayer,
  slotRoles?: readonly string[],
): LineupSlotPlayer {
  return {
    id: p.id,
    name: p.name,
    club_id: p.club_id,
    club_name: p.club_name,
    league_id: p.league_id,
    league_name: p.league_name,
    position_display: p.position_display,
    fm_rating: p.fm_rating,
    market_value_eur: p.market_value_eur,
    wage_pw: p.wage_pw,
    portrait_url: p.portrait_url,
    fantasy_line: p.fantasy_line,
    xPts: p.xPts,
    is_home: p.is_home,
    opponent: p.opponent,
    ...(slotRoles ? { slot_roles: slotRoles } : {}),
  };
}

/** Max-score assignment of players to formation slots (branch & bound). */
function bestFormationXi(
  players: ScoredPlayer[],
  formation: FormationTemplate,
): { indices: number[]; score: number } | null {
  const slots = formation.slots;
  const candidates = slots.map((slot) => {
    const idxs: number[] = [];
    for (let i = 0; i < players.length; i++) {
      if (playerMatchesSlot(players[i], slot)) idxs.push(i);
    }
    // Prefer higher xPts first (helps find good solutions early).
    idxs.sort((a, b) => players[b].xPts - players[a].xPts);
    return idxs;
  });

  if (candidates.some((c) => c.length === 0)) return null;

  const order = slots
    .map((_, i) => i)
    .sort((a, b) => candidates[a].length - candidates[b].length);

  const used = new Array<boolean>(players.length).fill(false);
  const assignment = new Array<number>(slots.length).fill(-1);
  let bestScore = -Infinity;
  let bestAssign: number[] | null = null;

  // Upper bound: for unassigned slots, take best unused candidate (optimistic, may double-count).
  function upperBound(k: number, current: number): number {
    let bound = current;
    const taken = new Set<number>();
    for (let i = 0; i < players.length; i++) {
      if (used[i]) taken.add(i);
    }
    for (let t = k; t < order.length; t++) {
      const si = order[t];
      let best = -Infinity;
      for (const pi of candidates[si]) {
        if (taken.has(pi)) continue;
        best = Math.max(best, players[pi].xPts);
      }
      if (best === -Infinity) return -Infinity;
      bound += best;
      // Don't mark taken — optimistic bound allows reuse, still valid upper.
    }
    return bound;
  }

  function solve(k: number, current: number): void {
    if (k === order.length) {
      if (current > bestScore) {
        bestScore = current;
        bestAssign = assignment.slice();
      }
      return;
    }
    if (upperBound(k, current) <= bestScore) return;

    const si = order[k];
    for (const pi of candidates[si]) {
      if (used[pi]) continue;
      used[pi] = true;
      assignment[si] = pi;
      solve(k + 1, current + players[pi].xPts);
      used[pi] = false;
      assignment[si] = -1;
    }
  }

  solve(0, 0);
  if (!bestAssign) return null;
  return { indices: bestAssign, score: bestScore };
}

function pickBench(remaining: ScoredPlayer[]): ScoredPlayer[] {
  const gks = remaining.filter(isGk).sort((a, b) => b.xPts - a.xPts);
  const outfield = remaining.filter((p) => !isGk(p)).sort((a, b) => b.xPts - a.xPts);

  const bench: ScoredPlayer[] = [];
  if (gks.length > 0) bench.push(gks[0]);

  for (const p of outfield) {
    if (bench.length >= 7) break;
    bench.push(p);
  }

  // If no GK available, fill with best remaining (should be rare).
  if (bench.length < 7) {
    const used = new Set(bench.map((p) => p.id));
    for (const p of remaining.sort((a, b) => b.xPts - a.xPts)) {
      if (used.has(p.id)) continue;
      bench.push(p);
      if (bench.length >= 7) break;
    }
  }

  return bench.slice(0, 7);
}

export function scoreSquadForGw(
  players: DraftPlayer[],
  gw: number,
  clubFixtures: ClubGwFixtures,
): ScoredPlayer[] {
  return players.map((p) => {
    const fixtures = clubFixtures.get(p.club_id)?.get(gw) ?? [];
    const display = fixtureDisplay(fixtures);
    return {
      ...p,
      xPts: estimateXPtsForGw(p, fixtures),
      is_home: display.is_home,
      opponent: display.opponent,
      fantasy_line: fantasyLine(p),
    };
  });
}

export function pickGwLineup(
  players: DraftPlayer[],
  gw: number,
  clubFixtures: ClubGwFixtures,
  formations: readonly FormationTemplate[] = FORMATIONS,
): GwLineup | null {
  const scored = scoreSquadForGw(players, gw, clubFixtures);

  let best: {
    formation: FormationTemplate;
    indices: number[];
    score: number;
  } | null = null;

  for (const formation of formations) {
    const result = bestFormationXi(scored, formation);
    if (!result) continue;
    if (!best || result.score > best.score) {
      best = { formation, indices: result.indices, score: result.score };
    }
  }

  if (!best) return null;

  const used = new Set(best.indices);
  const xi = best.indices.map((pi, slotIdx) =>
    toLineupPlayer(scored[pi], best!.formation.slots[slotIdx]),
  );
  const remaining = scored.filter((_, i) => !used.has(i));
  const bench = pickBench(remaining).map((p) => toLineupPlayer(p));

  return {
    gw,
    formation: best.formation.id,
    formation_label: best.formation.label,
    xi,
    bench,
    xPtsTotal: Math.round(best.score * 100) / 100,
  };
}

export function buildTeamGameweeks(
  players: DraftPlayer[],
  gameweeks: number[],
  clubFixtures: ClubGwFixtures,
): GwLineup[] {
  const out: GwLineup[] = [];
  for (const gw of gameweeks) {
    const lineup = pickGwLineup(players, gw, clubFixtures);
    if (lineup) out.push(lineup);
  }
  return out;
}

/** Append a club fixture into club → gw → fixtures[] map. */
export function ingestFixtureRow(
  map: ClubGwFixtures,
  clubId: string | null | undefined,
  gw: number,
  isHome: boolean,
  opponent: string | null,
  opponentName?: string | null,
  afLeagueId?: number | null,
): void {
  if (!clubId || !Number.isFinite(gw) || gw < 1) return;
  let byGw = map.get(clubId);
  if (!byGw) {
    byGw = new Map();
    map.set(clubId, byGw);
  }
  let list = byGw.get(gw);
  if (!list) {
    list = [];
    byGw.set(gw, list);
  }
  list.push({
    isHome,
    opponent,
    opponentName: opponentName ?? null,
    afLeagueId: afLeagueId ?? null,
  });
}
