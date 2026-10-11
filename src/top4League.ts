/**
 * Топ-4 катка: ENG/SPA/ITA/GER registration, lottery, draft state.
 * Draft algorithm reuses primerDraft with TOP4_DRAFT_CONFIG.
 */
import type Database from "better-sqlite3";
import { CELESTIAL_TEAM_NAMES } from "./primerDraft.js";

export const TOP4_IDS = ["GB1", "ES1", "IT1", "L1"] as const;
export type Top4LeagueId = (typeof TOP4_IDS)[number];

/** Current club is Top-4 eligible iff its league is ENG/SPA/ITA/GER. */
export function isTop4LeagueId(id: string | null | undefined): boolean {
  return (TOP4_IDS as readonly string[]).includes(String(id || ""));
}

export const TOP4_LEAGUE_LABEL: Record<Top4LeagueId, string> = {
  GB1: "ENG · Premier League",
  ES1: "SPA · LaLiga",
  IT1: "ITA · Serie A",
  L1: "GER · Bundesliga",
};

/** 9 managers · 26 picks · full ENG/SPA/ITA/GER pools. */
export const TOP4_TEAM_COUNT = 9;
export const TOP4_ROUNDS = 26;
export const TOP4_MV_CAP = 1_200_000_000;
export const TOP4_WAGE_CAP = 5_000_000;
export const TOP4_MIN_PER_LEAGUE = 3;
export const TOP4_MAX_PER_CLUB = 3;
export const TOP4_MIN_GK = 3;

export const TOP4_TEAM_NAMES: readonly string[] = CELESTIAL_TEAM_NAMES.slice(
  0,
  TOP4_TEAM_COUNT,
);

export type Top4Status = "open" | "lottery_done" | "drafting" | "complete";

export type Top4Registration = {
  email: string;
  name: string | null;
  team_name: string;
  registered_at: string;
  logo_url?: string | null;
  /** 3-letter Latin code (A–Z), unique across registrations. */
  team_code?: string | null;
};

export type Top4LotteryEntry = {
  email: string;
  name: string | null;
  draft_slot: number;
  team_id: number;
  team_name: string;
};

export type Top4StateRow = {
  status: Top4Status;
  lottery_order_json: string | null;
  draft_json: string | null;
  updated_at: string;
  current_pick_no: number;
  current_pick_at: string | null;
  draft_started_at: string | null;
  pick_timeout_sec: number;
  pick_bank_sec: number;
  draft_hours_tz: string;
  draft_hours_start: string;
  draft_hours_end: string;
};

const TEAM_NAME_MIN = 2;
const TEAM_NAME_MAX = 40;
const TEAM_CODE_RE = /^[A-Z]{3}$/;

/** Prod/local seed: unique 3-letter codes derived from current team names. */
export const TOP4_SEEDED_TEAM_CODES: ReadonlyArray<{
  email: string;
  team_code: string;
  team_name: string;
}> = [
  { email: "aharodnik@gmail.com", team_code: "LNH", team_name: "Loch Ness FC" },
  {
    email: "sschegolev87rossmann@gmail.com",
    team_code: "INH",
    team_name: "Inosuke Hashibira",
  },
  {
    email: "lebrin.nba@gmail.com",
    team_code: "T4O",
    team_name: "Top 4 Onaneers",
  },
  { email: "drkomsa@gmail.com", team_code: "SPR", team_name: "FC Sprats" },
  {
    email: "maksimkorneevets@gmail.com",
    team_code: "NAC",
    team_name: "Netflix And Chilwell",
  },
  {
    email: "bylino.tema@gmail.com",
    team_code: "UGL",
    team_name: "Угол головы",
  },
  {
    email: "oksana.chernysh@gmail.com",
    team_code: "VSK",
    team_name: "В следующих командах замечены геи:",
  },
  {
    email: "evgenifan@gmail.com",
    team_code: "KSP",
    team_name: "Куда спешим, ща пикну",
  },
  {
    email: "vassimka@gmail.com",
    team_code: "PRZ",
    team_name: "FC Pruzhynka",
  },
];

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

export function normalizeTeamCode(raw: string): string {
  return String(raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
}

export function assertTeamCode(raw: string): string {
  const code = normalizeTeamCode(raw);
  if (!TEAM_CODE_RE.test(code)) throw new Error("team_code_invalid");
  return code;
}

/** Latinize letters (incl. Cyrillic) then keep A–Z only. */
function latinLetters(raw: string): string {
  const map: Record<string, string> = {
    а: "A",
    б: "B",
    в: "V",
    г: "G",
    д: "D",
    е: "E",
    ё: "E",
    ж: "ZH",
    з: "Z",
    и: "I",
    й: "Y",
    к: "K",
    л: "L",
    м: "M",
    н: "N",
    о: "O",
    п: "P",
    р: "R",
    с: "S",
    т: "T",
    у: "U",
    ф: "F",
    х: "H",
    ц: "C",
    ч: "CH",
    ш: "SH",
    щ: "SCH",
    ъ: "",
    ы: "Y",
    ь: "",
    э: "E",
    ю: "YU",
    я: "YA",
    і: "I",
    ї: "YI",
    є: "YE",
    ґ: "G",
  };
  let out = "";
  for (const ch of String(raw || "")) {
    const lower = ch.toLowerCase();
    if (map[lower] != null) out += map[lower];
    else if (/[a-z]/i.test(ch)) out += ch.toUpperCase();
  }
  return out;
}

/**
 * Suggest a unique 3-letter code from a team name (initials / consonants).
 * Falls back to AAA…ZZZ if needed.
 */
export function suggestTeamCode(
  teamName: string,
  taken: ReadonlySet<string>,
): string {
  const words = normalizeTeamName(teamName)
    .split(/[\s\-_/.,:;!?]+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .filter((w) => !/^(fc|cf|sc|ac|fk|afc|the|and|и|у|в|на|для)$/i.test(w));
  const latinWords = words.map(latinLetters).filter((w) => w.length > 0);
  const candidates: string[] = [];
  if (latinWords.length >= 3) {
    candidates.push(
      (latinWords[0][0] + latinWords[1][0] + latinWords[2][0]).toUpperCase(),
    );
  }
  if (latinWords.length === 2) {
    const a = latinWords[0];
    const b = latinWords[1];
    candidates.push((a[0] + b[0] + (b[1] || a[1] || "X")).toUpperCase());
    candidates.push((a[0] + a[1] + b[0]).toUpperCase());
  }
  if (latinWords.length === 1) {
    const w = latinWords[0];
    const consonants = w.replace(/[AEIOU]/g, "");
    if (consonants.length >= 3) candidates.push(consonants.slice(0, 3));
    candidates.push((w + "XXX").slice(0, 3));
  }
  if (latinWords.length >= 2) {
    const joined = latinWords.join("");
    const consonants = joined.replace(/[AEIOU]/g, "");
    if (consonants.length >= 3) candidates.push(consonants.slice(0, 3));
  }
  for (const c of candidates) {
    const code = normalizeTeamCode(c);
    if (TEAM_CODE_RE.test(code) && !taken.has(code)) return code;
  }
  for (let i = 0; i < 26 * 26 * 26; i++) {
    const a = String.fromCharCode(65 + Math.floor(i / (26 * 26)));
    const b = String.fromCharCode(65 + Math.floor((i / 26) % 26));
    const c = String.fromCharCode(65 + (i % 26));
    const code = a + b + c;
    if (!taken.has(code)) return code;
  }
  throw new Error("team_code_exhausted");
}

export function ensureTop4Tables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS top4_registrations (
      email TEXT PRIMARY KEY COLLATE NOCASE,
      name TEXT,
      team_name TEXT,
      registered_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS top4_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT NOT NULL DEFAULT 'open',
      lottery_order_json TEXT,
      draft_json TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS top4_wishlist (
      email TEXT NOT NULL COLLATE NOCASE,
      player_id TEXT NOT NULL,
      priority INTEGER NOT NULL,
      PRIMARY KEY (email, player_id)
    );
    CREATE INDEX IF NOT EXISTS idx_top4_wishlist_email_pri
      ON top4_wishlist (email, priority);
  `);
  // Migrate older DBs that lack team_name.
  const cols = db.prepare(`PRAGMA table_info(top4_registrations)`).all() as Array<{
    name: string;
  }>;
  if (!cols.some((c) => c.name === "team_name")) {
    db.exec(`ALTER TABLE top4_registrations ADD COLUMN team_name TEXT`);
  }
  if (!cols.some((c) => c.name === "consigliere_email")) {
    db.exec(`ALTER TABLE top4_registrations ADD COLUMN consigliere_email TEXT`);
  }
  if (!cols.some((c) => c.name === "logo_url")) {
    db.exec(`ALTER TABLE top4_registrations ADD COLUMN logo_url TEXT`);
  }
  if (!cols.some((c) => c.name === "team_code")) {
    db.exec(`ALTER TABLE top4_registrations ADD COLUMN team_code TEXT`);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_top4_registrations_team_code
      ON top4_registrations (team_code)
      WHERE team_code IS NOT NULL
  `);
  const wlCols = db.prepare(`PRAGMA table_info(top4_wishlist)`).all() as Array<{
    name: string;
  }>;
  if (!wlCols.some((c) => c.name === "set_by")) {
    db.exec(
      `ALTER TABLE top4_wishlist ADD COLUMN set_by TEXT NOT NULL DEFAULT 'manager'`,
    );
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS top4_lineups (
      team_id INTEGER NOT NULL,
      gw INTEGER NOT NULL,
      formation TEXT NOT NULL,
      slots_json TEXT NOT NULL,
      set_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      PRIMARY KEY (team_id, gw)
    );
  `);
  // Live snake draft: turn/bank columns on top4_state + per-pick and per-manager bank tables.
  const stateCols = db.prepare(`PRAGMA table_info(top4_state)`).all() as Array<{
    name: string;
  }>;
  const addStateCol = (name: string, ddl: string) => {
    if (!stateCols.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE top4_state ADD COLUMN ${ddl}`);
    }
  };
  addStateCol("current_pick_no", "current_pick_no INTEGER DEFAULT 0");
  addStateCol("current_pick_at", "current_pick_at TEXT");
  addStateCol("draft_started_at", "draft_started_at TEXT");
  addStateCol("pick_timeout_sec", "pick_timeout_sec INTEGER DEFAULT 1800");
  addStateCol("pick_bank_sec", "pick_bank_sec INTEGER DEFAULT 14400");
  addStateCol("draft_hours_tz", "draft_hours_tz TEXT DEFAULT 'Europe/Warsaw'");
  addStateCol("draft_hours_start", "draft_hours_start TEXT DEFAULT '10:00'");
  addStateCol("draft_hours_end", "draft_hours_end TEXT DEFAULT '20:00'");
  db.exec(`
    CREATE TABLE IF NOT EXISTS top4_draft_picks (
      pick_number INTEGER PRIMARY KEY,
      team_id INTEGER NOT NULL,
      email TEXT NOT NULL COLLATE NOCASE,
      player_id TEXT NOT NULL,
      auto INTEGER NOT NULL DEFAULT 0,
      picked_at TEXT NOT NULL,
      set_by TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS top4_draft_banks (
      email TEXT PRIMARY KEY COLLATE NOCASE,
      bank_remaining_sec INTEGER NOT NULL,
      out_of_draft INTEGER NOT NULL DEFAULT 0,
      draft_finished INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS top4_telegram_links (
      telegram_user_id INTEGER PRIMARY KEY,
      chat_id INTEGER NOT NULL,
      email TEXT NOT NULL COLLATE NOCASE,
      team_id INTEGER,
      team_name TEXT NOT NULL,
      last_notified_pick_no INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_top4_telegram_links_email
      ON top4_telegram_links (email);
  `);
  const bankCols = db.prepare(`PRAGMA table_info(top4_draft_banks)`).all() as Array<{
    name: string;
  }>;
  if (!bankCols.some((c) => c.name === "draft_finished")) {
    db.exec(
      `ALTER TABLE top4_draft_banks ADD COLUMN draft_finished INTEGER NOT NULL DEFAULT 0`,
    );
  }
  const pickCols = db.prepare(`PRAGMA table_info(top4_draft_picks)`).all() as Array<{
    name: string;
  }>;
  if (!pickCols.some((c) => c.name === "replaced")) {
    db.exec(
      `ALTER TABLE top4_draft_picks ADD COLUMN replaced INTEGER NOT NULL DEFAULT 0`,
    );
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS top4_pick_replace_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pick_number INTEGER NOT NULL,
      team_id INTEGER NOT NULL,
      old_player_id TEXT NOT NULL,
      new_player_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      logged INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS top4_draft_vacancies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL,
      email TEXT NOT NULL COLLATE NOCASE,
      pick_number INTEGER NOT NULL UNIQUE,
      old_player_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const replaceLogCols = db
    .prepare(`PRAGMA table_info(top4_pick_replace_log)`)
    .all() as Array<{ name: string }>;
  if (!replaceLogCols.some((c) => c.name === "kind")) {
    db.exec(
      `ALTER TABLE top4_pick_replace_log ADD COLUMN kind TEXT NOT NULL DEFAULT 'replace'`,
    );
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS top4_deadline_reminders (
      telegram_user_id INTEGER PRIMARY KEY,
      chat_id INTEGER NOT NULL,
      minutes_json TEXT NOT NULL,
      last_sent_gw INTEGER,
      last_sent_offsets_json TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const row = db.prepare(`SELECT id FROM top4_state WHERE id = 1`).get();
  if (!row) {
    db.prepare(
      `INSERT INTO top4_state (id, status, updated_at) VALUES (1, 'open', ?)`,
    ).run(new Date().toISOString());
  }
}

export function getTop4State(db: Database.Database): Top4StateRow {
  ensureTop4Tables(db);
  return db
    .prepare(
      `SELECT status, lottery_order_json, draft_json, updated_at,
              current_pick_no, current_pick_at, draft_started_at,
              pick_timeout_sec, pick_bank_sec,
              draft_hours_tz, draft_hours_start, draft_hours_end
       FROM top4_state WHERE id = 1`,
    )
    .get() as Top4StateRow;
}

export function listTop4Registrations(db: Database.Database): Top4Registration[] {
  ensureTop4Tables(db);
  return (
    db
      .prepare(
        `SELECT email, name, team_name, registered_at, logo_url, team_code FROM top4_registrations ORDER BY registered_at ASC`,
      )
      .all() as Array<{
      email: string;
      name: string | null;
      team_name: string | null;
      registered_at: string;
      logo_url: string | null;
      team_code: string | null;
    }>
  ).map((r) => ({
    email: r.email,
    name: r.name,
    team_name: r.team_name?.trim() || r.name || r.email,
    registered_at: r.registered_at,
    logo_url: r.logo_url?.trim() || null,
    team_code: r.team_code?.trim()?.toUpperCase() || null,
  }));
}

export function isRegistered(db: Database.Database, email: string): boolean {
  ensureTop4Tables(db);
  const row = db
    .prepare(`SELECT 1 AS ok FROM top4_registrations WHERE email = ? COLLATE NOCASE`)
    .get(email.toLowerCase());
  return Boolean(row);
}

export function getRegistration(
  db: Database.Database,
  email: string,
): Top4Registration | null {
  ensureTop4Tables(db);
  const row = db
    .prepare(
      `SELECT email, name, team_name, registered_at, logo_url, team_code FROM top4_registrations WHERE email = ? COLLATE NOCASE`,
    )
    .get(email.toLowerCase()) as
    | {
        email: string;
        name: string | null;
        team_name: string | null;
        registered_at: string;
        logo_url: string | null;
        team_code: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    email: row.email,
    name: row.name,
    team_name: row.team_name?.trim() || row.name || row.email,
    registered_at: row.registered_at,
    logo_url: row.logo_url?.trim() || null,
    team_code: row.team_code?.trim()?.toUpperCase() || null,
  };
}

export function registerTop4(
  db: Database.Database,
  email: string,
  name: string | null,
  teamNameRaw: string,
): Top4Registration {
  ensureTop4Tables(db);
  const state = getTop4State(db);
  if (state.status !== "open") throw new Error("registration_closed");
  const teamName = assertTeamName(teamNameRaw);
  const regs = listTop4Registrations(db);
  if (regs.some((r) => r.email.toLowerCase() === email.toLowerCase())) {
    throw new Error("already_registered");
  }
  if (regs.length >= TOP4_TEAM_COUNT) throw new Error("league_full");
  const taken = regs.some(
    (r) => r.team_name.toLowerCase() === teamName.toLowerCase(),
  );
  if (taken) throw new Error("team_name_taken");
  const takenCodes = new Set(
    regs.map((r) => r.team_code).filter((c): c is string => Boolean(c)),
  );
  const teamCode = suggestTeamCode(teamName, takenCodes);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO top4_registrations (email, name, team_name, registered_at, team_code) VALUES (?, ?, ?, ?, ?)`,
  ).run(email.toLowerCase(), name, teamName, now, teamCode);
  return {
    email: email.toLowerCase(),
    name,
    team_name: teamName,
    registered_at: now,
    logo_url: null,
    team_code: teamCode,
  };
}

export function updateTop4TeamName(
  db: Database.Database,
  email: string,
  teamNameRaw: string,
): Top4Registration {
  ensureTop4Tables(db);
  const state = getTop4State(db);
  if (state.status !== "open") throw new Error("registration_closed");
  const teamName = assertTeamName(teamNameRaw);
  const mine = getRegistration(db, email);
  if (!mine) throw new Error("not_registered");
  const clash = listTop4Registrations(db).some(
    (r) =>
      r.email.toLowerCase() !== email.toLowerCase() &&
      r.team_name.toLowerCase() === teamName.toLowerCase(),
  );
  if (clash) throw new Error("team_name_taken");
  db.prepare(
    `UPDATE top4_registrations SET team_name = ? WHERE email = ? COLLATE NOCASE`,
  ).run(teamName, email.toLowerCase());
  return { ...mine, team_name: teamName };
}

export function updateTop4TeamCode(
  db: Database.Database,
  email: string,
  teamCodeRaw: string,
): Top4Registration {
  ensureTop4Tables(db);
  const mine = getRegistration(db, email);
  if (!mine) throw new Error("not_registered");
  const teamCode = assertTeamCode(teamCodeRaw);
  const clash = listTop4Registrations(db).some(
    (r) =>
      r.email.toLowerCase() !== email.toLowerCase() &&
      r.team_code === teamCode,
  );
  if (clash) throw new Error("team_code_taken");
  db.prepare(
    `UPDATE top4_registrations SET team_code = ? WHERE email = ? COLLATE NOCASE`,
  ).run(teamCode, email.toLowerCase());
  return { ...mine, team_code: teamCode };
}

/** Apply known seed codes (by email); generate for anyone still missing. */
export function seedTop4TeamCodes(db: Database.Database): Array<{
  email: string;
  team_name: string;
  team_code: string;
  updated: boolean;
}> {
  ensureTop4Tables(db);
  const regs = listTop4Registrations(db);
  const byEmail = new Map(
    TOP4_SEEDED_TEAM_CODES.map((r) => [r.email.toLowerCase(), r.team_code]),
  );
  const taken = new Set(
    regs.map((r) => r.team_code).filter((c): c is string => Boolean(c)),
  );
  const out: Array<{
    email: string;
    team_name: string;
    team_code: string;
    updated: boolean;
  }> = [];
  const upd = db.prepare(
    `UPDATE top4_registrations SET team_code = ? WHERE email = ? COLLATE NOCASE`,
  );
  for (const r of regs) {
    if (r.team_code && TEAM_CODE_RE.test(r.team_code)) {
      out.push({
        email: r.email,
        team_name: r.team_name,
        team_code: r.team_code,
        updated: false,
      });
      continue;
    }
    const preferred = byEmail.get(r.email.toLowerCase());
    const code =
      preferred && !taken.has(preferred)
        ? preferred
        : suggestTeamCode(r.team_name, taken);
    taken.add(code);
    upd.run(code, r.email);
    out.push({
      email: r.email,
      team_name: r.team_name,
      team_code: code,
      updated: true,
    });
  }
  return out;
}

export function unregisterTop4(db: Database.Database, email: string): void {
  ensureTop4Tables(db);
  const state = getTop4State(db);
  if (state.status !== "open") throw new Error("registration_closed");
  const em = email.toLowerCase();
  db.prepare(`DELETE FROM top4_wishlist WHERE email = ? COLLATE NOCASE`).run(em);
  db.prepare(`DELETE FROM top4_registrations WHERE email = ? COLLATE NOCASE`).run(em);
}

/** Fisher–Yates shuffle (mutates copy). */
export function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function runTop4Lottery(db: Database.Database): Top4LotteryEntry[] {
  ensureTop4Tables(db);
  const state = getTop4State(db);
  if (state.status !== "open" && state.status !== "lottery_done") {
    throw new Error("lottery_not_allowed");
  }
  const regs = listTop4Registrations(db);
  if (regs.length !== TOP4_TEAM_COUNT) {
    throw new Error("need_full_roster");
  }
  const shuffled = shuffleInPlace([...regs]);
  const order: Top4LotteryEntry[] = shuffled.map((r, i) => ({
    email: r.email,
    name: r.name,
    draft_slot: i + 1,
    team_id: i + 1,
    team_name: r.team_name || TOP4_TEAM_NAMES[i] || `Команда ${i + 1}`,
  }));
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE top4_state SET status = 'lottery_done', lottery_order_json = ?, updated_at = ? WHERE id = 1`,
  ).run(JSON.stringify(order), now);
  return order;
}

export function parseLotteryOrder(state: Top4StateRow): Top4LotteryEntry[] | null {
  if (!state.lottery_order_json) return null;
  try {
    return JSON.parse(state.lottery_order_json) as Top4LotteryEntry[];
  } catch {
    return null;
  }
}

export function setTop4Draft(
  db: Database.Database,
  draft: unknown,
  status: Top4Status = "complete",
): void {
  ensureTop4Tables(db);
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE top4_state SET status = ?, draft_json = ?, updated_at = ? WHERE id = 1`,
  ).run(status, JSON.stringify(draft), now);
}

export function setTop4Status(db: Database.Database, status: Top4Status): void {
  ensureTop4Tables(db);
  db.prepare(`UPDATE top4_state SET status = ?, updated_at = ? WHERE id = 1`).run(
    status,
    new Date().toISOString(),
  );
}

export function resetTop4League(db: Database.Database): void {
  ensureTop4Tables(db);
  db.prepare(`DELETE FROM top4_wishlist`).run();
  db.prepare(`DELETE FROM top4_registrations`).run();
  try {
    db.prepare(`DELETE FROM top4_draft_room_sets`).run();
  } catch {
    /* table may not exist yet on older DBs */
  }
  db.prepare(`DELETE FROM top4_draft_picks`).run();
  db.prepare(`DELETE FROM top4_draft_banks`).run();
  db.prepare(`DELETE FROM top4_draft_vacancies`).run();
  db.prepare(`DELETE FROM top4_pick_replace_log`).run();
  db.prepare(
    `UPDATE top4_state SET status = 'open', lottery_order_json = NULL, draft_json = NULL,
     current_pick_no = 0, current_pick_at = NULL, draft_started_at = NULL, updated_at = ?
     WHERE id = 1`,
  ).run(new Date().toISOString());
}

export type Top4WishlistItem = {
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
  const state = getTop4State(db);
  if (state.status === "complete") throw new Error("wishlist_locked");
  if (!isRegistered(db, email)) throw new Error("not_registered");
}

export function listTop4Wishlist(
  db: Database.Database,
  email: string,
): Array<{ player_id: string; priority: number }> {
  ensureTop4Tables(db);
  return db
    .prepare(
      `SELECT player_id, priority FROM top4_wishlist
       WHERE email = ? COLLATE NOCASE
       ORDER BY priority ASC, player_id ASC`,
    )
    .all(email.toLowerCase()) as Array<{ player_id: string; priority: number }>;
}

export function addToTop4Wishlist(
  db: Database.Database,
  email: string,
  playerId: string,
): void {
  ensureTop4Tables(db);
  assertWishlistEditable(db, email);
  const em = email.toLowerCase();
  const exists = db
    .prepare(
      `SELECT 1 AS ok FROM top4_wishlist WHERE email = ? COLLATE NOCASE AND player_id = ?`,
    )
    .get(em, playerId);
  if (exists) return;
  const last = db
    .prepare(
      `SELECT MAX(priority) AS m FROM top4_wishlist WHERE email = ? COLLATE NOCASE`,
    )
    .get(em) as { m: number | null };
  const next = (last.m ?? 0) + 1;
  db.prepare(
    `INSERT INTO top4_wishlist (email, player_id, priority, set_by) VALUES (?, ?, ?, 'manager')`,
  ).run(em, playerId, next);
}

export function removeFromTop4Wishlist(
  db: Database.Database,
  email: string,
  playerId: string,
): void {
  ensureTop4Tables(db);
  assertWishlistEditable(db, email);
  const em = email.toLowerCase();
  db.prepare(
    `DELETE FROM top4_wishlist WHERE email = ? COLLATE NOCASE AND player_id = ?`,
  ).run(em, playerId);
  recompactTop4Wishlist(db, em);
}

export function reorderTop4Wishlist(
  db: Database.Database,
  email: string,
  playerIds: string[],
): void {
  ensureTop4Tables(db);
  assertWishlistEditable(db, email);
  const em = email.toLowerCase();
  const current = listTop4Wishlist(db, em);
  if (playerIds.length !== current.length) throw new Error("wishlist_changed");
  const set = new Set(current.map((c) => c.player_id));
  for (const id of playerIds) {
    if (!set.has(id)) throw new Error("invalid_player");
  }
  const tx = db.transaction(() => {
    // Two-pass to avoid unique conflicts on (email, priority) if we ever add that.
    playerIds.forEach((playerId, idx) => {
      db.prepare(
        `UPDATE top4_wishlist SET priority = ? WHERE email = ? COLLATE NOCASE AND player_id = ?`,
      ).run(10_000 + idx, em, playerId);
    });
    playerIds.forEach((playerId, idx) => {
      db.prepare(
        `UPDATE top4_wishlist SET priority = ? WHERE email = ? COLLATE NOCASE AND player_id = ?`,
      ).run(idx + 1, em, playerId);
    });
  });
  tx();
}

export function recompactTop4Wishlist(db: Database.Database, email: string): void {
  const rows = listTop4Wishlist(db, email);
  const tx = db.transaction(() => {
    rows.forEach((r, idx) => {
      db.prepare(
        `UPDATE top4_wishlist SET priority = ? WHERE email = ? COLLATE NOCASE AND player_id = ?`,
      ).run(idx + 1, email, r.player_id);
    });
  });
  tx();
}

export function top4RulesPublic() {
  return {
    teams: TOP4_TEAM_COUNT,
    rounds: TOP4_ROUNDS,
    mv_cap: TOP4_MV_CAP,
    wage_cap: TOP4_WAGE_CAP,
    min_per_league: TOP4_MIN_PER_LEAGUE,
    max_per_club: TOP4_MAX_PER_CLUB,
    min_gk: TOP4_MIN_GK,
    // Keep in sync with TOP4_DRAFT_CONFIG.reserveMv / reserveWage (primerDraft affordability).
    reserve_mv: 5_000_000,
    reserve_wage: 70_000,
    leagues: TOP4_IDS.map((id) => ({ id, label: TOP4_LEAGUE_LABEL[id] })),
    team_names: [...TOP4_TEAM_NAMES],
  };
}
