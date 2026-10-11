/**
 * Топ-8 катка: Primer league set (ENG/SPA/ITA/GER/FRA/POR/BEL/NED).
 * Caps match Primer; draft reuses primerDraft with TOP8_DRAFT_CONFIG.
 */
import type Database from "better-sqlite3";
import { TOP8_IDS, TOP8_LEAGUES } from "./leagues.js";
import { CELESTIAL_TEAM_NAMES } from "./primerDraft.js";

export type Top8LeagueId = (typeof TOP8_IDS)[number];
export { TOP8_IDS };

const SHORT_COUNTRY: Record<string, string> = {
  England: "ENG",
  Spain: "SPA",
  Italy: "ITA",
  Germany: "GER",
  France: "FRA",
  Portugal: "POR",
  Belgium: "BEL",
  Netherlands: "NED",
};

export const TOP8_LEAGUE_LABEL: Record<Top8LeagueId, string> = Object.fromEntries(
  TOP8_LEAGUES.map((l) => [
    l.id,
    `${SHORT_COUNTRY[l.country] ?? l.country.slice(0, 3).toUpperCase()} · ${l.name}`,
  ]),
) as Record<Top8LeagueId, string>;

/** 16 managers · 26 picks · full Primer Top-8 pools (no quota). */
export const TOP8_TEAM_COUNT = 16;
export const TOP8_ROUNDS = 26;
export const TOP8_MV_CAP = 900_000_000;
export const TOP8_WAGE_CAP = 3_500_000;
export const TOP8_MIN_PER_LEAGUE = 3;
export const TOP8_MAX_PER_CLUB = 3;
export const TOP8_MIN_GK = 3;

export const TOP8_TEAM_NAMES: readonly string[] = CELESTIAL_TEAM_NAMES.slice(
  0,
  TOP8_TEAM_COUNT,
);

export type Top8Status =
  | "open"
  | "postponed"
  | "lottery_done"
  | "drafting"
  | "complete";

export type Top8Registration = {
  email: string;
  name: string | null;
  team_name: string;
  registered_at: string;
};

export type Top8LotteryEntry = {
  email: string;
  name: string | null;
  draft_slot: number;
  team_id: number;
  team_name: string;
};

export type Top8StateRow = {
  status: Top8Status;
  lottery_order_json: string | null;
  draft_json: string | null;
  updated_at: string;
};

const TEAM_NAME_MIN = 2;
const TEAM_NAME_MAX = 40;

export function normalizeTeamName(raw: string): string {
  return String(raw ?? "").trim().replace(/\s+/g, " ");
}

export function assertTeamName(raw: string): string {
  const teamName = normalizeTeamName(raw);
  if (teamName.length < TEAM_NAME_MIN || teamName.length > TEAM_NAME_MAX) {
    throw new Error("team_name_invalid");
  }
  return teamName;
}

export function ensureTop8Tables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS top8_registrations (
      email TEXT PRIMARY KEY COLLATE NOCASE,
      name TEXT,
      team_name TEXT,
      registered_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS top8_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT NOT NULL DEFAULT 'open',
      lottery_order_json TEXT,
      draft_json TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS top8_wishlist (
      email TEXT NOT NULL COLLATE NOCASE,
      player_id TEXT NOT NULL,
      priority INTEGER NOT NULL,
      PRIMARY KEY (email, player_id)
    );
    CREATE INDEX IF NOT EXISTS idx_top8_wishlist_email_pri
      ON top8_wishlist (email, priority);
  `);
  // Migrate older DBs that lack team_name.
  const cols = db.prepare(`PRAGMA table_info(top8_registrations)`).all() as Array<{
    name: string;
  }>;
  if (!cols.some((c) => c.name === "team_name")) {
    db.exec(`ALTER TABLE top8_registrations ADD COLUMN team_name TEXT`);
  }
  const row = db.prepare(`SELECT id FROM top8_state WHERE id = 1`).get();
  if (!row) {
    db.prepare(
      `INSERT INTO top8_state (id, status, updated_at) VALUES (1, 'open', ?)`,
    ).run(new Date().toISOString());
  }
}

export function getTop8State(db: Database.Database): Top8StateRow {
  ensureTop8Tables(db);
  return db
    .prepare(
      `SELECT status, lottery_order_json, draft_json, updated_at FROM top8_state WHERE id = 1`,
    )
    .get() as Top8StateRow;
}

export function listTop8Registrations(db: Database.Database): Top8Registration[] {
  ensureTop8Tables(db);
  return (
    db
      .prepare(
        `SELECT email, name, team_name, registered_at FROM top8_registrations ORDER BY registered_at ASC`,
      )
      .all() as Array<{
      email: string;
      name: string | null;
      team_name: string | null;
      registered_at: string;
    }>
  ).map((r) => ({
    email: r.email,
    name: r.name,
    team_name: r.team_name?.trim() || r.name || r.email,
    registered_at: r.registered_at,
  }));
}

export function isRegistered(db: Database.Database, email: string): boolean {
  ensureTop8Tables(db);
  const row = db
    .prepare(`SELECT 1 AS ok FROM top8_registrations WHERE email = ? COLLATE NOCASE`)
    .get(email.toLowerCase());
  return Boolean(row);
}

export function getRegistration(
  db: Database.Database,
  email: string,
): Top8Registration | null {
  ensureTop8Tables(db);
  const row = db
    .prepare(
      `SELECT email, name, team_name, registered_at FROM top8_registrations WHERE email = ? COLLATE NOCASE`,
    )
    .get(email.toLowerCase()) as
    | {
        email: string;
        name: string | null;
        team_name: string | null;
        registered_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    email: row.email,
    name: row.name,
    team_name: row.team_name?.trim() || row.name || row.email,
    registered_at: row.registered_at,
  };
}

export function registerTop8(
  db: Database.Database,
  email: string,
  name: string | null,
  teamNameRaw: string,
): Top8Registration {
  ensureTop8Tables(db);
  const state = getTop8State(db);
  if (state.status !== "open") throw new Error("registration_closed");
  const teamName = assertTeamName(teamNameRaw);
  const regs = listTop8Registrations(db);
  if (regs.some((r) => r.email.toLowerCase() === email.toLowerCase())) {
    throw new Error("already_registered");
  }
  if (regs.length >= TOP8_TEAM_COUNT) throw new Error("league_full");
  const taken = regs.some(
    (r) => r.team_name.toLowerCase() === teamName.toLowerCase(),
  );
  if (taken) throw new Error("team_name_taken");
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO top8_registrations (email, name, team_name, registered_at) VALUES (?, ?, ?, ?)`,
  ).run(email.toLowerCase(), name, teamName, now);
  return {
    email: email.toLowerCase(),
    name,
    team_name: teamName,
    registered_at: now,
  };
}

export function updateTop8TeamName(
  db: Database.Database,
  email: string,
  teamNameRaw: string,
): Top8Registration {
  ensureTop8Tables(db);
  const state = getTop8State(db);
  if (state.status !== "open") throw new Error("registration_closed");
  const teamName = assertTeamName(teamNameRaw);
  const mine = getRegistration(db, email);
  if (!mine) throw new Error("not_registered");
  const clash = listTop8Registrations(db).some(
    (r) =>
      r.email.toLowerCase() !== email.toLowerCase() &&
      r.team_name.toLowerCase() === teamName.toLowerCase(),
  );
  if (clash) throw new Error("team_name_taken");
  db.prepare(
    `UPDATE top8_registrations SET team_name = ? WHERE email = ? COLLATE NOCASE`,
  ).run(teamName, email.toLowerCase());
  return { ...mine, team_name: teamName };
}

export function unregisterTop8(db: Database.Database, email: string): void {
  ensureTop8Tables(db);
  const state = getTop8State(db);
  if (state.status !== "open") throw new Error("registration_closed");
  const em = email.toLowerCase();
  db.prepare(`DELETE FROM top8_wishlist WHERE email = ? COLLATE NOCASE`).run(em);
  db.prepare(`DELETE FROM top8_registrations WHERE email = ? COLLATE NOCASE`).run(em);
}

/** Fisher–Yates shuffle (mutates copy). */
export function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function runTop8Lottery(db: Database.Database): Top8LotteryEntry[] {
  ensureTop8Tables(db);
  const state = getTop8State(db);
  if (state.status !== "open" && state.status !== "lottery_done") {
    throw new Error("lottery_not_allowed");
  }
  const regs = listTop8Registrations(db);
  if (regs.length !== TOP8_TEAM_COUNT) {
    throw new Error("need_full_roster");
  }
  const shuffled = shuffleInPlace([...regs]);
  const order: Top8LotteryEntry[] = shuffled.map((r, i) => ({
    email: r.email,
    name: r.name,
    draft_slot: i + 1,
    team_id: i + 1,
    team_name: r.team_name || TOP8_TEAM_NAMES[i] || `Команда ${i + 1}`,
  }));
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE top8_state SET status = 'lottery_done', lottery_order_json = ?, updated_at = ? WHERE id = 1`,
  ).run(JSON.stringify(order), now);
  return order;
}

export function parseLotteryOrder(state: Top8StateRow): Top8LotteryEntry[] | null {
  if (!state.lottery_order_json) return null;
  try {
    return JSON.parse(state.lottery_order_json) as Top8LotteryEntry[];
  } catch {
    return null;
  }
}

export function setTop8Draft(
  db: Database.Database,
  draft: unknown,
  status: Top8Status = "complete",
): void {
  ensureTop8Tables(db);
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE top8_state SET status = ?, draft_json = ?, updated_at = ? WHERE id = 1`,
  ).run(status, JSON.stringify(draft), now);
}

export function setTop8Status(db: Database.Database, status: Top8Status): void {
  ensureTop8Tables(db);
  db.prepare(`UPDATE top8_state SET status = ?, updated_at = ? WHERE id = 1`).run(
    status,
    new Date().toISOString(),
  );
}

export function resetTop8League(db: Database.Database): void {
  ensureTop8Tables(db);
  db.prepare(`DELETE FROM top8_wishlist`).run();
  db.prepare(`DELETE FROM top8_registrations`).run();
  db.prepare(
    `UPDATE top8_state SET status = 'open', lottery_order_json = NULL, draft_json = NULL, updated_at = ? WHERE id = 1`,
  ).run(new Date().toISOString());
}

export type Top8WishlistItem = {
  player_id: string;
  priority: number;
  name: string;
  club_name: string;
  league_id: string;
  position_display: string;
  fm_rating: number | null;
  market_value_eur: number;
  wage_pw: number;
  portrait_url: string | null;
};

function assertWishlistEditable(db: Database.Database, email: string): void {
  const state = getTop8State(db);
  if (state.status === "complete") throw new Error("wishlist_locked");
  if (!isRegistered(db, email)) throw new Error("not_registered");
}

export function listTop8Wishlist(
  db: Database.Database,
  email: string,
): Array<{ player_id: string; priority: number }> {
  ensureTop8Tables(db);
  return db
    .prepare(
      `SELECT player_id, priority FROM top8_wishlist
       WHERE email = ? COLLATE NOCASE
       ORDER BY priority ASC, player_id ASC`,
    )
    .all(email.toLowerCase()) as Array<{ player_id: string; priority: number }>;
}

export function addToTop8Wishlist(
  db: Database.Database,
  email: string,
  playerId: string,
): void {
  ensureTop8Tables(db);
  assertWishlistEditable(db, email);
  const em = email.toLowerCase();
  const exists = db
    .prepare(
      `SELECT 1 AS ok FROM top8_wishlist WHERE email = ? COLLATE NOCASE AND player_id = ?`,
    )
    .get(em, playerId);
  if (exists) return;
  const last = db
    .prepare(
      `SELECT MAX(priority) AS m FROM top8_wishlist WHERE email = ? COLLATE NOCASE`,
    )
    .get(em) as { m: number | null };
  const next = (last.m ?? 0) + 1;
  db.prepare(
    `INSERT INTO top8_wishlist (email, player_id, priority) VALUES (?, ?, ?)`,
  ).run(em, playerId, next);
}

export function removeFromTop8Wishlist(
  db: Database.Database,
  email: string,
  playerId: string,
): void {
  ensureTop8Tables(db);
  assertWishlistEditable(db, email);
  const em = email.toLowerCase();
  db.prepare(
    `DELETE FROM top8_wishlist WHERE email = ? COLLATE NOCASE AND player_id = ?`,
  ).run(em, playerId);
  recompactTop8Wishlist(db, em);
}

export function reorderTop8Wishlist(
  db: Database.Database,
  email: string,
  playerIds: string[],
): void {
  ensureTop8Tables(db);
  assertWishlistEditable(db, email);
  const em = email.toLowerCase();
  const current = listTop8Wishlist(db, em);
  if (playerIds.length !== current.length) throw new Error("wishlist_changed");
  const set = new Set(current.map((c) => c.player_id));
  for (const id of playerIds) {
    if (!set.has(id)) throw new Error("invalid_player");
  }
  const tx = db.transaction(() => {
    // Two-pass to avoid unique conflicts on (email, priority) if we ever add that.
    playerIds.forEach((playerId, idx) => {
      db.prepare(
        `UPDATE top8_wishlist SET priority = ? WHERE email = ? COLLATE NOCASE AND player_id = ?`,
      ).run(10_000 + idx, em, playerId);
    });
    playerIds.forEach((playerId, idx) => {
      db.prepare(
        `UPDATE top8_wishlist SET priority = ? WHERE email = ? COLLATE NOCASE AND player_id = ?`,
      ).run(idx + 1, em, playerId);
    });
  });
  tx();
}

function recompactTop8Wishlist(db: Database.Database, email: string): void {
  const rows = listTop8Wishlist(db, email);
  const tx = db.transaction(() => {
    rows.forEach((r, idx) => {
      db.prepare(
        `UPDATE top8_wishlist SET priority = ? WHERE email = ? COLLATE NOCASE AND player_id = ?`,
      ).run(idx + 1, email, r.player_id);
    });
  });
  tx();
}

export function top8RulesPublic() {
  return {
    teams: TOP8_TEAM_COUNT,
    rounds: TOP8_ROUNDS,
    mv_cap: TOP8_MV_CAP,
    wage_cap: TOP8_WAGE_CAP,
    min_per_league: TOP8_MIN_PER_LEAGUE,
    max_per_club: TOP8_MAX_PER_CLUB,
    min_gk: TOP8_MIN_GK,
    leagues: TOP8_IDS.map((id) => ({ id, label: TOP8_LEAGUE_LABEL[id] })),
    team_names: [...TOP8_TEAM_NAMES],
  };
}
