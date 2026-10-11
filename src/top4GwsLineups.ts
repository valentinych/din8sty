/**
 * Top-4 public GW lineups board: current + next gameweek saved XIs.
 * Same source as lineup.html (`top4_lineups`); current GW = gameweekFromKickoff(now).
 */
import type Database from "better-sqlite3";
import {
  clubCodeLabel,
  formatParenHaOpponent,
} from "./clubCode.js";
import {
  excludeIgnoredFixturesWhere,
  seasonGameweekWhere,
} from "./fixturesFilter.js";
import { gameweekFromKickoff, gameweekRange } from "./gameweeks.js";
import { FORMATIONS, type FormationTemplate } from "./primerDraft.js";
import {
  ingestFixtureRow,
  type ClubGwFixtures,
} from "./primerLineups.js";
import { getTop4SquadsPublic } from "./top4LiveDraft.js";
import { loadSquadGwLock } from "./top4LineupLock.js";
import {
  ensureTop4ConsigliereSchema,
  listTop4RegistrationsFull,
} from "./top4Consigliere.js";
import {
  formationById,
  parseSlotsJson,
  shortSurname,
} from "./userLineups.js";

export type Top4GwLineupPlayer = {
  id: string;
  name: string;
  short: string;
  pos: string | null;
  /** Bench tag when this row is a reserve, e.g. `R1` (1-based bench index). */
  r?: string | null;
  /** Real club short code (TM code or derived). */
  club: string | null;
  /** Compact opponents for this GW, e.g. `(A) ARS` or `(H) ARS (A) ATM`. */
  opp: string | null;
};

export type Top4GwLineupSaved = {
  formation: string;
  updated_at: string;
  xi: Top4GwLineupPlayer[];
  reserves: Top4GwLineupPlayer[];
};

export type Top4GwsLineupsTeam = {
  team_id: number;
  code: string | null;
  name: string;
  lineups: Record<string, Top4GwLineupSaved | null>;
  /** ISO kickoff of the first GW match involving any club from the drafted squad. */
  deadlines: Record<string, string | null>;
};

export type Top4GwsLineupsPayload = {
  currentGw: number;
  nextGw: number;
  currentLabel: string;
  nextLabel: string;
  teams: Top4GwsLineupsTeam[];
};

type PlayerMeta = {
  name: string;
  club_id: string | null;
  club: string | null;
};

function emptyPlayer(pos: string | null): Top4GwLineupPlayer {
  return {
    id: "",
    name: "",
    short: "—",
    pos,
    club: null,
    opp: null,
  };
}

function loadPlayerMeta(
  db: Database.Database,
  ids: string[],
): Map<string, PlayerMeta> {
  const out = new Map<string, PlayerMeta>();
  if (!ids.length) return out;
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.club_id,
              c.club_code, c.short_name, c.name AS club_name
       FROM players p
       LEFT JOIN clubs c ON c.id = p.club_id
       WHERE p.id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids) as Array<{
    id: string;
    name: string;
    club_id: string | null;
    club_code: string | null;
    short_name: string | null;
    club_name: string | null;
  }>;
  for (const r of rows) {
    const clubId = r.club_id ? String(r.club_id) : null;
    out.set(String(r.id), {
      name: r.name,
      club_id: clubId,
      club: clubId
        ? clubCodeLabel(r.club_code, r.short_name || r.club_name)
        : null,
    });
  }
  return out;
}

function loadClubGwFixtures(
  db: Database.Database,
  clubIds: string[],
  gws: number[],
): ClubGwFixtures {
  const map: ClubGwFixtures = new Map();
  if (!clubIds.length || !gws.length) return map;
  const hasFixtures = !!db
    .prepare(
      `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'fixtures'`,
    )
    .get();
  const hasMap = !!db
    .prepare(
      `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'club_af_map'`,
    )
    .get();
  if (!hasFixtures || !hasMap) return map;

  const where = `${seasonGameweekWhere("f")} AND ${excludeIgnoredFixturesWhere("f")}`;
  const clubPh = clubIds.map(() => "?").join(",");
  const gwPh = gws.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT f.gameweek AS gw,
              f.af_league_id AS af_league_id,
              hm.club_id AS home_club_id,
              am.club_id AS away_club_id,
              f.home_name,
              f.away_name,
              hc.club_code AS home_club_code,
              ac.club_code AS away_club_code
       FROM fixtures f
       LEFT JOIN club_af_map hm ON hm.af_team_id = f.home_af_id
       LEFT JOIN club_af_map am ON am.af_team_id = f.away_af_id
       LEFT JOIN clubs hc ON hc.id = hm.club_id
       LEFT JOIN clubs ac ON ac.id = am.club_id
       WHERE ${where}
         AND f.gameweek IN (${gwPh})
         AND (hm.club_id IN (${clubPh}) OR am.club_id IN (${clubPh}))
       ORDER BY f.gameweek, f.date`,
    )
    .all(...gws, ...clubIds, ...clubIds) as Array<{
    gw: number;
    af_league_id: number | null;
    home_club_id: string | null;
    away_club_id: string | null;
    home_name: string;
    away_name: string;
    home_club_code: string | null;
    away_club_code: string | null;
  }>;

  const wanted = new Set(clubIds);
  for (const r of rows) {
    const gw = Number(r.gw);
    if (!Number.isFinite(gw) || gw < 1) continue;
    const afLeagueId =
      r.af_league_id == null ? null : Number(r.af_league_id);
    if (r.home_club_id && wanted.has(r.home_club_id)) {
      ingestFixtureRow(
        map,
        r.home_club_id,
        gw,
        true,
        clubCodeLabel(r.away_club_code, r.away_name),
        r.away_name || null,
        afLeagueId,
      );
    }
    if (r.away_club_id && wanted.has(r.away_club_id)) {
      ingestFixtureRow(
        map,
        r.away_club_id,
        gw,
        false,
        clubCodeLabel(r.home_club_code, r.home_name),
        r.home_name || null,
        afLeagueId,
      );
    }
  }
  return map;
}

function formatOppLabel(
  fixtures: readonly { isHome: boolean; opponent: string | null }[],
): string | null {
  if (!fixtures.length) return null;
  return fixtures
    .map((fx) => formatParenHaOpponent(fx.isHome, fx.opponent))
    .join(" ");
}

function playerEntry(
  id: string | null | undefined,
  pos: string | null,
  meta: Map<string, PlayerMeta>,
  clubFixtures: ClubGwFixtures,
  gw: number,
): Top4GwLineupPlayer | null {
  if (!id) return null;
  const info = meta.get(id);
  const name = info?.name ?? id;
  const clubId = info?.club_id ?? null;
  const fixtures = clubId
    ? (clubFixtures.get(clubId)?.get(gw) ?? [])
    : [];
  return {
    id,
    name,
    short: shortSurname(name),
    pos: pos || null,
    club: info?.club ?? null,
    opp: formatOppLabel(fixtures),
  };
}

function packLineup(
  formation: FormationTemplate,
  slotsJson: string,
  updatedAt: string,
  meta: Map<string, PlayerMeta>,
  clubFixtures: ClubGwFixtures,
  gw: number,
): Top4GwLineupSaved {
  const parsed = parseSlotsJson(slotsJson);
  const xi: Top4GwLineupPlayer[] = [];
  for (let i = 0; i < formation.slots.length; i++) {
    const id = parsed.slots[i] ?? null;
    const role =
      parsed.roles[i] ||
      (formation.slots[i]?.[0] ? String(formation.slots[i][0]) : null);
    const entry = playerEntry(id, role, meta, clubFixtures, gw);
    xi.push(entry ?? emptyPlayer(role));
  }
  // lineup.html bench: up to 7 slots (R1=GK … R7). Show every occupied slot.
  const reserves: Top4GwLineupPlayer[] = [];
  for (let i = 0; i < parsed.bench.length; i++) {
    const id = parsed.bench[i] ?? null;
    if (!id) continue;
    const role = parsed.benchRoles[i] || (i === 0 ? "GK" : null);
    const entry = playerEntry(id, role, meta, clubFixtures, gw);
    if (!entry) continue;
    reserves.push({ ...entry, r: `R${i + 1}` });
  }
  return {
    formation: formation.id,
    updated_at: updatedAt,
    xi,
    reserves,
  };
}

export function buildTop4GwsLineupsPayload(
  db: Database.Database,
): Top4GwsLineupsPayload {
  ensureTop4ConsigliereSchema(db);
  const currentGw = Math.max(1, gameweekFromKickoff(new Date()));
  const nextGw = currentGw + 1;
  const gws = [currentGw, nextGw];

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
        }))
      : regs.map((r, i) => ({
          team_id: i + 1,
          email: r.email,
          name: r.team_name,
          code: r.team_code,
        }));

  const lineupRows = db
    .prepare(
      `SELECT team_id, gw, formation, slots_json, updated_at
       FROM top4_lineups WHERE gw IN (?, ?)`,
    )
    .all(currentGw, nextGw) as Array<{
    team_id: number;
    gw: number;
    formation: string;
    slots_json: string;
    updated_at: string;
  }>;

  const allIds = new Set<string>();
  const parsedRows: Array<{
    team_id: number;
    gw: number;
    formation: FormationTemplate;
    slots_json: string;
    updated_at: string;
  }> = [];
  for (const row of lineupRows) {
    const formation =
      formationById(row.formation, FORMATIONS) ??
      FORMATIONS.find((f) => f.id === row.formation) ??
      null;
    if (!formation) continue;
    const parsed = parseSlotsJson(row.slots_json);
    for (const id of [...parsed.slots, ...parsed.bench]) {
      if (id) allIds.add(id);
    }
    parsedRows.push({
      team_id: row.team_id,
      gw: row.gw,
      formation,
      slots_json: row.slots_json,
      updated_at: row.updated_at,
    });
  }
  const meta = loadPlayerMeta(db, [...allIds]);
  const clubIds = [
    ...new Set(
      [...meta.values()]
        .map((m) => m.club_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const clubFixtures = loadClubGwFixtures(db, clubIds, gws);

  const byTeamGw = new Map<string, Top4GwLineupSaved>();
  for (const row of parsedRows) {
    byTeamGw.set(
      `${row.team_id}:${row.gw}`,
      packLineup(
        row.formation,
        row.slots_json,
        row.updated_at,
        meta,
        clubFixtures,
        row.gw,
      ),
    );
  }

  const clubIdsByTeam = new Map<number, string[]>();
  for (const t of squads.teams) {
    clubIdsByTeam.set(t.team_id, [
      ...new Set(
        t.players
          .map((p) => (p.club_id ? String(p.club_id) : ""))
          .filter(Boolean),
      ),
    ]);
  }

  const teams: Top4GwsLineupsTeam[] = teamsSrc.map((t) => {
    const lineups: Record<string, Top4GwLineupSaved | null> = {};
    const deadlines: Record<string, string | null> = {};
    const squadClubIds = clubIdsByTeam.get(t.team_id) ?? [];
    for (const gw of gws) {
      lineups[String(gw)] = byTeamGw.get(`${t.team_id}:${gw}`) ?? null;
      deadlines[String(gw)] = loadSquadGwLock(db, squadClubIds, gw).deadlineAt;
    }
    return {
      team_id: t.team_id,
      code: t.code ?? null,
      name: t.name,
      lineups,
      deadlines,
    };
  });

  teams.sort((a, b) =>
    String(a.code || a.name).localeCompare(String(b.code || b.name)),
  );

  return {
    currentGw,
    nextGw,
    currentLabel: gameweekRange(currentGw).label,
    nextLabel: gameweekRange(nextGw).label,
    teams,
  };
}
