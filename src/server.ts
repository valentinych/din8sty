import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import Database from "better-sqlite3";
import { QUOTA_POOL, TOP8_LEAGUES } from "./leagues.js";
import {
  collectDistinctRoles,
  formatPositionDisplay,
  playerMatchesLineFilter,
  playerMatchesRoleFilter,
} from "./positions.js";
import { getPlayerById } from "./playerDetail.js";
import { refreshManagerSquadInfo } from "./lineupRefresh.js";
import {
  ensureAvailabilitySynced,
  forceSyncAvailability,
  loadAvailabilityForGw,
  loadAvailabilityForPlayer,
  loadAvailabilityForPlayers,
  loadAvailabilitySyncedAt,
} from "./playerAvailability.js";
import { listPlayerCoaches } from "./playerCoaches.js";
import { ensurePlayerCoaches } from "./coachSync.js";
import {
  compareRatingWageMv,
  loadWagePeers,
  trustedWageMap,
  withTrustedWage,
  withTrustedWageAsWagePw,
} from "./trustedWage.js";
import { resolvePlayerAvatarUrl, sanitizePortraitUrl } from "./playerAvatar.js";
import {
  defaultScheduleFilters,
  excludeIgnoredFixturesWhere,
  parseIncludeFriendlies,
  scheduleWhereClauses,
  seasonGameweekWhere,
} from "./fixturesFilter.js";
import {
  defaultTop4LineupGw,
  gameweekFromKickoff,
  gameweekRange,
  lineupDeadlinePassed,
} from "./gameweeks.js";
import { purgePlaceholderKickoffFixtures } from "./fixtureUpsert.js";
import {
  clearSessionCookie,
  getSessionUser,
  isAdminEmail,
  isSecureRequest,
  mintSessionToken,
  panenkaSsoUrl,
  safeNextPath,
  setSessionCookie,
  verifyToken,
  type AuthUser,
} from "./auth.js";
import { CELESTIAL_TEAMS, teamById } from "./teams.js";
import { FORMATIONS } from "./primerDraft.js";
import {
  ensureTop4Tables,
  getRegistration,
  getTop4State,
  isRegistered,
  listTop4Registrations,
  listTop4Wishlist,
  parseLotteryOrder,
  registerTop4,
  reorderTop4Wishlist,
  resetTop4League,
  runTop4Lottery,
  top4RulesPublic,
  TOP4_IDS,
  TOP4_TEAM_COUNT,
  unregisterTop4,
  updateTop4TeamName,
  updateTop4TeamCode,
} from "./top4League.js";
import {
  addToTop4WishlistAs,
  assertWishlistActor,
  canEditTop4TeamAs,
  ensureTop4ConsigliereSchema,
  getRegistrationFull,
  getTop4Lineup,
  listConsigliereClients,
  listTop4RegistrationsFull,
  managerEmailForTop4Team,
  removeFromTop4WishlistAs,
  resolveTop4Owner,
  setTop4Consigliere,
  upsertTop4Lineup,
  wishlistHasManagerPicks,
} from "./top4Consigliere.js";
import { isClubLocked, loadSquadGwLock } from "./top4LineupLock.js";
import {
  createDraftRoomSet,
  deleteDraftRoomSet,
  DRAFT_ROOM_MAX_SETS,
  draftRoomAllowedPlayerIds,
  draftRoomFormationsPublic,
  ensureTop4DraftRoomTables,
  listDraftRoomSets,
  updateDraftRoomSet,
  type DraftRoomPoolPlayer,
  type DraftRoomSlot,
} from "./top4DraftRoom.js";
import {
  assertTop4WishlistPlayerEligible,
  attemptManualPick,
  fillVacancy,
  getLiveDraftPublic,
  getTop4SquadsPublic,
  pruneTop4WishlistForDraft,
  removeAutoPicks,
  replaceAutoPick,
  setTop4DraftFinished,
  setTop4OutOfDraft,
  startLiveDraft,
  tickLiveDraft,
} from "./top4LiveDraft.js";
import { parseAdminDraftHours } from "./draftHours.js";
import { loadTop4SeasonScores } from "./top4SeasonCache.js";
import {
  buildTop4CurrentSeasonPayload,
  isCurrentTop4SeasonSlug,
} from "./top4CurrentSeason.js";
import {
  compMultiplierForAfLeague,
  TOP4_SEASON_SLUG,
} from "./top4SeasonFpts.js";
import { fullTeamsByFixtureId, xiTeamsByFixtureId } from "./top4ScheduleXi.js";
import {
  buildTop4LiveStandingPayload,
  buildTop4MySquadPayload,
  buildTop4ResultsPayload,
  computeRosterForm,
  computeRosterGwFpts,
  computeTop4SquadsSeasonFpts,
  computeTop4TeamGwResult,
  ensureLiveGwStatsSynced,
  getIndexGwFpMap,
  top4GwHasKickedOff,
} from "./top4GwResults.js";
import { buildTop4GwsLineupsPayload } from "./top4GwsLineups.js";
import {
  adminPassCurrentTurn,
  dumpTransferPlayer,
  getTransferBoard,
  getTransferSummary,
  listFormerPlayersByTeam,
  openTransferWindow,
  passTransferTurn,
  pickTransferPlayer,
} from "./top4Transfers.js";
import {
  addToTop8Wishlist,
  ensureTop8Tables,
  getRegistration as getTop8Registration,
  getTop8State,
  isRegistered as isTop8Registered,
  listTop8Registrations,
  listTop8Wishlist,
  parseLotteryOrder as parseTop8LotteryOrder,
  registerTop8,
  removeFromTop8Wishlist,
  reorderTop8Wishlist,
  resetTop8League,
  runTop8Lottery,
  setTop8Draft,
  setTop8Status,
  top8RulesPublic,
  TOP8_TEAM_COUNT,
  unregisterTop8,
  updateTop8TeamName,
} from "./top8League.js";
import { runTop8SnakeDraft } from "./top8Draft.js";
import { loadTop8SeasonScores } from "./top8SeasonCache.js";
import { TOP8_SEASON_SLUG } from "./top8SeasonFpts.js";
import {
  estimateXPtsForGw,
  ingestFixtureRow,
  type ClubGwFixtures,
} from "./primerLineups.js";
import {
  fixtureOpponentLabel,
  formationById,
  parseSlotsJson,
  pitchFormations,
  serializeSlotsJson,
  validateBenchSlots,
  validateLineupSlots,
  type LineupSlotRole,
} from "./userLineups.js";
import { clubCodeLabel } from "./clubCode.js";
import {
  applyFmMatch,
  listPlayersMissingFm,
  scrapeFmPlayer,
} from "./fmManualMatch.js";
import {
  clearTop4Logo,
  deleteTop4LogoFilesForEmail,
  ensureTop4LogoDir,
  ensureTop4LogoSchema,
  resolveTop4LogoFile,
  saveTop4Logo,
  TOP4_LOGO_MAX_BYTES,
  TOP4_LOGO_PUBLIC_PREFIX,
} from "./top4TeamLogo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const dbPath = process.env.DIN8STY_DB ?? path.join(root, "data", "din8sty.db");
const dataDir = path.dirname(dbPath);
const port = Number(process.env.PORT ?? 3080);
const host = process.env.HOST ?? "0.0.0.0";

const db = new Database(dbPath, { readonly: true });
// Writable handle for transfers + user↔team mapping (same file; data volume is rw).
let dbWrite: Database.Database | null = null;
try {
  dbWrite = new Database(dbPath);
  dbWrite.exec(`
    CREATE TABLE IF NOT EXISTS user_team_map (
      email TEXT PRIMARY KEY COLLATE NOCASE,
      team_id INTEGER NOT NULL,
      team_name TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );
    CREATE TABLE IF NOT EXISTS user_lineups (
      team_id INTEGER NOT NULL,
      gw INTEGER NOT NULL,
      formation TEXT NOT NULL,
      slots_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT,
      PRIMARY KEY (team_id, gw)
    );
  `);
  ensureTop4Tables(dbWrite);
  ensureTop8Tables(dbWrite);
  try {
    const purged = purgePlaceholderKickoffFixtures(dbWrite);
    if (purged) console.log(`purged ${purged} placeholder fixture kickoffs`);
  } catch (err) {
    console.warn(
      "placeholder fixture purge:",
      err instanceof Error ? err.message : err,
    );
  }
} catch (err) {
  console.warn(
    "db write disabled (transfers + user_team_map + user_lineups):",
    err instanceof Error ? err.message : err,
  );
}

type TeamAssignment = { team_id: number; team_name: string };

function getTeamForEmail(email: string): TeamAssignment | null {
  if (!dbWrite) return null;
  const row = dbWrite
    .prepare(`SELECT team_id, team_name FROM user_team_map WHERE email = ? COLLATE NOCASE`)
    .get(email.toLowerCase()) as TeamAssignment | undefined;
  return row ?? null;
}

function listTeamMappings(): Array<{
  email: string;
  team_id: number;
  team_name: string;
  updated_at: string;
  updated_by: string | null;
}> {
  if (!dbWrite) return [];
  return dbWrite
    .prepare(
      `SELECT email, team_id, team_name, updated_at, updated_by
       FROM user_team_map
       ORDER BY team_id ASC, email ASC`,
    )
    .all() as Array<{
    email: string;
    team_id: number;
    team_name: string;
    updated_at: string;
    updated_by: string | null;
  }>;
}

/** Distinct team ids that already have a user in user_team_map (no emails). */
function listClaimedTeamIds(): number[] {
  if (!dbWrite) return [];
  const rows = dbWrite
    .prepare(`SELECT DISTINCT team_id FROM user_team_map ORDER BY team_id ASC`)
    .all() as Array<{ team_id: number }>;
  return rows.map((r) => r.team_id);
}

function upsertTeamMapping(
  email: string,
  teamId: number,
  updatedBy: string,
): TeamAssignment {
  if (!dbWrite) throw new Error("db_write_unavailable");
  const team = teamById(teamId);
  if (!team) throw new Error("unknown_team");
  const now = new Date().toISOString();
  dbWrite
    .prepare(
      `INSERT INTO user_team_map (email, team_id, team_name, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         team_id = excluded.team_id,
         team_name = excluded.team_name,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
    )
    .run(email.toLowerCase(), team.id, team.name, now, updatedBy);
  return { team_id: team.id, team_name: team.name };
}

function deleteTeamMapping(email: string): void {
  if (!dbWrite) throw new Error("db_write_unavailable");
  dbWrite
    .prepare(`DELETE FROM user_team_map WHERE email = ? COLLATE NOCASE`)
    .run(email.toLowerCase());
}

type SavedLineup = {
  team_id: number;
  gw: number;
  formation: string;
  slots: Array<string | null>;
  roles: Array<LineupSlotRole>;
  bench: Array<string | null>;
  bench_roles: Array<LineupSlotRole>;
  updated_at: string;
  updated_by: string | null;
};

function getSavedLineup(teamId: number, gw: number): SavedLineup | null {
  if (!dbWrite) return null;
  const row = dbWrite
    .prepare(
      `SELECT team_id, gw, formation, slots_json, updated_at, updated_by
       FROM user_lineups WHERE team_id = ? AND gw = ?`,
    )
    .get(teamId, gw) as
    | {
        team_id: number;
        gw: number;
        formation: string;
        slots_json: string;
        updated_at: string;
        updated_by: string | null;
      }
    | undefined;
  if (!row) return null;
  const parsed = parseSlotsJson(row.slots_json);
  return {
    team_id: row.team_id,
    gw: row.gw,
    formation: row.formation,
    slots: parsed.slots,
    roles: parsed.roles,
    bench: parsed.bench,
    bench_roles: parsed.benchRoles,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
  };
}

function upsertLineup(
  teamId: number,
  gw: number,
  formation: string,
  slots: Array<string | null>,
  roles: Array<LineupSlotRole>,
  bench: Array<string | null>,
  benchRoles: Array<LineupSlotRole>,
  updatedBy: string,
): SavedLineup {
  if (!dbWrite) throw new Error("db_write_unavailable");
  const now = new Date().toISOString();
  dbWrite
    .prepare(
      `INSERT INTO user_lineups (team_id, gw, formation, slots_json, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(team_id, gw) DO UPDATE SET
         formation = excluded.formation,
         slots_json = excluded.slots_json,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
    )
    .run(
      teamId,
      gw,
      formation,
      serializeSlotsJson(slots, roles, bench, benchRoles),
      now,
      updatedBy,
    );
  return {
    team_id: teamId,
    gw,
    formation,
    slots,
    roles,
    bench,
    bench_roles: benchRoles,
    updated_at: now,
    updated_by: updatedBy,
  };
}

type PrimerTeamLite = {
  id: number;
  name: string;
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
    pick?: number;
  }>;
  gameweeks?: Array<{
    gw: number;
    formation: string;
    formation_label: string;
    xi: Array<{ id: string }>;
    bench?: Array<{ id: string }>;
  }>;
};

function loadPrimerTeam(teamId: number): PrimerTeamLite | null {
  const primerPath = path.join(root, "data", "primer-draft.json");
  if (!fs.existsSync(primerPath)) return null;
  const data = JSON.parse(fs.readFileSync(primerPath, "utf8")) as {
    teams?: PrimerTeamLite[];
  };
  return data.teams?.find((t) => t.id === teamId) ?? null;
}

type Top4DraftTeamLite = {
  id: number;
  name: string;
  players: PrimerTeamLite["players"];
  vacancies?: number;
};

function loadTop4DraftSnapshot(): {
  teams: Top4DraftTeamLite[];
  managers: Array<{ team_id: number; email: string; team_name: string }>;
} | null {
  if (!dbWrite) return null;
  const state = getTop4State(dbWrite);

  // Prefer live `top4_draft_picks` (same source as squads tab) once lottery exists.
  if (
    state.lottery_order_json &&
    (state.status === "drafting" ||
      state.status === "complete" ||
      state.status === "lottery_done")
  ) {
    const squads = getTop4SquadsPublic(dbWrite);
    if (squads.teams.length) {
      return {
        teams: squads.teams.map((t) => ({
          id: t.team_id,
          name: t.team_name,
          vacancies: t.vacancies,
          players: t.players.map((p) => ({
            id: p.id,
            name: p.name,
            club_id: p.club_id,
            club_name: p.club_name,
            league_id: p.league_id,
            league_name: "",
            position_display: p.position_display,
            fm_rating: p.fm_rating ?? 0,
            market_value_eur: p.market_value_eur,
            wage_pw: p.wage_pw,
            // Live squads omit avatars; lineup API re-enriches from players+clubs.
            portrait_url: null,
            pick: p.pick_number,
          })),
        })),
        managers: squads.teams.map((t) => ({
          team_id: t.team_id,
          email: t.email,
          team_name: t.team_name,
        })),
      };
    }
  }

  if (!state.draft_json || state.status !== "complete") return null;
  try {
    const draft = JSON.parse(state.draft_json) as {
      teams?: Top4DraftTeamLite[];
      managers?: Array<{ team_id: number; email: string; team_name: string }>;
    };
    if (!draft.teams?.length) return null;
    return {
      teams: draft.teams,
      managers: draft.managers || [],
    };
  } catch {
    return null;
  }
}

function loadTop4DraftTeam(teamId: number): Top4DraftTeamLite | null {
  return loadTop4DraftSnapshot()?.teams.find((t) => t.id === teamId) ?? null;
}

/** Fresh portrait + current club crest for lineup chips (live picks omit avatars). */
function loadPlayerAvatarMap(
  playerIds: string[],
): Map<string, { portrait_url: string | null; club_crest: string | null }> {
  const map = new Map<
    string,
    { portrait_url: string | null; club_crest: string | null }
  >();
  if (!playerIds.length) return map;
  const rows = db
    .prepare(
      `SELECT p.id, p.portrait_url, c.crest_url AS club_crest
       FROM players p
       LEFT JOIN clubs c ON c.id = p.club_id
       WHERE p.id IN (${playerIds.map(() => "?").join(",")})`,
    )
    .all(...playerIds) as Array<{
    id: string;
    portrait_url: string | null;
    club_crest: string | null;
  }>;
  for (const r of rows) {
    const crest =
      r.club_crest != null && String(r.club_crest).trim()
        ? String(r.club_crest).trim()
        : null;
    map.set(String(r.id), {
      portrait_url: sanitizePortraitUrl(r.portrait_url),
      club_crest: crest,
    });
  }
  return map;
}

function attachSquadClubAndAvailability<
  T extends {
    teams: Array<{
      team_id?: number;
      players: Array<{ id: string; club_name?: string }>;
    }>;
  },
>(squads: T): T {
  const formerByTeam = listFormerPlayersByTeam(dbWrite ?? db);
  const ids = [
    ...squads.teams.flatMap((t) => t.players.map((p) => p.id)),
    ...[...formerByTeam.values()].flatMap((list) => list.map((p) => p.id)),
  ];
  const avatars = loadPlayerAvatarMap(ids);
  const avail = loadAvailabilityForPlayers(dbWrite ?? db, ids);
  const fpts = computeTop4SquadsSeasonFpts(dbWrite ?? db);
  return {
    ...squads,
    teams: squads.teams.map((t) => ({
      ...t,
      players: t.players.map((p) => {
        const fp = fpts.get(String(p.id));
        return {
          ...p,
          club_crest: avatars.get(p.id)?.club_crest ?? null,
          availability: avail.get(p.id) ?? null,
          brought: fp?.brought ?? 0,
          scored: fp?.scored ?? 0,
        };
      }),
      former: (formerByTeam.get(Number(t.team_id)) || []).map((p) => {
        const fp = fpts.get(String(p.id));
        return {
          ...p,
          club_crest: avatars.get(p.id)?.club_crest ?? null,
          brought: fp?.brought ?? 0,
          scored: fp?.scored ?? 0,
        };
      }),
    })),
  };
}

function loadClubGwFixturesForClubs(clubIds: string[]): ClubGwFixtures {
  const map: ClubGwFixtures = new Map();
  if (!clubIds.length) return map;
  const hasFixtures = !!db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'fixtures'`)
    .get();
  const hasMap = !!db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'club_af_map'`)
    .get();
  if (!hasFixtures || !hasMap) return map;

  const where = `${seasonGameweekWhere("f")} AND ${excludeIgnoredFixturesWhere("f")}`;
  const placeholders = clubIds.map(() => "?").join(",");
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
         AND (hm.club_id IN (${placeholders}) OR am.club_id IN (${placeholders}))
       ORDER BY f.gameweek, f.date`,
    )
    .all(...clubIds, ...clubIds) as Array<{
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

/** Save/edit: only the logged-in user's mapped team (admin email does not bypass). */
function canEditTeam(user: AuthUser | null, teamId: number): boolean {
  if (!user) return false;
  const mapped = getTeamForEmail(user.email);
  return Boolean(mapped && mapped.team_id === teamId);
}

/**
 * View lineup: own team always; other teams only after GW lineup deadline
 * (Fri 00:00 London start of that GW). No admin peek before deadline.
 */
function canViewTeamLineup(
  user: AuthUser | null,
  teamId: number,
  gw: number,
): boolean {
  if (!user) return false;
  if (canEditTeam(user, teamId)) return true;
  return lineupDeadlinePassed(gw);
}

function requireAdmin(req: FastifyRequest): AuthUser | null {
  const user = getSessionUser(req);
  if (!user || !isAdminEmail(user.email)) return null;
  return user;
}

type PlayerRow = Record<string, unknown>;

/** player_id → Top-4 fantasy team that drafted them (team_code + name). */
function loadTop4DraftOwnersByPlayerId(): Map<
  string,
  { code: string | null; name: string | null }
> {
  const out = new Map<string, { code: string | null; name: string | null }>();
  try {
    const exists = db
      .prepare(
        `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'top4_draft_picks'`,
      )
      .get() as { ok: number } | undefined;
    if (!exists) return out;
    const rows = db
      .prepare(
        `SELECT dp.player_id AS player_id,
                r.team_code AS team_code,
                NULLIF(TRIM(r.team_name), '') AS team_name
         FROM top4_draft_picks dp
         LEFT JOIN top4_registrations r ON r.email = dp.email COLLATE NOCASE`,
      )
      .all() as Array<{
      player_id: string;
      team_code: string | null;
      team_name: string | null;
    }>;
    for (const r of rows) {
      const code = r.team_code?.trim()?.toUpperCase() || null;
      out.set(String(r.player_id), { code, name: r.team_name || null });
    }
  } catch {
    // Top-4 tables may be absent on a fresh/partial DB.
  }
  return out;
}

function draftPicksTableExists(): boolean {
  try {
    const row = db
      .prepare(
        `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'top4_draft_picks'`,
      )
      .get() as { ok: number } | undefined;
    return Boolean(row);
  } catch {
    return false;
  }
}

function listPlayers(opts: {
  league?: string;
  leagues?: string[];
  club?: string;
  q?: string;
  line?: string;
  pos?: string;
  sort?: string;
  hidePicked?: boolean;
  hideNonTop4?: boolean;
  fpByPlayerId?: Map<string, number>;
  limit?: number;
  offset?: number;
}) {
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts.leagues?.length) {
    where.push(`p.league_id IN (${opts.leagues.map(() => "?").join(",")})`);
    params.push(...opts.leagues);
  } else if (opts.league) {
    where.push("p.league_id = ?");
    params.push(opts.league);
  }
  if (opts.hideNonTop4) {
    where.push(`p.league_id IN (${TOP4_IDS.map(() => "?").join(",")})`);
    params.push(...TOP4_IDS);
  }
  if (opts.club) {
    where.push("p.club_id = ?");
    params.push(opts.club);
  }
  if (opts.q) {
    where.push("(p.name LIKE ? OR c.name LIKE ? OR p.nationality LIKE ?)");
    const like = `%${opts.q}%`;
    params.push(like, like, like);
  }
  if (opts.hidePicked && draftPicksTableExists()) {
    where.push(
      `NOT EXISTS (SELECT 1 FROM top4_draft_picks dp WHERE dp.player_id = p.id)`,
    );
  }

  const sortTrustedWage = opts.sort === "wage-desc";
  const sortFp = opts.sort === "fp-desc" || opts.sort === "fp-asc";
  const order =
    opts.sort === "rating-desc"
      ? "COALESCE(p.fm_rating, -1) DESC, COALESCE(p.market_value_eur, 0) DESC"
      : sortTrustedWage || sortFp
        ? "p.name ASC"
        : opts.sort === "age-asc"
          ? "COALESCE(p.age, 99) ASC"
          : opts.sort === "name"
            ? "p.name ASC"
            : "COALESCE(p.market_value_eur, 0) DESC, p.name ASC";

  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 5000);
  const offset = Math.max(opts.offset ?? 0, 0);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const baseSql = `SELECT p.*, c.name AS club_name, c.crest_url AS club_crest, l.name AS league_name
       FROM players p
       JOIN clubs c ON c.id = p.club_id
       JOIN leagues l ON l.id = p.league_id
       ${whereSql}
       ORDER BY ${order}`;

  const peers = loadWagePeers(db);
  const draftOwners = loadTop4DraftOwnersByPlayerId();
  const fpOf = (id: unknown): number =>
    Math.round((opts.fpByPlayerId?.get(String(id)) ?? 0) * 100) / 100;
  const enrich = (
    row: PlayerRow,
  ): PlayerRow & {
    trusted_wage_pw: number;
    trusted_wage_source: string;
    draft_team_code: string | null;
    draft_team_name: string | null;
    fp: number;
  } => {
    const owner = draftOwners.get(String(row.id));
    return withTrustedWage(
      {
        ...row,
        position_display: formatPositionDisplay(row),
        draft_team_code: owner?.code ?? null,
        draft_team_name: owner?.name ?? null,
        fp: fpOf(row.id),
      },
      peers,
    );
  };

  // Trusted wage / FP are computed in JS — enrich before sort/paginate.
  if (opts.line || opts.pos || sortTrustedWage || sortFp) {
    const allRows = db.prepare(baseSql).all(...params) as PlayerRow[];
    const filtered = allRows.filter((row) => {
      if (opts.line && !playerMatchesLineFilter(row, opts.line)) return false;
      if (opts.pos && !playerMatchesRoleFilter(row, opts.pos)) return false;
      return true;
    });
    const enriched = filtered.map(enrich);
    if (sortTrustedWage) {
      enriched.sort(
        (a, b) =>
          (Number(b.trusted_wage_pw) || -1) - (Number(a.trusted_wage_pw) || -1) ||
          String(a.name ?? "").localeCompare(String(b.name ?? "")),
      );
    } else if (sortFp) {
      const dir = opts.sort === "fp-asc" ? 1 : -1;
      enriched.sort(
        (a, b) =>
          dir * ((Number(a.fp) || 0) - (Number(b.fp) || 0)) ||
          String(a.name ?? "").localeCompare(String(b.name ?? "")),
      );
    }
    const players = enriched.slice(offset, offset + limit);
    return { total: enriched.length, limit, offset, players };
  }

  const total = (
    db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM players p
         JOIN clubs c ON c.id = p.club_id
         ${whereSql}`,
      )
      .get(...params) as { n: number }
  ).n;

  const rows = db.prepare(`${baseSql} LIMIT ? OFFSET ?`).all(...params, limit, offset) as PlayerRow[];

  return { total, limit, offset, players: rows.map(enrich) };
}

async function main() {
  const app = Fastify({ logger: true });

  app.addHook("onRequest", async (req, reply) => {
    const h = String(req.headers.host ?? "");
    if (h.startsWith("din8sty.panenka.games") || h.startsWith("localhost") || h.startsWith("127.0.0.1")) {
      return;
    }
    // Still serve on LAN IPs during local dev.
  });

  app.get("/api/health", async () => ({
    ok: true,
    host: "din8sty.panenka.games",
    db: dbPath,
    auth: Boolean(process.env.SSO_SECRET ?? process.env.AUTH_SECRET),
  }));

  /**
   * Which emails are known to @draftmantra_bot (H2H / FPL / UCL / Top-4 binds).
   * Auth: X-H2H-Bot-Secret (same secret as panenka H2H bot bridge).
   * Returns optional telegram username — from the bind row or the same
   * telegram_user_id in panenka_links / other bot tables.
   */
  app.get("/api/draftmantra/known-emails", async (req, reply) => {
    const secret = process.env.H2H_BOT_SECRET?.trim();
    const got = String(req.headers["x-h2h-bot-secret"] ?? "").trim();
    if (!secret || got !== secret) {
      return reply.code(401).send({ ok: false, error: "unauthorized" });
    }
    const q = req.query as { emails?: string };
    const emails = String(q.emails ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.includes("@"));
    if (!emails.length) {
      return {
        ok: true,
        known: [] as { email: string; telegram: string | null }[],
      };
    }

    const placeholders = emails.map(() => "?").join(",");
    type Hit = { email: string; telegram_user_id: number | null; telegram: string | null };
    const byEmail = new Map<string, Hit>();

    const cleanTg = (raw: string | null | undefined) => {
      const t = String(raw ?? "")
        .replace(/^@/, "")
        .trim();
      return t || null;
    };

    const mark = (
      email: string,
      telegramUserId: number | null | undefined,
      telegram?: string | null
    ) => {
      const e = email.trim().toLowerCase();
      if (!e) return;
      const tg = cleanTg(telegram);
      const prev = byEmail.get(e);
      if (!prev) {
        byEmail.set(e, {
          email: e,
          telegram_user_id: telegramUserId ?? null,
          telegram: tg,
        });
        return;
      }
      if (prev.telegram_user_id == null && telegramUserId != null) {
        prev.telegram_user_id = telegramUserId;
      }
      if (!prev.telegram && tg) prev.telegram = tg;
    };

    const emailTables = [
      { table: "h2h_telegram_links", hasTg: true },
      { table: "fpl_telegram_links", hasTg: true },
      { table: "ucl_telegram_links", hasTg: true },
      { table: "top4_telegram_links", hasTg: true },
    ] as const;
    for (const { table, hasTg } of emailTables) {
      try {
        const sql = hasTg
          ? `SELECT lower(email) AS email, telegram_user_id, tg_username AS telegram
             FROM ${table} WHERE lower(email) IN (${placeholders})`
          : `SELECT lower(email) AS email, telegram_user_id, NULL AS telegram
             FROM ${table} WHERE lower(email) IN (${placeholders})`;
        for (const r of db.prepare(sql).all(...emails) as Hit[]) {
          mark(r.email, r.telegram_user_id, r.telegram);
        }
      } catch {
        /* older DB / missing tg_username column — retry without username */
        try {
          const rows = db
            .prepare(
              `SELECT lower(email) AS email, telegram_user_id, NULL AS telegram
               FROM ${table} WHERE lower(email) IN (${placeholders})`
            )
            .all(...emails) as Hit[];
          for (const r of rows) mark(r.email, r.telegram_user_id, r.telegram);
        } catch {
          /* table missing */
        }
      }
    }

    // Fill missing usernames from any table keyed by the same telegram_user_id.
    const ids = [
      ...new Set(
        [...byEmail.values()]
          .map((h) => h.telegram_user_id)
          .filter((id): id is number => id != null)
      ),
    ];
    if (ids.length) {
      const idPh = ids.map(() => "?").join(",");
      const usernameSources = [
        "SELECT telegram_user_id, tg_username AS telegram FROM panenka_links WHERE telegram_user_id IN (" +
          idPh +
          ") AND tg_username IS NOT NULL AND tg_username != ''",
        "SELECT telegram_user_id, tg_username AS telegram FROM top4_telegram_links WHERE telegram_user_id IN (" +
          idPh +
          ") AND tg_username IS NOT NULL AND tg_username != ''",
        "SELECT telegram_user_id, tg_username AS telegram FROM fpl_telegram_links WHERE telegram_user_id IN (" +
          idPh +
          ") AND tg_username IS NOT NULL AND tg_username != ''",
        "SELECT telegram_user_id, tg_username AS telegram FROM ucl_telegram_links WHERE telegram_user_id IN (" +
          idPh +
          ") AND tg_username IS NOT NULL AND tg_username != ''",
      ];
      const byId = new Map<number, string>();
      for (const sql of usernameSources) {
        try {
          for (const r of db.prepare(sql).all(...ids) as {
            telegram_user_id: number;
            telegram: string;
          }[]) {
            const tg = cleanTg(r.telegram);
            if (tg && !byId.has(r.telegram_user_id)) byId.set(r.telegram_user_id, tg);
          }
        } catch {
          /* ignore */
        }
      }
      for (const hit of byEmail.values()) {
        if (hit.telegram || hit.telegram_user_id == null) continue;
        hit.telegram = byId.get(hit.telegram_user_id) ?? null;
      }
    }

    return {
      ok: true,
      known: [...byEmail.values()].map((h) => ({
        email: h.email,
        telegram: h.telegram,
      })),
    };
  });

  /** Current user + team assignment (null user when anonymous). claimedTeamIds has no emails. */
  app.get("/api/auth/me", async (req) => {
    const claimedTeamIds = listClaimedTeamIds();
    const user = getSessionUser(req);
    if (!user) {
      return { user: null, isAdmin: false, team: null, claimedTeamIds };
    }
    const team = getTeamForEmail(user.email);
    return {
      user: { email: user.email, name: user.name },
      isAdmin: isAdminEmail(user.email),
      team: team ? { id: team.team_id, name: team.team_name } : null,
      claimedTeamIds,
    };
  });

  /** Kick off panenka.games Google login → SSO handoff. */
  app.get("/api/auth/login", async (req, reply) => {
    const q = req.query as { next?: string };
    const next = safeNextPath(q.next);
    const hostHeader = String(req.headers.host ?? `127.0.0.1:${port}`);
    const proto = isSecureRequest(req) ? "https" : "http";
    const callbackUrl = `${proto}://${hostHeader}/api/auth/callback`;
    return reply.redirect(panenkaSsoUrl(callbackUrl, next));
  });

  /** Consume one-time SSO token from panenka.games, set session cookie. */
  app.get("/api/auth/callback", async (req, reply) => {
    const q = req.query as { token?: string; next?: string };
    const next = safeNextPath(q.next);
    const payload = q.token ? verifyToken(q.token) : null;
    if (!payload) {
      return reply.code(400).type("text/html").send(
        `<!doctype html><meta charset="utf-8"><title>Login failed</title>
         <p>Не удалось войти через panenka.games.</p>
         <p><a href="/api/auth/login?next=${encodeURIComponent(next)}">Попробовать снова</a></p>`,
      );
    }
    const token = mintSessionToken({ email: payload.email, name: payload.name });
    setSessionCookie(reply, token, isSecureRequest(req));
    return reply.redirect(next);
  });

  app.post("/api/auth/logout", async (req, reply) => {
    clearSessionCookie(reply, isSecureRequest(req));
    return { ok: true };
  });

  app.get("/api/auth/logout", async (req, reply) => {
    clearSessionCookie(reply, isSecureRequest(req));
    const q = req.query as { next?: string };
    return reply.redirect(safeNextPath(q.next));
  });

  /** Топ-4 катка: state, registrations, rules, draft snapshot. */
  app.get("/api/top4", async (req) => {
    if (!dbWrite) {
      return {
        rules: top4RulesPublic(),
        status: "open",
        registrations: [],
        lottery: null,
        draft: null,
        live: null,
        squads: { status: "open", teams: [] },
        me: { registered: false, user: null, isAdmin: false },
        slots: { taken: 0, total: TOP4_TEAM_COUNT },
        error: "db_write_unavailable",
      };
    }
    ensureTop4ConsigliereSchema(dbWrite);
    ensureTop4LogoSchema(dbWrite);
    ensureTop4LogoDir(dataDir);
    const user = getSessionUser(req);
    const state = getTop4State(dbWrite);
    const registrations = listTop4RegistrationsFull(dbWrite);
    let draft = null;
    if (state.draft_json) {
      try {
        draft = JSON.parse(state.draft_json);
      } catch {
        draft = null;
      }
    }
    const registration = user ? getRegistrationFull(dbWrite, user.email) : null;
    const consigliereFor = user
      ? listConsigliereClients(dbWrite, user.email)
      : [];
    const wishlistOwner =
      registration?.email ||
      (consigliereFor.length === 1 ? consigliereFor[0].email : null);
    const wishlistIds = wishlistOwner
      ? listTop4Wishlist(dbWrite, wishlistOwner).map((w) => w.player_id)
      : [];
    const wishlistEditable = (() => {
      if (state.status === "complete") return false;
      if (registration) return true;
      if (consigliereFor.length === 1) {
        return !wishlistHasManagerPicks(dbWrite, consigliereFor[0].email);
      }
      return false;
    })();
    const live = state.status === "drafting" ? getLiveDraftPublic(dbWrite) : null;
    await ensureAvailabilitySynced(dbWrite).catch((err) => {
      console.warn(
        "availability sync:",
        err instanceof Error ? err.message : err,
      );
    });
    const squads = attachSquadClubAndAvailability(getTop4SquadsPublic(dbWrite));
    const onClockEmail = live?.on_clock?.email?.toLowerCase() ?? null;
    const myTurn = Boolean(
      user &&
        onClockEmail &&
        ((registration && registration.email.toLowerCase() === onClockEmail) ||
          (consigliereFor.some((c) => c.email.toLowerCase() === onClockEmail) &&
            !wishlistHasManagerPicks(dbWrite, onClockEmail))),
    );
    return {
      rules: top4RulesPublic(),
      status: state.status,
      updated_at: state.updated_at,
      registrations,
      lottery: parseLotteryOrder(state),
      draft,
      live,
      squads,
      me: {
        user: user ? { email: user.email, name: user.name } : null,
        isAdmin: isAdminEmail(user?.email),
        registered: Boolean(registration),
        registration,
        consigliere_email: registration?.consigliere_email ?? null,
        consigliere_for: consigliereFor,
        wishlist_owner: wishlistOwner,
        wishlistIds,
        wishlistEditable,
        wishlist_locked_by_manager:
          Boolean(wishlistOwner) &&
          !registration &&
          wishlistHasManagerPicks(dbWrite, wishlistOwner!),
        my_turn: myTurn,
      },
      slots: { taken: registrations.length, total: TOP4_TEAM_COUNT },
      transfers: (() => {
        try {
          return getTransferSummary(dbWrite, {
            isAdmin: isAdminEmail(user?.email),
          });
        } catch {
          return {
            current_gw: 0,
            preview_gw: null,
            can_open: false,
            window: null,
          };
        }
      })(),
    };
  });

  /** Manager assigns / clears their consigliere (trusted deputy). */
  app.put("/api/top4/consigliere", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.code(401).send({ error: "login_required" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    const body = (req.body ?? {}) as {
      email?: string | null;
      consigliere?: string | null;
      consigliere_email?: string | null;
    };
    const raw =
      body.consigliere_email ?? body.consigliere ?? body.email ?? null;
    try {
      const registration = setTop4Consigliere(dbWrite, user.email, raw);
      return { ok: true, registration };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      const code =
        msg === "not_registered"
          ? 403
          : msg === "consigliere_email_invalid" ||
              msg === "consigliere_self" ||
              msg === "consigliere_not_participant"
            ? 400
            : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  /** Top-4 season fantasy scores: 2025-26 JSON cache, 2026-27 from GW FPTS. */
  app.get("/api/top4/season/:slug", async (req, reply) => {
    const slug = String((req.params as { slug?: string }).slug || "").trim();
    if (isCurrentTop4SeasonSlug(slug)) {
      if (!dbWrite) {
        return reply.code(503).send({ error: "db_write_unavailable" });
      }
      try {
        return await buildTop4CurrentSeasonPayload(dbWrite, { syncLimit: 25 });
      } catch (err) {
        return reply.code(500).send({
          error: err instanceof Error ? err.message : "season_failed",
        });
      }
    }
    const normalized =
      slug === "2025/26" || slug === "2025-26" || slug === "2526"
        ? TOP4_SEASON_SLUG
        : slug;
    const payload = loadTop4SeasonScores(dataDir, normalized);
    if (!payload) {
      return reply.code(404).send({
        error: "season_not_found",
        hint: "Run: npm run top4:season:sync",
        slug: normalized,
      });
    }
    return payload;
  });

  /**
   * Top-4 GW results from saved lineups + AF fixture stats (from GW2).
   * Lazily syncs a batch of finished fixture player stats when called.
   */
  app.get("/api/top4/results", async (_req, reply) => {
    if (!dbWrite) {
      return reply.code(503).send({ error: "db_write_unavailable" });
    }
    try {
      return await buildTop4ResultsPayload(dbWrite, { syncLimit: 25 });
    } catch (err) {
      return reply.code(500).send({
        error: err instanceof Error ? err.message : "results_failed",
      });
    }
  });

  app.get("/api/top4/results/:teamId/:gw", async (req, reply) => {
    if (!dbWrite) {
      return reply.code(503).send({ error: "db_write_unavailable" });
    }
    const { teamId: teamRaw, gw: gwRaw } = req.params as {
      teamId?: string;
      gw?: string;
    };
    const teamId = Number(teamRaw);
    const gw = Number(gwRaw);
    if (!Number.isFinite(teamId) || !Number.isFinite(gw)) {
      return reply.code(400).send({ error: "bad_request" });
    }
    try {
      const payload = computeTop4TeamGwResult(dbWrite, teamId, gw);
      if (!payload) return reply.code(404).send({ error: "not_found" });
      return payload;
    } catch (err) {
      return reply.code(500).send({
        error: err instanceof Error ? err.message : "results_gw_failed",
      });
    }
  });

  app.get("/api/top4/transfers", async (req, reply) => {
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    const user = getSessionUser(req);
    return getTransferBoard(dbWrite, {
      email: user?.email ?? null,
      isAdmin: isAdminEmail(user?.email),
    });
  });

  app.post("/api/top4/transfers/open", async (req, reply) => {
    if (!requireAdmin(req)) return reply.code(401).send({ error: "unauthorized" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    try {
      openTransferWindow(dbWrite, requireAdmin(req)!.email);
      return { ok: true, transfers: getTransferBoard(dbWrite, { isAdmin: true }) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      const code =
        msg === "window_not_preview" ||
        msg === "window_already_open" ||
        msg === "window_complete" ||
        msg === "no_standings"
          ? 409
          : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  app.post("/api/top4/transfers/dump", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.code(401).send({ error: "login_required" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    const body = (req.body ?? {}) as { playerId?: string; player_id?: string };
    const playerId = String(body.playerId ?? body.player_id ?? "").trim();
    try {
      dumpTransferPlayer(dbWrite, user.email, playerId);
      return {
        ok: true,
        transfers: getTransferBoard(dbWrite, {
          email: user.email,
          isAdmin: isAdminEmail(user.email),
        }),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      const code =
        msg === "not_your_turn"
          ? 403
          : msg === "window_not_open" || msg === "dump_limit" || msg === "player_not_on_roster"
            ? 409
            : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  app.post("/api/top4/transfers/pick", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.code(401).send({ error: "login_required" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    const body = (req.body ?? {}) as { playerId?: string; player_id?: string };
    const playerId = String(body.playerId ?? body.player_id ?? "").trim();
    try {
      pickTransferPlayer(dbWrite, user.email, playerId);
      return {
        ok: true,
        transfers: getTransferBoard(dbWrite, {
          email: user.email,
          isAdmin: isAdminEmail(user.email),
        }),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      const code =
        msg === "not_your_turn"
          ? 403
          : msg === "window_not_open" ||
              msg === "pick_limit" ||
              msg === "player_taken" ||
              msg === "player_not_eligible" ||
              msg === "over_mv" ||
              msg === "over_wage" ||
              msg === "club_limit"
            ? 409
            : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  app.post("/api/top4/transfers/pass", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.code(401).send({ error: "login_required" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    try {
      passTransferTurn(dbWrite, user.email);
      return {
        ok: true,
        transfers: getTransferBoard(dbWrite, {
          email: user.email,
          isAdmin: isAdminEmail(user.email),
        }),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      const code = msg === "not_your_turn" ? 403 : msg === "window_not_open" ? 409 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  app.post("/api/top4/transfers/admin-pass", async (req, reply) => {
    const admin = requireAdmin(req);
    if (!admin) return reply.code(401).send({ error: "unauthorized" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    try {
      adminPassCurrentTurn(dbWrite);
      return {
        ok: true,
        transfers: getTransferBoard(dbWrite, {
          email: admin.email,
          isAdmin: true,
        }),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      const code = msg === "window_not_open" ? 409 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  /**
   * Live GW standing: same FPTS math as results, current gameweek only,
   * including in-progress fixture player stats when AF has them.
   */
  app.get("/api/top4/live", async (_req, reply) => {
    if (!dbWrite) {
      return reply.code(503).send({ error: "db_write_unavailable" });
    }
    try {
      return await buildTop4LiveStandingPayload(dbWrite, { syncLimit: 20 });
    } catch (err) {
      return reply.code(500).send({
        error: err instanceof Error ? err.message : "live_standing_failed",
      });
    }
  });

  /**
   * Logged-in manager (or consigliere) squad FPTS by played GW.
   * Query: team_id optional — own team, else first accessible.
   */
  app.get("/api/top4/my-squad", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.code(401).send({ error: "login_required" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });

    ensureTop4ConsigliereSchema(dbWrite);
    const snap = loadTop4DraftSnapshot();
    if (!snap) {
      return reply.code(404).send({
        error: "top4_draft_required",
        message: "Составы Топ-4 доступны после завершения драфта.",
      });
    }
    const myManager = snap.managers.find(
      (m) => m.email.toLowerCase() === user.email.toLowerCase(),
    );
    const consigliereClients = listConsigliereClients(dbWrite, user.email);
    const accessible = snap.managers.filter(
      (m) =>
        m.email.toLowerCase() === user.email.toLowerCase() ||
        consigliereClients.some(
          (c) => c.email.toLowerCase() === m.email.toLowerCase(),
        ),
    );
    if (!accessible.length) {
      return reply.code(403).send({
        error: "no_top4_team",
        message: "Нет команды Топ-4 и вы не consigliere.",
      });
    }
    const q = req.query as { team_id?: string };
    let teamId = q.team_id ? Number(q.team_id) : NaN;
    if (!Number.isInteger(teamId)) {
      teamId = myManager?.team_id ?? accessible[0].team_id;
    }
    if (!accessible.some((m) => m.team_id === teamId)) {
      return reply.code(403).send({ error: "forbidden_team" });
    }

    try {
      const payload = await buildTop4MySquadPayload(dbWrite, teamId, {
        syncLimit: 25,
      });
      if (!payload) {
        return reply.code(400).send({ error: "invalid_team" });
      }
      const teams = accessible.map((m) => {
        const t = snap.teams.find((x) => x.id === m.team_id);
        return {
          id: m.team_id,
          name: t?.name || m.team_name,
        };
      });
      return { ...payload, teams };
    } catch (err) {
      return reply.code(500).send({
        error: err instanceof Error ? err.message : "my_squad_failed",
      });
    }
  });

  /**
   * Saved Top-4 lineups for current + next GW (columns = teams).
   * currentGw = gameweekFromKickoff(now); nextGw = currentGw + 1.
   */
  app.get("/api/top4/gws-lineups", async (_req, reply) => {
    if (!dbWrite) {
      return reply.code(503).send({ error: "db_write_unavailable" });
    }
    try {
      return buildTop4GwsLineupsPayload(dbWrite);
    } catch (err) {
      return reply.code(500).send({
        error: err instanceof Error ? err.message : "gws_lineups_failed",
      });
    }
  });

  app.post("/api/top4/register", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.code(401).send({ error: "login_required" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    const body = (req.body ?? {}) as { teamName?: string; team_name?: string };
    const teamName = body.teamName ?? body.team_name ?? "";
    try {
      const row = registerTop4(dbWrite, user.email, user.name, teamName);
      return {
        ok: true,
        registration: row,
        slots: {
          taken: listTop4Registrations(dbWrite).length,
          total: TOP4_TEAM_COUNT,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      const code =
        msg === "league_full" ||
        msg === "already_registered" ||
        msg === "registration_closed" ||
        msg === "team_name_taken"
          ? 409
          : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  app.put("/api/top4/team-name", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.code(401).send({ error: "login_required" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    const body = (req.body ?? {}) as { teamName?: string; team_name?: string };
    const teamName = body.teamName ?? body.team_name ?? "";
    try {
      const row = updateTop4TeamName(dbWrite, user.email, teamName);
      return { ok: true, registration: row };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      const code =
        msg === "registration_closed" ||
        msg === "not_registered" ||
        msg === "team_name_taken"
          ? 409
          : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  /** Manager sets/edits 3-letter team code (unique, A–Z). Editable any time. */
  app.put("/api/top4/team-code", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.code(401).send({ error: "login_required" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    const body = (req.body ?? {}) as { teamCode?: string; team_code?: string };
    const teamCode = body.teamCode ?? body.team_code ?? "";
    try {
      const row = updateTop4TeamCode(dbWrite, user.email, teamCode);
      return { ok: true, registration: getRegistrationFull(dbWrite, user.email) ?? row };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      const code =
        msg === "not_registered" || msg === "team_code_taken" ? 409 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  /** Manager uploads fantasy club logo (png/jpg/webp, ≤1.5MB). Base64 JSON body. */
  app.put(
    "/api/top4/logo",
    { bodyLimit: TOP4_LOGO_MAX_BYTES * 2 + 64_000 },
    async (req, reply) => {
      const user = getSessionUser(req);
      if (!user) return reply.code(401).send({ error: "login_required" });
      if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
      const body = (req.body ?? {}) as {
        image?: string;
        imageBase64?: string;
        data?: string;
      };
      const raw = String(body.image ?? body.imageBase64 ?? body.data ?? "").trim();
      if (!raw) return reply.code(400).send({ error: "logo_empty" });
      let b64 = raw;
      const dataUrl = /^data:image\/(png|jpeg|jpg|webp);base64,/i.exec(raw);
      if (dataUrl) {
        b64 = raw.slice(dataUrl[0].length);
      }
      let buf: Buffer;
      try {
        buf = Buffer.from(b64, "base64");
      } catch {
        return reply.code(400).send({ error: "logo_invalid" });
      }
      if (!buf.length) return reply.code(400).send({ error: "logo_empty" });
      try {
        const { logo_url } = saveTop4Logo(dbWrite, dataDir, user.email, buf);
        const registration = getRegistrationFull(dbWrite, user.email);
        return { ok: true, logo_url, registration };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "error";
        const code =
          msg === "not_registered"
            ? 403
            : msg === "logo_too_large"
              ? 413
              : 400;
        return reply.code(code).send({ error: msg });
      }
    },
  );

  app.delete("/api/top4/logo", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.code(401).send({ error: "login_required" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    try {
      clearTop4Logo(dbWrite, dataDir, user.email);
      const registration = getRegistrationFull(dbWrite, user.email);
      return { ok: true, logo_url: null, registration };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      return reply.code(msg === "not_registered" ? 403 : 400).send({ error: msg });
    }
  });

  app.post("/api/top4/unregister", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.code(401).send({ error: "login_required" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    try {
      deleteTop4LogoFilesForEmail(dbWrite, dataDir, user.email);
      unregisterTop4(dbWrite, user.email);
      return {
        ok: true,
        slots: {
          taken: listTop4Registrations(dbWrite).length,
          total: TOP4_TEAM_COUNT,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      return reply.code(msg === "registration_closed" ? 409 : 400).send({ error: msg });
    }
  });

  /** Wishlist for manager (or their consigliere when manager has no picks). */
  app.get("/api/top4/wishlist", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.code(401).send({ error: "login_required" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    const q = req.query as { owner?: string; for?: string };
    let ownerEmail: string;
    let asConsigliere: boolean;
    try {
      ({ ownerEmail, asConsigliere } = resolveTop4Owner(
        dbWrite,
        user.email,
        q.owner ?? q.for,
      ));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      return reply
        .code(msg === "not_registered" || msg === "not_consigliere" ? 403 : 400)
        .send({ error: msg });
    }
    const leagueStatus = getTop4State(dbWrite).status;
    if (leagueStatus === "drafting" || leagueStatus === "complete") {
      pruneTop4WishlistForDraft(dbWrite, ownerEmail);
    }
    const entries = listTop4Wishlist(dbWrite, ownerEmail);
    const editable =
      leagueStatus !== "complete" &&
      (!asConsigliere || !wishlistHasManagerPicks(dbWrite, ownerEmail));
    if (!entries.length) {
      return {
        items: [],
        editable,
        owner_email: ownerEmail,
        as_consigliere: asConsigliere,
      };
    }
    const placeholders = entries.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT p.id, p.name, p.fm_rating, p.market_value_eur, p.portrait_url,
                p.position, p.detail_role, p.detail_label, p.side_role,
                p.capology_wage_pw, p.fm_wage_pw,
                c.name AS club_name, c.crest_url AS club_crest, p.league_id
         FROM players p
         JOIN clubs c ON c.id = p.club_id
         WHERE p.id IN (${placeholders})`,
      )
      .all(...entries.map((e) => e.player_id)) as Array<Record<string, unknown>>;
    const peers = loadWagePeers(db);
    const byId = new Map(
      rows.map((r) => {
        const enriched = withTrustedWageAsWagePw(
          { ...r, position_display: formatPositionDisplay(r) },
          peers,
        ) as Record<string, unknown> & { wage_pw: number; position_display?: string };
        return [String(r.id), enriched];
      }),
    );
    const setByRows = db
      .prepare(
        `SELECT player_id, set_by FROM top4_wishlist WHERE email = ? COLLATE NOCASE`,
      )
      .all(ownerEmail.toLowerCase()) as Array<{ player_id: string; set_by: string }>;
    const setByMap = new Map(setByRows.map((r) => [r.player_id, r.set_by]));
    const items = entries
      .map((e) => {
        const p = byId.get(e.player_id);
        if (!p) return null;
        return {
          player_id: e.player_id,
          priority: e.priority,
          set_by: setByMap.get(e.player_id) || "manager",
          name: String(p.name),
          club_name: String(p.club_name),
          league_id: String(p.league_id),
          position_display: String(p.position_display ?? ""),
          fm_rating: p.fm_rating == null ? null : Number(p.fm_rating),
          market_value_eur: Number(p.market_value_eur) || 0,
          wage_pw: Number(p.wage_pw) || 0,
          portrait_url: resolvePlayerAvatarUrl(
            p.portrait_url as string | null,
            p.club_crest as string | null,
          ),
        };
      })
      .filter(Boolean);
    return {
      items,
      editable,
      owner_email: ownerEmail,
      as_consigliere: asConsigliere,
    };
  });

  app.post("/api/top4/wishlist", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.code(401).send({ error: "login_required" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    const body = (req.body ?? {}) as {
      playerId?: string;
      player_id?: string;
      owner?: string;
      for?: string;
    };
    const playerId = String(body.playerId ?? body.player_id ?? "").trim();
    if (!playerId) return reply.code(400).send({ error: "player_id_required" });
    const exists = db.prepare(`SELECT 1 AS ok FROM players WHERE id = ?`).get(playerId);
    if (!exists) return reply.code(404).send({ error: "player_not_found" });
    try {
      const { ownerEmail, asConsigliere } = resolveTop4Owner(
        dbWrite,
        user.email,
        body.owner ?? body.for,
      );
      assertWishlistActor(dbWrite, user.email, ownerEmail, asConsigliere);
      assertTop4WishlistPlayerEligible(dbWrite, ownerEmail, playerId);
      addToTop4WishlistAs(
        dbWrite,
        ownerEmail,
        playerId,
        asConsigliere ? "consigliere" : "manager",
      );
      return {
        ok: true,
        owner_email: ownerEmail,
        as_consigliere: asConsigliere,
        wishlistIds: listTop4Wishlist(dbWrite, ownerEmail).map((w) => w.player_id),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      const code =
        msg === "not_registered" ||
        msg === "wishlist_locked" ||
        msg === "cannot_override_manager" ||
        msg === "not_consigliere" ||
        msg === "player_taken" ||
        msg === "pick_invalid" ||
        msg === "not_in_draft_pool"
          ? 409
          : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  app.delete("/api/top4/wishlist/:playerId", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.code(401).send({ error: "login_required" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    const { playerId } = req.params as { playerId: string };
    const q = req.query as { owner?: string; for?: string };
    try {
      const { ownerEmail, asConsigliere } = resolveTop4Owner(
        dbWrite,
        user.email,
        q.owner ?? q.for,
      );
      assertWishlistActor(dbWrite, user.email, ownerEmail, asConsigliere);
      removeFromTop4WishlistAs(dbWrite, ownerEmail, playerId, asConsigliere);
      return {
        ok: true,
        owner_email: ownerEmail,
        wishlistIds: listTop4Wishlist(dbWrite, ownerEmail).map((w) => w.player_id),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      const code =
        msg === "not_registered" ||
        msg === "wishlist_locked" ||
        msg === "cannot_override_manager" ||
        msg === "not_consigliere"
          ? 409
          : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  app.put("/api/top4/wishlist/order", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.code(401).send({ error: "login_required" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    const body = (req.body ?? {}) as {
      playerIds?: string[];
      owner?: string;
      for?: string;
    };
    const playerIds = Array.isArray(body.playerIds) ? body.playerIds.map(String) : [];
    try {
      const { ownerEmail, asConsigliere } = resolveTop4Owner(
        dbWrite,
        user.email,
        body.owner ?? body.for,
      );
      assertWishlistActor(dbWrite, user.email, ownerEmail, asConsigliere);
      reorderTop4Wishlist(dbWrite, ownerEmail, playerIds);
      return { ok: true, owner_email: ownerEmail };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      const code =
        msg === "not_registered" ||
        msg === "wishlist_locked" ||
        msg === "wishlist_changed" ||
        msg === "cannot_override_manager" ||
        msg === "not_consigliere"
          ? 409
          : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  /** Draft room: list sets + wishlist∪squad pool + formations (owner-only). */
  app.get("/api/top4/draft-room/sets", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.code(401).send({ error: "login_required" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    ensureTop4DraftRoomTables(dbWrite);
    if (!isRegistered(dbWrite, user.email)) {
      return reply.code(403).send({ error: "not_registered" });
    }
    const { wishlistIds, squadIds, allowedIds } = draftRoomAllowedPlayerIds(
      dbWrite,
      user.email,
    );
    const sets = listDraftRoomSets(dbWrite, user.email);
    const pool: DraftRoomPoolPlayer[] = [];
    if (allowedIds.size) {
      const ids = [...allowedIds];
      const placeholders = ids.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT p.id, p.name, p.fm_rating, p.market_value_eur, p.portrait_url,
                  p.position, p.detail_role, p.detail_label, p.side_role,
                  p.capology_wage_pw, p.fm_wage_pw,
                  p.club_id, c.name AS club_name, c.crest_url AS club_crest, p.league_id
           FROM players p
           JOIN clubs c ON c.id = p.club_id
           WHERE p.id IN (${placeholders})`,
        )
        .all(...ids) as Array<Record<string, unknown>>;
      const peers = loadWagePeers(db);
      const wl = new Set(wishlistIds);
      const sq = new Set(squadIds);
      for (const r of rows) {
        const id = String(r.id);
        const enriched = withTrustedWageAsWagePw(
          { ...r, position_display: formatPositionDisplay(r) },
          peers,
        ) as Record<string, unknown> & { wage_pw: number; position_display?: string };
        const inWl = wl.has(id);
        const inSq = sq.has(id);
        const strOrNull = (v: unknown): string | null =>
          v == null || v === "" ? null : String(v);
        pool.push({
          player_id: id,
          name: String(enriched.name),
          club_id: String(enriched.club_id ?? ""),
          club_name: String(enriched.club_name),
          league_id: String(enriched.league_id),
          position: strOrNull(enriched.position),
          detail_role: strOrNull(enriched.detail_role),
          detail_label: strOrNull(enriched.detail_label),
          side_role: strOrNull(enriched.side_role),
          position_display: String(enriched.position_display ?? ""),
          fm_rating: enriched.fm_rating == null ? null : Number(enriched.fm_rating),
          market_value_eur: Number(enriched.market_value_eur) || 0,
          wage_pw: Number(enriched.wage_pw) || 0,
          portrait_url: sanitizePortraitUrl(enriched.portrait_url as string | null),
          club_crest:
            enriched.club_crest != null && String(enriched.club_crest).trim()
              ? String(enriched.club_crest)
              : null,
          source: inWl && inSq ? "both" : inSq ? "squad" : "wishlist",
        });
      }
      pool.sort((a, b) => {
        const srcRank = (s: string) => (s === "wishlist" || s === "both" ? 0 : 1);
        const d = srcRank(a.source) - srcRank(b.source);
        if (d) return d;
        return (b.fm_rating ?? 0) - (a.fm_rating ?? 0);
      });
    }
    return {
      sets,
      pool,
      formations: draftRoomFormationsPublic(),
      max_sets: DRAFT_ROOM_MAX_SETS,
      wishlist_count: wishlistIds.length,
      squad_count: squadIds.length,
      rules: top4RulesPublic(),
    };
  });

  app.post("/api/top4/draft-room/sets", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.code(401).send({ error: "login_required" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    const body = (req.body ?? {}) as {
      name?: string;
      formation?: string;
      slots?: DraftRoomSlot[];
    };
    try {
      const set = createDraftRoomSet(dbWrite, user.email, body);
      return { ok: true, set, sets: listDraftRoomSets(dbWrite, user.email) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      const code =
        msg === "not_registered"
          ? 403
          : msg === "draft_room_limit"
            ? 409
            : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  app.put("/api/top4/draft-room/sets/:id", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.code(401).send({ error: "login_required" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id < 1) {
      return reply.code(400).send({ error: "invalid_id" });
    }
    const body = (req.body ?? {}) as {
      name?: string;
      formation?: string;
      slots?: DraftRoomSlot[];
    };
    try {
      const set = updateDraftRoomSet(dbWrite, user.email, id, body);
      return { ok: true, set, sets: listDraftRoomSets(dbWrite, user.email) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      const code =
        msg === "not_registered"
          ? 403
          : msg === "set_not_found"
            ? 404
            : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  app.delete("/api/top4/draft-room/sets/:id", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.code(401).send({ error: "login_required" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id < 1) {
      return reply.code(400).send({ error: "invalid_id" });
    }
    try {
      deleteDraftRoomSet(dbWrite, user.email, id);
      return { ok: true, sets: listDraftRoomSets(dbWrite, user.email) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      const code =
        msg === "not_registered"
          ? 403
          : msg === "set_not_found"
            ? 404
            : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  /** Admin: lottery — shuffle draft order (animation is client-side). */
  app.post("/api/top4/lottery", async (req, reply) => {
    if (!requireAdmin(req)) return reply.code(401).send({ error: "unauthorized" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    try {
      const order = runTop4Lottery(dbWrite);
      return { ok: true, lottery: order, status: "lottery_done" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      return reply.code(msg === "need_full_roster" ? 409 : 400).send({ error: msg });
    }
  });

  /** Admin: start the live snake draft (30 min/turn + 4h bank per manager). */
  app.post("/api/top4/draft/start", async (req, reply) => {
    if (!requireAdmin(req)) return reply.code(401).send({ error: "unauthorized" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    const state = getTop4State(dbWrite);
    if (state.status === "drafting") {
      return { ok: true, status: "drafting", live: getLiveDraftPublic(dbWrite) };
    }
    const lottery = parseLotteryOrder(state);
    if (!lottery || lottery.length !== TOP4_TEAM_COUNT) {
      return reply.code(409).send({ error: "lottery_required" });
    }
    const body = (req.body ?? {}) as {
      draftHoursStart?: string;
      draftHoursEnd?: string;
      draft_hours_start?: string;
      draft_hours_end?: string;
      draftHoursTz?: string;
      draft_hours_tz?: string;
      start?: string;
      end?: string;
    };
    let hours: { timezone: string; start: string; end: string };
    try {
      hours = parseAdminDraftHours({
        start: body.draftHoursStart ?? body.draft_hours_start ?? body.start,
        end: body.draftHoursEnd ?? body.draft_hours_end ?? body.end,
        timezone: body.draftHoursTz ?? body.draft_hours_tz,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "invalid_draft_hours";
      return reply.code(400).send({ error: msg });
    }
    try {
      startLiveDraft(dbWrite, lottery, hours);
      return { ok: true, status: "drafting", live: getLiveDraftPublic(dbWrite) };
    } catch (err) {
      return reply.code(500).send({
        error: "draft_start_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /** Live draft: manual pick on your turn (or as consigliere, per wishlist rules). */
  app.post("/api/top4/draft/pick", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.code(401).send({ error: "login_required" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    const body = (req.body ?? {}) as {
      playerId?: string;
      player_id?: string;
      owner?: string;
      for?: string;
    };
    const playerId = String(body.playerId ?? body.player_id ?? "").trim();
    if (!playerId) return reply.code(400).send({ error: "player_id_required" });
    try {
      const live = attemptManualPick(dbWrite, user.email, playerId, body.owner ?? body.for);
      return { ok: true, live, status: getTop4State(dbWrite).status };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      const code =
        msg === "not_registered" ||
        msg === "not_consigliere" ||
        msg === "cannot_override_manager" ||
        msg === "not_your_turn"
          ? 403
          : msg === "draft_not_live" || msg === "draft_complete" || msg === "player_taken"
            ? 409
            : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  /**
   * Replace an algorithmic autopick (auto=2) with a free eligible player.
   * Body: { newPlayerId, playerId? | pickNumber?, owner? }.
   * Prefer remove-auto + fill-vacancy for bulk remove-then-fill UX.
   */
  app.post("/api/top4/draft/replace-auto", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.code(401).send({ error: "login_required" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    const body = (req.body ?? {}) as {
      newPlayerId?: string;
      new_player_id?: string;
      playerId?: string;
      player_id?: string;
      pickNumber?: number;
      pick_number?: number;
      owner?: string;
      for?: string;
    };
    const newPlayerId = String(body.newPlayerId ?? body.new_player_id ?? "").trim();
    if (!newPlayerId) return reply.code(400).send({ error: "player_id_required" });
    const playerId = String(body.playerId ?? body.player_id ?? "").trim() || null;
    const pickRaw = body.pickNumber ?? body.pick_number;
    const pickNumber =
      pickRaw != null && String(pickRaw).trim() !== "" ? Number(pickRaw) : null;
    if (!playerId && (pickNumber == null || !Number.isFinite(pickNumber))) {
      return reply.code(400).send({ error: "player_id_required" });
    }
    try {
      const result = replaceAutoPick(dbWrite, user.email, {
        newPlayerId,
        playerId,
        pickNumber,
        ownerEmailRaw: body.owner ?? body.for,
      });
      return { ok: true, ...result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      const code =
        msg === "not_registered" ||
        msg === "not_consigliere" ||
        msg === "not_your_pick"
          ? 403
          : msg === "draft_not_live" ||
              msg === "player_taken" ||
              msg === "already_replaced" ||
              msg === "not_algo_auto"
            ? 409
            : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  /**
   * Remove algorithmic autopick(s) without replacement — frees MV/wage, opens vacancies.
   * Body: { all: true } or { playerId? | pickNumber? }, optional owner.
   */
  app.post("/api/top4/draft/remove-auto", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.code(401).send({ error: "login_required" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    const body = (req.body ?? {}) as {
      all?: boolean;
      playerId?: string;
      player_id?: string;
      pickNumber?: number;
      pick_number?: number;
      owner?: string;
      for?: string;
    };
    const all = Boolean(body.all);
    const playerId = String(body.playerId ?? body.player_id ?? "").trim() || null;
    const pickRaw = body.pickNumber ?? body.pick_number;
    const pickNumber =
      pickRaw != null && String(pickRaw).trim() !== "" ? Number(pickRaw) : null;
    if (!all && !playerId && (pickNumber == null || !Number.isFinite(pickNumber))) {
      return reply.code(400).send({ error: "player_id_required" });
    }
    try {
      const result = removeAutoPicks(dbWrite, user.email, {
        all,
        playerId,
        pickNumber,
        ownerEmailRaw: body.owner ?? body.for,
      });
      return { ok: true, ...result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      const code =
        msg === "not_registered" ||
        msg === "not_consigliere" ||
        msg === "not_your_pick"
          ? 403
          : msg === "draft_not_live" ||
              msg === "already_replaced" ||
              msg === "not_algo_auto" ||
              msg === "no_algo_autos"
            ? 409
            : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  /**
   * Fill one vacancy (from remove-auto) with a free eligible player.
   * Body: { newPlayerId, owner? }.
   */
  app.post("/api/top4/draft/fill-vacancy", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.code(401).send({ error: "login_required" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    const body = (req.body ?? {}) as {
      newPlayerId?: string;
      new_player_id?: string;
      owner?: string;
      for?: string;
    };
    const newPlayerId = String(body.newPlayerId ?? body.new_player_id ?? "").trim();
    if (!newPlayerId) return reply.code(400).send({ error: "player_id_required" });
    try {
      const result = fillVacancy(dbWrite, user.email, {
        newPlayerId,
        ownerEmailRaw: body.owner ?? body.for,
      });
      return { ok: true, ...result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      const code =
        msg === "not_registered" || msg === "not_consigliere"
          ? 403
          : msg === "draft_not_live" ||
              msg === "player_taken" ||
              msg === "no_vacancy"
            ? 409
            : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  /** Live draft: advance timers — resolves due timeout/bank-out/OOD autopicks. */
  app.post("/api/top4/draft/tick", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.code(401).send({ error: "login_required" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    const live = tickLiveDraft(dbWrite);
    return { ok: true, live, status: getTop4State(dbWrite).status };
  });

  /** Live draft: toggle "out of draft" (instant wishlist/rating autopick on your turn). */
  app.put("/api/top4/draft/out-of-draft", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.code(401).send({ error: "login_required" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    const body = (req.body ?? {}) as { value?: boolean; owner?: string; for?: string };
    try {
      const { ownerEmail } = resolveTop4Owner(dbWrite, user.email, body.owner ?? body.for);
      const live = setTop4OutOfDraft(dbWrite, ownerEmail, Boolean(body.value));
      return { ok: true, live };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      const code =
        msg === "not_registered" || msg === "not_consigliere"
          ? 403
          : msg === "draft_not_live" || msg === "not_in_draft" || msg === "draft_finished"
            ? 409
            : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  /**
   * Live draft: finish for yourself (skip further turns). Requires ≥26 players.
   * Whole draft ends when every manager has finished.
   */
  app.put("/api/top4/draft/finish", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.code(401).send({ error: "login_required" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    const body = (req.body ?? {}) as { value?: boolean; owner?: string; for?: string };
    try {
      const { ownerEmail } = resolveTop4Owner(dbWrite, user.email, body.owner ?? body.for);
      const live = setTop4DraftFinished(dbWrite, ownerEmail, Boolean(body.value));
      return { ok: true, live, status: getTop4State(dbWrite).status };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      const code =
        msg === "not_registered" || msg === "not_consigliere"
          ? 403
          : msg === "draft_not_live" || msg === "not_in_draft"
            ? 409
            : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  /** Admin: reset league (registrations + lottery + draft). */
  app.post("/api/top4/reset", async (req, reply) => {
    if (!requireAdmin(req)) return reply.code(401).send({ error: "unauthorized" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    resetTop4League(dbWrite);
    return { ok: true, status: "open" };
  });

  /** Топ-8 катка: state, registrations, rules, draft snapshot. */
  app.get("/api/top8", async (req) => {
    if (!dbWrite) {
      return {
        rules: top8RulesPublic(),
        status: "open",
        registrations: [],
        lottery: null,
        draft: null,
        me: { registered: false, user: null, isAdmin: false },
        slots: { taken: 0, total: TOP8_TEAM_COUNT },
        error: "db_write_unavailable",
      };
    }
    const user = getSessionUser(req);
    const state = getTop8State(dbWrite);
    const registrations = listTop8Registrations(dbWrite);
    let draft = null;
    if (state.draft_json) {
      try {
        draft = JSON.parse(state.draft_json);
      } catch {
        draft = null;
      }
    }
    const registration = user ? getTop8Registration(dbWrite, user.email) : null;
    const wishlistIds = user ? listTop8Wishlist(dbWrite, user.email).map((w) => w.player_id) : [];
    return {
      rules: top8RulesPublic(),
      status: state.status,
      updated_at: state.updated_at,
      registrations,
      lottery: parseTop8LotteryOrder(state),
      draft,
      me: {
        user: user ? { email: user.email, name: user.name } : null,
        isAdmin: isAdminEmail(user?.email),
        registered: Boolean(registration),
        registration,
        wishlistIds,
        wishlistEditable: Boolean(registration) && state.status !== "complete",
      },
      slots: { taken: registrations.length, total: TOP8_TEAM_COUNT },
    };
  });

  /** Historical Top-8 season fantasy scores (precomputed from API-Football). */
  app.get("/api/top8/season/:slug", async (req, reply) => {
    const slug = String((req.params as { slug?: string }).slug || "").trim();
    const normalized =
      slug === "2025/26" || slug === "2025-26" || slug === "2526"
        ? TOP8_SEASON_SLUG
        : slug;
    const payload = loadTop8SeasonScores(dataDir, normalized);
    if (!payload) {
      return reply.code(404).send({
        error: "season_not_found",
        hint: "Run: npm run top8:season:sync",
        slug: normalized,
      });
    }
    return payload;
  });

  app.post("/api/top8/register", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.code(401).send({ error: "login_required" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    const body = (req.body ?? {}) as { teamName?: string; team_name?: string };
    const teamName = body.teamName ?? body.team_name ?? "";
    try {
      const row = registerTop8(dbWrite, user.email, user.name, teamName);
      return {
        ok: true,
        registration: row,
        slots: {
          taken: listTop8Registrations(dbWrite).length,
          total: TOP8_TEAM_COUNT,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      const code =
        msg === "league_full" ||
        msg === "already_registered" ||
        msg === "registration_closed" ||
        msg === "team_name_taken"
          ? 409
          : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  app.put("/api/top8/team-name", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.code(401).send({ error: "login_required" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    const body = (req.body ?? {}) as { teamName?: string; team_name?: string };
    const teamName = body.teamName ?? body.team_name ?? "";
    try {
      const row = updateTop8TeamName(dbWrite, user.email, teamName);
      return { ok: true, registration: row };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      const code =
        msg === "registration_closed" ||
        msg === "not_registered" ||
        msg === "team_name_taken"
          ? 409
          : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  app.post("/api/top8/unregister", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.code(401).send({ error: "login_required" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    try {
      unregisterTop8(dbWrite, user.email);
      return {
        ok: true,
        slots: {
          taken: listTop8Registrations(dbWrite).length,
          total: TOP8_TEAM_COUNT,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      return reply.code(msg === "registration_closed" ? 409 : 400).send({ error: msg });
    }
  });

  /** Wishlist for the logged-in registered manager (ordered). */
  app.get("/api/top8/wishlist", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.code(401).send({ error: "login_required" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    if (!isTop8Registered(dbWrite, user.email)) {
      return reply.code(403).send({ error: "not_registered" });
    }
    const entries = listTop8Wishlist(dbWrite, user.email);
    if (!entries.length) {
      return { items: [], editable: getTop8State(dbWrite).status !== "complete" };
    }
    const placeholders = entries.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT p.id, p.name, p.fm_rating, p.market_value_eur, p.portrait_url,
                p.position, p.detail_role, p.detail_label, p.side_role,
                p.capology_wage_pw, p.fm_wage_pw,
                c.name AS club_name, p.league_id
         FROM players p
         JOIN clubs c ON c.id = p.club_id
         WHERE p.id IN (${placeholders})`,
      )
      .all(...entries.map((e) => e.player_id)) as Array<Record<string, unknown>>;
    const peers = loadWagePeers(db);
    const byId = new Map(
      rows.map((r) => {
        const enriched = withTrustedWageAsWagePw(
          { ...r, position_display: formatPositionDisplay(r) },
          peers,
        ) as Record<string, unknown> & { wage_pw: number; position_display?: string };
        return [String(r.id), enriched];
      }),
    );
    const items = entries
      .map((e) => {
        const p = byId.get(e.player_id);
        if (!p) return null;
        return {
          player_id: e.player_id,
          priority: e.priority,
          name: String(p.name),
          club_name: String(p.club_name),
          league_id: String(p.league_id),
          position_display: String(p.position_display ?? ""),
          fm_rating: p.fm_rating == null ? null : Number(p.fm_rating),
          market_value_eur: Number(p.market_value_eur) || 0,
          wage_pw: Number(p.wage_pw) || 0,
          portrait_url: p.portrait_url != null ? String(p.portrait_url) : null,
        };
      })
      .filter(Boolean);
    return {
      items,
      editable: getTop8State(dbWrite).status !== "complete",
    };
  });

  app.post("/api/top8/wishlist", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.code(401).send({ error: "login_required" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    const body = (req.body ?? {}) as { playerId?: string; player_id?: string };
    const playerId = String(body.playerId ?? body.player_id ?? "").trim();
    if (!playerId) return reply.code(400).send({ error: "player_id_required" });
    const exists = db.prepare(`SELECT 1 AS ok FROM players WHERE id = ?`).get(playerId);
    if (!exists) return reply.code(404).send({ error: "player_not_found" });
    try {
      addToTop8Wishlist(dbWrite, user.email, playerId);
      return { ok: true, wishlistIds: listTop8Wishlist(dbWrite, user.email).map((w) => w.player_id) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      const code =
        msg === "not_registered" || msg === "wishlist_locked" ? 409 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  app.delete("/api/top8/wishlist/:playerId", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.code(401).send({ error: "login_required" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    const { playerId } = req.params as { playerId: string };
    try {
      removeFromTop8Wishlist(dbWrite, user.email, playerId);
      return { ok: true, wishlistIds: listTop8Wishlist(dbWrite, user.email).map((w) => w.player_id) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      const code =
        msg === "not_registered" || msg === "wishlist_locked" ? 409 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  app.put("/api/top8/wishlist/order", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.code(401).send({ error: "login_required" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    const body = (req.body ?? {}) as { playerIds?: string[] };
    const playerIds = Array.isArray(body.playerIds) ? body.playerIds.map(String) : [];
    try {
      reorderTop8Wishlist(dbWrite, user.email, playerIds);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      const code =
        msg === "not_registered" ||
        msg === "wishlist_locked" ||
        msg === "wishlist_changed"
          ? 409
          : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  /** Admin: lottery — shuffle draft order (animation is client-side). */
  app.post("/api/top8/lottery", async (req, reply) => {
    if (!requireAdmin(req)) return reply.code(401).send({ error: "unauthorized" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    try {
      const order = runTop8Lottery(dbWrite);
      return { ok: true, lottery: order, status: "lottery_done" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      return reply.code(msg === "need_full_roster" ? 409 : 400).send({ error: msg });
    }
  });

  /** Admin: run snake draft with lottery order. */
  app.post("/api/top8/draft/start", async (req, reply) => {
    if (!requireAdmin(req)) return reply.code(401).send({ error: "unauthorized" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    const state = getTop8State(dbWrite);
    const lottery = parseTop8LotteryOrder(state);
    if (!lottery || lottery.length !== TOP8_TEAM_COUNT) {
      return reply.code(409).send({ error: "lottery_required" });
    }
    try {
      setTop8Status(dbWrite, "drafting");
      const draft = runTop8SnakeDraft(db, lottery);
      setTop8Draft(dbWrite, draft, "complete");
      return { ok: true, status: "complete", draft };
    } catch (err) {
      setTop8Status(dbWrite, "lottery_done");
      return reply.code(500).send({
        error: "draft_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /** Admin: reset league (registrations + lottery + draft). */
  app.post("/api/top8/reset", async (req, reply) => {
    if (!requireAdmin(req)) return reply.code(401).send({ error: "unauthorized" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    resetTop8League(dbWrite);
    return { ok: true, status: "open" };
  });

  /** Admin: list celestial teams + email→team mappings. */
  app.get("/api/admin/mappings", async (req, reply) => {
    if (!requireAdmin(req)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return {
      teams: CELESTIAL_TEAMS,
      mappings: listTeamMappings(),
    };
  });

  /** Admin: assign or clear email → team. Body: { email, team_id | null }. */
  app.put("/api/admin/mappings", async (req, reply) => {
    const admin = requireAdmin(req);
    if (!admin) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (!dbWrite) {
      return reply.code(503).send({ error: "db_write_unavailable" });
    }
    const body = (req.body ?? {}) as { email?: string; team_id?: number | null };
    const email = String(body.email ?? "")
      .trim()
      .toLowerCase();
    if (!email || !email.includes("@")) {
      return reply.code(400).send({ error: "invalid_email" });
    }
    if (body.team_id == null || body.team_id === undefined) {
      deleteTeamMapping(email);
      return { ok: true, email, team: null };
    }
    const teamId = Number(body.team_id);
    if (!Number.isInteger(teamId) || !teamById(teamId)) {
      return reply.code(400).send({ error: "invalid_team" });
    }
    try {
      const team = upsertTeamMapping(email, teamId, admin.email);
      return { ok: true, email, team: { id: team.team_id, name: team.team_name } };
    } catch (err) {
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : "map_failed" });
    }
  });

  /** Admin: players with no FMInside match (fm_rating IS NULL). */
  app.get("/api/admin/fm-missing", async (req, reply) => {
    if (!requireAdmin(req)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const q = req.query as { limit?: string };
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 200));
    return listPlayersMissingFm(db, limit);
  });

  /**
   * Admin: manually match a Din8sty player to an FMInside ID/URL.
   * Body: { player_id, fm: "<id or url>" }
   * Scrapes FMInside (Playwright) and writes rating/wage/url/matched_name.
   */
  app.post("/api/admin/fm-match", async (req, reply) => {
    if (!requireAdmin(req)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (!dbWrite) {
      return reply.code(503).send({ error: "db_write_unavailable" });
    }
    const body = (req.body ?? {}) as { player_id?: string; fm?: string };
    const playerId = String(body.player_id ?? "").trim();
    const fmInput = String(body.fm ?? "").trim();
    if (!playerId || !fmInput) {
      return reply.code(400).send({ error: "player_id_and_fm_required" });
    }
    const row = db
      .prepare(`SELECT id, name FROM players WHERE id = ?`)
      .get(playerId) as { id: string; name: string } | undefined;
    if (!row) {
      return reply.code(404).send({ error: "player_not_found" });
    }
    try {
      const scraped = scrapeFmPlayer(fmInput, row.name);
      const matched = applyFmMatch(dbWrite, playerId, scraped);
      const remaining = (
        dbWrite
          .prepare(`SELECT COUNT(*) AS n FROM players WHERE fm_rating IS NULL`)
          .get() as { n: number }
      ).n;
      return { ok: true, match: matched, remaining };
    } catch (err) {
      return reply
        .code(502)
        .send({ error: err instanceof Error ? err.message : "fm_match_failed" });
    }
  });

  /**
   * Lineup editor payload: roster + formations + GW fixtures + saved slots.
   * Query: team_id (optional → own mapped team), gw (optional).
   * Top-4 default gw = current Fri–Sun London, next from Monday; Primer stays first GW.
   * Other teams only after lineup deadline (GW Fri 00:00 London); no admin peek.
   */
  app.get("/api/lineup", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) {
      return reply.code(401).send({ error: "login_required" });
    }

    const q = req.query as { team_id?: string; gw?: string; league?: string };
    const league = String(q.league || "primer").toLowerCase();

    /** Top-4 post-draft lineups (separate from Primer celestial teams). */
    if (league === "top4") {
      if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
      ensureTop4ConsigliereSchema(dbWrite);
      const snap = loadTop4DraftSnapshot();
      if (!snap) {
        return reply.code(404).send({
          error: "top4_draft_required",
          message: "Составы Топ-4 доступны после завершения драфта.",
        });
      }
      const myManager = snap.managers.find(
        (m) => m.email.toLowerCase() === user.email.toLowerCase(),
      );
      const consigliereClients = listConsigliereClients(dbWrite, user.email);
      const accessible = snap.managers.filter(
        (m) =>
          m.email.toLowerCase() === user.email.toLowerCase() ||
          consigliereClients.some(
            (c) => c.email.toLowerCase() === m.email.toLowerCase(),
          ),
      );
      if (!accessible.length) {
        return reply.code(403).send({
          error: "no_top4_team",
          message: "Нет команды Топ-4 и вы не consigliere.",
        });
      }
      let teamId = q.team_id ? Number(q.team_id) : NaN;
      if (!Number.isInteger(teamId)) {
        teamId = myManager?.team_id ?? accessible[0].team_id;
      }
      const top4Team = loadTop4DraftTeam(teamId);
      if (!top4Team) {
        return reply.code(400).send({ error: "invalid_team" });
      }
      const managerEmail = managerEmailForTop4Team(dbWrite, teamId);
      if (!managerEmail) {
        return reply.code(400).send({ error: "invalid_team" });
      }
      const clubIds = [...new Set(top4Team.players.map((p) => p.club_id))];
      const clubFixtures = loadClubGwFixturesForClubs(clubIds);
      const gwList = (() => {
        const set = new Set<number>();
        for (const byGw of clubFixtures.values()) {
          for (const gw of byGw.keys()) set.add(gw);
        }
        return [...set].sort((a, b) => a - b);
      })();
      // current = London Friday week; default XI editor: current Fri–Sun, next from Mon.
      const currentGw = Math.max(1, gameweekFromKickoff(new Date()));
      const nextGw = currentGw + 1;
      const preferredGw = defaultTop4LineupGw();
      let gw = q.gw ? Number(q.gw) : NaN;
      if (!Number.isFinite(gw) || (gwList.length && !gwList.includes(gw))) {
        if (gwList.includes(preferredGw)) gw = preferredGw;
        else if (gwList.includes(currentGw)) gw = currentGw;
        else if (gwList.includes(nextGw)) gw = nextGw;
        else gw = gwList[0] ?? preferredGw;
      }
      const isManager = managerEmail === user.email.toLowerCase();
      const isConsigliere = isManager
        ? false
        : listConsigliereClients(dbWrite, user.email).some(
            (c) => c.email.toLowerCase() === managerEmail,
          );
      if (!isManager && !isConsigliere && !lineupDeadlinePassed(gw)) {
        return reply.code(403).send({
          error: "lineup_locked",
          message:
            "Состав другой команды скрыт до начала тура (пт 00:00 London).",
        });
      }
      const edit = canEditTop4TeamAs(dbWrite, user.email, teamId, gw);
      const squadLock = loadSquadGwLock(db, clubIds, gw);
      const lockedClubs = new Set(squadLock.lockedClubIds);
      const playerIds = top4Team.players.map((p) => p.id);
      const roleRows =
        playerIds.length === 0
          ? []
          : (db
              .prepare(
                `SELECT id, position, detail_role, detail_label, side_role
                 FROM players WHERE id IN (${playerIds.map(() => "?").join(",")})`,
              )
              .all(...playerIds) as Array<{
              id: string;
              position: string | null;
              detail_role: string | null;
              detail_label: string | null;
              side_role: string | null;
            }>);
      const rolesById = new Map(roleRows.map((r) => [r.id, r]));
      const avatarById = loadPlayerAvatarMap(playerIds);
      const wages = trustedWageMap(loadWagePeers(db), playerIds);
      if (dbWrite) {
        await ensureAvailabilitySynced(dbWrite).catch((err) => {
          console.warn(
            "availability sync:",
            err instanceof Error ? err.message : err,
          );
        });
      }
      const availById = loadAvailabilityForGw(dbWrite ?? db, playerIds, gw);
      const formPlayers = top4Team.players.map((p) => {
        const roles = rolesById.get(p.id);
        return {
          id: p.id,
          name: p.name,
          club_id: p.club_id,
          position: roles?.position ?? null,
          detail_role: roles?.detail_role ?? null,
          detail_label: roles?.detail_label ?? null,
          side_role: roles?.side_role ?? null,
        };
      });
      const formById = computeRosterForm(dbWrite ?? db, formPlayers);
      const showGwFpts =
        gw < currentGw ||
        (gw === currentGw && top4GwHasKickedOff(dbWrite ?? db, gw));
      if (showGwFpts && gw === currentGw) {
        await ensureLiveGwStatsSynced(dbWrite).catch((err) => {
          console.warn(
            "lineup gw fpts sync:",
            err instanceof Error ? err.message : err,
          );
        });
      }
      const gwFptsById = showGwFpts
        ? computeRosterGwFpts(dbWrite ?? db, gw, formPlayers)
        : null;
      const roster = top4Team.players.map((p) => {
        const roles = rolesById.get(p.id);
        const avatar = avatarById.get(p.id);
        const fields = {
          position: roles?.position ?? null,
          detail_role: roles?.detail_role ?? null,
          detail_label: roles?.detail_label ?? null,
          side_role: roles?.side_role ?? null,
        };
        const fixtures = clubFixtures.get(p.club_id)?.get(gw) ?? [];
        const display = fixtureOpponentLabel(fixtures);
        const draftLike = {
          ...p,
          ...fields,
          position_display: p.position_display || formatPositionDisplay(fields),
        };
        return {
          id: p.id,
          name: p.name,
          club_id: p.club_id,
          club_name: p.club_name,
          league_id: p.league_id,
          league_name: p.league_name,
          position_display: draftLike.position_display,
          fm_rating: p.fm_rating,
          market_value_eur: p.market_value_eur,
          wage_pw: wages.get(p.id)?.trusted_wage_pw ?? p.wage_pw,
          portrait_url: avatar?.portrait_url ?? sanitizePortraitUrl(p.portrait_url),
          club_crest: avatar?.club_crest ?? null,
          pick: p.pick ?? null,
          ...fields,
          is_home: display.is_home,
          opponent: display.opponent,
          opponent_name: display.opponent_name,
          fixture_count: fixtures.length,
          locked: isClubLocked(p.club_id, lockedClubs),
          availability: availById.get(p.id) ?? null,
          xPts: estimateXPtsForGw(draftLike, fixtures, (fx) =>
            compMultiplierForAfLeague(fx.afLeagueId),
          ),
          form: formById.get(p.id)?.form ?? null,
          form_n: formById.get(p.id)?.form_n ?? 0,
          gw_fpts: gwFptsById?.get(p.id) ?? null,
        };
      });
      const savedRow = getTop4Lineup(dbWrite, teamId, gw);
      const savedParsed = savedRow
        ? parseSlotsJson(savedRow.slots_json)
        : null;
      const teamsList = accessible.map((m) => {
        const t = snap.teams.find((x) => x.id === m.team_id);
        const reg = getRegistrationFull(dbWrite, m.email);
        return {
          id: m.team_id,
          name: t?.name || m.team_name,
          logo_url: reg?.logo_url ?? null,
        };
      });
      const managerReg = getRegistrationFull(dbWrite, managerEmail);
      const refreshedAt =
        (
          dbWrite
            .prepare(`SELECT value FROM meta WHERE key = ?`)
            .get(`lineup_refresh_${teamId}`) as { value: string } | undefined
        )?.value ?? null;
      return {
        league: "top4",
        team: {
          id: top4Team.id,
          name: top4Team.name,
          vacancies: top4Team.vacancies ?? 0,
          logo_url: managerReg?.logo_url ?? null,
        },
        refreshed_at: refreshedAt,
        teams: teamsList,
        can_edit: edit.ok,
        can_edit_reason: edit.reason ?? null,
        as_consigliere: edit.asConsigliere,
        manager_email: managerEmail,
        formations: pitchFormations(FORMATIONS),
        gameweeks: (gwList.length ? gwList : [1]).map((n) => {
          const range = gameweekRange(n);
          return { gameweek: n, label: range.label };
        }),
        currentGw,
        nextGw,
        gw,
        deadline_at: squadLock.deadlineAt,
        deadline_passed: Boolean(
          squadLock.deadlineAt && Date.parse(squadLock.deadlineAt) <= Date.now(),
        ),
        roster,
        saved: savedParsed
          ? {
              formation:
                formationById(savedRow!.formation)?.id ?? savedRow!.formation,
              slots: savedParsed.slots,
              roles: savedParsed.roles,
              bench: savedParsed.bench,
              bench_roles: savedParsed.benchRoles,
              updated_at: savedRow!.updated_at,
              updated_by: savedRow!.updated_by,
              set_by: savedRow!.set_by,
            }
          : null,
        suggested: null,
      };
    }

    const own = getTeamForEmail(user.email);
    let teamId = q.team_id ? Number(q.team_id) : NaN;
    if (!Number.isInteger(teamId)) {
      teamId = own?.team_id ?? NaN;
    }
    if (!Number.isInteger(teamId) || !teamById(teamId)) {
      return reply.code(400).send({
        error: own ? "invalid_team" : "no_team",
        message:
          "Команда Примера не назначена. Обратитесь к админу. Для Топ-4/Топ-8 заявьтесь на страницах лиг — маппинг Примера не нужен.",
      });
    }

    const primerTeam = loadPrimerTeam(teamId);
    if (!primerTeam) {
      return reply.code(404).send({
        error: "primer_not_found",
        hint: "Запустите npm run primer:draft",
      });
    }

    const playerIds = primerTeam.players.map((p) => p.id);
    const roleRows =
      playerIds.length === 0
        ? []
        : (db
            .prepare(
              `SELECT id, position, detail_role, detail_label, side_role
               FROM players WHERE id IN (${playerIds.map(() => "?").join(",")})`,
            )
            .all(...playerIds) as Array<{
            id: string;
            position: string | null;
            detail_role: string | null;
            detail_label: string | null;
            side_role: string | null;
          }>);
    const rolesById = new Map(roleRows.map((r) => [r.id, r]));

    const clubIds = [...new Set(primerTeam.players.map((p) => p.club_id))];
    const clubFixtures = loadClubGwFixturesForClubs(clubIds);

    const gwList = (() => {
      const fromPrimer = (primerTeam.gameweeks || []).map((g) => g.gw);
      if (fromPrimer.length) return fromPrimer;
      const set = new Set<number>();
      for (const byGw of clubFixtures.values()) {
        for (const gw of byGw.keys()) set.add(gw);
      }
      return [...set].sort((a, b) => a - b);
    })();

    let gw = q.gw ? Number(q.gw) : NaN;
    if (!Number.isFinite(gw) || !gwList.includes(gw)) {
      gw = gwList[0] ?? 1;
    }

    if (!canViewTeamLineup(user, teamId, gw)) {
      return reply.code(403).send({
        error: "lineup_locked",
        message:
          "Состав другой команды скрыт до начала тура (пт 00:00 London).",
      });
    }

    const isOwn = canEditTeam(user, teamId);
    const wages = trustedWageMap(
      loadWagePeers(db),
      primerTeam.players.map((p) => p.id),
    );
    if (dbWrite) {
      await ensureAvailabilitySynced(dbWrite).catch((err) => {
        console.warn(
          "availability sync:",
          err instanceof Error ? err.message : err,
        );
      });
    }
    const availById = loadAvailabilityForGw(
      dbWrite ?? db,
      primerTeam.players.map((p) => p.id),
      gw,
    );
    const roster = primerTeam.players.map((p) => {
      const roles = rolesById.get(p.id);
      const fields = {
        position: roles?.position ?? null,
        detail_role: roles?.detail_role ?? null,
        detail_label: roles?.detail_label ?? null,
        side_role: roles?.side_role ?? null,
      };
      const fixtures = clubFixtures.get(p.club_id)?.get(gw) ?? [];
      const display = fixtureOpponentLabel(fixtures);
      const draftLike = {
        ...p,
        ...fields,
        position_display: p.position_display || formatPositionDisplay(fields),
      };
      return {
        id: p.id,
        name: p.name,
        club_id: p.club_id,
        club_name: p.club_name,
        league_id: p.league_id,
        league_name: p.league_name,
        position_display: draftLike.position_display,
        fm_rating: p.fm_rating,
        market_value_eur: p.market_value_eur,
        wage_pw: wages.get(p.id)?.trusted_wage_pw ?? p.wage_pw,
        portrait_url: p.portrait_url,
        pick: p.pick ?? null,
        ...fields,
        is_home: display.is_home,
        opponent: display.opponent,
        opponent_name: display.opponent_name,
        fixture_count: fixtures.length,
        availability: availById.get(p.id) ?? null,
        xPts: estimateXPtsForGw(draftLike, fixtures),
      };
    });

    const saved = getSavedLineup(teamId, gw);
    const suggestedGw = (primerTeam.gameweeks || []).find((g) => g.gw === gw);
    // Primer suggestion only for own team (not another club's pick).
    const suggested =
      isOwn && suggestedGw
        ? {
            formation: suggestedGw.formation,
            formation_label: suggestedGw.formation_label,
            slots: suggestedGw.xi.map((p) => p.id),
            bench: (suggestedGw.bench || []).map((p) => p.id),
          }
        : null;

    const teamMeta = teamById(teamId)!;
    const ownMeta = own ? teamById(own.team_id) : null;
    return {
      team: { id: teamMeta.id, name: teamMeta.name },
      // Never expose full celestial list — UI stays locked to mapped team.
      teams: ownMeta
        ? [{ id: ownMeta.id, name: ownMeta.name }]
        : [{ id: teamMeta.id, name: teamMeta.name }],
      can_edit: isOwn,
      formations: pitchFormations(FORMATIONS),
      gameweeks: gwList.map((n) => {
        const range = gameweekRange(n);
        return { gameweek: n, label: range.label };
      }),
      gw,
      roster,
      saved: saved
        ? {
            formation: formationById(saved.formation)?.id ?? saved.formation,
            slots: saved.slots,
            roles: saved.roles,
            bench: saved.bench,
            bench_roles: saved.bench_roles,
            updated_at: saved.updated_at,
            updated_by: saved.updated_by,
          }
        : null,
      suggested,
    };
  });

  /** Refresh clubs / injuries / fixtures for this Top-4 manager's squad, then reload xPts via GET. */
  app.post("/api/lineup/refresh", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) return reply.code(401).send({ error: "login_required" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });

    const body = (req.body ?? {}) as { team_id?: number; league?: string };
    const league = String(body.league || "top4").toLowerCase();
    if (league !== "top4") {
      return reply.code(400).send({ error: "top4_only" });
    }
    const snap = loadTop4DraftSnapshot();
    if (!snap) return reply.code(404).send({ error: "top4_draft_required" });
    const consigliereClients = listConsigliereClients(dbWrite, user.email);
    const accessible = snap.managers.filter(
      (m) =>
        m.email.toLowerCase() === user.email.toLowerCase() ||
        consigliereClients.some(
          (c) => c.email.toLowerCase() === m.email.toLowerCase(),
        ),
    );
    if (!accessible.length) {
      return reply.code(403).send({ error: "no_top4_team" });
    }
    let teamId = Number(body.team_id);
    if (!Number.isInteger(teamId)) {
      const myManager = snap.managers.find(
        (m) => m.email.toLowerCase() === user.email.toLowerCase(),
      );
      teamId = myManager?.team_id ?? accessible[0].team_id;
    }
    if (!accessible.some((m) => m.team_id === teamId)) {
      return reply.code(403).send({ error: "forbidden_team" });
    }
    const top4Team = loadTop4DraftTeam(teamId);
    if (!top4Team) return reply.code(400).send({ error: "invalid_team" });
    const refreshKey = `lineup_refresh_${teamId}`;
    const prevAt = Date.parse(
      String(
        (
          dbWrite
            .prepare(`SELECT value FROM meta WHERE key = ?`)
            .get(refreshKey) as { value: string } | undefined
        )?.value || "",
      ),
    );
    const refreshGapMs = 6 * 60 * 60 * 1000;
    if (Number.isFinite(prevAt) && Date.now() - prevAt < refreshGapMs) {
      return reply.code(429).send({
        error: "too_soon",
        message: "Повторно можно через 6 часов.",
      });
    }

    const playerIds = [...new Set(top4Team.players.map((p) => p.id).filter(Boolean))];
    try {
      const result = await refreshManagerSquadInfo(dbWrite, playerIds);
      dbWrite
        .prepare(
          `INSERT INTO meta(key,value) VALUES(?,?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        )
        .run(refreshKey, new Date().toISOString());
      return { ok: true, ...result };
    } catch (err) {
      console.warn(
        "lineup refresh:",
        err instanceof Error ? err.message : err,
      );
      return reply.code(500).send({
        error: "refresh_failed",
        message: err instanceof Error ? err.message : "refresh_failed",
      });
    }
  });

  /** Persist lineup for team + GW. Body: { team_id, gw, formation, slots, roles?, bench?, bench_roles?, league? }. */
  app.put("/api/lineup", async (req, reply) => {
    const user = getSessionUser(req);
    if (!user) {
      return reply.code(401).send({ error: "login_required" });
    }
    if (!dbWrite) {
      return reply.code(503).send({ error: "db_write_unavailable" });
    }

    const body = (req.body ?? {}) as {
      team_id?: number;
      gw?: number;
      formation?: string;
      slots?: Array<string | null>;
      roles?: Array<string | null>;
      bench?: Array<string | null>;
      bench_roles?: Array<string | null>;
      league?: string;
    };
    const league = String(body.league || "primer").toLowerCase();
    const teamId = Number(body.team_id);
    const gw = Number(body.gw);
    const formationId = String(body.formation ?? "");
    if (!Number.isInteger(gw) || gw < 1) {
      return reply.code(400).send({ error: "invalid_gw" });
    }

    if (league === "top4") {
      ensureTop4ConsigliereSchema(dbWrite);
      const top4Team = loadTop4DraftTeam(teamId);
      if (!top4Team) return reply.code(400).send({ error: "invalid_team" });
      const managerEmail = managerEmailForTop4Team(dbWrite, teamId);
      if (!managerEmail) return reply.code(400).send({ error: "invalid_team" });
      const edit = canEditTop4TeamAs(dbWrite, user.email, teamId, gw);
      if (!edit.ok) {
        return reply.code(403).send({
          error: edit.reason || "forbidden",
          message:
            edit.reason === "cannot_override_manager"
              ? "consigliere cannot override the manager's lineup"
              : edit.reason === "deadline_passed"
                ? "Deadline passed — consigliere cannot set lineup"
                : "Cannot save this Top-4 lineup",
        });
      }
      const formation = formationById(formationId, FORMATIONS);
      if (!formation) return reply.code(400).send({ error: "invalid_formation" });
      if (!Array.isArray(body.slots)) {
        return reply.code(400).send({ error: "invalid_slots" });
      }
      const playerIds = top4Team.players.map((p) => p.id);
      const roleRows =
        playerIds.length === 0
          ? []
          : (db
              .prepare(
                `SELECT id, position, detail_role, detail_label, side_role
                 FROM players WHERE id IN (${playerIds.map(() => "?").join(",")})`,
              )
              .all(...playerIds) as Array<{
              id: string;
              position: string | null;
              detail_role: string | null;
              detail_label: string | null;
              side_role: string | null;
            }>);
      const playersById = new Map(
        roleRows.map((r) => [
          r.id,
          {
            position: r.position,
            detail_role: r.detail_role,
            detail_label: r.detail_label,
            side_role: r.side_role,
          },
        ]),
      );
      for (const id of playerIds) {
        if (!playersById.has(id)) {
          const p = top4Team.players.find((x) => x.id === id);
          playersById.set(id, {
            position: null,
            detail_role: null,
            detail_label: p?.position_display?.split(" ")[0] ?? null,
            side_role: null,
          });
        }
      }
      const validated = validateLineupSlots(
        playersById,
        formation,
        body.slots,
        body.roles ?? null,
      );
      if (!validated.ok) {
        return reply.code(400).send({ error: validated.error });
      }
      const validatedBench = validateBenchSlots(
        playersById,
        body.bench ?? null,
        body.bench_roles ?? null,
        validated.slots,
      );
      if (!validatedBench.ok) {
        return reply.code(400).send({ error: validatedBench.error });
      }
      const squad = new Set(playerIds);
      for (const pid of [...validated.slots, ...validatedBench.bench]) {
        if (pid && !squad.has(pid)) {
          return reply.code(400).send({ error: "not_in_squad" });
        }
      }
      const clubIds = [...new Set(top4Team.players.map((p) => p.club_id))];
      const squadLock = loadSquadGwLock(db, clubIds, gw);
      const lockedClubs = new Set(squadLock.lockedClubIds);
      const lockedIds = [...validated.slots, ...validatedBench.bench].filter(
        (pid) => {
          if (!pid) return false;
          const p = top4Team.players.find((x) => x.id === pid);
          return Boolean(p && isClubLocked(p.club_id, lockedClubs));
        },
      );
      if (lockedIds.length) {
        return reply.code(400).send({
          error: "player_already_played",
          message:
            "Cannot include players whose club has already played in this GW",
          player_ids: lockedIds,
        });
      }
      const setBy = edit.asConsigliere ? "consigliere" : "manager";
      const slotsJson = serializeSlotsJson(
        validated.slots,
        validated.roles,
        validatedBench.bench,
        validatedBench.benchRoles,
      );
      const saved = upsertTop4Lineup(
        dbWrite,
        teamId,
        gw,
        formation.id,
        slotsJson,
        setBy,
        user.email,
      );
      const parsed = parseSlotsJson(saved.slots_json);
      return {
        ok: true,
        league: "top4",
        saved: {
          formation: saved.formation,
          slots: parsed.slots,
          roles: parsed.roles,
          bench: parsed.bench,
          bench_roles: parsed.benchRoles,
          updated_at: saved.updated_at,
          updated_by: saved.updated_by,
          set_by: saved.set_by,
        },
      };
    }

    if (!Number.isInteger(teamId) || !teamById(teamId)) {
      return reply.code(400).send({ error: "invalid_team" });
    }
    if (!canEditTeam(user, teamId)) {
      return reply.code(403).send({
        error: "forbidden",
        message: "Сохранять можно только состав своей команды.",
      });
    }

    const formation = formationById(formationId, FORMATIONS);
    if (!formation) {
      return reply.code(400).send({ error: "invalid_formation" });
    }
    if (!Array.isArray(body.slots)) {
      return reply.code(400).send({ error: "invalid_slots" });
    }

    const primerTeam = loadPrimerTeam(teamId);
    if (!primerTeam) {
      return reply.code(404).send({ error: "primer_not_found" });
    }

    const playerIds = primerTeam.players.map((p) => p.id);
    const roleRows =
      playerIds.length === 0
        ? []
        : (db
            .prepare(
              `SELECT id, position, detail_role, detail_label, side_role
               FROM players WHERE id IN (${playerIds.map(() => "?").join(",")})`,
            )
            .all(...playerIds) as Array<{
            id: string;
            position: string | null;
            detail_role: string | null;
            detail_label: string | null;
            side_role: string | null;
          }>);
    const playersById = new Map(
      roleRows.map((r) => [
        r.id,
        {
          position: r.position,
          detail_role: r.detail_role,
          detail_label: r.detail_label,
          side_role: r.side_role,
        },
      ]),
    );
    // Only squad members allowed
    for (const id of playerIds) {
      if (!playersById.has(id)) {
        const p = primerTeam.players.find((x) => x.id === id);
        playersById.set(id, {
          position: null,
          detail_role: null,
          detail_label: p?.position_display?.split(" ")[0] ?? null,
          side_role: null,
        });
      }
    }

    const validated = validateLineupSlots(
      playersById,
      formation,
      body.slots,
      body.roles ?? null,
    );
    if (!validated.ok) {
      return reply.code(400).send({ error: validated.error });
    }

    const validatedBench = validateBenchSlots(
      playersById,
      body.bench ?? null,
      body.bench_roles ?? null,
      validated.slots,
    );
    if (!validatedBench.ok) {
      return reply.code(400).send({ error: validatedBench.error });
    }

    // Ensure every non-null slot is on the squad
    const squad = new Set(playerIds);
    for (const pid of [...validated.slots, ...validatedBench.bench]) {
      if (pid && !squad.has(pid)) {
        return reply.code(400).send({ error: "not_in_squad" });
      }
    }

    try {
      const saved = upsertLineup(
        teamId,
        gw,
        formation.id,
        validated.slots,
        validated.roles,
        validatedBench.bench,
        validatedBench.benchRoles,
        user.email,
      );
      return {
        ok: true,
        saved: {
          formation: saved.formation,
          slots: saved.slots,
          roles: saved.roles,
          bench: saved.bench,
          bench_roles: saved.bench_roles,
          updated_at: saved.updated_at,
          updated_by: saved.updated_by,
        },
      };
    } catch (err) {
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : "save_failed" });
    }
  });

  app.get("/api/leagues", async () => {
    const rows = db
      .prepare(
        `SELECT l.*,
                (SELECT COUNT(*) FROM clubs c WHERE c.league_id = l.id) AS clubs,
                (SELECT COUNT(*) FROM players p WHERE p.league_id = l.id) AS players,
                (SELECT COUNT(*) FROM players p WHERE p.league_id = l.id AND p.fm_rating IS NOT NULL) AS fm_matched
         FROM leagues l
         ORDER BY l.sort_order`,
      )
      .all();
    return { leagues: rows.length ? rows : TOP8_LEAGUES };
  });

  /** Top-26 + mixed quota pool by FM rating: Σ market value + Σ trusted weekly wage. */
  app.get("/api/leagues/top26", async () => {
    const peers = loadWagePeers(db);
    const rated = (
      db
        .prepare(
          `SELECT p.id, p.name, p.league_id, p.fm_rating, p.market_value_eur,
                  p.capology_wage_pw, p.fm_wage_pw
           FROM players p
           WHERE p.fm_rating IS NOT NULL`,
        )
        .all() as Array<Record<string, unknown>>
    ).map((p) => withTrustedWageAsWagePw(p, peers));

    const byLeague = new Map<string, typeof rated>();
    for (const p of rated) {
      const lid = String(p.league_id);
      let list = byLeague.get(lid);
      if (!list) {
        list = [];
        byLeague.set(lid, list);
      }
      list.push(p);
    }
    for (const list of byLeague.values()) list.sort(compareRatingWageMv);

    const leagueMeta = db
      .prepare(`SELECT id, name, country FROM leagues ORDER BY sort_order`)
      .all() as Array<{ id: string; name: string; country: string }>;

    const leagues = leagueMeta.map((l) => {
      const top = (byLeague.get(l.id) ?? []).slice(0, 26);
      return {
        id: l.id,
        name: l.name,
        country: l.country,
        players: top.length,
        sum_market_value_eur: top.reduce((s, p) => s + (Number(p.market_value_eur) || 0), 0),
        sum_wage_pw: top.reduce((s, p) => s + (Number(p.wage_pw) || 0), 0),
      };
    });

    const quotaLeagues = QUOTA_POOL.map((q) => {
      const meta = leagueMeta.find((l) => l.id === q.id);
      const top = (byLeague.get(q.id) ?? []).slice(0, q.n);
      return {
        id: q.id,
        name: meta?.name ?? q.id,
        country: meta?.country ?? "",
        quota: q.n,
        players: top.length,
        sum_market_value_eur: top.reduce((s, p) => s + (Number(p.market_value_eur) || 0), 0),
        sum_wage_pw: top.reduce((s, p) => s + (Number(p.wage_pw) || 0), 0),
      };
    }).sort((a, b) => b.quota - a.quota);

    const sumMv = quotaLeagues.reduce((s, r) => s + r.sum_market_value_eur, 0);
    const sumWage = quotaLeagues.reduce((s, r) => s + r.sum_wage_pw, 0);
    const players = quotaLeagues.reduce((s, r) => s + r.players, 0);

    return {
      leagues,
      quota: {
        leagues: quotaLeagues,
        totals: {
          players,
          sum_market_value_eur: sumMv,
          sum_wage_pw: sumWage,
        },
        per_manager_16: {
          sum_market_value_eur: sumMv / 16,
          sum_wage_pw: sumWage / 16,
        },
      },
    };
  });

  app.get("/api/clubs", async (req) => {
    const q = req.query as { league?: string };
    const rows = q.league
      ? db
          .prepare(
            `SELECT c.*,
                    (SELECT COUNT(*) FROM players p WHERE p.club_id = c.id) AS players,
                    (SELECT COUNT(*) FROM players p WHERE p.club_id = c.id AND p.fm_rating IS NOT NULL) AS fm_matched
             FROM clubs c WHERE c.league_id = ?
             ORDER BY COALESCE(c.ranking, 999), c.name`,
          )
          .all(q.league)
      : db
          .prepare(
            `SELECT c.*,
                    (SELECT COUNT(*) FROM players p WHERE p.club_id = c.id) AS players,
                    (SELECT COUNT(*) FROM players p WHERE p.club_id = c.id AND p.fm_rating IS NOT NULL) AS fm_matched
             FROM clubs c
             ORDER BY c.league_id, COALESCE(c.ranking, 999), c.name`,
          )
          .all();
    return { clubs: rows };
  });

  app.get("/api/players", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const leagues = q.leagues
      ? q.leagues.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    const truthy = (v: string | undefined) => v === "1" || v === "true";
    let fpByPlayerId: Map<string, number> | undefined;
    try {
      const fpDb = dbWrite ?? db;
      const { fp } = await getIndexGwFpMap(fpDb, { sync: Boolean(dbWrite) });
      fpByPlayerId = fp;
    } catch {
      fpByPlayerId = undefined;
    }
    const result = listPlayers({
      league: q.league || undefined,
      leagues,
      club: q.club || undefined,
      q: q.q || undefined,
      line: q.line || undefined,
      pos: q.pos || undefined,
      sort: q.sort || undefined,
      hidePicked: truthy(q.hide_picked),
      hideNonTop4: truthy(q.hide_non_top4),
      fpByPlayerId,
      limit: q.limit ? Number(q.limit) : 500,
      offset: q.offset ? Number(q.offset) : 0,
    });
    const availDb = dbWrite ?? db;
    const ids = result.players.map((p) => String(p.id));
    const avail = loadAvailabilityForPlayers(availDb, ids);
    return {
      ...result,
      players: result.players.map((p) => ({
        ...p,
        availability: avail.get(String(p.id)) ?? null,
      })),
      availability_synced_at: loadAvailabilitySyncedAt(availDb),
    };
  });

  /** Last successful AF+FotMob availability sync (public timestamp). */
  app.get("/api/availability", async () => ({
    lastUpdated: loadAvailabilitySyncedAt(dbWrite ?? db),
  }));

  /** Admin: refresh injuries/suspensions for all Top-4 clubs (AF + FotMob). */
  app.post("/api/availability/refresh", async (req, reply) => {
    if (!requireAdmin(req)) return reply.code(401).send({ error: "unauthorized" });
    if (!dbWrite) return reply.code(503).send({ error: "db_write_unavailable" });
    try {
      const result = await forceSyncAvailability(dbWrite);
      return { ok: true, ...result };
    } catch (err) {
      console.warn(
        "availability refresh:",
        err instanceof Error ? err.message : err,
      );
      return reply.code(500).send({
        error: "refresh_failed",
        message: err instanceof Error ? err.message : "refresh_failed",
      });
    }
  });

  app.get("/api/players/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (dbWrite) {
      await ensureAvailabilitySynced(dbWrite).catch((err) => {
        console.warn(
          "availability sync:",
          err instanceof Error ? err.message : err,
        );
      });
    }
    const player = await getPlayerById(db, root, id, dbWrite);
    if (!player) {
      reply.code(404);
      return { error: "player_not_found", id };
    }
    return {
      ...player,
      availability: loadAvailabilityForPlayer(dbWrite ?? db, id),
    };
  });

  app.get("/api/players/:id/coaches", async (req, reply) => {
    const { id } = req.params as { id: string };
    const exists = db.prepare(`SELECT 1 AS ok FROM players WHERE id = ?`).get(id) as
      | { ok: number }
      | undefined;
    if (!exists) {
      reply.code(404);
      return { error: "player_not_found", id };
    }
    const cached = listPlayerCoaches(dbWrite ?? db, id);
    const coaches = await ensurePlayerCoaches(dbWrite, id, cached);
    return { player_id: id, coaches };
  });

  app.get("/api/positions", async () => {
    const rows = db
      .prepare(`SELECT position, detail_role, detail_label, side_role FROM players`)
      .all() as PlayerRow[];
    return { roles: collectDistinctRoles(rows) };
  });

  /** Precomputed 16-team snake fantasy draft (npm run primer:draft). */
  app.get("/api/primer", async (_req, reply) => {
    const primerPath = path.join(root, "data", "primer-draft.json");
    if (!fs.existsSync(primerPath)) {
      reply.code(404);
      return {
        error: "primer_not_found",
        hint: "Запустите npm run primer:draft",
      };
    }
    const data = JSON.parse(fs.readFileSync(primerPath, "utf8")) as {
      teams?: Array<{
        players?: Array<{ id: string; wage_pw: number }>;
        sum_wage_pw?: number;
      }>;
      unselected?: Array<{ id: string; wage_pw: number }>;
      [key: string]: unknown;
    };
    const peers = loadWagePeers(db);
    const ids: string[] = [];
    for (const t of data.teams ?? []) {
      for (const p of t.players ?? []) ids.push(p.id);
    }
    for (const p of data.unselected ?? []) ids.push(p.id);
    const wages = trustedWageMap(peers, ids);
    const apply = (p: { id: string; wage_pw: number }) => {
      const tw = wages.get(p.id);
      if (tw) p.wage_pw = tw.trusted_wage_pw;
    };
    for (const t of data.teams ?? []) {
      for (const p of t.players ?? []) apply(p);
      t.sum_wage_pw = (t.players ?? []).reduce((s, p) => s + (Number(p.wage_pw) || 0), 0);
    }
    for (const p of data.unselected ?? []) apply(p);
    return data;
  });

  app.get("/api/stats", async () => {
    const totals = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM players) AS players,
           (SELECT COUNT(*) FROM clubs) AS clubs,
           (SELECT COUNT(*) FROM players WHERE fm_rating IS NOT NULL) AS fm_matched,
           (SELECT COUNT(*) FROM players WHERE fm_wage_pw IS NOT NULL) AS fm_wage,
           (SELECT COUNT(*) FROM players WHERE capology_wage_pw IS NOT NULL) AS capology_wage
        `,
      )
      .get();
    const byLeague = db
      .prepare(
        `SELECT l.id, l.name,
                COUNT(p.id) AS players,
                SUM(CASE WHEN p.fm_rating IS NOT NULL THEN 1 ELSE 0 END) AS fm_matched
         FROM leagues l
         LEFT JOIN players p ON p.league_id = l.id
         GROUP BY l.id
         ORDER BY l.sort_order`,
      )
      .all();
    const meta = Object.fromEntries(
      (db.prepare(`SELECT key, value FROM meta`).all() as Array<{ key: string; value: string }>).map(
        (r) => [r.key, r.value],
      ),
    );
    return { totals, byLeague, meta };
  });

  function tableExists(name: string): boolean {
    const row = db
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) as { ok: number } | undefined;
    return Boolean(row);
  }

  function hasGameweekColumn(): boolean {
    if (!tableExists("fixtures")) return false;
    const cols = db.prepare(`PRAGMA table_info(fixtures)`).all() as Array<{ name: string }>;
    return cols.some((c) => c.name === "gameweek");
  }

  app.get("/api/fixtures/stats", async () => {
    if (!tableExists("fixtures")) {
      return { total: 0, byLeague: [], mappedClubs: 0 };
    }
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM fixtures`).get() as { n: number }).n;
    const byLeague = db
      .prepare(
        `SELECT f.league_id AS id, l.name, COUNT(*) AS fixtures
         FROM fixtures f
         LEFT JOIN leagues l ON l.id = f.league_id
         GROUP BY f.league_id
         ORDER BY MIN(l.sort_order), f.league_id`,
      )
      .all();
    const mappedClubs = tableExists("club_af_map")
      ? (db.prepare(`SELECT COUNT(*) AS n FROM club_af_map`).get() as { n: number }).n
      : 0;
    return { total, byLeague, mappedClubs };
  });

  app.get("/api/gameweeks", async () => {
    if (!tableExists("fixtures") || !hasGameweekColumn()) {
      return { gameweeks: [] };
    }
    const scheduleWhere = scheduleWhereClauses("fixtures").join(" AND ");
    const rows = db
      .prepare(
        `SELECT gameweek AS gw, COUNT(*) AS fixtures, MIN(date) AS first, MAX(date) AS last
         FROM fixtures
         WHERE ${scheduleWhere}
         GROUP BY gameweek
         HAVING COUNT(*) > 0
         ORDER BY gameweek`,
      )
      .all() as Array<{ gw: number; fixtures: number; first: string; last: string }>;
    return {
      gameweeks: rows.map((r) => {
        const range = gameweekRange(r.gw);
        return {
          gameweek: r.gw,
          fixtures: r.fixtures,
          first: r.first,
          last: r.last,
          start: new Date(range.startMs).toISOString(),
          end: new Date(range.endMs).toISOString(),
          label: range.label,
        };
      }),
    };
  });

  app.get("/api/fixtures", async (req) => {
    if (!tableExists("fixtures")) {
      return { total: 0, fixtures: [], meta: { byLeague: [] } };
    }
    const q = req.query as Record<string, string | undefined>;
    const where: string[] = [];
    const params: unknown[] = [];

    const scheduleDefaults = defaultScheduleFilters({
      includeFriendlies: parseIncludeFriendlies(q.include_friendlies),
    });
    where.push(...scheduleWhereClauses("f", scheduleDefaults));

    if (q.league) {
      where.push("f.league_id = ?");
      params.push(q.league);
    } else if (q.leagues) {
      const ids = q.leagues
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (ids.length) {
        where.push(`f.league_id IN (${ids.map(() => "?").join(",")})`);
        params.push(...ids);
      }
    }
    // Fixtures involving clubs from these domestic leagues (cups / supers / Europe),
    // not only rows where f.league_id is the domestic competition id.
    if (q.club_leagues && tableExists("club_af_map")) {
      const ids = q.club_leagues
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (ids.length) {
        const ph = ids.map(() => "?").join(",");
        const afSub = `SELECT m.af_team_id FROM club_af_map m
          JOIN clubs c ON c.id = m.club_id
          WHERE c.league_id IN (${ph})`;
        where.push(`(f.home_af_id IN (${afSub}) OR f.away_af_id IN (${afSub}))`);
        params.push(...ids, ...ids);
      }
    }
    if (q.status) {
      where.push("f.status = ?");
      params.push(q.status);
    }
    if (q.gameweek) {
      const gw = Number(q.gameweek);
      if (Number.isFinite(gw)) {
        where.push("f.gameweek = ?");
        params.push(gw);
      }
    }
    if (q.gw_min) {
      const gwMin = Number(q.gw_min);
      if (Number.isFinite(gwMin)) {
        where.push("f.gameweek >= ?");
        params.push(gwMin);
      }
    }
    if (q.gw_max) {
      const gwMax = Number(q.gw_max);
      if (Number.isFinite(gwMax)) {
        where.push("f.gameweek <= ?");
        params.push(gwMax);
      }
    }
    if (q.from) {
      where.push("f.date >= ?");
      params.push(q.from);
    }
    if (q.to) {
      // inclusive end-of-day if date-only
      const to = q.to.length === 10 ? `${q.to}T23:59:59` : q.to;
      where.push("f.date <= ?");
      params.push(to);
    }
    if (q.club) {
      const club = q.club;
      const clubRow = db.prepare(`SELECT id FROM clubs WHERE id = ?`).get(club) as
        | { id: string }
        | undefined;
      if (clubRow && tableExists("club_af_map")) {
        const afIds = (
          db
            .prepare(`SELECT af_team_id FROM club_af_map WHERE club_id = ?`)
            .all(club) as Array<{ af_team_id: number }>
        ).map((r) => r.af_team_id);
        if (afIds.length === 0) {
          return { total: 0, fixtures: [], meta: { byLeague: [] } };
        }
        where.push(
          `(f.home_af_id IN (${afIds.map(() => "?").join(",")}) OR f.away_af_id IN (${afIds.map(() => "?").join(",")}))`,
        );
        params.push(...afIds, ...afIds);
      } else {
        const asAf = Number(club);
        if (Number.isFinite(asAf) && String(asAf) === club) {
          where.push("(f.home_af_id = ? OR f.away_af_id = ?)");
          params.push(asAf, asAf);
        } else {
          return { total: 0, fixtures: [], meta: { byLeague: [] } };
        }
      }
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const hasMap = tableExists("club_af_map");
    const limitRaw = q.limit ? Number(q.limit) : NaN;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 5000) : null;
    const offsetRaw = q.offset ? Number(q.offset) : 0;
    const offset = Number.isFinite(offsetRaw) ? Math.max(Math.trunc(offsetRaw), 0) : 0;

    const sql = `SELECT f.*,
            COALESCE(f.competition_name, l.name) AS league_name,
            ${
              hasMap
                ? `hm.club_id AS home_club_id, am.club_id AS away_club_id,
            hc.name AS home_club_name, ac.name AS away_club_name,
            hc.club_code AS home_club_code, ac.club_code AS away_club_code,
            hc.crest_url AS home_crest, ac.crest_url AS away_crest`
                : `NULL AS home_club_id, NULL AS away_club_id,
            NULL AS home_club_name, NULL AS away_club_name,
            NULL AS home_club_code, NULL AS away_club_code,
            NULL AS home_crest, NULL AS away_crest`
            }
     FROM fixtures f
     LEFT JOIN leagues l ON l.id = f.league_id
     ${
       hasMap
         ? `LEFT JOIN club_af_map hm ON hm.af_team_id = f.home_af_id
     LEFT JOIN clubs hc ON hc.id = hm.club_id
     LEFT JOIN club_af_map am ON am.af_team_id = f.away_af_id
     LEFT JOIN clubs ac ON ac.id = am.club_id`
         : ""
     }
     ${whereSql}
     ORDER BY f.date ASC, f.id ASC`;

    const total = (
      db.prepare(`SELECT COUNT(*) AS n FROM fixtures f ${whereSql}`).get(...params) as { n: number }
    ).n;
    const rows = limit
      ? db.prepare(`${sql} LIMIT ? OFFSET ?`).all(...params, limit, offset)
      : db.prepare(sql).all(...params);
    const byLeague = db
      .prepare(
        `SELECT f.league_id AS id, COUNT(*) AS fixtures
         FROM fixtures f
         ${whereSql}
         GROUP BY f.league_id`,
      )
      .all(...params);

    const wantXi = q.xi === "1" || q.xi === "true";
    const fixtureClubRefs = wantXi
      ? (
          rows as Array<{
            id: number;
            gameweek?: number | null;
            home_club_id?: string | null;
            away_club_id?: string | null;
          }>
        ).map((r) => ({
          id: r.id,
          gameweek: r.gameweek,
          home_club_id: r.home_club_id,
          away_club_id: r.away_club_id,
        }))
      : [];
    const xiById = wantXi ? xiTeamsByFixtureId(db, fixtureClubRefs) : null;
    const fullById = wantXi ? fullTeamsByFixtureId(db, fixtureClubRefs) : null;
    const fixtures = (
      rows as Array<{
        id: number;
        home_club_code?: string | null;
        away_club_code?: string | null;
        home_club_name?: string | null;
        away_club_name?: string | null;
        home_name?: string | null;
        away_name?: string | null;
      }>
    ).map((r) => ({
      ...r,
      home_club_code: clubCodeLabel(r.home_club_code, r.home_club_name || r.home_name),
      away_club_code: clubCodeLabel(r.away_club_code, r.away_club_name || r.away_name),
      ...(xiById ? { xi_teams: xiById.get(r.id) ?? [] } : {}),
      ...(fullById ? { full_teams: fullById.get(r.id) ?? [] } : {}),
    }));

    return {
      total,
      limit: limit ?? undefined,
      offset: limit ? offset : undefined,
      fixtures,
      meta: { byLeague },
    };
  });

  /** Fantasy team logos (data volume) — path-safe, no directory listing. */
  app.get(`${TOP4_LOGO_PUBLIC_PREFIX}/:file`, async (req, reply) => {
    const fileParam = String((req.params as { file?: string }).file || "");
    const full = resolveTop4LogoFile(dataDir, fileParam);
    if (!full || !fs.existsSync(full)) {
      return reply.code(404).send({ error: "not_found" });
    }
    const ext = path.extname(full).slice(1).toLowerCase();
    const type =
      ext === "png"
        ? "image/png"
        : ext === "webp"
          ? "image/webp"
          : ext === "jpg" || ext === "jpeg"
            ? "image/jpeg"
            : "application/octet-stream";
    reply.header("Content-Type", type);
    reply.header("Cache-Control", "public, max-age=86400");
    return reply.send(fs.createReadStream(full));
  });

  const publicRoot = path.join(root, "public");
  const top4HtmlPath = path.join(publicRoot, "top4.html");
  const playersHtmlPath = path.join(publicRoot, "index.html");
  const TOP4_TAB_SLUGS: Record<string, string> = {
    draft: "draft",
    "draft-room": "draftRoom",
    draftRoom: "draftRoom",
    squads: "squads",
    stats: "stats",
    statistics: "stats",
    live: "live",
    "live-standing": "live",
    results: "results",
    transfers: "transfers",
    gws: "gws",
    schedule: "schedule",
    rules: "rules",
    season: "season2526",
    season2526: "season2526",
    "season-2026": "season2627",
    season2627: "season2627",
  };
  const TOP4_TAB_PATH: Record<string, string> = {
    draft: "/top4.html",
    draftRoom: "/top4/draft-room",
    squads: "/top4/squads",
    stats: "/top4/stats",
    live: "/top4/live",
    results: "/top4/results",
    transfers: "/top4/transfers",
    gws: "/top4/gws",
    schedule: "/top4/schedule",
    rules: "/top4/rules",
    season2526: "/top4/season",
    season2627: "/top4/season-2026",
  };
  const sendTop4Page = (reply: FastifyReply) =>
    reply
      .type("text/html; charset=utf-8")
      .header("Cache-Control", "public, max-age=0")
      .send(fs.createReadStream(top4HtmlPath));
  const sendPlayersPage = (reply: FastifyReply) =>
    reply
      .type("text/html; charset=utf-8")
      .header("Cache-Control", "public, max-age=0")
      .send(fs.createReadStream(playersHtmlPath));

  app.get("/", async (_req, reply) => sendTop4Page(reply));
  app.get("/players", async (_req, reply) => sendPlayersPage(reply));

  app.get("/top4.html", async (req, reply) => {
    const q = req.query as Record<string, string | string[] | undefined>;
    const raw = Array.isArray(q.tab) ? q.tab[0] : q.tab;
    const tab = raw ? TOP4_TAB_SLUGS[raw] : undefined;
    if (tab && tab !== "draft") {
      const dest = new URL(TOP4_TAB_PATH[tab] || "/top4.html", "http://local");
      for (const [k, v] of Object.entries(q)) {
        if (k === "tab" || v == null) continue;
        dest.searchParams.set(k, Array.isArray(v) ? String(v[0]) : String(v));
      }
      return reply.redirect(dest.pathname + dest.search);
    }
    return sendTop4Page(reply);
  });

  app.get("/top4/:page", async (req, reply) => {
    const page = String((req.params as { page?: string }).page || "");
    if (!TOP4_TAB_SLUGS[page]) {
      return reply.code(404).type("text/plain").send("Not found");
    }
    return sendTop4Page(reply);
  });

  app.get("/manifest.webmanifest", async (_req, reply) => {
    const manifestPath = path.join(publicRoot, "manifest.webmanifest");
    return reply
      .type("application/manifest+json")
      .header("Cache-Control", "no-cache")
      .send(fs.createReadStream(manifestPath));
  });

  await app.register(fastifyStatic, {
    root: publicRoot,
    prefix: "/",
    index: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith("sw.js")) {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  });

  await app.listen({ port, host });
  console.log(`Din8sty → http://127.0.0.1:${port}`);
  console.log(`Din8sty → http://din8sty.panenka.games:${port} (after /etc/hosts)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
