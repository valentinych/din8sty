import {
  collectPlayerRoles,
  playerMatchesRoleFilter,
  type PlayerPositionFields,
  type PositionGroup,
} from "./positions.js";
import { QUOTA_POOL, TOP8_IDS, type LeagueId } from "./leagues.js";
import {
  compareRatingWageMv,
  type PeerRow,
  withTrustedWageAsWagePw,
} from "./trustedWage.js";

export const MV_CAP = 900_000_000;
export const WAGE_CAP = 3_500_000;
export const TEAM_COUNT = 16;
export const ROUNDS = 26;
export const MIN_PER_LEAGUE = 3;
export const MAX_PER_CLUB = 3;
export const MIN_GK = 3;
/** Safety cap on optional post-26 snake rounds. */
export const MAX_EXTRA_ROUNDS = 20;

export type DraftConfig = {
  teamCount: number;
  rounds: number;
  mvCap: number;
  wageCap: number;
  minPerLeague: number;
  maxPerClub: number;
  minGk: number;
  maxExtraRounds: number;
  leagueIds: readonly string[];
  reserveMv: number;
  reserveWage: number;
};

export const PRIMER_DRAFT_CONFIG: DraftConfig = {
  teamCount: TEAM_COUNT,
  rounds: ROUNDS,
  mvCap: MV_CAP,
  wageCap: WAGE_CAP,
  minPerLeague: MIN_PER_LEAGUE,
  maxPerClub: MAX_PER_CLUB,
  minGk: MIN_GK,
  maxExtraRounds: MAX_EXTRA_ROUNDS,
  leagueIds: TOP8_IDS,
  reserveMv: 4_000_000,
  reserveWage: 55_000,
};

/** Active config for the current `runPrimerDraft` call (defaults to primer). */
let activeDraftConfig: DraftConfig = PRIMER_DRAFT_CONFIG;

function cfg(): DraftConfig {
  return activeDraftConfig;
}

/** Celestial body names for the 16 primer draft teams (stable order). */
export const CELESTIAL_TEAM_NAMES: readonly string[] = [
  "Сатурн",
  "Марс",
  "Венера",
  "Церера",
  "Юпитер",
  "Нептун",
  "Уран",
  "Меркурий",
  "Плутон",
  "Европа",
  "Титан",
  "Ио",
  "Каллисто",
  "Ганимед",
  "Луна",
  "Солнце",
] as const;

/**
 * Reserve budget for remaining picks.
 * Quota-pool average wage is below €3.5M/26; reserves still force a mix of
 * stars + cheaper squad players. Values live on DraftConfig.reserveMv/Wage.
 */

export type SlotRoles = readonly string[];

export type FormationTemplate = {
  id: string;
  label: string;
  slots: readonly SlotRoles[];
};

/** Matchday XI templates from screenshot, mapped to Din8sty/TM roles. */
export const FORMATIONS: readonly FormationTemplate[] = [
  {
    id: "4-4-2",
    label: "4-4-2 / 4-2-4",
    slots: [
      ["GK"],
      ["LB"],
      ["CB"],
      ["CB"],
      ["RB"],
      ["LM", "LW"],
      ["DM", "CM", "AM"],
      ["DM", "CM"],
      ["RM", "RW"],
      ["SS"],
      ["CF"],
    ],
  },
  {
    id: "4-5-1",
    label: "4-5-1 / 4-3-3",
    slots: [
      ["GK"],
      ["LB"],
      ["CB"],
      ["CB"],
      ["RB"],
      ["LM", "LW"],
      ["CM", "AM"],
      ["DM", "CM"],
      ["DM", "CM"],
      ["RM", "RW"],
      ["CF"],
    ],
  },
  {
    // 3 CB + LM/RM wings; toggle drops LM→LB / RM→RB → 5-3-2
    id: "3-5-2",
    label: "3-5-2 / 5-3-2",
    slots: [
      ["GK"],
      ["CB"],
      ["CB"],
      ["CB"],
      ["LM", "LB"],
      ["CM", "AM"],
      ["DM", "CM"],
      ["DM", "CM"],
      ["RM", "RB"],
      ["SS"],
      ["CF"],
    ],
  },
  {
    // 3 CB + LM/RM wings; toggle drops LM→LB / RM→RB → 5-2-3
    id: "3-4-3",
    label: "3-4-3 / 5-2-3",
    slots: [
      ["GK"],
      ["CB"],
      ["CB"],
      ["CB"],
      ["LM", "LB"],
      ["DM", "CM", "AM"],
      ["DM", "CM"],
      ["RM", "RB"],
      ["LW"],
      ["RW"],
      ["CF"],
    ],
  },
  {
    // From 5-2-3: drop LW→LM / RW→RM → 5 DEF + 4 MID + 1 ST
    id: "5-4-1",
    label: "5-4-1",
    slots: [
      ["GK"],
      ["LB"],
      ["CB"],
      ["CB"],
      ["CB"],
      ["RB"],
      ["LM", "LW"],
      ["DM", "CM", "AM"],
      ["DM", "CM"],
      ["RM", "RW"],
      ["CF"],
    ],
  },
];

/** Target roster shape for 26 so all templates stay viable (≥3 GK). */
export const TARGET_GROUPS: Record<PositionGroup, number> = {
  GK: 3,
  DEF: 8,
  MID: 9,
  ATT: 6,
};

/** Soft minimums by specific role (greedy coverage). */
const ROLE_TARGETS: Record<string, number> = {
  GK: 3,
  LB: 1,
  RB: 1,
  CB: 4,
  LM: 1,
  RM: 1,
  DM: 2,
  CM: 2,
  AM: 1,
  LW: 1,
  RW: 1,
  SS: 1,
  CF: 2,
};

const ROLE_TO_GROUP: Record<string, PositionGroup> = {
  GK: "GK",
  LB: "DEF",
  CB: "DEF",
  RB: "DEF",
  LWB: "DEF",
  RWB: "DEF",
  DM: "MID",
  CM: "MID",
  AM: "MID",
  LM: "MID",
  RM: "MID",
  LW: "ATT",
  RW: "ATT",
  SS: "ATT",
  CF: "ATT",
};

export type DraftPlayer = PlayerPositionFields & {
  id: string;
  name: string;
  club_id: string;
  club_name: string;
  league_id: string;
  league_name: string;
  fm_rating: number;
  market_value_eur: number;
  wage_pw: number;
  position_display: string;
  portrait_url: string | null;
};

export type TeamState = {
  id: number;
  name: string;
  players: DraftPlayer[];
  sum_market_value_eur: number;
  sum_wage_pw: number;
};

export type UnselectedPlayer = {
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
};

function normRole(value: string): string {
  const n = value.trim().toUpperCase();
  return n === "ST" ? "CF" : n;
}

export function primaryRole(p: PlayerPositionFields): string | null {
  const main = p.detail_role?.trim() || p.detail_label?.trim() || p.position?.trim();
  return main ? normRole(main) : null;
}

export function primaryGroup(p: PlayerPositionFields): PositionGroup | null {
  const role = primaryRole(p);
  if (!role) return null;
  if (role === "GK" || role === "DEF" || role === "MID" || role === "ATT") {
    return role;
  }
  return ROLE_TO_GROUP[role] ?? null;
}

export function isGoalkeeper(p: PlayerPositionFields): boolean {
  return primaryGroup(p) === "GK" || primaryRole(p) === "GK";
}

function playerMatchesSlot(p: PlayerPositionFields, slot: SlotRoles): boolean {
  return slot.some((role) => playerMatchesRoleFilter(p, role));
}

/** True if squad can field this XI (each player used at most once). */
export function canFieldFormation(
  players: PlayerPositionFields[],
  formation: FormationTemplate,
): boolean {
  const slots = formation.slots;
  const candidates = slots.map((slot) => {
    const idxs: number[] = [];
    for (let i = 0; i < players.length; i++) {
      if (playerMatchesSlot(players[i], slot)) idxs.push(i);
    }
    return idxs;
  });

  // Fail fast if any slot has no candidate.
  if (candidates.some((c) => c.length === 0)) return false;

  const order = slots
    .map((_, i) => i)
    .sort((a, b) => candidates[a].length - candidates[b].length);

  const used = new Array<boolean>(players.length).fill(false);

  function solve(k: number): boolean {
    if (k === order.length) return true;
    const si = order[k];
    for (const pi of candidates[si]) {
      if (used[pi]) continue;
      used[pi] = true;
      if (solve(k + 1)) return true;
      used[pi] = false;
    }
    return false;
  }

  return solve(0);
}

export function fieldableFormations(players: PlayerPositionFields[]): string[] {
  return FORMATIONS.filter((f) => canFieldFormation(players, f)).map((f) => f.label);
}

function groupCounts(players: PlayerPositionFields[]): Record<PositionGroup, number> {
  const counts: Record<PositionGroup, number> = { GK: 0, DEF: 0, MID: 0, ATT: 0 };
  for (const p of players) {
    const g = primaryGroup(p);
    if (g) counts[g] += 1;
  }
  return counts;
}

function roleCounts(players: PlayerPositionFields[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of players) {
    const role = primaryRole(p);
    if (!role) continue;
    counts[role] = (counts[role] ?? 0) + 1;
  }
  return counts;
}

function leagueCounts(players: DraftPlayer[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of players) {
    counts[p.league_id] = (counts[p.league_id] ?? 0) + 1;
  }
  return counts;
}

function clubCounts(players: DraftPlayer[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of players) {
    if (!p.club_id) continue;
    counts[p.club_id] = (counts[p.club_id] ?? 0) + 1;
  }
  return counts;
}

function leagueNeedAfter(players: DraftPlayer[], add?: DraftPlayer): number {
  const counts = leagueCounts(players);
  if (add) counts[add.league_id] = (counts[add.league_id] ?? 0) + 1;
  let need = 0;
  const c = cfg();
  for (const id of c.leagueIds) {
    need += Math.max(0, c.minPerLeague - (counts[id] ?? 0));
  }
  return need;
}

function gkNeedAfter(players: DraftPlayer[], add?: DraftPlayer): number {
  let have = players.filter(isGoalkeeper).length;
  if (add && isGoalkeeper(add)) have += 1;
  return Math.max(0, cfg().minGk - have);
}

function maxClubAfter(players: DraftPlayer[], add: DraftPlayer): number {
  const counts = clubCounts(players);
  const n = (counts[add.club_id] ?? 0) + 1;
  return n;
}

function affordable(
  team: TeamState,
  player: DraftPlayer,
  remainingAfterPick: number,
): boolean {
  const c = cfg();
  const mvLeft = c.mvCap - team.sum_market_value_eur - player.market_value_eur;
  const wageLeft = c.wageCap - team.sum_wage_pw - player.wage_pw;
  if (mvLeft < 0 || wageLeft < 0) return false;
  if (remainingAfterPick <= 0) return true;
  return (
    mvLeft >= remainingAfterPick * c.reserveMv &&
    wageLeft >= remainingAfterPick * c.reserveWage
  );
}

function affordableLoose(team: TeamState, player: DraftPlayer): boolean {
  const c = cfg();
  return (
    team.sum_market_value_eur + player.market_value_eur <= c.mvCap &&
    team.sum_wage_pw + player.wage_pw <= c.wageCap
  );
}

/**
 * Hard constraints: club ≤3, and (during base 26) remaining picks must still
 * be able to hit ≥3/league and ≥3 GK.
 */
function eligible(
  team: TeamState,
  player: DraftPlayer,
  remainingAfterPick: number,
  enforceRosterMins: boolean,
): boolean {
  if (maxClubAfter(team.players, player) > cfg().maxPerClub) return false;
  if (!enforceRosterMins) return true;
  const leagueNeed = leagueNeedAfter(team.players, player);
  const gkNeed = gkNeedAfter(team.players, player);
  return remainingAfterPick >= leagueNeed && remainingAfterPick >= gkNeed;
}

/** Higher = more needed for formation coverage + roster shape + hard mins. */
function needScore(team: TeamState, player: DraftPlayer): number {
  const c = cfg();
  const picksLeftIncluding = Math.max(1, c.rounds - team.players.length);
  const groups = groupCounts(team.players);
  const roles = roleCounts(team.players);
  const leagues = leagueCounts(team.players);
  const g = primaryGroup(player);
  const role = primaryRole(player);

  let score = 0;

  // Hard league minimums — urgent when picks are tight.
  const haveLeague = leagues[player.league_id] ?? 0;
  const leagueDeficit = c.minPerLeague - haveLeague;
  if (leagueDeficit > 0) {
    const totalLeagueNeed = leagueNeedAfter(team.players);
    score += 2000 + leagueDeficit * 200;
    if (picksLeftIncluding <= totalLeagueNeed + 1) score += 1500;
  }

  // Hard GK minimum.
  const gkHave = team.players.filter(isGoalkeeper).length;
  if (isGoalkeeper(player) && gkHave < c.minGk) {
    score += 2500 + (c.minGk - gkHave) * 300;
    if (picksLeftIncluding <= gkNeedAfter(team.players) + 1) score += 1500;
  } else if (!isGoalkeeper(player) && gkHave < c.minGk) {
    // Mild penalty so we don't burn late slots on outfield while GK lag.
    const gkNeed = gkNeedAfter(team.players);
    if (picksLeftIncluding <= gkNeed + leagueNeedAfter(team.players)) {
      score -= 800;
    }
  }

  if (g) {
    const target = TARGET_GROUPS[g];
    const have = groups[g];
    const deficit = target - have;
    if (deficit > 0) {
      score += 1000 + deficit * 100;
      const otherNeed = (Object.keys(TARGET_GROUPS) as PositionGroup[])
        .filter((k) => k !== g)
        .reduce((s, k) => s + Math.max(0, TARGET_GROUPS[k] - groups[k]), 0);
      if (picksLeftIncluding <= deficit + otherNeed) score += 500;
    } else {
      score -= 200 + (have - target) * 50;
    }
  }

  if (role) {
    const target = ROLE_TARGETS[role] ?? 0;
    const have = roles[role] ?? 0;
    if (target > 0 && have < target) {
      score += 300 + (target - have) * 80;
    }

    const allRoles = collectPlayerRoles(player);
    for (const r of allRoles) {
      const t = ROLE_TARGETS[r] ?? 0;
      const h = roles[r] ?? 0;
      if (t > 0 && h < t) score += 40;
    }
  }

  return score;
}

function isBetterPick(
  cand: DraftPlayer,
  need: number,
  best: DraftPlayer | null,
  bestNeed: number,
): boolean {
  if (!best) return true;
  if (need !== bestNeed) return need > bestNeed;
  if (cand.fm_rating !== best.fm_rating) return cand.fm_rating > best.fm_rating;
  // Rating ties: lean cheaper so late rounds stay fillable under the wage cap.
  if (cand.wage_pw !== best.wage_pw) return cand.wage_pw < best.wage_pw;
  return cand.market_value_eur < best.market_value_eur;
}

function pickBest(
  team: TeamState,
  pool: DraftPlayer[],
  remainingAfterPick: number,
  mode: "paced" | "loose" | "cheapest",
  enforceRosterMins: boolean,
): DraftPlayer | null {
  const canAfford =
    mode === "loose" || mode === "cheapest"
      ? (p: DraftPlayer) => affordableLoose(team, p)
      : (p: DraftPlayer) => affordable(team, p, remainingAfterPick);

  let best: DraftPlayer | null = null;
  let bestNeed = -Infinity;

  for (const p of pool) {
    if (!canAfford(p)) continue;
    if (!eligible(team, p, remainingAfterPick, enforceRosterMins)) continue;
    const need = needScore(team, p);
    if (mode === "cheapest") {
      if (
        !best ||
        need > bestNeed ||
        (need === bestNeed &&
          (p.wage_pw < best.wage_pw ||
            (p.wage_pw === best.wage_pw && p.market_value_eur < best.market_value_eur) ||
            (p.wage_pw === best.wage_pw &&
              p.market_value_eur === best.market_value_eur &&
              p.fm_rating > best.fm_rating)))
      ) {
        best = p;
        bestNeed = need;
      }
      continue;
    }
    if (isBetterPick(p, need, best, bestNeed)) {
      best = p;
      bestNeed = need;
    }
  }
  return best;
}

export function choosePick(
  team: TeamState,
  availablePrimary: DraftPlayer[],
  availableAll: DraftPlayer[],
  remainingAfter: number,
  enforceRosterMins: boolean,
): DraftPlayer | null {
  return (
    pickBest(team, availablePrimary, remainingAfter, "paced", enforceRosterMins) ??
    pickBest(team, availablePrimary, remainingAfter, "loose", enforceRosterMins) ??
    pickBest(team, availablePrimary, remainingAfter, "cheapest", enforceRosterMins) ??
    pickBest(team, availableAll, remainingAfter, "paced", enforceRosterMins) ??
    pickBest(team, availableAll, remainingAfter, "loose", enforceRosterMins) ??
    pickBest(team, availableAll, remainingAfter, "cheapest", enforceRosterMins)
  );
}

export function addPlayer(team: TeamState, player: DraftPlayer): void {
  team.players.push(player);
  team.sum_market_value_eur += player.market_value_eur;
  team.sum_wage_pw += player.wage_pw;
}

/** Run fn under a temporary draft config (for live single-pick validation). */
export function withDraftConfig<T>(config: DraftConfig, fn: () => T): T {
  const prev = activeDraftConfig;
  activeDraftConfig = config;
  try {
    return fn();
  } finally {
    activeDraftConfig = prev;
  }
}

export function emptyTeamState(id: number, name: string): TeamState {
  return {
    id,
    name,
    players: [],
    sum_market_value_eur: 0,
    sum_wage_pw: 0,
  };
}

export function canAddPlayerToTeam(
  team: TeamState,
  player: DraftPlayer,
  remainingAfterPick: number,
  enforceRosterMins: boolean,
): boolean {
  if (!affordableLoose(team, player) && !affordable(team, player, remainingAfterPick)) {
    return false;
  }
  if (!eligible(team, player, remainingAfterPick, enforceRosterMins)) return false;
  return affordable(team, player, remainingAfterPick) || affordableLoose(team, player);
}

export function pickFirstFromWishlist(
  team: TeamState,
  wishlistIds: readonly string[],
  available: DraftPlayer[],
  remainingAfter: number,
  enforceRosterMins: boolean,
): DraftPlayer | null {
  return pickFromWishlist(team, wishlistIds, available, remainingAfter, enforceRosterMins);
}

function snakeOrder(round: number): number[] {
  const ids = Array.from({ length: cfg().teamCount }, (_, i) => i);
  return round % 2 === 0 ? ids : ids.reverse();
}

function toUnselected(p: DraftPlayer): UnselectedPlayer {
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
  };
}

function teamConstraintsOk(t: TeamState): {
  within_budget: boolean;
  leagues_ok: boolean;
  clubs_ok: boolean;
  gk_ok: boolean;
  leagues: Record<string, number>;
  max_club: number;
} {
  const c = cfg();
  const leagues = leagueCounts(t.players);
  const clubs = clubCounts(t.players);
  const max_club = Object.values(clubs).reduce((m, n) => Math.max(m, n), 0);
  const leagues_ok = c.leagueIds.every((id) => (leagues[id] ?? 0) >= c.minPerLeague);
  const clubs_ok = max_club <= c.maxPerClub;
  const gk_ok = t.players.filter(isGoalkeeper).length >= c.minGk;
  const within_budget =
    t.sum_market_value_eur <= c.mvCap && t.sum_wage_pw <= c.wageCap;
  return { within_budget, leagues_ok, clubs_ok, gk_ok, leagues, max_club };
}

export type PrimerDraftResult = {
  generated_at: string;
  rules: {
    teams: number;
    rounds: number;
    mv_cap: number;
    wage_cap: number;
    min_per_league: number;
    max_per_club: number;
    min_gk: number;
    draft: string;
  };
  formations: Array<{ id: string; label: string }>;
  teams: Array<{
    id: number;
    name: string;
    player_count: number;
    sum_market_value_eur: number;
    sum_wage_pw: number;
    within_budget: boolean;
    leagues_ok: boolean;
    clubs_ok: boolean;
    gk_ok: boolean;
    leagues: Record<string, number>;
    max_club: number;
    groups: Record<PositionGroup, number>;
    formations: string[];
    players: Array<{
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
      pick: number;
    }>;
    gameweeks?: Array<{
      gw: number;
      formation: string;
      formation_label: string;
      xi: unknown[];
      bench: unknown[];
      xPtsTotal: number;
    }>;
  }>;
  unselected: UnselectedPlayer[];
  summary: {
    all_have_26: boolean;
    all_within_budget: boolean;
    all_field_formation: boolean;
    all_leagues_ok: boolean;
    all_clubs_ok: boolean;
    all_gk_ok: boolean;
    total_players: number;
    unselected_count: number;
  };
};

/** Optional per-team wishlist (team index 0-based → player ids by priority). */
export type TeamWishlists = ReadonlyMap<number, readonly string[]>;

export function runPrimerDraft(
  poolPlayers: DraftPlayer[],
  overflowPlayers: DraftPlayer[] = [],
  teamNames: readonly string[] = CELESTIAL_TEAM_NAMES,
  draftConfig: DraftConfig = PRIMER_DRAFT_CONFIG,
  teamWishlists: TeamWishlists | null = null,
): PrimerDraftResult {
  const prev = activeDraftConfig;
  activeDraftConfig = draftConfig;
  try {
    return runPrimerDraftInner(
      poolPlayers,
      overflowPlayers,
      teamNames,
      teamWishlists,
    );
  } finally {
    activeDraftConfig = prev;
  }
}

function pickFromWishlist(
  team: TeamState,
  wishlistIds: readonly string[],
  available: DraftPlayer[],
  remainingAfter: number,
  enforceRosterMins: boolean,
): DraftPlayer | null {
  const byId = new Map(available.map((p) => [p.id, p]));
  for (const id of wishlistIds) {
    const p = byId.get(id);
    if (!p) continue;
    if (!affordable(team, p, remainingAfter) && !affordableLoose(team, p)) {
      continue;
    }
    if (!eligible(team, p, remainingAfter, enforceRosterMins)) continue;
    // Prefer paced affordability; allow loose if paced fails but still eligible.
    if (
      affordable(team, p, remainingAfter) ||
      affordableLoose(team, p)
    ) {
      return p;
    }
  }
  return null;
}

function runPrimerDraftInner(
  poolPlayers: DraftPlayer[],
  overflowPlayers: DraftPlayer[],
  teamNames: readonly string[],
  teamWishlists: TeamWishlists | null,
): PrimerDraftResult {
  const c = cfg();
  const names = [...teamNames];
  while (names.length < c.teamCount) names.push(`Команда ${names.length + 1}`);

  const teams: TeamState[] = names.slice(0, c.teamCount).map((name, i) => ({
    id: i + 1,
    name,
    players: [],
    sum_market_value_eur: 0,
    sum_wage_pw: 0,
  }));

  // Primary quota pool + cheap overflow for wage-cap fillers.
  const primaryIds = new Set(poolPlayers.map((p) => p.id));
  const overflow = overflowPlayers.filter((p) => !primaryIds.has(p.id));
  const pool = [...poolPlayers, ...overflow];
  const taken = new Set<string>();
  const pickIndex = new Map<string, number>();
  let overallPick = 0;

  // Base snake rounds with hard roster mins.
  for (let round = 0; round < c.rounds; round++) {
    for (const ti of snakeOrder(round)) {
      const team = teams[ti];
      const remainingAfter = c.rounds - team.players.length - 1;
      const availablePrimary = poolPlayers.filter((p) => !taken.has(p.id));
      const availableAll = pool.filter((p) => !taken.has(p.id));

      const wl = teamWishlists?.get(ti) ?? [];
      const choice =
        (wl.length
          ? pickFromWishlist(
              team,
              wl,
              availableAll,
              remainingAfter,
              true,
            )
          : null) ??
        choosePick(
          team,
          availablePrimary,
          availableAll,
          remainingAfter,
          true,
        );

      if (!choice) {
        console.warn(
          `Team ${team.id} could not pick in round ${round + 1} (have ${team.players.length})`,
        );
        continue;
      }

      taken.add(choice.id);
      overallPick += 1;
      pickIndex.set(choice.id, overallPick);
      addPlayer(team, choice);
    }
  }

  // Optional extra snake rounds while budget + club/GK/league constraints allow.
  for (let extra = 0; extra < c.maxExtraRounds; extra++) {
    let anyPicked = false;
    for (const ti of snakeOrder(c.rounds + extra)) {
      const team = teams[ti];
      const availablePrimary = poolPlayers.filter((p) => !taken.has(p.id));
      const availableAll = pool.filter((p) => !taken.has(p.id));

      // No reserve pacing; only hard budget + club cap (mins already met).
      let choice = choosePick(team, availablePrimary, availableAll, 0, false);
      if (!choice) continue;

      // Prefer useful adds: need score or solid rating upgrade.
      const need = needScore(team, choice);
      if (need < 0 && choice.fm_rating < 140) {
        // Try next-best with positive need among affordable.
        const useful = availableAll
          .filter(
            (p) =>
              affordableLoose(team, p) &&
              eligible(team, p, 0, false) &&
              needScore(team, p) >= 0,
          )
          .sort(
            (a, b) =>
              needScore(team, b) - needScore(team, a) ||
              b.fm_rating - a.fm_rating ||
              a.wage_pw - b.wage_pw,
          )[0];
        if (!useful) continue;
        choice = useful;
      }

      taken.add(choice.id);
      overallPick += 1;
      pickIndex.set(choice.id, overallPick);
      addPlayer(team, choice);
      anyPicked = true;
    }
    if (!anyPicked) break;
  }

  const teamResults = teams.map((t) => {
    const constraints = teamConstraintsOk(t);
    const formations = fieldableFormations(t.players);
    const within =
      constraints.within_budget &&
      constraints.leagues_ok &&
      constraints.clubs_ok &&
      constraints.gk_ok &&
      t.players.length >= c.rounds;

    return {
      id: t.id,
      name: t.name,
      player_count: t.players.length,
      sum_market_value_eur: t.sum_market_value_eur,
      sum_wage_pw: t.sum_wage_pw,
      within_budget: within,
      leagues_ok: constraints.leagues_ok,
      clubs_ok: constraints.clubs_ok,
      gk_ok: constraints.gk_ok,
      leagues: constraints.leagues,
      max_club: constraints.max_club,
      groups: groupCounts(t.players),
      formations,
      players: t.players.map((p) => ({
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
        pick: pickIndex.get(p.id) ?? 0,
      })),
    };
  });

  // Quota pool is the draft board; overflow is cheap fillers only when needed.
  const unselected = poolPlayers
    .filter((p) => !taken.has(p.id))
    .sort(
      (a, b) =>
        b.fm_rating - a.fm_rating ||
        b.wage_pw - a.wage_pw ||
        b.market_value_eur - a.market_value_eur ||
        a.name.localeCompare(b.name),
    )
    .map(toUnselected);

  const all_have_26 = teamResults.every((t) => t.player_count >= c.rounds);
  const all_within_budget = teamResults.every(
    (t) => t.sum_market_value_eur <= c.mvCap && t.sum_wage_pw <= c.wageCap,
  );
  const all_field_formation = teamResults.every((t) => t.formations.length > 0);
  const all_leagues_ok = teamResults.every((t) => t.leagues_ok);
  const all_clubs_ok = teamResults.every((t) => t.clubs_ok);
  const all_gk_ok = teamResults.every((t) => t.gk_ok);

  return {
    generated_at: new Date().toISOString(),
    rules: {
      teams: c.teamCount,
      rounds: c.rounds,
      mv_cap: c.mvCap,
      wage_cap: c.wageCap,
      min_per_league: c.minPerLeague,
      max_per_club: c.maxPerClub,
      min_gk: c.minGk,
      draft: "snake+optional",
    },
    formations: FORMATIONS.map((f) => ({ id: f.id, label: f.label })),
    teams: teamResults,
    unselected,
    summary: {
      all_have_26,
      all_within_budget,
      all_field_formation,
      all_leagues_ok,
      all_clubs_ok,
      all_gk_ok,
      total_players: teamResults.reduce((s, t) => s + t.player_count, 0),
      unselected_count: unselected.length,
    },
  };
}

/** Build quota pool: top N per league by rating, trusted wage, MV — same sort as top26. */
export function buildQuotaPoolQuery(
  quotas: ReadonlyArray<{ id: string; n: number }> = QUOTA_POOL,
): {
  sql: string;
  params: unknown[];
  quotas: ReadonlyArray<{ id: string; n: number }>;
} {
  const quotaValues = quotas.map(() => "(?, ?)").join(", ");
  const quotaParams = quotas.flatMap((q) => [q.id, q.n]);
  // Ranking + wage_pw = trusted happens in JS (see applyTrustedQuotaPool).
  const sql = `
    WITH quotas(league_id, n) AS (VALUES ${quotaValues})
    SELECT
      p.id,
      p.name,
      p.position,
      p.detail_role,
      p.detail_label,
      p.side_role,
      p.club_id,
      p.league_id,
      p.fm_rating,
      COALESCE(p.market_value_eur, 0) AS market_value_eur,
      p.capology_wage_pw,
      p.fm_wage_pw,
      p.portrait_url,
      c.name AS club_name,
      l.name AS league_name
    FROM players p
    JOIN clubs c ON c.id = p.club_id
    JOIN leagues l ON l.id = p.league_id
    WHERE p.fm_rating IS NOT NULL
      AND p.league_id IN (SELECT league_id FROM quotas)
  `;
  return { sql, params: quotaParams, quotas };
}

/** Apply trusted wage, rank, and take top N per league (same order as /api/leagues/top26). */
export function applyTrustedQuotaPool(
  rows: Array<Record<string, unknown>>,
  peers: PeerRow[],
  quotas: ReadonlyArray<{ id: string; n: number }> = QUOTA_POOL,
): Array<Record<string, unknown> & { wage_pw: number }> {
  const enriched = rows.map((r) => withTrustedWageAsWagePw(r, peers));
  const byLeague = new Map<string, typeof enriched>();
  for (const p of enriched) {
    const lid = String(p.league_id);
    let list = byLeague.get(lid);
    if (!list) {
      list = [];
      byLeague.set(lid, list);
    }
    list.push(p);
  }
  const out: typeof enriched = [];
  for (const q of quotas) {
    const list = byLeague.get(q.id) ?? [];
    list.sort(compareRatingWageMv);
    out.push(...list.slice(0, q.n));
  }
  out.sort(compareRatingWageMv);
  return out;
}
