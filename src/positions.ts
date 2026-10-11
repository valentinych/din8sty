export type PositionGroup = "GK" | "DEF" | "MID" | "ATT";

export type PlayerPositionFields = {
  position?: string | null;
  detail_role?: string | null;
  detail_label?: string | null;
  side_role?: string | null;
};

export const POSITION_GROUPS = ["GK", "DEF", "MID", "ATT"] as const;
const GROUPS = new Set<string>(POSITION_GROUPS);

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

function normRole(value: string): string {
  return value.trim().toUpperCase();
}

/** TM long labels (detail_label) → short codes used in display/filters. */
const LABEL_TO_ROLE: Record<string, string> = {
  GOALKEEPER: "GK",
  "CENTRE-BACK": "CB",
  "LEFT-BACK": "LB",
  "RIGHT-BACK": "RB",
  SWEEPER: "CB",
  "DEFENSIVE MIDFIELD": "DM",
  "CENTRAL MIDFIELD": "CM",
  "ATTACKING MIDFIELD": "AM",
  "LEFT MIDFIELD": "LM",
  "RIGHT MIDFIELD": "RM",
  "LEFT WINGER": "LW",
  "RIGHT WINGER": "RW",
  "CENTRE-FORWARD": "CF",
  STRIKER: "CF",
  "SECOND STRIKER": "SS",
};

/** ST and Centre-Forward (CF) are the same TM role — always use CF. */
function canonicalRole(value: string): string {
  const normalized = LABEL_TO_ROLE[normRole(value)] ?? normRole(value);
  return normalized === "ST" ? "CF" : normalized;
}

function splitSideRole(side: string | null | undefined): string[] {
  if (!side) return [];
  return side
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Distinct TM role abbreviations from detail_role, detail_label, and side_role. */
export function collectPlayerRoles(p: PlayerPositionFields): string[] {
  const raw: string[] = [];
  if (p.detail_role) raw.push(p.detail_role);
  if (p.detail_label) raw.push(p.detail_label);
  raw.push(...splitSideRole(p.side_role));
  if (p.position && !GROUPS.has(normRole(p.position))) {
    raw.push(p.position);
  }

  const seen = new Set<string>();
  const roles: string[] = [];
  for (const role of raw) {
    const normalized = canonicalRole(role);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    roles.push(normalized);
  }
  return roles;
}

function mainRole(p: PlayerPositionFields): string | null {
  const main = p.detail_role?.trim() || p.detail_label?.trim() || p.position?.trim();
  return main ? canonicalRole(main) : null;
}

/** Main TM detail role plus additional roles in parentheses. */
export function formatPositionDisplay(p: PlayerPositionFields): string {
  const main = mainRole(p);
  if (!main) return "—";

  const extras = collectPlayerRoles(p).filter((role) => role !== main);
  if (!extras.length) return main;
  return `${main} (${extras.join(", ")})`;
}

function roleGroup(role: string): PositionGroup | null {
  const normalized = canonicalRole(role);
  if (GROUPS.has(normalized)) return normalized as PositionGroup;
  return ROLE_TO_GROUP[normalized] ?? null;
}

const GROUP_SORT: Record<PositionGroup, number> = { GK: 0, DEF: 1, MID: 2, ATT: 3 };

const ROLE_SORT: Record<string, number> = {
  GK: 0,
  LB: 10,
  CB: 11,
  RB: 12,
  LWB: 13,
  RWB: 14,
  DM: 20,
  CM: 21,
  AM: 22,
  LM: 23,
  RM: 24,
  LW: 30,
  RW: 31,
  SS: 32,
  CF: 33,
};

/** Sort roles: GK first, then DEF / MID / ATT groups, alphabetically within unknowns. */
export function sortRoles(roles: string[]): string[] {
  return [...roles].sort((a, b) => {
    const ga = roleGroup(a);
    const gb = roleGroup(b);
    const goa = ga ? GROUP_SORT[ga] : 99;
    const gob = gb ? GROUP_SORT[gb] : 99;
    if (goa !== gob) return goa - gob;
    const ra = ROLE_SORT[a] ?? 50;
    const rb = ROLE_SORT[b] ?? 50;
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b);
  });
}

/** Distinct specific roles across many players (detail_role, detail_label, side_role). */
export function collectDistinctRoles(players: PlayerPositionFields[]): string[] {
  const seen = new Set<string>();
  for (const p of players) {
    for (const role of collectPlayerRoles(p)) {
      seen.add(role);
    }
  }
  return sortRoles([...seen]);
}

/** Match GK/DEF/MID/ATT formation line against main or side positions. */
export function playerMatchesLineFilter(p: PlayerPositionFields, line: string): boolean {
  const wanted = normRole(line);
  if (!wanted || !GROUPS.has(wanted)) return true;

  const roles = collectPlayerRoles(p);
  const coarse = p.position ? normRole(p.position) : null;
  if (coarse === wanted) return true;
  return roles.some((role) => roleGroup(role) === wanted);
}

/** Match a specific TM role (CB, DM, CF, …) against main or side positions. */
export function playerMatchesRoleFilter(p: PlayerPositionFields, role: string): boolean {
  const wanted = canonicalRole(role);
  if (!wanted) return true;

  const roles = collectPlayerRoles(p);
  const coarse = p.position ? canonicalRole(p.position) : null;
  if (roles.some((r) => r === wanted)) return true;
  return coarse === wanted;
}

/** Match GK/DEF/MID/ATT groups or an exact role against main or side positions. */
export function playerMatchesPosFilter(p: PlayerPositionFields, filter: string): boolean {
  const wanted = normRole(filter);
  if (!wanted) return true;
  if (GROUPS.has(wanted)) return playerMatchesLineFilter(p, wanted);
  return playerMatchesRoleFilter(p, wanted);
}
