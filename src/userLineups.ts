/**
 * User-editable GW lineups: formation slots, pitch layout, eligibility.
 * Reuses primer FORMATIONS + position matching.
 */
import {
  collectPlayerRoles,
  playerMatchesRoleFilter,
  type PlayerPositionFields,
} from "./positions.js";
import {
  FORMATIONS,
  primaryRole,
  type FormationTemplate,
  type SlotRoles,
} from "./primerDraft.js";
import type { ClubFixtureCtx } from "./primerLineups.js";
import { formatHaOpponent } from "./clubCode.js";

/** Multiplicative GW xPts when assigned role equals player's primary. */
export const PRIMARY_POSITION_XPTS_BONUS = 1.2;

export type LineupSlotRole = string | null;

/** Fantasy bench: 1 GK + 6 outfield. */
export const BENCH_SIZE = 7;

export type ParsedLineupSlots = {
  slots: Array<string | null>;
  roles: Array<LineupSlotRole>;
  bench: Array<string | null>;
  benchRoles: Array<LineupSlotRole>;
};

export function emptyBenchSlots(): Array<string | null> {
  return Array.from({ length: BENCH_SIZE }, () => null);
}

export function emptyBenchRoles(): Array<LineupSlotRole> {
  return Array.from({ length: BENCH_SIZE }, () => null);
}

function isGkPlayer(p: PlayerPositionFields): boolean {
  const vals = [p.position, p.detail_role, p.detail_label]
    .filter(Boolean)
    .map((v) => String(v).trim().toUpperCase());
  if (vals.some((v) => v === "GK" || v === "GKP")) return true;
  return primaryRole(p) === "GK";
}

/** Bench slot 0 = GK only; 1–6 = any non-GK. */
export function playerMatchesBenchSlot(
  p: PlayerPositionFields,
  benchIndex: number,
): boolean {
  if (benchIndex < 0 || benchIndex >= BENCH_SIZE) return false;
  if (benchIndex === 0) return isGkPlayer(p);
  return !isGkPlayer(p);
}

/** Role variants for a bench slot (in-slot cycle only). */
export function benchRoleVariants(
  p: PlayerPositionFields,
  benchIndex: number,
): string[] {
  if (!playerMatchesBenchSlot(p, benchIndex)) return [];
  if (benchIndex === 0) return ["GK"];
  const roles = collectPlayerRoles(p).map(canonRole).filter((r) => r && r !== "GK");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of roles) {
    if (seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }
  return out;
}

export function defaultRoleForBench(
  p: PlayerPositionFields,
  benchIndex: number,
): string | null {
  const variants = benchRoleVariants(p, benchIndex);
  if (!variants.length) return null;
  if (benchIndex === 0) return "GK";
  const primary = primaryRole(p);
  if (primary && variants.includes(canonRole(primary))) return canonRole(primary);
  return variants[0] ?? null;
}

export type PitchSlotDef = {
  roles: SlotRoles;
  label: string;
  /** 0–100 left→right */
  x: number;
  /** 0–100 GK (bottom) → attack (top) */
  y: number;
};

export type PitchFormation = {
  id: string;
  label: string;
  slots: readonly PitchSlotDef[];
  /** Same slot order with wings on the DEF line (LM→LB / RM→RB visual). */
  back5_slots?: readonly PitchSlotDef[];
};

/** Pitch coordinates aligned to FORMATIONS slot order. */
const PITCH_LAYOUTS: Record<string, readonly { x: number; y: number }[]> = {
  "4-4-2": [
    { x: 50, y: 10 },
    { x: 12, y: 30 },
    { x: 36, y: 28 },
    { x: 64, y: 28 },
    { x: 88, y: 30 },
    { x: 12, y: 54 },
    { x: 36, y: 52 },
    { x: 64, y: 52 },
    { x: 88, y: 54 },
    { x: 36, y: 78 },
    { x: 64, y: 78 },
  ],
  "4-5-1": [
    { x: 50, y: 10 },
    { x: 12, y: 30 },
    { x: 36, y: 28 },
    { x: 64, y: 28 },
    { x: 88, y: 30 },
    { x: 10, y: 54 },
    { x: 30, y: 52 },
    { x: 50, y: 48 },
    { x: 70, y: 52 },
    { x: 90, y: 54 },
    { x: 50, y: 78 },
  ],
  "3-5-2": [
    { x: 50, y: 10 },
    { x: 22, y: 28 },
    { x: 50, y: 26 },
    { x: 78, y: 28 },
    { x: 8, y: 48 },
    { x: 32, y: 52 },
    { x: 50, y: 48 },
    { x: 68, y: 52 },
    { x: 92, y: 48 },
    { x: 36, y: 78 },
    { x: 64, y: 78 },
  ],
  // Slot order: GK, 3×CB, LM, 2×CM, RM, LW, RW, CF — attack is LW | CF | RW left→right
  "3-4-3": [
    { x: 50, y: 10 },
    { x: 22, y: 28 },
    { x: 50, y: 26 },
    { x: 78, y: 28 },
    { x: 8, y: 50 },
    { x: 36, y: 50 },
    { x: 64, y: 50 },
    { x: 92, y: 50 },
    { x: 22, y: 76 },
    { x: 78, y: 76 },
    { x: 50, y: 80 },
  ],
  // GK, LB, 3×CB, RB, LM, 2×CM, RM, CF
  "5-4-1": [
    { x: 50, y: 10 },
    { x: 8, y: 28 },
    { x: 28, y: 26 },
    { x: 50, y: 24 },
    { x: 72, y: 26 },
    { x: 92, y: 28 },
    { x: 12, y: 52 },
    { x: 38, y: 50 },
    { x: 62, y: 50 },
    { x: 88, y: 52 },
    { x: 50, y: 78 },
  ],
};

/**
 * Back-five pitch for dual 3/5 schemes (same slot indices).
 * Wings sit on the DEF line; CBs shift slightly inward.
 */
const BACK5_LAYOUTS: Record<string, readonly { x: number; y: number }[]> = {
  "3-5-2": [
    { x: 50, y: 10 },
    { x: 28, y: 28 },
    { x: 50, y: 26 },
    { x: 72, y: 28 },
    { x: 8, y: 30 },
    { x: 28, y: 52 },
    { x: 50, y: 48 },
    { x: 72, y: 52 },
    { x: 92, y: 30 },
    { x: 36, y: 78 },
    { x: 64, y: 78 },
  ],
  "3-4-3": [
    { x: 50, y: 10 },
    { x: 28, y: 28 },
    { x: 50, y: 26 },
    { x: 72, y: 28 },
    { x: 8, y: 30 },
    { x: 38, y: 52 },
    { x: 62, y: 52 },
    { x: 92, y: 30 },
    { x: 22, y: 76 },
    { x: 78, y: 76 },
    { x: 50, y: 80 },
  ],
};

/** Wing slot indices that drop LM→LB / RM→RB in back-five mode. */
const BACK5_WING_INDEX: Record<string, { lm: number; rm: number }> = {
  "3-5-2": { lm: 4, rm: 8 },
  "3-4-3": { lm: 4, rm: 7 },
};

/** Legacy ids still resolve to the dual 3/5 schemes. */
const FORMATION_ID_ALIASES: Record<string, string> = {
  "5-3-2": "3-5-2",
  "5-2-3": "3-4-3",
};

function slotLabel(roles: SlotRoles): string {
  return roles.join("/");
}

/** Prefer DEF role first in label/order when showing back-five shape. */
function preferDefFirst(roles: SlotRoles): SlotRoles {
  const def = roles.filter((r) => r === "LB" || r === "RB");
  if (!def.length) return roles;
  const rest = roles.filter((r) => r !== "LB" && r !== "RB");
  return [...def, ...rest];
}

function buildPitchSlots(
  rolesList: readonly SlotRoles[],
  layout: readonly { x: number; y: number }[] | undefined,
  preferDef = false,
): PitchSlotDef[] {
  return rolesList.map((roles, i) => {
    const ordered = preferDef ? preferDefFirst(roles) : roles;
    return {
      roles: ordered,
      label: slotLabel(ordered),
      x: layout?.[i]?.x ?? 50,
      y: layout?.[i]?.y ?? 50,
    };
  });
}

export function pitchFormations(
  templates: readonly FormationTemplate[] = FORMATIONS,
): PitchFormation[] {
  return templates.map((f) => {
    const slots = buildPitchSlots(f.slots, PITCH_LAYOUTS[f.id]);
    const back5Layout = BACK5_LAYOUTS[f.id];
    const out: PitchFormation = { id: f.id, label: f.label, slots };
    if (back5Layout && BACK5_WING_INDEX[f.id]) {
      out.back5_slots = buildPitchSlots(f.slots, back5Layout, true);
    }
    return out;
  });
}

/** Wing indices for dual schemes that support the «5 сзади» toggle. */
export function back5WingIndex(
  formationId: string,
): { lm: number; rm: number } | null {
  const resolved = FORMATION_ID_ALIASES[formationId] ?? formationId;
  return BACK5_WING_INDEX[resolved] ?? null;
}

export function formationById(
  id: string,
  templates: readonly FormationTemplate[] = FORMATIONS,
): FormationTemplate | null {
  const resolved = FORMATION_ID_ALIASES[id] ?? id;
  return templates.find((f) => f.id === resolved) ?? null;
}

export function playerMatchesSlot(p: PlayerPositionFields, slot: SlotRoles): boolean {
  return slot.some((role) => playerMatchesRoleFilter(p, role));
}

function canonRole(value: string): string {
  const n = value.trim().toUpperCase();
  return n === "ST" ? "CF" : n;
}

/** Roles the player can play that this formation actually hosts. */
export function eligibleRoleVariants(
  p: PlayerPositionFields,
  formation: FormationTemplate,
): string[] {
  const playerRoles = new Set(collectPlayerRoles(p));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const slot of formation.slots) {
    for (const role of slot) {
      const r = canonRole(role);
      if (!playerRoles.has(r) || seen.has(r)) continue;
      if (!playerMatchesRoleFilter(p, r)) continue;
      seen.add(r);
      out.push(r);
    }
  }
  return out;
}

/** Prefer primary when the slot accepts it; else first overlapping role. */
export function defaultRoleForSlot(
  p: PlayerPositionFields,
  slot: SlotRoles,
): string | null {
  const overlap = slot
    .map((r) => canonRole(r))
    .filter((r) => playerMatchesRoleFilter(p, r));
  if (!overlap.length) return null;
  const primary = primaryRole(p);
  if (primary && overlap.includes(primary)) return primary;
  return overlap[0] ?? null;
}

/**
 * Player roles in auto-sub match order: ideal/primary first, then additional
 * positions in TM priority order (side_role left→right).
 */
export function rolesByAutoSubPriority(p: PlayerPositionFields): string[] {
  const primary = primaryRole(p);
  const out: string[] = [];
  const seen = new Set<string>();
  if (primary) {
    const c = canonRole(primary);
    out.push(c);
    seen.add(c);
  }
  for (const role of collectPlayerRoles(p)) {
    const c = canonRole(role);
    if (!c || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

export type BenchCoverPick = {
  benchIndex: number;
  matchedRole: string;
  /** 0 = ideal/primary; 1+ = additional position priority index. */
  priorityIndex: number;
};

/**
 * Auto-sub cover for a vacant XI slot when the starter did not play.
 * Passes: (1) ideal/primary role match, then (2+) each additional position
 * in priority order. Within a pass, bench is scanned in slot order.
 */
export function pickBenchCover(
  slot: SlotRoles,
  benchPlayers: Array<PlayerPositionFields | null | undefined>,
): BenchCoverPick | null {
  const slotRoles = slot.map((r) => canonRole(r));
  if (!slotRoles.length) return null;

  let maxLen = 0;
  const prioritized: Array<string[] | null> = benchPlayers.map((p) => {
    if (!p) return null;
    const roles = rolesByAutoSubPriority(p);
    if (roles.length > maxLen) maxLen = roles.length;
    return roles;
  });

  for (let priorityIndex = 0; priorityIndex < maxLen; priorityIndex++) {
    for (let benchIndex = 0; benchIndex < prioritized.length; benchIndex++) {
      const roles = prioritized[benchIndex];
      if (!roles) continue;
      const role = roles[priorityIndex];
      if (!role) continue;
      if (!slotRoles.includes(role)) continue;
      const player = benchPlayers[benchIndex];
      if (!player || !playerMatchesRoleFilter(player, role)) continue;
      return { benchIndex, matchedRole: role, priorityIndex };
    }
  }
  return null;
}

export function effectiveLineupXPts(
  baseXPts: number | null | undefined,
  primary: string | null | undefined,
  assignedRole: string | null | undefined,
): number {
  const base = Number(baseXPts);
  if (!Number.isFinite(base)) return 0;
  if (
    primary &&
    assignedRole &&
    canonRole(primary) === canonRole(assignedRole)
  ) {
    return Math.round(base * PRIMARY_POSITION_XPTS_BONUS * 100) / 100;
  }
  return base;
}

function padBench(
  list: Array<string | null>,
  roleList: Array<LineupSlotRole>,
): { bench: Array<string | null>; benchRoles: Array<LineupSlotRole> } {
  const bench = emptyBenchSlots();
  const benchRoles = emptyBenchRoles();
  for (let i = 0; i < BENCH_SIZE; i++) {
    bench[i] = list[i] ?? null;
    benchRoles[i] = roleList[i] ?? null;
  }
  return { bench, benchRoles };
}

/** Parse slots_json: legacy string[] or { slots, roles [, bench, bench_roles] }. */
export function parseSlotsJson(raw: string): ParsedLineupSlots {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      const slots = parsed.map((x) => {
        if (x == null || x === "") return null;
        if (typeof x === "object" && x !== null && "id" in x) {
          const id = (x as { id?: unknown }).id;
          return id == null || id === "" ? null : String(id);
        }
        return String(x);
      });
      const roles = parsed.map((x) => {
        if (x != null && typeof x === "object" && "role" in x) {
          const role = (x as { role?: unknown }).role;
          return role == null || role === "" ? null : canonRole(String(role));
        }
        return null;
      });
      return { slots, roles, bench: emptyBenchSlots(), benchRoles: emptyBenchRoles() };
    }
    if (parsed && typeof parsed === "object") {
      const obj = parsed as {
        slots?: unknown;
        roles?: unknown;
        players?: unknown;
        bench?: unknown;
        bench_roles?: unknown;
        benchRoles?: unknown;
      };
      const list = Array.isArray(obj.slots)
        ? obj.slots
        : Array.isArray(obj.players)
          ? obj.players
          : [];
      const slots = list.map((x) => (x == null || x === "" ? null : String(x)));
      const roleList = Array.isArray(obj.roles) ? obj.roles : [];
      const roles = slots.map((_, i) => {
        const r = roleList[i];
        return r == null || r === "" ? null : canonRole(String(r));
      });
      const rawBench = Array.isArray(obj.bench) ? obj.bench : [];
      const benchIds = rawBench.map((x) =>
        x == null || x === "" ? null : String(x),
      );
      const rawBenchRoles = Array.isArray(obj.bench_roles)
        ? obj.bench_roles
        : Array.isArray(obj.benchRoles)
          ? obj.benchRoles
          : [];
      const benchRoleList = benchIds.map((_, i) => {
        const r = rawBenchRoles[i];
        return r == null || r === "" ? null : canonRole(String(r));
      });
      const { bench, benchRoles } = padBench(benchIds, benchRoleList);
      return { slots, roles, bench, benchRoles };
    }
  } catch {
    /* ignore */
  }
  return {
    slots: [],
    roles: [],
    bench: emptyBenchSlots(),
    benchRoles: emptyBenchRoles(),
  };
}

export function serializeSlotsJson(
  slots: Array<string | null>,
  roles: Array<LineupSlotRole>,
  bench: Array<string | null> = emptyBenchSlots(),
  benchRoles: Array<LineupSlotRole> = emptyBenchRoles(),
): string {
  const normalizedRoles = slots.map((_, i) => roles[i] ?? null);
  const { bench: b, benchRoles: br } = padBench(bench, benchRoles);
  return JSON.stringify({
    slots,
    roles: normalizedRoles,
    bench: b,
    bench_roles: br,
  });
}

/** Keep players on same-index slots if still eligible; else null (pool). */
export function remapSlotsOnFormationChange(
  playersById: Map<string, PlayerPositionFields>,
  slots: Array<string | null>,
  roles: Array<LineupSlotRole>,
  nextFormation: FormationTemplate,
): ParsedLineupSlots {
  const nextSlots: Array<string | null> = nextFormation.slots.map(() => null);
  const nextRoles: Array<LineupSlotRole> = nextFormation.slots.map(() => null);
  const used = new Set<string>();

  for (let i = 0; i < nextFormation.slots.length; i++) {
    const pid = slots[i] ?? null;
    if (!pid || used.has(pid)) continue;
    const player = playersById.get(pid);
    if (!player) continue;
    const slotRoles = nextFormation.slots[i];
    if (!playerMatchesSlot(player, slotRoles)) continue;
    nextSlots[i] = pid;
    used.add(pid);
    const prevRole = roles[i];
    if (
      prevRole &&
      slotRoles.some((r) => canonRole(r) === canonRole(prevRole)) &&
      playerMatchesRoleFilter(player, prevRole)
    ) {
      nextRoles[i] = canonRole(prevRole);
    } else {
      nextRoles[i] = defaultRoleForSlot(player, slotRoles);
    }
  }
  return {
    slots: nextSlots,
    roles: nextRoles,
    bench: emptyBenchSlots(),
    benchRoles: emptyBenchRoles(),
  };
}

export function validateLineupSlots(
  playersById: Map<string, PlayerPositionFields>,
  formation: FormationTemplate,
  slots: Array<string | null>,
  roles?: Array<LineupSlotRole | undefined> | null,
):
  | { ok: true; slots: Array<string | null>; roles: Array<LineupSlotRole> }
  | { ok: false; error: string } {
  if (slots.length !== formation.slots.length) {
    return { ok: false, error: "slot_count" };
  }
  const seen = new Set<string>();
  const normalized: Array<string | null> = [];
  const normalizedRoles: Array<LineupSlotRole> = [];
  for (let i = 0; i < slots.length; i++) {
    const raw = slots[i];
    if (raw == null || raw === "") {
      normalized.push(null);
      normalizedRoles.push(null);
      continue;
    }
    const pid = String(raw);
    if (seen.has(pid)) return { ok: false, error: "duplicate_player" };
    const player = playersById.get(pid);
    if (!player) return { ok: false, error: "unknown_player" };
    const slotRoles = formation.slots[i];
    if (!playerMatchesSlot(player, slotRoles)) {
      return { ok: false, error: "ineligible_slot" };
    }
    const rawRole = roles?.[i];
    let role: LineupSlotRole =
      rawRole == null || rawRole === "" ? null : canonRole(String(rawRole));
    if (
      role &&
      (!slotRoles.some((r) => canonRole(r) === role) ||
        !playerMatchesRoleFilter(player, role))
    ) {
      return { ok: false, error: "ineligible_role" };
    }
    if (!role) role = defaultRoleForSlot(player, slotRoles);
    seen.add(pid);
    normalized.push(pid);
    normalizedRoles.push(role);
  }
  return { ok: true, slots: normalized, roles: normalizedRoles };
}

/**
 * Validate bench (length 7). Slot 0 = GK when occupied; 1–6 = outfield.
 * Partial benches allowed. `xiSlots` used to reject XI↔bench duplicates.
 */
export function validateBenchSlots(
  playersById: Map<string, PlayerPositionFields>,
  bench: Array<string | null> | null | undefined,
  benchRoles?: Array<LineupSlotRole | undefined> | null,
  xiSlots?: Array<string | null> | null,
):
  | { ok: true; bench: Array<string | null>; benchRoles: Array<LineupSlotRole> }
  | { ok: false; error: string } {
  const raw = Array.isArray(bench) ? bench : [];
  if (raw.length > BENCH_SIZE) {
    return { ok: false, error: "bench_count" };
  }
  const xiSeen = new Set(
    (xiSlots || []).filter((id): id is string => !!id).map(String),
  );
  const normalized = emptyBenchSlots();
  const normalizedRoles = emptyBenchRoles();
  const seen = new Set<string>();

  for (let i = 0; i < BENCH_SIZE; i++) {
    const rawId = raw[i];
    if (rawId == null || rawId === "") {
      normalized[i] = null;
      normalizedRoles[i] = null;
      continue;
    }
    const pid = String(rawId);
    if (seen.has(pid) || xiSeen.has(pid)) {
      return { ok: false, error: "duplicate_player" };
    }
    const player = playersById.get(pid);
    if (!player) return { ok: false, error: "unknown_player" };
    if (!playerMatchesBenchSlot(player, i)) {
      return { ok: false, error: "ineligible_bench" };
    }
    const variants = benchRoleVariants(player, i);
    const rawRole = benchRoles?.[i];
    let role: LineupSlotRole =
      rawRole == null || rawRole === "" ? null : canonRole(String(rawRole));
    if (role && !variants.includes(role)) {
      return { ok: false, error: "ineligible_role" };
    }
    if (!role) role = defaultRoleForBench(player, i);
    seen.add(pid);
    normalized[i] = pid;
    normalizedRoles[i] = role;
  }
  return { ok: true, bench: normalized, benchRoles: normalizedRoles };
}

/** Opponent labels for UI (compact code + full fixture name). */
export function fixtureOpponentLabel(
  fixtures: readonly ClubFixtureCtx[],
): {
  is_home: boolean | null;
  opponent: string | null;
  opponent_name: string | null;
} {
  if (!fixtures.length) {
    return { is_home: null, opponent: null, opponent_name: null };
  }
  if (fixtures.length === 1) {
    const fx = fixtures[0]!;
    return {
      is_home: fx.isHome,
      opponent: fx.opponent,
      opponent_name: fx.opponentName || fx.opponent,
    };
  }
  const label = fixtures
    .map((fx) => formatHaOpponent(fx.isHome, fx.opponent))
    .join(" / ");
  const nameLabel = fixtures
    .map((fx) => formatHaOpponent(fx.isHome, fx.opponentName || fx.opponent))
    .join(" / ");
  return { is_home: null, opponent: label, opponent_name: nameLabel };
}

export function shortSurname(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts[parts.length - 1] || name;
}
