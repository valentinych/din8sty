/**
 * Top-4 live snake draft: 30 min/turn inside draft hours (default 10:00–20:00
 * Europe/Warsaw; admin may set 09:00–20:00 at start) plus a 4h total time bank
 * per manager.
 *
 * Turn timeout with bank still remaining: wishlist first valid pick, else
 * algorithmic fallback (primerDraft.choosePick).
 * When the time bank is exhausted (bank hits 0 / turn timer was capped by bank):
 * forcibly set out_of_draft, then wishlist else highest fm_rating among eligible.
 * OOD managers get an instant autopick on their turn (wishlist, else rating).
 *
 * Draft length is open-ended: managers may pick past the ≥26 roster minimum.
 * Each manager can mark draft_finished (≥26 required) to skip further turns.
 * The whole draft completes only when every manager has finished.
 */
import type Database from "better-sqlite3";
import {
  DEFAULT_DRAFT_HOURS,
  countWorkingMs,
  draftHoursFromLeague,
  isPickTimerExpired,
  isWithinDraftHours,
  pickTimerRemainingMs,
  type DraftHoursConfig,
} from "./draftHours.js";
import {
  FORMATIONS,
  addPlayer,
  canAddPlayerToTeam,
  choosePick,
  emptyTeamState,
  fieldableFormations,
  isGoalkeeper,
  pickFirstFromWishlist,
  primaryGroup,
  withDraftConfig,
  type DraftPlayer,
  type PrimerDraftResult,
  type TeamState,
} from "./primerDraft.js";
import { loadTop4PlayersByIds, loadTop4Pool, TOP4_DRAFT_CONFIG } from "./top4Draft.js";
import {
  ensureTop4Tables,
  getTop4State,
  isTop4LeagueId,
  listTop4Registrations,
  listTop4Wishlist,
  parseLotteryOrder,
  recompactTop4Wishlist,
  TOP4_IDS,
  TOP4_MAX_PER_CLUB,
  TOP4_MIN_GK,
  TOP4_MIN_PER_LEAGUE,
  TOP4_MV_CAP,
  TOP4_ROUNDS,
  TOP4_TEAM_COUNT,
  TOP4_WAGE_CAP,
  type Top4LotteryEntry,
  type Top4StateRow,
} from "./top4League.js";
import { assertWishlistActor, resolveTop4Owner } from "./top4Consigliere.js";

const DEFAULT_PICK_TIMEOUT_SEC = 1800;
const DEFAULT_BANK_SEC = 14400;
/** Safety cap for consecutive skip/autopick resolutions in one tick. */
const ENSURE_GUARD = TOP4_TEAM_COUNT * 200;

/** Snake slot (1-based, matches lottery draft_slot) on the clock for a given overall pick number. */
export function memberSlotForPick(
  pickNumber: number,
  teamCount: number = TOP4_TEAM_COUNT,
): number {
  const idx = Math.max(0, pickNumber - 1);
  const round = Math.floor(idx / teamCount);
  const posInRound = idx % teamCount;
  const slotIdx = round % 2 === 0 ? posInRound : teamCount - 1 - posInRound;
  return slotIdx + 1;
}

/** Remaining picks toward the ≥26 roster minimum after taking one more player. */
function remainingAfterPick(team: TeamState): number {
  return Math.max(0, TOP4_ROUNDS - team.players.length - 1);
}

function hoursConfig(state: Top4StateRow): DraftHoursConfig {
  return draftHoursFromLeague({
    draftHoursTz: state.draft_hours_tz,
    draftHoursStart: state.draft_hours_start,
    draftHoursEnd: state.draft_hours_end,
  });
}

type PickRow = {
  pick_number: number;
  team_id: number;
  email: string;
  player_id: string;
  auto: 0 | 1 | 2;
  picked_at: string;
  set_by: string;
  /** 1 after manager/consigliere replaced an algorithmic (auto=2) pick. */
  replaced: number;
};

type BankRow = {
  email: string;
  bank_remaining_sec: number;
  out_of_draft: number;
  draft_finished: number;
};

type PoolCtx = { all: DraftPlayer[]; byId: Map<string, DraftPlayer> };

function loadPoolCtx(db: Database.Database): PoolCtx {
  const all = loadTop4Pool(db);
  return { all, byId: new Map(all.map((p) => [p.id, p])) };
}

function listPicks(db: Database.Database): PickRow[] {
  return db
    .prepare(
      `SELECT pick_number, team_id, email, player_id, auto, picked_at, set_by,
              COALESCE(replaced, 0) AS replaced
       FROM top4_draft_picks ORDER BY pick_number ASC`,
    )
    .all() as PickRow[];
}

function getBank(db: Database.Database, email: string): BankRow | null {
  return (
    (db
      .prepare(
        `SELECT email, bank_remaining_sec, out_of_draft, draft_finished FROM top4_draft_banks
         WHERE email = ? COLLATE NOCASE`,
      )
      .get(email.toLowerCase()) as BankRow | undefined) ?? null
  );
}

function listBanks(db: Database.Database): BankRow[] {
  return db
    .prepare(
      `SELECT email, bank_remaining_sec, out_of_draft, draft_finished FROM top4_draft_banks`,
    )
    .all() as BankRow[];
}

function setOutOfDraftFlag(db: Database.Database, email: string, value: boolean): void {
  db.prepare(
    `UPDATE top4_draft_banks SET out_of_draft = ? WHERE email = ? COLLATE NOCASE`,
  ).run(value ? 1 : 0, email.toLowerCase());
}

function setDraftFinishedFlag(db: Database.Database, email: string, value: boolean): void {
  db.prepare(
    `UPDATE top4_draft_banks SET draft_finished = ? WHERE email = ? COLLATE NOCASE`,
  ).run(value ? 1 : 0, email.toLowerCase());
}

function pickCountForEmail(db: Database.Database, email: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM top4_draft_picks WHERE email = ? COLLATE NOCASE`,
    )
    .get(email.toLowerCase()) as { n: number };
  return row?.n ?? 0;
}

function allManagersFinished(
  lottery: Top4LotteryEntry[],
  banks: BankRow[],
): boolean {
  if (!lottery.length) return false;
  const byEmail = new Map(banks.map((b) => [b.email.toLowerCase(), b]));
  return lottery.every((e) => Boolean(byEmail.get(e.email.toLowerCase())?.draft_finished));
}

function buildTeams(
  lottery: Top4LotteryEntry[],
  picks: PickRow[],
  pool: PoolCtx,
): Map<number, TeamState> {
  const teams = new Map<number, TeamState>();
  for (const e of lottery) teams.set(e.team_id, emptyTeamState(e.team_id, e.team_name));
  for (const p of picks) {
    const team = teams.get(p.team_id);
    const player = pool.byId.get(p.player_id);
    if (team && player) addPlayer(team, player);
  }
  return teams;
}

function groupCounts(players: DraftPlayer[]): Record<string, number> {
  const counts: Record<string, number> = { GK: 0, DEF: 0, MID: 0, ATT: 0 };
  for (const p of players) {
    const g = primaryGroup(p);
    if (g) counts[g] += 1;
  }
  return counts;
}

function computeTeamConstraints(players: DraftPlayer[]) {
  const leagues: Record<string, number> = {};
  const clubs = new Map<string, number>();
  let mv = 0;
  let wage = 0;
  let gk = 0;
  for (const p of players) {
    leagues[p.league_id] = (leagues[p.league_id] ?? 0) + 1;
    if (p.club_id) clubs.set(p.club_id, (clubs.get(p.club_id) ?? 0) + 1);
    mv += p.market_value_eur;
    wage += p.wage_pw;
    if (isGoalkeeper(p)) gk += 1;
  }
  const max_club = [...clubs.values()].reduce((m, n) => Math.max(m, n), 0);
  const leagues_ok = TOP4_IDS.every((id) => (leagues[id] ?? 0) >= TOP4_MIN_PER_LEAGUE);
  return {
    leagues,
    max_club,
    leagues_ok,
    clubs_ok: max_club <= TOP4_MAX_PER_CLUB,
    gk_ok: gk >= TOP4_MIN_GK,
    within_budget: mv <= TOP4_MV_CAP && wage <= TOP4_WAGE_CAP,
  };
}

/** Start the live draft: reset picks/banks, seed the 4h bank per manager, open pick #1. */
export function startLiveDraft(
  db: Database.Database,
  lottery: Top4LotteryEntry[],
  hours?: { timezone?: string; start?: string; end?: string },
): void {
  ensureTop4Tables(db);
  const now = new Date().toISOString();
  const tz = hours?.timezone?.trim() || DEFAULT_DRAFT_HOURS.timezone;
  const start =
    hours?.start?.trim() ||
    `${String(DEFAULT_DRAFT_HOURS.startHour).padStart(2, "0")}:00`;
  const end =
    hours?.end?.trim() ||
    `${String(DEFAULT_DRAFT_HOURS.endHour).padStart(2, "0")}:00`;
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM top4_draft_picks`).run();
    db.prepare(`DELETE FROM top4_draft_banks`).run();
    db.prepare(`DELETE FROM top4_draft_vacancies`).run();
    db.prepare(`DELETE FROM top4_pick_replace_log`).run();
    const insertBank = db.prepare(
      `INSERT INTO top4_draft_banks (email, bank_remaining_sec, out_of_draft, draft_finished)
       VALUES (?, ?, 0, 0)`,
    );
    for (const e of lottery) insertBank.run(e.email.toLowerCase(), DEFAULT_BANK_SEC);
    db.prepare(
      `UPDATE top4_state SET
         status = 'drafting',
         draft_json = NULL,
         current_pick_no = 1,
         current_pick_at = ?,
         draft_started_at = ?,
         pick_timeout_sec = ?,
         pick_bank_sec = ?,
         draft_hours_tz = ?,
         draft_hours_start = ?,
         draft_hours_end = ?,
         updated_at = ?
       WHERE id = 1`,
    ).run(
      now,
      now,
      DEFAULT_PICK_TIMEOUT_SEC,
      DEFAULT_BANK_SEC,
      tz,
      start,
      end,
      now,
    );
  });
  tx();
}

/**
 * Drop drafted players from every wishlist, then drop wishlist players whose
 * next pick is an immediate hard block (club max / MV / wage).
 * Uses `enforceRosterMins: false` so min-GK / min-league do not prune wishlist.
 * When `ownerEmail` is set, limit-pruning is scoped to that manager; taken
 * players are always removed globally.
 */
export function pruneTop4WishlistForDraft(
  db: Database.Database,
  ownerEmail?: string | null,
): void {
  ensureTop4Tables(db);
  const state = getTop4State(db);
  if (state.status !== "drafting" && state.status !== "complete") return;

  const lottery = parseLotteryOrder(state) ?? [];
  const pool = loadPoolCtx(db);
  const picks = listPicks(db);
  const teams = lottery.length ? buildTeams(lottery, picks, pool) : new Map<number, TeamState>();

  const owners = ownerEmail
    ? lottery.filter((e) => e.email.toLowerCase() === ownerEmail.toLowerCase())
    : lottery;

  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM top4_wishlist
       WHERE player_id IN (SELECT player_id FROM top4_draft_picks)`,
    ).run();

    const delOne = db.prepare(
      `DELETE FROM top4_wishlist WHERE email = ? COLLATE NOCASE AND player_id = ?`,
    );

    for (const entry of owners) {
      const em = entry.email.toLowerCase();
      const team = teams.get(entry.team_id);
      if (!team) continue;
      const rows = listTop4Wishlist(db, em);
      if (!rows.length) continue;

      const remainingAfter = remainingAfterPick(team);
      for (const r of rows) {
        const player = pool.byId.get(r.player_id);
        if (!player) {
          delOne.run(em, r.player_id);
          continue;
        }
        const ok = withDraftConfig(TOP4_DRAFT_CONFIG, () =>
          canAddPlayerToTeam(team, player, remainingAfter, false),
        );
        if (!ok) delOne.run(em, r.player_id);
      }
    }

    const emails = db
      .prepare(`SELECT DISTINCT email FROM top4_wishlist`)
      .all() as Array<{ email: string }>;
    for (const { email } of emails) recompactTop4Wishlist(db, email);
  });
  tx();
}

/** During live draft, reject wishlist adds that are taken or hard-blocked. */
export function assertTop4WishlistPlayerEligible(
  db: Database.Database,
  ownerEmail: string,
  playerId: string,
): void {
  ensureTop4Tables(db);
  const state = getTop4State(db);
  if (state.status !== "drafting") return;

  const picks = listPicks(db);
  if (picks.some((p) => p.player_id === playerId)) throw new Error("player_taken");

  const lottery = parseLotteryOrder(state) ?? [];
  const entry = lottery.find((e) => e.email.toLowerCase() === ownerEmail.toLowerCase());
  if (!entry) return;

  const pool = loadPoolCtx(db);
  const player = pool.byId.get(playerId);
  // Exists in players table (caller checked) but outside Top-4 draft leagues.
  if (!player) throw new Error("not_in_draft_pool");

  const teams = buildTeams(lottery, picks, pool);
  const team = teams.get(entry.team_id);
  if (!team) return;

  const remainingAfter = remainingAfterPick(team);
  const ok = withDraftConfig(TOP4_DRAFT_CONFIG, () =>
    canAddPlayerToTeam(team, player, remainingAfter, false),
  );
  if (!ok) throw new Error("pick_invalid");
}

function markDraftComplete(db: Database.Database, pickNo: number): void {
  const nowIso = new Date().toISOString();
  const draft = assembleDraftJson(db);
  db.prepare(
    `UPDATE top4_state SET status = 'complete', draft_json = ?, current_pick_no = ?,
     current_pick_at = NULL, updated_at = ? WHERE id = 1`,
  ).run(JSON.stringify(draft), pickNo, nowIso);
}

/** Advance the clock to the next pick number without recording a pick (skip finished). */
function advancePickClock(db: Database.Database, fromPickNo: number): void {
  const nowIso = new Date().toISOString();
  db.prepare(
    `UPDATE top4_state SET current_pick_no = ?, current_pick_at = ?, updated_at = ?
     WHERE id = 1`,
  ).run(fromPickNo + 1, nowIso, nowIso);
}

/** Insert a resolved pick, debit the manager's bank, and advance the draft clock. */
function finalizePick(
  db: Database.Database,
  opts: {
    state: Top4StateRow;
    entry: Top4LotteryEntry;
    player: DraftPlayer;
    auto: 0 | 1 | 2;
    setBy: string;
    instant: boolean;
  },
): void {
  const { state, entry, player, auto, setBy, instant } = opts;
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const pickNo = state.current_pick_no || 1;
  const hours = hoursConfig(state);
  const pickAtMs = state.current_pick_at ? Date.parse(state.current_pick_at) : nowMs;
  const workingMs = instant ? 0 : countWorkingMs(pickAtMs, nowMs, hours);
  const usedSec = Math.max(0, Math.ceil(workingMs / 1000));

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO top4_draft_picks (pick_number, team_id, email, player_id, auto, picked_at, set_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(pickNo, entry.team_id, entry.email.toLowerCase(), player.id, auto, nowIso, setBy);

    if (usedSec > 0) {
      db.prepare(
        `UPDATE top4_draft_banks SET bank_remaining_sec = MAX(0, bank_remaining_sec - ?)
         WHERE email = ? COLLATE NOCASE`,
      ).run(usedSec, entry.email.toLowerCase());
    }

    const nextPickNo = pickNo + 1;
    db.prepare(
      `UPDATE top4_state SET current_pick_no = ?, current_pick_at = ?, updated_at = ?
       WHERE id = 1`,
    ).run(nextPickNo, nowIso, nowIso);
  });
  tx();
  pruneTop4WishlistForDraft(db);
}

/** Highest fm_rating among players that pass canAddPlayerToTeam (taken already filtered). */
function pickHighestRatedEligible(
  team: TeamState,
  available: DraftPlayer[],
  remainingAfter: number,
  enforceRosterMins: boolean,
): DraftPlayer | null {
  let best: DraftPlayer | null = null;
  for (const p of available) {
    if (!canAddPlayerToTeam(team, p, remainingAfter, enforceRosterMins)) continue;
    if (!best) {
      best = p;
      continue;
    }
    const better =
      p.fm_rating > best.fm_rating ||
      (p.fm_rating === best.fm_rating && p.wage_pw > best.wage_pw) ||
      (p.fm_rating === best.fm_rating &&
        p.wage_pw === best.wage_pw &&
        p.market_value_eur > best.market_value_eur) ||
      (p.fm_rating === best.fm_rating &&
        p.wage_pw === best.wage_pw &&
        p.market_value_eur === best.market_value_eur &&
        p.name.localeCompare(best.name) < 0);
    if (better) best = p;
  }
  return best;
}

/**
 * Try to resolve the current pick automatically. Returns true iff a pick was made.
 * fallback: "algorithm" = choosePick (paced); "rating" = fm_rating high→low within limits.
 */
function tryAutoPick(
  db: Database.Database,
  state: Top4StateRow,
  entry: Top4LotteryEntry,
  opts: { fallback: "algorithm" | "rating"; instant: boolean },
): boolean {
  const pool = loadPoolCtx(db);
  const picks = listPicks(db);
  const taken = new Set(picks.map((p) => p.player_id));
  const teams = buildTeams(parseLotteryOrder(state) ?? [], picks, pool);
  const team = teams.get(entry.team_id);
  if (!team) return false;
  const available = pool.all.filter((p) => !taken.has(p.id));
  const remainingAfter = remainingAfterPick(team);
  const wishlistIds = listTop4Wishlist(db, entry.email).map((w) => w.player_id);

  const choice = withDraftConfig(TOP4_DRAFT_CONFIG, () => {
    const fromWishlist = wishlistIds.length
      ? pickFirstFromWishlist(team, wishlistIds, available, remainingAfter, true)
      : null;
    if (fromWishlist) return { player: fromWishlist, auto: 1 as const };
    const fallback =
      opts.fallback === "rating"
        ? pickHighestRatedEligible(team, available, remainingAfter, true)
        : (choosePick(team, available, available, remainingAfter, true) ?? available[0] ?? null);
    return fallback ? { player: fallback, auto: 2 as const } : null;
  });

  if (!choice) return false;
  finalizePick(db, {
    state,
    entry,
    player: choice.player,
    auto: choice.auto,
    setBy: "system",
    instant: opts.instant,
  });
  return true;
}

/**
 * Resolve due auto-picks and skip finished managers until the clock lands on an
 * unfinished manager who needs a human (or the draft completes).
 */
function ensureCurrentPickFresh(db: Database.Database): void {
  for (let i = 0; i < ENSURE_GUARD; i++) {
    const state = getTop4State(db);
    if (state.status !== "drafting") return;

    const lottery = parseLotteryOrder(state) ?? [];
    const banks = listBanks(db);
    if (allManagersFinished(lottery, banks)) {
      markDraftComplete(db, state.current_pick_no || 1);
      return;
    }

    const pickNo = state.current_pick_no || 1;
    const slot = memberSlotForPick(pickNo, TOP4_TEAM_COUNT);
    const entry = lottery.find((e) => e.draft_slot === slot);
    if (!entry) return;

    const bank = getBank(db, entry.email);
    if (!bank) return;

    if (bank.draft_finished) {
      advancePickClock(db, pickNo);
      continue;
    }

    if (bank.out_of_draft) {
      // Wishlist first; empty/invalid wishlist → highest eligible fm_rating (do not stall / clear OOD).
      if (tryAutoPick(db, state, entry, { fallback: "rating", instant: true })) continue;
      return;
    }

    const hours = hoursConfig(state);
    const timeoutSec = Math.min(
      state.pick_timeout_sec || DEFAULT_PICK_TIMEOUT_SEC,
      bank.bank_remaining_sec,
    );
    const pickAtMs = state.current_pick_at ? Date.parse(state.current_pick_at) : Date.now();
    if (!isPickTimerExpired(pickAtMs, Date.now(), timeoutSec, hours)) return;

    // Timer was capped by remaining bank (or bank already 0) → force OOD + rating fallback.
    const bankExhausted = bank.bank_remaining_sec <= timeoutSec;
    if (bankExhausted) {
      setOutOfDraftFlag(db, entry.email, true);
      if (tryAutoPick(db, state, entry, { fallback: "rating", instant: false })) continue;
      return;
    }

    if (!tryAutoPick(db, state, entry, { fallback: "algorithm", instant: false })) return;
  }
}

/** Advance timers — resolves any due timeout/bank-out/out-of-draft autopicks. */
export function tickLiveDraft(db: Database.Database): LiveDraftPublic | null {
  ensureTop4Tables(db);
  ensureCurrentPickFresh(db);
  return getLiveDraftPublic(db);
}

/** Manual pick by the on-clock manager (or their consigliere, per wishlist rules). */
export function attemptManualPick(
  db: Database.Database,
  actorEmail: string,
  playerId: string,
  ownerEmailRaw?: string | null,
): LiveDraftPublic {
  ensureTop4Tables(db);
  ensureCurrentPickFresh(db);
  const state = getTop4State(db);
  if (state.status === "complete") throw new Error("draft_complete");
  if (state.status !== "drafting") throw new Error("draft_not_live");

  const lottery = parseLotteryOrder(state) ?? [];
  const pickNo = state.current_pick_no || 1;
  const slot = memberSlotForPick(pickNo, TOP4_TEAM_COUNT);
  const entry = lottery.find((e) => e.draft_slot === slot);
  if (!entry) throw new Error("draft_state_invalid");

  const bank = getBank(db, entry.email);
  if (bank?.draft_finished) throw new Error("draft_finished");

  const { ownerEmail, asConsigliere } = resolveTop4Owner(db, actorEmail, ownerEmailRaw);
  if (ownerEmail.toLowerCase() !== entry.email.toLowerCase()) {
    throw new Error("not_your_turn");
  }
  assertWishlistActor(db, actorEmail, ownerEmail, asConsigliere);

  const pool = loadPoolCtx(db);
  const player = pool.byId.get(playerId);
  if (!player) throw new Error("player_not_found");

  const picks = listPicks(db);
  if (picks.some((p) => p.player_id === playerId)) throw new Error("player_taken");

  const teams = buildTeams(lottery, picks, pool);
  const team = teams.get(entry.team_id);
  if (!team) throw new Error("draft_state_invalid");
  const remainingAfter = remainingAfterPick(team);

  const ok = withDraftConfig(TOP4_DRAFT_CONFIG, () =>
    canAddPlayerToTeam(team, player, remainingAfter, true),
  );
  if (!ok) throw new Error("pick_invalid");

  finalizePick(db, {
    state,
    entry,
    player,
    auto: 0,
    setBy: asConsigliere ? "consigliere" : "manager",
    instant: false,
  });

  ensureCurrentPickFresh(db);
  return getLiveDraftPublic(db)!;
}

/**
 * Replace an algorithmic autopick (auto=2, not yet replaced) with a free eligible player.
 * Allowed for the pick's manager or their consigliere while drafting or after complete.
 * Updates the existing pick row in place (keeps pick_number); sets replaced=1.
 */
export function replaceAutoPick(
  db: Database.Database,
  actorEmail: string,
  opts: {
    newPlayerId: string;
    /** Current player on the algorithmic pick to replace. */
    playerId?: string | null;
    /** Or address the pick by overall pick number. */
    pickNumber?: number | null;
    ownerEmailRaw?: string | null;
  },
): { squads: Top4SquadsPublic; live: LiveDraftPublic | null; status: Top4StateRow["status"] } {
  ensureTop4Tables(db);
  const state = getTop4State(db);
  if (state.status !== "drafting" && state.status !== "complete") {
    throw new Error("draft_not_live");
  }

  const newPlayerId = String(opts.newPlayerId || "").trim();
  if (!newPlayerId) throw new Error("player_id_required");

  const { ownerEmail, asConsigliere } = resolveTop4Owner(
    db,
    actorEmail,
    opts.ownerEmailRaw,
  );

  const picks = listPicks(db);
  let target: PickRow | undefined;
  if (opts.pickNumber != null && Number.isFinite(Number(opts.pickNumber))) {
    const n = Number(opts.pickNumber);
    target = picks.find((p) => p.pick_number === n);
  } else if (opts.playerId) {
    const pid = String(opts.playerId).trim();
    target = picks.find(
      (p) =>
        p.player_id === pid &&
        p.email.toLowerCase() === ownerEmail.toLowerCase(),
    );
  } else {
    throw new Error("player_id_required");
  }

  if (!target) throw new Error("pick_not_found");
  if (target.email.toLowerCase() !== ownerEmail.toLowerCase()) {
    throw new Error("not_your_pick");
  }
  if (target.auto !== 2) throw new Error("not_algo_auto");
  if (target.replaced) throw new Error("already_replaced");
  if (target.player_id === newPlayerId) throw new Error("same_player");

  const pool = loadPoolCtx(db);
  const newPlayer = pool.byId.get(newPlayerId);
  if (!newPlayer) throw new Error("player_not_found");

  if (picks.some((p) => p.player_id === newPlayerId)) {
    throw new Error("player_taken");
  }

  const lottery = parseLotteryOrder(state) ?? [];
  const picksWithoutOld = picks.filter((p) => p.pick_number !== target!.pick_number);
  const teams = buildTeams(lottery, picksWithoutOld, pool);
  const team = teams.get(target.team_id);
  if (!team) throw new Error("draft_state_invalid");
  const remainingAfter = remainingAfterPick(team);

  const ok = withDraftConfig(TOP4_DRAFT_CONFIG, () =>
    canAddPlayerToTeam(team, newPlayer, remainingAfter, true),
  );
  if (!ok) throw new Error("pick_invalid");

  const nowIso = new Date().toISOString();
  const setBy = asConsigliere ? "consigliere" : "manager";
  const oldPlayerId = target.player_id;

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE top4_draft_picks
       SET player_id = ?, replaced = 1, set_by = ?, picked_at = ?
       WHERE pick_number = ?`,
    ).run(newPlayerId, setBy, nowIso, target!.pick_number);

    db.prepare(
      `INSERT INTO top4_pick_replace_log
         (pick_number, team_id, old_player_id, new_player_id, created_at, logged, kind)
       VALUES (?, ?, ?, ?, ?, 0, 'replace')`,
    ).run(target!.pick_number, target!.team_id, oldPlayerId, newPlayerId, nowIso);

    db.prepare(`UPDATE top4_state SET updated_at = ? WHERE id = 1`).run(nowIso);
  });
  tx();

  pruneTop4WishlistForDraft(db);

  if (state.status === "complete") {
    const draft = assembleDraftJson(db);
    db.prepare(
      `UPDATE top4_state SET draft_json = ?, updated_at = ? WHERE id = 1`,
    ).run(JSON.stringify(draft), new Date().toISOString());
  }

  return {
    squads: getTop4SquadsPublic(db),
    live: getLiveDraftPublic(db),
    status: getTop4State(db).status,
  };
}

type VacancyRow = {
  id: number;
  team_id: number;
  email: string;
  pick_number: number;
  old_player_id: string;
  created_at: string;
};

function listVacancies(db: Database.Database): VacancyRow[] {
  return db
    .prepare(
      `SELECT id, team_id, email, pick_number, old_player_id, created_at
       FROM top4_draft_vacancies ORDER BY id ASC`,
    )
    .all() as VacancyRow[];
}

function syncDraftJsonIfComplete(db: Database.Database, status: Top4StateRow["status"]): void {
  if (status !== "complete") return;
  const draft = assembleDraftJson(db);
  db.prepare(
    `UPDATE top4_state SET draft_json = ?, updated_at = ? WHERE id = 1`,
  ).run(JSON.stringify(draft), new Date().toISOString());
}

/**
 * Remove algorithmic autopicks (auto=2, replaced=0) without immediate replacement.
 * Deletes pick rows and records vacancies (reuse pick_number on fill).
 * Pass pickNumber/playerId for one pick, or `all: true` for every remaining algo auto.
 */
export function removeAutoPicks(
  db: Database.Database,
  actorEmail: string,
  opts: {
    all?: boolean;
    playerId?: string | null;
    pickNumber?: number | null;
    ownerEmailRaw?: string | null;
  },
): {
  squads: Top4SquadsPublic;
  live: LiveDraftPublic | null;
  status: Top4StateRow["status"];
  removed: number;
} {
  ensureTop4Tables(db);
  const state = getTop4State(db);
  if (state.status !== "drafting" && state.status !== "complete") {
    throw new Error("draft_not_live");
  }

  const { ownerEmail } = resolveTop4Owner(
    db,
    actorEmail,
    opts.ownerEmailRaw,
  );
  const ownerLc = ownerEmail.toLowerCase();
  const picks = listPicks(db);
  const mine = picks.filter((p) => p.email.toLowerCase() === ownerLc);

  let targets: PickRow[];
  if (opts.all) {
    targets = mine.filter((p) => p.auto === 2 && !p.replaced);
  } else {
    let target: PickRow | undefined;
    if (opts.pickNumber != null && Number.isFinite(Number(opts.pickNumber))) {
      const n = Number(opts.pickNumber);
      target = mine.find((p) => p.pick_number === n);
    } else if (opts.playerId) {
      const pid = String(opts.playerId).trim();
      target = mine.find((p) => p.player_id === pid);
    } else {
      throw new Error("player_id_required");
    }
    if (!target) throw new Error("pick_not_found");
    if (target.auto !== 2) throw new Error("not_algo_auto");
    if (target.replaced) throw new Error("already_replaced");
    targets = [target];
  }

  if (!targets.length) throw new Error("no_algo_autos");

  const nowIso = new Date().toISOString();

  const tx = db.transaction(() => {
    const del = db.prepare(`DELETE FROM top4_draft_picks WHERE pick_number = ?`);
    const insVac = db.prepare(
      `INSERT INTO top4_draft_vacancies (team_id, email, pick_number, old_player_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insLog = db.prepare(
      `INSERT INTO top4_pick_replace_log
         (pick_number, team_id, old_player_id, new_player_id, created_at, logged, kind)
       VALUES (?, ?, ?, '', ?, 0, 'remove')`,
    );
    for (const t of targets) {
      del.run(t.pick_number);
      insVac.run(t.team_id, ownerLc, t.pick_number, t.player_id, nowIso);
      insLog.run(t.pick_number, t.team_id, t.player_id, nowIso);
    }
    db.prepare(`UPDATE top4_state SET updated_at = ? WHERE id = 1`).run(nowIso);
  });
  tx();

  syncDraftJsonIfComplete(db, state.status);

  return {
    squads: getTop4SquadsPublic(db),
    live: getLiveDraftPublic(db),
    status: getTop4State(db).status,
    removed: targets.length,
  };
}

/**
 * Fill one vacancy created by removeAutoPicks with a free eligible player.
 * Reuses the vacated pick_number; new pick is manual (auto=0).
 */
export function fillVacancy(
  db: Database.Database,
  actorEmail: string,
  opts: {
    newPlayerId: string;
    ownerEmailRaw?: string | null;
  },
): { squads: Top4SquadsPublic; live: LiveDraftPublic | null; status: Top4StateRow["status"] } {
  ensureTop4Tables(db);
  const state = getTop4State(db);
  if (state.status !== "drafting" && state.status !== "complete") {
    throw new Error("draft_not_live");
  }

  const newPlayerId = String(opts.newPlayerId || "").trim();
  if (!newPlayerId) throw new Error("player_id_required");

  const { ownerEmail, asConsigliere } = resolveTop4Owner(
    db,
    actorEmail,
    opts.ownerEmailRaw,
  );
  const ownerLc = ownerEmail.toLowerCase();

  const vacancy = db
    .prepare(
      `SELECT id, team_id, email, pick_number, old_player_id, created_at
       FROM top4_draft_vacancies
       WHERE email = ? COLLATE NOCASE
       ORDER BY id ASC
       LIMIT 1`,
    )
    .get(ownerLc) as VacancyRow | undefined;
  if (!vacancy) throw new Error("no_vacancy");

  const pool = loadPoolCtx(db);
  const newPlayer = pool.byId.get(newPlayerId);
  if (!newPlayer) throw new Error("player_not_found");

  const picks = listPicks(db);
  if (picks.some((p) => p.player_id === newPlayerId)) {
    throw new Error("player_taken");
  }
  if (picks.some((p) => p.pick_number === vacancy.pick_number)) {
    throw new Error("draft_state_invalid");
  }

  const lottery = parseLotteryOrder(state) ?? [];
  const teams = buildTeams(lottery, picks, pool);
  const team = teams.get(vacancy.team_id);
  if (!team) throw new Error("draft_state_invalid");
  const remainingAfter = remainingAfterPick(team);

  const ok = withDraftConfig(TOP4_DRAFT_CONFIG, () =>
    canAddPlayerToTeam(team, newPlayer, remainingAfter, true),
  );
  if (!ok) throw new Error("pick_invalid");

  const nowIso = new Date().toISOString();
  const setBy = asConsigliere ? "consigliere" : "manager";

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO top4_draft_picks
         (pick_number, team_id, email, player_id, auto, picked_at, set_by, replaced)
       VALUES (?, ?, ?, ?, 0, ?, ?, 0)`,
    ).run(
      vacancy.pick_number,
      vacancy.team_id,
      ownerLc,
      newPlayerId,
      nowIso,
      setBy,
    );
    db.prepare(`DELETE FROM top4_draft_vacancies WHERE id = ?`).run(vacancy.id);
    db.prepare(
      `INSERT INTO top4_pick_replace_log
         (pick_number, team_id, old_player_id, new_player_id, created_at, logged, kind)
       VALUES (?, ?, ?, ?, ?, 0, 'fill')`,
    ).run(
      vacancy.pick_number,
      vacancy.team_id,
      vacancy.old_player_id,
      newPlayerId,
      nowIso,
    );
    db.prepare(`UPDATE top4_state SET updated_at = ? WHERE id = 1`).run(nowIso);
  });
  tx();

  pruneTop4WishlistForDraft(db);
  syncDraftJsonIfComplete(db, state.status);

  return {
    squads: getTop4SquadsPublic(db),
    live: getLiveDraftPublic(db),
    status: getTop4State(db).status,
  };
}

/** Toggle a manager's "out of draft" flag (instant wishlist/rating autopick on their turn). */
export function setTop4OutOfDraft(
  db: Database.Database,
  ownerEmail: string,
  value: boolean,
): LiveDraftPublic | null {
  ensureTop4Tables(db);
  const state = getTop4State(db);
  if (state.status !== "drafting") throw new Error("draft_not_live");
  const bank = getBank(db, ownerEmail);
  if (!bank) throw new Error("not_in_draft");
  if (bank.draft_finished) throw new Error("draft_finished");
  setOutOfDraftFlag(db, ownerEmail, value);
  if (value) ensureCurrentPickFresh(db);
  return getLiveDraftPublic(db);
}

/**
 * Mark a manager finished (skip further turns). Requires ≥26 picks.
 * Unfinish is allowed while the draft is still live.
 */
export function setTop4DraftFinished(
  db: Database.Database,
  ownerEmail: string,
  value: boolean,
): LiveDraftPublic | null {
  ensureTop4Tables(db);
  const state = getTop4State(db);
  if (state.status !== "drafting") throw new Error("draft_not_live");
  const bank = getBank(db, ownerEmail);
  if (!bank) throw new Error("not_in_draft");

  if (value) {
    if (pickCountForEmail(db, ownerEmail) < TOP4_ROUNDS) {
      throw new Error("finish_requires_26");
    }
    setDraftFinishedFlag(db, ownerEmail, true);
    // Finished managers no longer need OOD autopick.
    setOutOfDraftFlag(db, ownerEmail, false);
    ensureCurrentPickFresh(db);
  } else {
    setDraftFinishedFlag(db, ownerEmail, false);
  }
  return getLiveDraftPublic(db);
}

export type LiveDraftPublic = {
  pick_no: number;
  /** @deprecated Fake fixed total removed; kept null for older clients. */
  total_picks: null;
  active_managers_left: number;
  round: number;
  slot: number;
  complete: boolean;
  on_clock: { team_id: number; team_name: string; email: string; name: string | null } | null;
  turn: {
    pick_at: string | null;
    timeout_sec: number;
    bank_remaining_sec: number;
    remaining_ms: number;
    paused: boolean;
  } | null;
  banks: Array<{
    team_id: number;
    team_name: string;
    email: string;
    bank_remaining_sec: number;
    out_of_draft: boolean;
    draft_finished: boolean;
    player_count: number;
  }>;
  recent_picks: Array<{
    pick_number: number;
    team_id: number;
    team_name: string;
    email: string;
    auto: 0 | 1 | 2;
    picked_at: string;
    player: {
      id: string;
      name: string;
      position_display: string;
      club_name: string;
      league_id: string;
      fm_rating: number | null;
      portrait_url: string | null;
    };
  }>;
  picked_player_ids: string[];
  draft_hours: { tz: string; start: string; end: string };
};

/** Live board snapshot for polling clients. Returns null when the draft isn't live. */
export function getLiveDraftPublic(db: Database.Database): LiveDraftPublic | null {
  ensureTop4Tables(db);
  const state = getTop4State(db);
  if (state.status !== "drafting") return null;

  const lottery = parseLotteryOrder(state) ?? [];
  const picks = listPicks(db);
  const pool = loadPoolCtx(db);
  const bankByEmail = new Map(listBanks(db).map((b) => [b.email.toLowerCase(), b]));
  const bySlot = new Map(lottery.map((e) => [e.draft_slot, e]));
  const picksByTeam = new Map<number, number>();
  for (const p of picks) {
    picksByTeam.set(p.team_id, (picksByTeam.get(p.team_id) ?? 0) + 1);
  }

  const pickNo = state.current_pick_no || 1;
  const round = Math.floor((pickNo - 1) / TOP4_TEAM_COUNT) + 1;
  const slot = memberSlotForPick(pickNo, TOP4_TEAM_COUNT);
  const onClockEntry = bySlot.get(slot) ?? null;
  const onClockBank = onClockEntry
    ? bankByEmail.get(onClockEntry.email.toLowerCase())
    : null;
  // Finished managers should already be skipped; treat as no one on clock if stale.
  const onClockActive = onClockEntry && !onClockBank?.draft_finished ? onClockEntry : null;

  let turn: LiveDraftPublic["turn"] = null;
  if (onClockActive) {
    const bank = bankByEmail.get(onClockActive.email.toLowerCase());
    const bankRemaining = bank?.bank_remaining_sec ?? 0;
    const timeoutSec = Math.min(state.pick_timeout_sec || DEFAULT_PICK_TIMEOUT_SEC, bankRemaining);
    const hours = hoursConfig(state);
    const pickAtMs = state.current_pick_at ? Date.parse(state.current_pick_at) : Date.now();
    turn = {
      pick_at: state.current_pick_at,
      timeout_sec: timeoutSec,
      bank_remaining_sec: bankRemaining,
      remaining_ms: pickTimerRemainingMs(pickAtMs, Date.now(), timeoutSec, hours),
      paused: !isWithinDraftHours(Date.now(), hours),
    };
  }

  const recent_picks = picks
    .slice(-20)
    .reverse()
    .map((p) => {
      const player = pool.byId.get(p.player_id);
      const entry = lottery.find((e) => e.team_id === p.team_id);
      return {
        pick_number: p.pick_number,
        team_id: p.team_id,
        team_name: entry?.team_name ?? String(p.team_id),
        email: p.email,
        auto: p.auto,
        picked_at: p.picked_at,
        player: player
          ? {
              id: player.id,
              name: player.name,
              position_display: player.position_display,
              club_name: player.club_name,
              league_id: player.league_id,
              fm_rating: player.fm_rating,
              portrait_url: player.portrait_url,
            }
          : {
              id: p.player_id,
              name: p.player_id,
              position_display: "",
              club_name: "",
              league_id: "",
              fm_rating: null,
              portrait_url: null,
            },
      };
    });

  const banks = lottery.map((e) => {
    const b = bankByEmail.get(e.email.toLowerCase());
    return {
      team_id: e.team_id,
      team_name: e.team_name,
      email: e.email,
      bank_remaining_sec: b?.bank_remaining_sec ?? DEFAULT_BANK_SEC,
      out_of_draft: Boolean(b?.out_of_draft),
      draft_finished: Boolean(b?.draft_finished),
      player_count: picksByTeam.get(e.team_id) ?? 0,
    };
  });

  const active_managers_left = banks.filter((b) => !b.draft_finished).length;

  return {
    pick_no: pickNo,
    total_picks: null,
    active_managers_left,
    round,
    slot,
    complete: false,
    on_clock: onClockActive
      ? {
          team_id: onClockActive.team_id,
          team_name: onClockActive.team_name,
          email: onClockActive.email,
          name: onClockActive.name,
        }
      : null,
    turn,
    banks,
    recent_picks,
    picked_player_ids: picks.map((p) => p.player_id),
    draft_hours: {
      tz: state.draft_hours_tz || DEFAULT_DRAFT_HOURS.timezone,
      start: state.draft_hours_start || "10:00",
      end: state.draft_hours_end || "20:00",
    },
  };
}

export type Top4SquadPlayer = {
  pick_number: number;
  id: string;
  name: string;
  position_display: string;
  club_id: string;
  club_name: string;
  league_id: string;
  fm_rating: number | null;
  market_value_eur: number;
  wage_pw: number;
  auto: 0 | 1 | 2;
  /** True after algorithmic autopick was replaced by manager/consigliere. */
  replaced: boolean;
  /** Current club is outside ENG/SPA/ITA/GER — still listed, excluded from bank. */
  out: boolean;
};

export type Top4SquadTeam = {
  team_id: number;
  team_name: string;
  email: string;
  name: string | null;
  draft_slot: number;
  logo_url: string | null;
  team_code: string | null;
  players: Top4SquadPlayer[];
  /** Open slots from removed algorithmic autopicks (awaiting fill). */
  vacancies: number;
};

export type Top4SquadsPublic = {
  status: Top4StateRow["status"];
  teams: Top4SquadTeam[];
};

/**
 * Drafted rosters grouped by team (lottery / draft-slot order).
 * Live + complete: prefer `top4_draft_picks` + pool; complete falls back to `draft_json`.
 */
export function getTop4SquadsPublic(db: Database.Database): Top4SquadsPublic {
  ensureTop4Tables(db);
  const state = getTop4State(db);
  const lottery = parseLotteryOrder(state) ?? [];
  const picks = listPicks(db);
  const regs = listTop4Registrations(db);
  const logoByEmail = new Map(
    regs.map((r) => [r.email.toLowerCase(), r.logo_url?.trim() || null]),
  );
  const codeByEmail = new Map(
    regs.map((r) => [
      r.email.toLowerCase(),
      r.team_code?.trim()?.toUpperCase() || null,
    ]),
  );
  const logoFor = (email: string | null | undefined) =>
    logoByEmail.get(String(email || "").toLowerCase()) ?? null;
  const codeFor = (email: string | null | undefined) =>
    codeByEmail.get(String(email || "").toLowerCase()) ?? null;

  if (lottery.length && (picks.length || state.status !== "complete")) {
    const pool = loadPoolCtx(db);
    const draftedById = new Map(
      loadTop4PlayersByIds(
        db,
        picks.map((p) => p.player_id),
      ).map((p) => [p.id, p]),
    );
    const vacancies = listVacancies(db);
    const vacancyByTeam = new Map<number, number>();
    for (const v of vacancies) {
      vacancyByTeam.set(v.team_id, (vacancyByTeam.get(v.team_id) ?? 0) + 1);
    }
    const byTeam = new Map<number, PickRow[]>();
    for (const p of picks) {
      const list = byTeam.get(p.team_id) ?? [];
      list.push(p);
      byTeam.set(p.team_id, list);
    }
    const teams = lottery
      .slice()
      .sort((a, b) => a.draft_slot - b.draft_slot)
      .map((entry) => {
        const teamPicks = (byTeam.get(entry.team_id) ?? []).slice().sort(
          (a, b) => a.pick_number - b.pick_number,
        );
        return {
          team_id: entry.team_id,
          team_name: entry.team_name,
          email: entry.email,
          name: entry.name,
          draft_slot: entry.draft_slot,
          logo_url: logoFor(entry.email),
          team_code: codeFor(entry.email),
          vacancies: vacancyByTeam.get(entry.team_id) ?? 0,
          players: teamPicks.map((p) => {
            const listed = draftedById.get(p.player_id);
            const player = listed ?? pool.byId.get(p.player_id);
            const clubLeague = listed?.club_league_id ?? player?.league_id ?? "";
            return {
              pick_number: p.pick_number,
              id: player?.id ?? p.player_id,
              name: player?.name ?? p.player_id,
              position_display: player?.position_display ?? "",
              club_id: player?.club_id ?? "",
              club_name: player?.club_name ?? "",
              league_id: player?.league_id ?? "",
              fm_rating: player?.fm_rating ?? null,
              market_value_eur: player?.market_value_eur ?? 0,
              wage_pw: player?.wage_pw ?? 0,
              auto: p.auto,
              replaced: Boolean(p.replaced),
              out: Boolean(player) && !isTop4LeagueId(clubLeague),
            };
          }),
        };
      });
    return { status: state.status, teams };
  }

  if (state.status === "complete" && state.draft_json) {
    try {
      const draft = JSON.parse(state.draft_json) as {
        teams?: Array<{
          id: number;
          name: string;
          players?: Array<{
            id: string;
            name: string;
            position_display?: string;
            club_id?: string;
            club_name?: string;
            league_id?: string;
            fm_rating?: number | null;
            market_value_eur?: number;
            wage_pw?: number;
            pick?: number;
          }>;
        }>;
        managers?: Array<{
          team_id: number;
          team_name: string;
          email: string;
          name: string | null;
        }>;
        lottery?: Top4LotteryEntry[];
      };
      const managers = new Map(
        (draft.managers || []).map((m) => [m.team_id, m]),
      );
      const lotteryOrder = (draft.lottery || lottery)
        .slice()
        .sort((a, b) => a.draft_slot - b.draft_slot);
      const teamOrder =
        lotteryOrder.length > 0
          ? lotteryOrder.map((e) => e.team_id)
          : (draft.teams || []).map((t) => t.id);
      const byId = new Map((draft.teams || []).map((t) => [t.id, t]));
      const draftedFallback = new Map(
        loadTop4PlayersByIds(
          db,
          (draft.teams || []).flatMap((t) => (t.players || []).map((p) => p.id)),
        ).map((p) => [p.id, p]),
      );
      const teams: Top4SquadTeam[] = [];
      for (const teamId of teamOrder) {
        const t = byId.get(teamId);
        if (!t) continue;
        const m = managers.get(t.id);
        const lot = lotteryOrder.find((e) => e.team_id === t.id);
        const email = m?.email ?? lot?.email ?? "";
        teams.push({
          team_id: t.id,
          team_name: t.name,
          email,
          name: m?.name ?? lot?.name ?? null,
          draft_slot: lot?.draft_slot ?? teams.length + 1,
          logo_url: logoFor(email),
          team_code: codeFor(email),
          vacancies: 0,
          players: (t.players || [])
            .slice()
            .sort((a, b) => (a.pick ?? 0) - (b.pick ?? 0))
            .map((p) => {
              const live = draftedFallback.get(p.id);
              const clubLeague = live?.club_league_id ?? live?.league_id ?? p.league_id ?? "";
              return {
                pick_number: p.pick ?? 0,
                id: live?.id ?? p.id,
                name: live?.name ?? p.name,
                position_display: live?.position_display ?? p.position_display ?? "",
                club_id: live?.club_id ?? p.club_id ?? "",
                club_name: live?.club_name ?? p.club_name ?? "",
                league_id: live?.league_id ?? p.league_id ?? "",
                fm_rating: live?.fm_rating ?? p.fm_rating ?? null,
                market_value_eur: live?.market_value_eur ?? p.market_value_eur ?? 0,
                wage_pw: live?.wage_pw ?? p.wage_pw ?? 0,
                auto: 0 as const,
                replaced: false,
                out: !isTop4LeagueId(clubLeague),
              };
            }),
        });
      }
      return { status: state.status, teams };
    } catch {
      /* ignore bad draft_json */
    }
  }

  return { status: state.status, teams: [] };
}

/** Assemble the same `draft_json` shape `runTop4SnakeDraft` used to produce. */
function assembleDraftJson(
  db: Database.Database,
): PrimerDraftResult & {
  lottery: Top4LotteryEntry[];
  managers: Array<{ team_id: number; team_name: string; email: string; name: string | null }>;
} {
  const state = getTop4State(db);
  const lottery = parseLotteryOrder(state) ?? [];
  const picks = listPicks(db);
  const pool = loadPoolCtx(db);
  const teams = buildTeams(lottery, picks, pool);
  const pickIndexByPlayer = new Map(picks.map((p) => [p.player_id, p.pick_number]));

  const teamResults = lottery
    .slice()
    .sort((a, b) => a.draft_slot - b.draft_slot)
    .map((entry) => {
      const team = teams.get(entry.team_id)!;
      const constraints = computeTeamConstraints(team.players);
      const formations = fieldableFormations(team.players);
      const within =
        constraints.within_budget &&
        constraints.leagues_ok &&
        constraints.clubs_ok &&
        constraints.gk_ok &&
        team.players.length >= TOP4_ROUNDS;
      return {
        id: team.id,
        name: team.name,
        player_count: team.players.length,
        sum_market_value_eur: team.sum_market_value_eur,
        sum_wage_pw: team.sum_wage_pw,
        within_budget: within,
        leagues_ok: constraints.leagues_ok,
        clubs_ok: constraints.clubs_ok,
        gk_ok: constraints.gk_ok,
        leagues: constraints.leagues,
        max_club: constraints.max_club,
        groups: groupCounts(team.players) as PrimerDraftResult["teams"][number]["groups"],
        formations,
        players: team.players.map((p) => ({
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
          pick: pickIndexByPlayer.get(p.id) ?? 0,
        })),
      };
    });

  const takenSet = new Set(picks.map((p) => p.player_id));
  const unselected = pool.all
    .filter((p) => !takenSet.has(p.id))
    .sort(
      (a, b) =>
        b.fm_rating - a.fm_rating ||
        b.wage_pw - a.wage_pw ||
        b.market_value_eur - a.market_value_eur ||
        a.name.localeCompare(b.name),
    )
    .map((p) => ({
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
    }));

  const managers = lottery.map((e) => ({
    team_id: e.team_id,
    team_name: e.team_name,
    email: e.email,
    name: e.name,
  }));

  return {
    generated_at: new Date().toISOString(),
    rules: {
      teams: TOP4_TEAM_COUNT,
      rounds: TOP4_ROUNDS,
      mv_cap: TOP4_MV_CAP,
      wage_cap: TOP4_WAGE_CAP,
      min_per_league: TOP4_MIN_PER_LEAGUE,
      max_per_club: TOP4_MAX_PER_CLUB,
      min_gk: TOP4_MIN_GK,
      draft: "snake-live",
    },
    formations: FORMATIONS.map((f) => ({ id: f.id, label: f.label })),
    teams: teamResults,
    unselected,
    summary: {
      all_have_26: teamResults.every((t) => t.player_count >= TOP4_ROUNDS),
      all_within_budget: teamResults.every(
        (t) => t.sum_market_value_eur <= TOP4_MV_CAP && t.sum_wage_pw <= TOP4_WAGE_CAP,
      ),
      all_field_formation: teamResults.every((t) => t.formations.length > 0),
      all_leagues_ok: teamResults.every((t) => t.leagues_ok),
      all_clubs_ok: teamResults.every((t) => t.clubs_ok),
      all_gk_ok: teamResults.every((t) => t.gk_ok),
      total_players: teamResults.reduce((s, t) => s + t.player_count, 0),
      unselected_count: unselected.length,
    },
    lottery,
    managers,
  };
}
