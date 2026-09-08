/**
 * Top-4 live draft Telegram ping bot.
 *
 * /help — full command list (RU)
 * /start — short intro + pointer to /help
 * /pihajme — bind Telegram ↔ manager team
 * /testping — sample ping (bound users only, DM)
 * /testlog — sample pick log to the group log chat (bound users)
 * /deadline — lineup-deadline reminders for the bound team (1–3 offsets)
 * /dildline — alias of /deadline
 * /deadline off — disable deadline reminders
 * /testdeadline — sample deadline reminder (bound users only, DM)
 * Polls draft state; pings when it's your turn and you are not OOD
 * (OOD always autopicks: wishlist else highest fm_rating).
 * Also posts every new draft pick to TOP4_PICK_LOG_CHAT_ID + TOP4_PICK_LOG_THREAD_ID
 * (forum topic; structured log only).
 * FPL 2026: pick logs to FPL_PICK_LOG_CHAT_ID + FPL_PICK_LOG_THREAD_ID
 * (default https://t.me/c/2419087266/2), turn DMs via the same email map,
 * lineup-deadline reminders via /fpldeadline (same 1–3 offsets as /deadline).
 * Liga prvaka (ЛЧ 2026/27): topic log to UCL_PICK_LOG_CHAT_ID +
 * UCL_PICK_LOG_THREAD_ID (default https://t.me/c/2419087266/4), turn DMs and
 * matchday reminders via /ucl and /ucldeadline.
 *
 * Token: TOP4_PING_BOT_TOKEN or TELEGRAM_PIHAJME_TOKEN (env / .env — never commit).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { gameweekFromKickoff } from "./gameweeks.js";
import { loadTop4Pool } from "./top4Draft.js";
import {
  ensureTop4Tables,
  getTop4State,
  listTop4Registrations,
  parseLotteryOrder,
  TOP4_TEAM_COUNT,
  type Top4LotteryEntry,
} from "./top4League.js";
import { loadSquadGwLock } from "./top4LineupLock.js";
import { getLiveDraftPublic, getTop4SquadsPublic } from "./top4LiveDraft.js";
import {
  checkH2hNotifications,
  ensureH2hBotTables,
  handleH2hMessage,
  h2hHelpLine,
} from "./h2hDraftBot.js";
import {
  checkPekloLcNotifications,
  ensurePekloLcBotTables,
  handlePekloLcMessage,
  pekloLcHelpLine,
} from "./pekloLcDraftBot.js";
import {
  checkFplDraft,
  ensureFplBotTables,
  fplHelpLine,
  handleFplMessage,
} from "./fplDraftBot.js";
import {
  checkUclDraft,
  ensureUclBotTables,
  handleUclMessage,
  uclHelpLine,
} from "./uclDraftBot.js";
import {
  ensurePanenkaLinkTables,
  handlePanenkaMessage,
  panenkaLinkHelpLine,
} from "./panenkaLinkBot.js";
import {
  ensureTop4TransferSchema,
  getTransferBotView,
  TRANSFER_MAX_DUMPS,
  TRANSFER_MAX_PICKS,
} from "./top4Transfers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const DRAFT_URL = "https://din8sty.panenka.games/top4.html";
const TRANSFERS_URL = "https://din8sty.panenka.games/top4/transfers";
const POLL_MS = Number(process.env.TOP4_PING_POLL_MS ?? 20_000);
/** Forum topic https://t.me/c/2419087266/3 — prefer env overrides. */
const DEFAULT_PICK_LOG_CHAT_ID = -1002419087266;
const DEFAULT_PICK_LOG_THREAD_ID = 3;
/** FPL 2026 pick logs: https://t.me/c/2419087266/2 */
const DEFAULT_FPL_PICK_LOG_CHAT_ID = -1002419087266;
const DEFAULT_FPL_PICK_LOG_THREAD_ID = 2;
/** Liga prvaka (ЛЧ 2026/27) logs: https://t.me/c/2419087266/4 */
const DEFAULT_UCL_PICK_LOG_CHAT_ID = -1002419087266;
const DEFAULT_UCL_PICK_LOG_THREAD_ID = 4;
const LEAGUE_SHORT: Record<string, string> = {
  GB1: "ENG",
  ES1: "SPA",
  IT1: "ITA",
  L1: "GER",
};

const PING_PHRASES = [
  "Поторопись! У нас там котлетки! С макарошками? Нет, с пюрешкой!",
  "Надо, менеджер, надо! Пикай, пока банк не съел время!",
  "Танцуют все — но сейчас очередь твоя. Не стой столбом, выбирай!",
  "Руссо туристо — облигато пикаре! Пора брать игрока!",
  "Кто не пикает — тот автопиком живёт. Шевелись, слот открыт!",
  "Замуровали, демоны! Твой ход уже открыт — вытаскивай игрока!",
  "Я требую продолжения бала! А драфт требует твоего пика — живо!",
  "Красавица, а я… а ты пикай! Время тикает!",
  "Кефирчик подождёт, а твой слот — нет. Поторопись с пиком!",
  "Пацаны, не стреляйте! Лучше пикайте. Твоя очередь!",
  "Сейчас покажу, откуда готовилось нападение… с вишлиста. Выбирай!",
  "Всё будет хорошо! Ещё лучше — если пикнешь прямо сейчас.",
  "Ку! Пикай, а то кусаться буду (банком времени).",
  "Обмануть меня не трудно — таймер не обманешь. Ход твой!",
  "Восторг! Восторг и ещё раз восторг — если успеешь до автопика.",
  "Где деньги, Зин? Где твой пик, менеджер?",
  "Спокойствие, только спокойствие… ладно, не спокойствие — ПИКАЙ УЖЕ!",
  "Я вас категорически приветствую! И категорически прошу сделать пик.",
  "Эта песня хорошо начинается… а твой ход ещё лучше закончится — если не проспишь.",
  "Шах и мат? Нет — пик и слот. Твоя очередь на доске драфта!",
] as const;

function pickPingPhrase(): string {
  return PING_PHRASES[Math.floor(Math.random() * PING_PHRASES.length)]!;
}

/** Same format for real turn pings and /testping. */
function formatPingMessage(teamName?: string | null): string {
  const phrase = pickPingPhrase();
  const context = teamName?.trim()
    ? `Твоя очередь в драфте Top-4 — «${teamName.trim()}»`
    : "Твоя очередь в драфте Top-4";
  return `${phrase}\n\n${context}\n${DRAFT_URL}`;
}

type TeamOption = { email: string; team_id: number | null; team_name: string };

type LinkRow = {
  telegram_user_id: number;
  chat_id: number;
  email: string;
  team_id: number | null;
  team_name: string;
  last_notified_pick_no: number;
  tg_username: string | null;
};

type TgUser = { id: number; username?: string; first_name?: string };
type TgChat = { id: number; type: string };
type TgMessage = {
  message_id: number;
  date: number;
  text?: string;
  chat: TgChat;
  from?: TgUser;
};
type TgUpdate = { update_id: number; message?: TgMessage };

const pendingBind = new Map<number, { teams: TeamOption[]; at: number }>();
const pendingDeadline = new Map<
  number,
  { step: "count" | "minutes"; count: number; minutes: number[]; at: number }
>();

const WARSAW_TZ = "Europe/Warsaw";
const DEADLINE_MAX_MINUTES = 14 * 24 * 60;
const PENDING_TTL_MS = 15 * 60_000;

type DeadlineReminderRow = {
  telegram_user_id: number;
  chat_id: number;
  minutes_json: string;
  last_sent_gw: number | null;
  last_sent_offsets_json: string;
  enabled: number;
};

function loadDotEnvFile(envPath: string): void {
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1]!;
    if (process.env[key] != null && process.env[key] !== "") continue;
    let val = m[2]!;
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

function loadDotEnv(): void {
  // Prefer process env; then .env; then .env.bot (prod keeps token/chat ids there).
  loadDotEnvFile(path.join(root, ".env"));
  loadDotEnvFile(path.join(root, ".env.bot"));
}

function configuredPickLogChatId(): number {
  loadDotEnv();
  const raw = process.env.TOP4_PICK_LOG_CHAT_ID?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
    console.error(`[top4-ping] invalid TOP4_PICK_LOG_CHAT_ID=${raw}, using default`);
  }
  return DEFAULT_PICK_LOG_CHAT_ID;
}

function configuredPickLogThreadId(): number {
  loadDotEnv();
  const raw = process.env.TOP4_PICK_LOG_THREAD_ID?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
    console.error(`[top4-ping] invalid TOP4_PICK_LOG_THREAD_ID=${raw}, using default`);
  }
  return DEFAULT_PICK_LOG_THREAD_ID;
}

function configuredFplPickLogChatId(): number {
  loadDotEnv();
  const raw = process.env.FPL_PICK_LOG_CHAT_ID?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
    console.error(`[fpl-bot] invalid FPL_PICK_LOG_CHAT_ID=${raw}, using default`);
  }
  return DEFAULT_FPL_PICK_LOG_CHAT_ID;
}

function configuredFplPickLogThreadId(): number {
  loadDotEnv();
  const raw = process.env.FPL_PICK_LOG_THREAD_ID?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
    console.error(`[fpl-bot] invalid FPL_PICK_LOG_THREAD_ID=${raw}, using default`);
  }
  return DEFAULT_FPL_PICK_LOG_THREAD_ID;
}

function configuredUclPickLogChatId(): number {
  loadDotEnv();
  const raw = process.env.UCL_PICK_LOG_CHAT_ID?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
    console.error(`[ucl-bot] invalid UCL_PICK_LOG_CHAT_ID=${raw}, using default`);
  }
  return DEFAULT_UCL_PICK_LOG_CHAT_ID;
}

function configuredUclPickLogThreadId(): number {
  loadDotEnv();
  const raw = process.env.UCL_PICK_LOG_THREAD_ID?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
    console.error(`[ucl-bot] invalid UCL_PICK_LOG_THREAD_ID=${raw}, using default`);
  }
  return DEFAULT_UCL_PICK_LOG_THREAD_ID;
}

function requireToken(): string {
  loadDotEnv();
  const token =
    process.env.TOP4_PING_BOT_TOKEN?.trim() ||
    process.env.TELEGRAM_PIHAJME_TOKEN?.trim() ||
    "";
  if (!token) {
    throw new Error(
      "TOP4_PING_BOT_TOKEN (or TELEGRAM_PIHAJME_TOKEN) missing. Set it in env / .env / .env.bot",
    );
  }
  return token;
}

function openDb(): Database.Database {
  const dbPath = process.env.DIN8STY_DB ?? path.join(root, "data", "din8sty.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  ensureTop4Tables(db);
  ensureH2hBotTables(db);
  ensurePekloLcBotTables(db);
  ensureFplBotTables(db);
  ensureUclBotTables(db);
  ensurePanenkaLinkTables(db);
  ensureTop4TransferSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS top4_pick_log_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_logged_pick_no INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS top4_transfer_log_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_move_id INTEGER NOT NULL DEFAULT 0,
      last_window_gw INTEGER NOT NULL DEFAULT 0
    );
  `);
  const linkCols = db
    .prepare(`PRAGMA table_info(top4_telegram_links)`)
    .all() as Array<{ name: string }>;
  if (!linkCols.some((c) => c.name === "tg_username")) {
    db.exec(`ALTER TABLE top4_telegram_links ADD COLUMN tg_username TEXT`);
  }
  return db;
}

function maxDraftPickNo(db: Database.Database): number {
  const row = db
    .prepare(`SELECT MAX(pick_number) AS m FROM top4_draft_picks`)
    .get() as { m: number | null };
  return Number(row?.m) || 0;
}

/** Seed to current max so a mid-draft restart / first deploy does not backfill-spam. */
function ensurePickLogState(db: Database.Database): number {
  const existing = db
    .prepare(`SELECT last_logged_pick_no FROM top4_pick_log_state WHERE id = 1`)
    .get() as { last_logged_pick_no: number } | undefined;
  if (existing) return existing.last_logged_pick_no;
  const seed = maxDraftPickNo(db);
  db.prepare(
    `INSERT INTO top4_pick_log_state (id, last_logged_pick_no) VALUES (1, ?)`,
  ).run(seed);
  console.log(`[top4-ping] pick-log state seeded last_logged_pick_no=${seed}`);
  return seed;
}

function getLastLoggedPickNo(db: Database.Database): number {
  return ensurePickLogState(db);
}

function setLastLoggedPickNo(db: Database.Database, pickNo: number): void {
  ensurePickLogState(db);
  db.prepare(
    `UPDATE top4_pick_log_state SET last_logged_pick_no = ? WHERE id = 1`,
  ).run(pickNo);
}

function autoLabelRu(auto: number): string {
  if (auto === 1) return "авто (wishlist)";
  if (auto === 2) return "авто (алгоритм)";
  return "ручной";
}

function formatMvEuro(n: number): string {
  const v = Number(n) || 0;
  if (v >= 1_000_000_000) {
    const b = v / 1_000_000_000;
    return `€${b.toFixed(b >= 10 ? 0 : 1)}B`;
  }
  if (v >= 1_000_000) return `€${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `€${Math.round(v / 1_000)}K`;
  return `€${v}`;
}

function formatWageEuro(n: number): string {
  const v = Number(n) || 0;
  if (v >= 1000) return `€${Math.round(v / 1000)}k/w`;
  return `€${v}/w`;
}

type DraftPickLogRow = {
  pick_number: number;
  team_id: number;
  email: string;
  player_id: string;
  auto: number;
};

function formatPickLogMessage(opts: {
  pickNumber: number;
  teamName: string;
  playerName: string;
  position: string;
  clubName: string;
  leagueShort: string;
  mv: number;
  wage: number;
  auto: number;
}): string {
  const round = Math.floor((opts.pickNumber - 1) / TOP4_TEAM_COUNT) + 1;
  const pos = opts.position || "?";
  const club = opts.clubName || "?";
  const league = opts.leagueShort || "?";
  return [
    `🎯 Пик #${opts.pickNumber} · Раунд ${round}`,
    `«${opts.teamName}» выбирает:`,
    `${opts.playerName} · ${pos} · ${club} (${league})`,
    `MV ${formatMvEuro(opts.mv)} · ${formatWageEuro(opts.wage)}`,
    autoLabelRu(opts.auto),
  ].join("\n");
}

function lotteryByTeamId(db: Database.Database): Map<number, Top4LotteryEntry> {
  const state = getTop4State(db);
  const lottery = parseLotteryOrder(state) ?? [];
  return new Map(lottery.map((e) => [e.team_id, e]));
}

function buildPickLogText(
  pick: DraftPickLogRow,
  byTeam: Map<number, Top4LotteryEntry>,
  poolById: Map<string, { name: string; position_display: string; club_name: string; league_id: string; market_value_eur: number; wage_pw: number }>,
): string {
  const entry = byTeam.get(pick.team_id);
  const teamName = entry?.team_name ?? String(pick.team_id);
  const player = poolById.get(pick.player_id);
  return formatPickLogMessage({
    pickNumber: pick.pick_number,
    teamName,
    playerName: player?.name ?? pick.player_id,
    position: player?.position_display ?? "",
    clubName: player?.club_name ?? "",
    leagueShort: player ? LEAGUE_SHORT[player.league_id] ?? player.league_id : "",
    mv: player?.market_value_eur ?? 0,
    wage: player?.wage_pw ?? 0,
    auto: pick.auto,
  });
}

function listBindableTeams(db: Database.Database): TeamOption[] {
  const state = getTop4State(db);
  const lottery = parseLotteryOrder(state);
  if (lottery?.length) {
    return lottery
      .slice()
      .sort((a, b) => a.draft_slot - b.draft_slot)
      .map((e) => ({
        email: e.email,
        team_id: e.team_id,
        team_name: e.team_name,
      }));
  }
  return listTop4Registrations(db).map((r) => ({
    email: r.email,
    team_id: null,
    team_name: r.team_name,
  }));
}

function getLink(db: Database.Database, telegramUserId: number): LinkRow | null {
  return (
    (db
      .prepare(
        `SELECT telegram_user_id, chat_id, email, team_id, team_name, last_notified_pick_no,
                tg_username
         FROM top4_telegram_links WHERE telegram_user_id = ?`,
      )
      .get(telegramUserId) as LinkRow | undefined) ?? null
  );
}

function listLinksForEmail(db: Database.Database, email: string): LinkRow[] {
  return db
    .prepare(
      `SELECT telegram_user_id, chat_id, email, team_id, team_name, last_notified_pick_no,
              tg_username
       FROM top4_telegram_links WHERE email = ? COLLATE NOCASE`,
    )
    .all(email.toLowerCase()) as LinkRow[];
}

function upsertLink(
  db: Database.Database,
  opts: {
    telegramUserId: number;
    chatId: number;
    email: string;
    teamId: number | null;
    teamName: string;
    tgUsername?: string | null;
  },
): void {
  const now = new Date().toISOString();
  const uname = opts.tgUsername?.replace(/^@/, "").trim() || null;
  db.prepare(
    `INSERT INTO top4_telegram_links
       (telegram_user_id, chat_id, email, team_id, team_name, last_notified_pick_no,
        created_at, updated_at, tg_username)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET
       chat_id = excluded.chat_id,
       email = excluded.email,
       team_id = excluded.team_id,
       team_name = excluded.team_name,
       updated_at = excluded.updated_at,
       tg_username = COALESCE(excluded.tg_username, top4_telegram_links.tg_username)`,
  ).run(
    opts.telegramUserId,
    opts.chatId,
    opts.email.toLowerCase(),
    opts.teamId,
    opts.teamName,
    now,
    now,
    uname,
  );
}

function parseMinutesJson(raw: string | null | undefined): number[] {
  try {
    const parsed = JSON.parse(raw || "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

function getDeadlineReminder(
  db: Database.Database,
  telegramUserId: number,
): DeadlineReminderRow | null {
  return (
    (db
      .prepare(
        `SELECT telegram_user_id, chat_id, minutes_json, last_sent_gw,
                last_sent_offsets_json, enabled
         FROM top4_deadline_reminders WHERE telegram_user_id = ?`,
      )
      .get(telegramUserId) as DeadlineReminderRow | undefined) ?? null
  );
}

function listEnabledDeadlineReminders(db: Database.Database): DeadlineReminderRow[] {
  return db
    .prepare(
      `SELECT telegram_user_id, chat_id, minutes_json, last_sent_gw,
              last_sent_offsets_json, enabled
       FROM top4_deadline_reminders WHERE enabled = 1`,
    )
    .all() as DeadlineReminderRow[];
}

function upsertDeadlineReminder(
  db: Database.Database,
  opts: { telegramUserId: number; chatId: number; minutes: number[] },
): void {
  const now = new Date().toISOString();
  const minutesJson = JSON.stringify(opts.minutes);
  db.prepare(
    `INSERT INTO top4_deadline_reminders
       (telegram_user_id, chat_id, minutes_json, last_sent_gw,
        last_sent_offsets_json, enabled, created_at, updated_at)
     VALUES (?, ?, ?, NULL, '[]', 1, ?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET
       chat_id = excluded.chat_id,
       minutes_json = excluded.minutes_json,
       enabled = 1,
       updated_at = excluded.updated_at`,
  ).run(opts.telegramUserId, opts.chatId, minutesJson, now, now);
}

function disableDeadlineReminder(
  db: Database.Database,
  telegramUserId: number,
): void {
  db.prepare(
    `UPDATE top4_deadline_reminders
     SET enabled = 0, updated_at = ?
     WHERE telegram_user_id = ?`,
  ).run(new Date().toISOString(), telegramUserId);
}

function markDeadlineSent(
  db: Database.Database,
  telegramUserId: number,
  gw: number,
  minutes: number,
): void {
  const row = getDeadlineReminder(db, telegramUserId);
  const sent =
    row && row.last_sent_gw === gw ? parseMinutesJson(row.last_sent_offsets_json) : [];
  if (!sent.includes(minutes)) sent.push(minutes);
  db.prepare(
    `UPDATE top4_deadline_reminders
     SET last_sent_gw = ?, last_sent_offsets_json = ?, updated_at = ?
     WHERE telegram_user_id = ?`,
  ).run(gw, JSON.stringify(sent), new Date().toISOString(), telegramUserId);
}

function formatWarsawDeadline(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: WARSAW_TZ,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const day = get("day");
  const month = get("month");
  const hour = String(get("hour") || "").padStart(2, "0");
  const minute = String(get("minute") || "").padStart(2, "0");
  if (!day || !month) return iso;
  return `${day}.${month} ${hour}:${minute}`;
}

function formatDeadlineReminderText(opts: {
  deadlineIso: string;
  teamName: string;
  teamCode?: string | null;
}): string {
  const when = formatWarsawDeadline(opts.deadlineIso);
  const name = opts.teamName.trim();
  const code = opts.teamCode?.trim();
  const team = code ? `«${name}» · ${code}` : `«${name}»`;
  return `DILDLINE IS COMING\n\n${when}\n${team}`;
}

function resolveBoundSquad(
  squads: ReturnType<typeof getTop4SquadsPublic>,
  link: LinkRow,
): { clubIds: string[]; teamCode: string | null } {
  const email = link.email.toLowerCase();
  const team =
    (link.team_id != null
      ? squads.teams.find((t) => t.team_id === link.team_id)
      : undefined) ??
    squads.teams.find((t) => t.email.toLowerCase() === email);
  if (!team) return { clubIds: [], teamCode: null };
  return {
    clubIds: [
      ...new Set(
        team.players
          .map((p) => (p.club_id ? String(p.club_id) : ""))
          .filter(Boolean),
      ),
    ],
    teamCode: team.team_code?.trim() || null,
  };
}

function clubIdsForBoundTeam(
  db: Database.Database,
  link: LinkRow,
): { clubIds: string[]; teamCode: string | null } {
  return resolveBoundSquad(getTop4SquadsPublic(db), link);
}

/** Same GW preference as lineup.html default: next, then current, if deadline is still upcoming. */
function upcomingSquadDeadline(
  db: Database.Database,
  clubIds: readonly string[],
  nowMs = Date.now(),
): { gw: number; deadlineAt: string; deadlineMs: number } | null {
  if (!clubIds.length) return null;
  const currentGw = Math.max(1, gameweekFromKickoff(new Date(nowMs)));
  const nextGw = currentGw + 1;
  for (const gw of [nextGw, currentGw]) {
    const lock = loadSquadGwLock(db, clubIds, gw);
    if (!lock.deadlineAt) continue;
    const ms = Date.parse(lock.deadlineAt);
    if (Number.isFinite(ms) && ms > nowMs) {
      return { gw, deadlineAt: lock.deadlineAt, deadlineMs: ms };
    }
  }
  return null;
}

function formatMinutesList(minutes: number[]): string {
  return minutes.join(", ");
}

function deadlineStatusLine(db: Database.Database, link: LinkRow): string {
  const { clubIds } = clubIdsForBoundTeam(db, link);
  if (!clubIds.length) {
    return "Дедлайн пока неизвестен (нет состава / матчей клубов).";
  }
  const upcoming = upcomingSquadDeadline(db, clubIds);
  if (!upcoming) {
    return "Дедлайн пока неизвестен (нет ближайших матчей клубов состава).";
  }
  return `Следующий дедлайн: GW${upcoming.gw} · ${formatWarsawDeadline(upcoming.deadlineAt)} (Warsaw)`;
}

function parseCountReply(raw: string): number | null {
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1 || n > 3) return null;
  return n;
}

function parseMinutesReply(raw: string): number | null {
  const m = raw.trim().match(/^(\d+)\s*(?:мин|min|m)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 1 || n > DEADLINE_MAX_MINUTES) return null;
  return n;
}

function isOffReply(raw: string): boolean {
  const t = raw.trim().toLowerCase();
  return t === "off" || t === "стоп" || t === "выкл" || t === "выключить";
}

function markNotified(db: Database.Database, telegramUserId: number, pickNo: number): void {
  db.prepare(
    `UPDATE top4_telegram_links
     SET last_notified_pick_no = ?, updated_at = ?
     WHERE telegram_user_id = ?`,
  ).run(pickNo, new Date().toISOString(), telegramUserId);
}

function formatTeamList(teams: TeamOption[]): string {
  return teams.map((t, i) => `${i + 1}. ${t.team_name}`).join("\n");
}

function matchTeam(raw: string, teams: TeamOption[]): TeamOption | null {
  const text = raw.trim();
  if (!text) return null;
  const asNum = Number(text);
  if (Number.isInteger(asNum) && asNum >= 1 && asNum <= teams.length) {
    return teams[asNum - 1]!;
  }
  const lower = text.toLowerCase();
  const exact = teams.find((t) => t.team_name.toLowerCase() === lower);
  if (exact) return exact;
  const starts = teams.filter((t) => t.team_name.toLowerCase().startsWith(lower));
  if (starts.length === 1) return starts[0]!;
  const includes = teams.filter((t) => t.team_name.toLowerCase().includes(lower));
  if (includes.length === 1) return includes[0]!;
  return null;
}

class TelegramApi {
  pickLogChatId: number | null = null;
  pickLogThreadId: number | null = null;
  fplPickLogChatId: number | null = null;
  fplPickLogThreadId: number | null = null;
  uclLogChatId: number | null = null;
  uclLogThreadId: number | null = null;

  constructor(private readonly token: string) {}

  private get base(): string {
    return `https://api.telegram.org/bot${this.token}`;
  }

  async call<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.base}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json()) as { ok: boolean; description?: string; result: T };
    if (!data.ok) {
      throw new Error(`Telegram ${method}: ${data.description ?? res.status}`);
    }
    return data.result;
  }

  sendMessage(
    chatId: number,
    text: string,
    opts?: { messageThreadId?: number; parseMode?: "HTML" },
  ): Promise<{ message_id: number }> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    };
    if (opts?.messageThreadId != null) {
      body.message_thread_id = opts.messageThreadId;
    }
    if (opts?.parseMode) {
      body.parse_mode = opts.parseMode;
    }
    return this.call("sendMessage", body);
  }

  /** Structured pick logs go to the forum topic only (never DMs / hurry phrases). */
  sendPickLog(
    text: string,
    opts?: { parseMode?: "HTML" },
  ): Promise<{ message_id: number }> {
    if (this.pickLogChatId == null || this.pickLogThreadId == null) {
      return Promise.reject(new Error("pick-log chat/thread not configured"));
    }
    return this.sendMessage(this.pickLogChatId, text, {
      messageThreadId: this.pickLogThreadId,
      parseMode: opts?.parseMode,
    });
  }

  sendFplPickLog(text: string): Promise<{ message_id: number }> {
    if (this.fplPickLogChatId == null || this.fplPickLogThreadId == null) {
      return Promise.reject(new Error("fpl pick-log chat/thread not configured"));
    }
    return this.sendMessage(this.fplPickLogChatId, text, {
      messageThreadId: this.fplPickLogThreadId,
      parseMode: "HTML",
    });
  }

  fplPickLogReady(): boolean {
    return this.fplPickLogChatId != null && this.fplPickLogThreadId != null;
  }

  /** Liga prvaka topic: pick log, draft/window/deadline announcements. */
  sendUclLog(text: string): Promise<{ message_id: number }> {
    if (this.uclLogChatId == null || this.uclLogThreadId == null) {
      return Promise.reject(new Error("ucl log chat/thread not configured"));
    }
    return this.sendMessage(this.uclLogChatId, text, {
      messageThreadId: this.uclLogThreadId,
      parseMode: "HTML",
    });
  }

  uclLogReady(): boolean {
    return this.uclLogChatId != null && this.uclLogThreadId != null;
  }

  getUpdates(offset: number, timeoutSec: number): Promise<TgUpdate[]> {
    return this.call("getUpdates", {
      offset,
      timeout: timeoutSec,
      allowed_updates: ["message"],
    });
  }

  /** Resolve pick-log forum topic (chat_id + message_thread_id). */
  async resolvePickLogChat(): Promise<boolean> {
    const chatId = configuredPickLogChatId();
    const threadId = configuredPickLogThreadId();
    try {
      await this.call<{ id: number }>("getChat", { chat_id: chatId });
      this.pickLogChatId = chatId;
      this.pickLogThreadId = threadId;
      console.log(
        `[top4-ping] pick-log topic ok chat_id=${chatId} thread_id=${threadId}`,
      );
      return true;
    } catch (err) {
      this.pickLogChatId = null;
      this.pickLogThreadId = null;
      console.error(
        `[top4-ping] pick-log getChat failed chat_id=${chatId} thread_id=${threadId}:`,
        err instanceof Error ? err.message : err,
      );
      return false;
    }
  }

  async resolveFplPickLogChat(): Promise<boolean> {
    const chatId = configuredFplPickLogChatId();
    const threadId = configuredFplPickLogThreadId();
    try {
      if (this.pickLogChatId !== chatId) {
        await this.call<{ id: number }>("getChat", { chat_id: chatId });
      }
      this.fplPickLogChatId = chatId;
      this.fplPickLogThreadId = threadId;
      console.log(
        `[fpl-bot] pick-log topic ok chat_id=${chatId} thread_id=${threadId}`,
      );
      return true;
    } catch (err) {
      this.fplPickLogChatId = null;
      this.fplPickLogThreadId = null;
      console.error(
        `[fpl-bot] pick-log getChat failed chat_id=${chatId} thread_id=${threadId}:`,
        err instanceof Error ? err.message : err,
      );
      return false;
    }
  }

  async resolveUclLogChat(): Promise<boolean> {
    const chatId = configuredUclPickLogChatId();
    const threadId = configuredUclPickLogThreadId();
    try {
      if (this.pickLogChatId !== chatId && this.fplPickLogChatId !== chatId) {
        await this.call<{ id: number }>("getChat", { chat_id: chatId });
      }
      this.uclLogChatId = chatId;
      this.uclLogThreadId = threadId;
      console.log(`[ucl-bot] topic ok chat_id=${chatId} thread_id=${threadId}`);
      return true;
    } catch (err) {
      this.uclLogChatId = null;
      this.uclLogThreadId = null;
      console.error(
        `[ucl-bot] topic getChat failed chat_id=${chatId} thread_id=${threadId}:`,
        err instanceof Error ? err.message : err,
      );
      return false;
    }
  }
}

function botHelpText(): string {
  return [
    "Бот Din8sty / Пекло.",
    "",
    "Топ-4:",
    "/pihajme — привязать команду",
    "/deadline · /dildline — напоминания DILDLINE состава (1–3; off — выкл)",
    "/testping — пробный пинг хода",
    "/testlog — тестовый лог пика в топик",
    "/testdeadline — пример напоминания дедлайна",
    "",
    "FPL 2026:",
    "/fpl — привязать email panenka (пинг, когда твой ход)",
    "/fpldeadline · /fpldildline — напоминания дедлайна состава (1–3; off — выкл)",
    "/testfpl — пробный пинг хода",
    "/testfpllog — тестовый лог пика в топик",
    "/testfpldeadline — пример напоминания дедлайна",
    "",
    "Лига чемпионов 2026/27:",
    "/ucl · /lch — привязать email panenka (пинг, когда твой ход)",
    "/ucldeadline · /ucldildline — напоминания о начале тура (1–3; off — выкл)",
    "/testucl — пробный пинг хода",
    "/testucllog — тестовый лог пика в топик",
    "/testucldeadline — пример напоминания о туре",
    "",
    "H2H:",
    "/h2h — привязка email и драфт цифрами (0 = назад)",
    "",
    "Пекло ЛЧ 2026/27:",
    "/regpeklo — регистрация в драфт групп; пик = код клуба (LIL)",
    "",
    "panenka.games:",
    "/panenka — привязка Telegram к игроку (yes/off/who/N)",
    "",
    "Общие:",
    "/start — коротко о боте",
    "/help — все команды",
  ].join("\n");
}

function botStartText(): string {
  return [
    "Бот Din8sty / Пекло.",
    "",
    "Топ-4:",
    "/pihajme — привязать команду",
    "/deadline — напоминания DILDLINE состава",
    "",
    "FPL 2026:",
    fplHelpLine(),
    "",
    "Лига чемпионов 2026/27:",
    uclHelpLine(),
    "",
    "H2H:",
    h2hHelpLine(),
    "",
    "Пекло ЛЧ 2026/27:",
    pekloLcHelpLine(),
    "",
    "panenka.games:",
    panenkaLinkHelpLine(),
    "",
    "Все команды: /help",
  ].join("\n");
}

async function handleBindFlow(
  db: Database.Database,
  api: TelegramApi,
  msg: TgMessage,
  text: string,
): Promise<boolean> {
  const from = msg.from;
  if (!from) return false;
  const userId = from.id;
  const chatId = msg.chat.id;
  const cmd = (text.trim().split(/\s+/)[0] ?? "").toLowerCase().replace(/@\w+$/, "");

  if (cmd === "/start" || cmd === "/help") {
    pendingDeadline.delete(userId);
    await api.sendMessage(chatId, cmd === "/help" ? botHelpText() : botStartText());
    return true;
  }

  if (cmd === "/testping") {
    pendingDeadline.delete(userId);
    const link = getLink(db, userId);
    if (!link) {
      await api.sendMessage(
        chatId,
        "Сначала привяжи команду: /pihajme",
      );
      return true;
    }
    await api.sendMessage(chatId, formatPingMessage(link.team_name));
    return true;
  }

  if (cmd === "/testlog") {
    pendingDeadline.delete(userId);
    const link = getLink(db, userId);
    if (!link) {
      await api.sendMessage(chatId, "Сначала привяжи команду: /pihajme");
      return true;
    }
    if (api.pickLogChatId == null || api.pickLogThreadId == null) {
      await api.sendMessage(
        chatId,
        "Лог пиков ещё не настроен (бот не смог достучаться до топика).",
      );
      return true;
    }
    const sample = formatPickLogMessage({
      pickNumber: 12,
      teamName: link.team_name,
      playerName: "Erling Haaland",
      position: "CF",
      clubName: "Manchester City",
      leagueShort: "ENG",
      mv: 180_000_000,
      wage: 375_000,
      auto: 0,
    });
    try {
      await api.sendPickLog(sample);
      await api.sendMessage(chatId, "Ок — тестовый лог пика отправлен в топик.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[top4-ping] /testlog failed chat=${api.pickLogChatId} thread=${api.pickLogThreadId}:`,
        msg,
      );
      await api.sendMessage(chatId, `Не удалось отправить в лог пиков: ${msg}`);
    }
    return true;
  }

  if (cmd === "/testdeadline") {
    pendingDeadline.delete(userId);
    const link = getLink(db, userId);
    if (!link) {
      await api.sendMessage(chatId, "Сначала привяжи команду: /pihajme");
      return true;
    }
    const { clubIds, teamCode } = clubIdsForBoundTeam(db, link);
    const upcoming = upcomingSquadDeadline(db, clubIds);
    if (!upcoming) {
      await api.sendMessage(
        chatId,
        `${deadlineStatusLine(db, link)}\nПример:\n\n${formatDeadlineReminderText({
          deadlineIso: "2026-08-16T14:00:00.000Z",
          teamName: link.team_name,
          teamCode,
        })}`,
      );
      return true;
    }
    await api.sendMessage(
      chatId,
      formatDeadlineReminderText({
        deadlineIso: upcoming.deadlineAt,
        teamName: link.team_name,
        teamCode,
      }),
    );
    return true;
  }

  if (cmd === "/deadline" || cmd === "/dildline") {
    pendingBind.delete(userId);
    const link = getLink(db, userId);
    if (!link) {
      pendingDeadline.delete(userId);
      await api.sendMessage(chatId, "Сначала привяжи команду: /pihajme");
      return true;
    }
    const rest = text.trim().split(/\s+/).slice(1).join(" ").trim();
    if (isOffReply(rest)) {
      pendingDeadline.delete(userId);
      disableDeadlineReminder(db, userId);
      await api.sendMessage(
        chatId,
        "Напоминания о дедлайне выключены. /deadline — настроить снова.",
      );
      return true;
    }
    const existing = getDeadlineReminder(db, userId);
    const currentMins = existing ? parseMinutesJson(existing.minutes_json) : [];
    const currentLine = currentMins.length
      ? `Сейчас${existing && !existing.enabled ? " (выкл)" : ""}: ${currentMins.length}× — за ${formatMinutesList(currentMins)} мин.\n`
      : "";
    pendingDeadline.set(userId, {
      step: "count",
      count: 0,
      minutes: [],
      at: Date.now(),
    });
    await api.sendMessage(
      chatId,
      `Напоминания о дедлайне состава «${link.team_name}».\n${currentLine}${deadlineStatusLine(db, link)}\n\nСколько напоминаний? Ответь 1, 2 или 3.\nПотом укажешь минуты до дедлайна для каждого (например 60, 30, 10).\n/deadline off — выключить.`,
    );
    return true;
  }

  if (cmd === "/pihajme") {
    pendingDeadline.delete(userId);
    const teams = listBindableTeams(db);
    if (!teams.length) {
      await api.sendMessage(chatId, "Пока нет зарегистрированных команд Топ-4.");
      return true;
    }
    const existing = getLink(db, userId);
    pendingBind.set(userId, { teams, at: Date.now() });
    const head = existing
      ? `Сейчас привязано: «${existing.team_name}».\nОтветь номером или названием, чтобы сменить.\n\n`
      : `Привяжи Telegram к команде менеджера Топ-4.\nОтветь номером или названием команды.\n\n`;
    await api.sendMessage(chatId, `${head}${formatTeamList(teams)}`);
    return true;
  }

  const deadlinePending = pendingDeadline.get(userId);
  if (deadlinePending) {
    if (Date.now() - deadlinePending.at > PENDING_TTL_MS) {
      pendingDeadline.delete(userId);
    } else {
      const link = getLink(db, userId);
      if (!link) {
        pendingDeadline.delete(userId);
        await api.sendMessage(chatId, "Сначала привяжи команду: /pihajme");
        return true;
      }
      if (isOffReply(text)) {
        pendingDeadline.delete(userId);
        disableDeadlineReminder(db, userId);
        await api.sendMessage(
          chatId,
          "Напоминания о дедлайне выключены. /deadline — настроить снова.",
        );
        return true;
      }
      if (deadlinePending.step === "count") {
        const count = parseCountReply(text);
        if (count == null) {
          await api.sendMessage(chatId, "Нужно число 1, 2 или 3. Или /deadline off.");
          return true;
        }
        pendingDeadline.set(userId, {
          step: "minutes",
          count,
          minutes: [],
          at: Date.now(),
        });
        await api.sendMessage(
          chatId,
          `За сколько минут до дедлайна прислать напоминание 1/${count}?\nЦелое число больше 0, например 60.`,
        );
        return true;
      }
      const minutes = parseMinutesReply(text);
      if (minutes == null) {
        await api.sendMessage(
          chatId,
          `Нужно целое число минут от 1 до ${DEADLINE_MAX_MINUTES} (например 60).`,
        );
        return true;
      }
      if (deadlinePending.minutes.includes(minutes)) {
        await api.sendMessage(
          chatId,
          `Уже есть напоминание за ${minutes} мин. Укажи другое число минут.`,
        );
        return true;
      }
      const nextMinutes = [...deadlinePending.minutes, minutes];
      if (nextMinutes.length < deadlinePending.count) {
        pendingDeadline.set(userId, {
          step: "minutes",
          count: deadlinePending.count,
          minutes: nextMinutes,
          at: Date.now(),
        });
        await api.sendMessage(
          chatId,
          `За сколько минут до дедлайна прислать напоминание ${nextMinutes.length + 1}/${deadlinePending.count}?\nУже задано: ${formatMinutesList(nextMinutes)}. Минуты должны быть разными.`,
        );
        return true;
      }
      const stored = nextMinutes.slice().sort((a, b) => b - a);
      upsertDeadlineReminder(db, {
        telegramUserId: userId,
        chatId,
        minutes: stored,
      });
      pendingDeadline.delete(userId);
      await api.sendMessage(
        chatId,
        `Готово: ${stored.length} напоминани${stored.length === 1 ? "е" : "я"} за ${formatMinutesList(stored)} мин до дедлайна.\n${deadlineStatusLine(db, link)}\nТекст: «DILDLINE IS COMING».`,
      );
      return true;
    }
  }

  const pending = pendingBind.get(userId);
  if (!pending) return false;
  if (Date.now() - pending.at > PENDING_TTL_MS) {
    pendingBind.delete(userId);
    return false;
  }

  const team = matchTeam(text, pending.teams);
  if (!team) {
    await api.sendMessage(
      chatId,
      `Не понял «${text.trim()}». Ответь номером из списка или точным названием:\n\n${formatTeamList(pending.teams)}`,
    );
    return true;
  }

  upsertLink(db, {
    telegramUserId: userId,
    chatId,
    email: team.email,
    teamId: team.team_id,
    teamName: team.team_name,
    tgUsername: from.username ?? null,
  });
  pendingBind.delete(userId);
  await api.sendMessage(
    chatId,
    `Готово: привязано к «${team.team_name}».\nБуду писать, когда твой ход в живом драфте (если автопик по wishlist не сработает).`,
  );
  return true;
}

async function checkTurns(db: Database.Database, api: TelegramApi): Promise<void> {
  const live = getLiveDraftPublic(db);
  if (!live || live.complete || !live.on_clock) return;

  const pickNo = live.pick_no;
  const onClock = live.on_clock;
  const bank = live.banks.find(
    (b) => b.email.toLowerCase() === onClock.email.toLowerCase(),
  );
  const outOfDraft = Boolean(bank?.out_of_draft);
  // OOD always resolves (wishlist else rating) — no human ping.
  if (outOfDraft) {
    return;
  }

  const links = listLinksForEmail(db, onClock.email);
  for (const link of links) {
    if (link.last_notified_pick_no === pickNo) continue;
    const text = formatPingMessage(onClock.team_name || link.team_name);
    try {
      await api.sendMessage(link.chat_id, text);
      markNotified(db, link.telegram_user_id, pickNo);
      console.log(
        `[top4-ping] notified user=${link.telegram_user_id} team=${link.team_name} pick=#${pickNo}`,
      );
    } catch (err) {
      console.error(
        `[top4-ping] send failed user=${link.telegram_user_id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

async function checkDeadlineReminders(
  db: Database.Database,
  api: TelegramApi,
): Promise<void> {
  const rows = listEnabledDeadlineReminders(db);
  if (!rows.length) return;

  const nowMs = Date.now();
  const squads = getTop4SquadsPublic(db);

  for (const row of rows) {
    const minutes = parseMinutesJson(row.minutes_json);
    if (!minutes.length) continue;
    const link = getLink(db, row.telegram_user_id);
    if (!link) continue;
    const { clubIds, teamCode } = resolveBoundSquad(squads, link);
    if (!clubIds.length) continue;
    const upcoming = upcomingSquadDeadline(db, clubIds, nowMs);
    if (!upcoming) continue;

    const sent =
      row.last_sent_gw === upcoming.gw
        ? parseMinutesJson(row.last_sent_offsets_json)
        : [];

    for (const offset of minutes) {
      if (sent.includes(offset)) continue;
      const fireAt = upcoming.deadlineMs - offset * 60_000;
      if (nowMs < fireAt) continue;
      if (nowMs >= upcoming.deadlineMs) continue;
      const text = formatDeadlineReminderText({
        deadlineIso: upcoming.deadlineAt,
        teamName: link.team_name,
        teamCode,
      });
      try {
        await api.sendMessage(link.chat_id, text);
        markDeadlineSent(db, link.telegram_user_id, upcoming.gw, offset);
        sent.push(offset);
        console.log(
          `[top4-ping] deadline reminder user=${link.telegram_user_id} team=${link.team_name} gw=${upcoming.gw} offset=${offset}m`,
        );
      } catch (err) {
        console.error(
          `[top4-ping] deadline send failed user=${link.telegram_user_id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatManagerTag(
  db: Database.Database,
  email: string,
  teamName: string,
): string {
  const label = `«${escapeHtml(teamName || email)}»`;
  const links = listLinksForEmail(db, email);
  const named = links.find((l) => l.tg_username);
  if (named?.tg_username) return `@${named.tg_username} ${label}`;
  const any = links[0];
  if (any) return `<a href="tg://user?id=${any.telegram_user_id}">${label}</a>`;
  return label;
}

function ensureTransferLogState(db: Database.Database): {
  last_move_id: number;
  last_window_gw: number;
} {
  const existing = db
    .prepare(
      `SELECT last_move_id, last_window_gw FROM top4_transfer_log_state WHERE id = 1`,
    )
    .get() as { last_move_id: number; last_window_gw: number } | undefined;
  if (existing) return existing;
  const maxMove = (
    db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM top4_transfer_moves`).get() as {
      m: number;
    }
  ).m;
  const openGw = getTransferBotView(db).window?.after_gw ?? 0;
  db.prepare(
    `INSERT INTO top4_transfer_log_state (id, last_move_id, last_window_gw)
     VALUES (1, ?, ?)`,
  ).run(maxMove, openGw);
  console.log(
    `[top4-ping] transfer-log seeded last_move_id=${maxMove} last_window_gw=${openGw}`,
  );
  return { last_move_id: maxMove, last_window_gw: openGw };
}

function setTransferLogMove(db: Database.Database, moveId: number): void {
  ensureTransferLogState(db);
  db.prepare(
    `UPDATE top4_transfer_log_state SET last_move_id = ? WHERE id = 1`,
  ).run(moveId);
}

function setTransferLogWindow(db: Database.Database, gw: number): void {
  ensureTransferLogState(db);
  db.prepare(
    `UPDATE top4_transfer_log_state SET last_window_gw = ? WHERE id = 1`,
  ).run(gw);
}

function formatTransferMoveText(
  db: Database.Database,
  move: {
    id: number;
    round: number;
    team_id: number;
    email: string;
    kind: "dump" | "pick" | "pass";
    player_id: string | null;
    player_name: string | null;
  },
  teamName: string,
  dumps: number,
  picks: number,
  next: { email: string; name: string } | null,
  done: boolean,
): string {
  const kind =
    move.kind === "dump" ? "📤 Сброс" : move.kind === "pick" ? "🎯 Пик" : "⏭ Пропуск";
  const verb =
    move.kind === "dump"
      ? "скидывает"
      : move.kind === "pick"
        ? "пикает"
        : "пропускает ход";
  const lines = [
    `${kind} · Раунд ${move.round}`,
    `«${escapeHtml(teamName)}» ${verb}${move.kind === "pass" ? "" : ":"}`,
  ];
  if (move.kind !== "pass") {
    lines.push(escapeHtml(move.player_name || move.player_id || "—"));
  }
  lines.push(`Сбросы ${dumps}/${TRANSFER_MAX_DUMPS} · пики ${picks}/${TRANSFER_MAX_PICKS}`);
  if (done) lines.push("Окно завершено");
  else if (next) lines.push(`Следующий: ${formatManagerTag(db, next.email, next.name)}`);
  lines.push(TRANSFERS_URL);
  return lines.join("\n");
}

/** Log new transfer-window opens and dump/pick/pass moves to the draft topic. */
async function checkTransferLogs(
  db: Database.Database,
  api: TelegramApi,
): Promise<void> {
  if (api.pickLogChatId == null || api.pickLogThreadId == null) return;
  const state = ensureTransferLogState(db);
  const view = getTransferBotView(db);
  const win = view.window;
  if (win && win.after_gw !== state.last_window_gw) {
    const clock = win.on_clock;
    const tag = clock
      ? formatManagerTag(db, clock.email, clock.name || clock.code || "")
      : "—";
    const text = [
      `🔁 Трансферное окно после GW${win.after_gw} открыто`,
      `Раунд ${win.round} из ${win.rounds}`,
      `Следующий: ${tag}`,
      TRANSFERS_URL,
    ].join("\n");
    try {
      await api.sendPickLog(text, { parseMode: "HTML" });
      setTransferLogWindow(db, win.after_gw);
      state.last_window_gw = win.after_gw;
      console.log(`[top4-ping] transfer-log window GW${win.after_gw}`);
    } catch (err) {
      console.error(
        "[top4-ping] transfer-log window send failed:",
        err instanceof Error ? err.message : err,
      );
      return;
    }
  }
  const fresh = view.moves.filter((m) => m.id > state.last_move_id);
  if (!fresh.length) return;
  const lastId = fresh[fresh.length - 1]!.id;
  const nameByTeam = new Map(view.order.map((t) => [t.team_id, t.name]));
  for (const move of fresh) {
    const dumps = view.moves.filter(
      (x) => x.team_id === move.team_id && x.kind === "dump" && x.id <= move.id,
    ).length;
    const picks = view.moves.filter(
      (x) => x.team_id === move.team_id && x.kind === "pick" && x.id <= move.id,
    ).length;
    const resolvedName =
      nameByTeam.get(move.team_id) ||
      listLinksForEmail(db, move.email)[0]?.team_name ||
      move.email;
    const isLast = move.id === lastId;
    const next =
      isLast && win?.status === "open" && win.on_clock
        ? { email: win.on_clock.email, name: win.on_clock.name || "" }
        : null;
    const text = formatTransferMoveText(
      db,
      move,
      resolvedName,
      dumps,
      picks,
      next,
      Boolean(isLast && win && win.status !== "open"),
    );
    try {
      await api.sendPickLog(text, { parseMode: "HTML" });
      setTransferLogMove(db, move.id);
      console.log(`[top4-ping] transfer-log ${move.kind} #${move.id}`);
    } catch (err) {
      console.error(
        `[top4-ping] transfer-log send failed #${move.id}:`,
        err instanceof Error ? err.message : err,
      );
      break;
    }
  }
}

/**
 * Post structured pick logs for every new row in top4_draft_picks (once each).
 * Runs while drafting or after the draft just completed (final picks).
 */
async function checkPickLogs(db: Database.Database, api: TelegramApi): Promise<void> {
  if (api.pickLogChatId == null || api.pickLogThreadId == null) return;

  const state = getTop4State(db);
  if (state.status !== "drafting" && state.status !== "complete") return;

  const maxPick = maxDraftPickNo(db);
  let last = getLastLoggedPickNo(db);
  // Draft reset (picks cleared / new draft): rewind cursor.
  if (maxPick < last) {
    setLastLoggedPickNo(db, maxPick);
    last = maxPick;
    console.log(`[top4-ping] pick-log cursor reset to ${last} (draft reset?)`);
  }
  if (maxPick <= last) return;

  const picks = db
    .prepare(
      `SELECT pick_number, team_id, email, player_id, auto
       FROM top4_draft_picks
       WHERE pick_number > ? AND pick_number <= ?
       ORDER BY pick_number ASC`,
    )
    .all(last, maxPick) as DraftPickLogRow[];

  const byTeam = lotteryByTeamId(db);
  const poolById = new Map(loadTop4Pool(db).map((p) => [p.id, p]));

  for (const pick of picks) {
    const text = buildPickLogText(pick, byTeam, poolById);
    try {
      await api.sendPickLog(text);
      setLastLoggedPickNo(db, pick.pick_number);
      console.log(
        `[top4-ping] pick-log #${pick.pick_number} team=${pick.team_id} auto=${pick.auto}`,
      );
    } catch (err) {
      console.error(
        `[top4-ping] pick-log send failed #${pick.pick_number} chat=${api.pickLogChatId} thread=${api.pickLogThreadId}:`,
        err instanceof Error ? err.message : err,
      );
      // Stop so we retry the same pick next poll (no gaps / duplicates after success).
      break;
    }
  }
}

type ReplaceLogRow = {
  id: number;
  pick_number: number;
  team_id: number;
  old_player_id: string;
  new_player_id: string;
  kind: string;
};

function formatReplaceLogMessage(opts: {
  pickNumber: number;
  teamName: string;
  oldName: string;
  newName: string;
  position: string;
  clubName: string;
  leagueShort: string;
  mv: number;
  wage: number;
  kind: string;
}): string {
  const round = Math.floor((opts.pickNumber - 1) / TOP4_TEAM_COUNT) + 1;
  const pos = opts.position || "?";
  const club = opts.clubName || "?";
  const league = opts.leagueShort || "?";
  if (opts.kind === "remove") {
    return [
      `🗑 Удаление авто · Пик #${opts.pickNumber} · Раунд ${round}`,
      `«${opts.teamName}» снимает авто (алгоритм):`,
      `${opts.oldName} · ${pos} · ${club} (${league})`,
      `MV ${formatMvEuro(opts.mv)} · ${formatWageEuro(opts.wage)}`,
      "удаление авто",
    ].join("\n");
  }
  if (opts.kind === "fill") {
    return [
      `➕ Вакансия · Пик #${opts.pickNumber} · Раунд ${round}`,
      `«${opts.teamName}» заполняет вакансию:`,
      `${opts.oldName} → ${opts.newName} · ${pos} · ${club} (${league})`,
      `MV ${formatMvEuro(opts.mv)} · ${formatWageEuro(opts.wage)}`,
      "заполнение вакансии",
    ].join("\n");
  }
  return [
    `🔄 Замена авто · Пик #${opts.pickNumber} · Раунд ${round}`,
    `«${opts.teamName}» меняет:`,
    `${opts.oldName} → ${opts.newName} · ${pos} · ${club} (${league})`,
    `MV ${formatMvEuro(opts.mv)} · ${formatWageEuro(opts.wage)}`,
    "замена авто",
  ].join("\n");
}

/** Post pending algorithmic-autopick replacements (manager/consigliere swaps). */
async function checkReplaceLogs(db: Database.Database, api: TelegramApi): Promise<void> {
  if (api.pickLogChatId == null || api.pickLogThreadId == null) return;

  const rows = db
    .prepare(
      `SELECT id, pick_number, team_id, old_player_id, new_player_id,
              COALESCE(kind, 'replace') AS kind
       FROM top4_pick_replace_log
       WHERE logged = 0
       ORDER BY id ASC
       LIMIT 20`,
    )
    .all() as ReplaceLogRow[];
  if (!rows.length) return;

  const byTeam = lotteryByTeamId(db);
  const poolById = new Map(loadTop4Pool(db).map((p) => [p.id, p]));
  const mark = db.prepare(`UPDATE top4_pick_replace_log SET logged = 1 WHERE id = ?`);

  for (const row of rows) {
    const entry = byTeam.get(row.team_id);
    const teamName = entry?.team_name ?? String(row.team_id);
    const oldP = poolById.get(row.old_player_id);
    const newP = row.new_player_id ? poolById.get(row.new_player_id) : null;
    const focus = row.kind === "remove" ? oldP : newP ?? oldP;
    const text = formatReplaceLogMessage({
      pickNumber: row.pick_number,
      teamName,
      oldName: oldP?.name ?? row.old_player_id,
      newName: newP?.name ?? (row.new_player_id || "—"),
      position: focus?.position_display ?? "?",
      clubName: focus?.club_name ?? "?",
      leagueShort: focus?.league_id ?? "?",
      mv: focus?.market_value_eur ?? 0,
      wage: focus?.wage_pw ?? 0,
      kind: row.kind || "replace",
    });
    try {
      await api.sendPickLog(text);
      mark.run(row.id);
      console.log(
        `[top4-ping] replace-log ${row.kind} #${row.pick_number} ${row.old_player_id}→${row.new_player_id || "—"}`,
      );
    } catch (err) {
      console.error(
        `[top4-ping] replace-log send failed id=${row.id}:`,
        err instanceof Error ? err.message : err,
      );
      break;
    }
  }
}

async function main(): Promise<void> {
  const token = requireToken();
  const db = openDb();
  const api = new TelegramApi(token);

  const me = await api.call<{ username?: string }>("getMe");
  console.log(`[top4-ping] started as @${me.username ?? "?"} poll=${POLL_MS}ms`);
  ensurePickLogState(db);
  await api.resolvePickLogChat();
  await api.resolveFplPickLogChat();
  await api.resolveUclLogChat();

  let offset = 0;
  let polling = false;

  const runPollJobs = async () => {
    if (polling) return;
    polling = true;
    try {
      await checkPickLogs(db, api);
      await checkReplaceLogs(db, api);
      await checkTransferLogs(db, api);
      await checkTurns(db, api);
      await checkDeadlineReminders(db, api);
      await checkH2hNotifications(db, api);
      await checkPekloLcNotifications(db, api);
      await checkFplDraft(db, api);
      await checkUclDraft(db, api);
    } catch (err) {
      console.error("[top4-ping] poll:", err instanceof Error ? err.message : err);
    } finally {
      polling = false;
    }
  };

  setInterval(() => {
    void runPollJobs();
  }, POLL_MS);
  void runPollJobs();

  for (;;) {
    try {
      const updates = await api.getUpdates(offset, 25);
      for (const u of updates) {
        offset = u.update_id + 1;
        const msg = u.message;
        if (!msg?.text || !msg.from) continue;
        try {
          const handledPanenka = await handlePanenkaMessage(db, api, msg, msg.text);
          const handledUcl =
            !handledPanenka && (await handleUclMessage(db, api, msg, msg.text));
          const handledFpl =
            !handledPanenka &&
            !handledUcl &&
            (await handleFplMessage(db, api, msg, msg.text));
          const handledH2h =
            !handledPanenka &&
            !handledUcl &&
            !handledFpl &&
            (await handleH2hMessage(db, api, msg, msg.text));
          const handledPekloLc =
            !handledPanenka &&
            !handledUcl &&
            !handledFpl &&
            !handledH2h &&
            (await handlePekloLcMessage(db, api, msg, msg.text));
          if (
            !handledPanenka &&
            !handledUcl &&
            !handledFpl &&
            !handledH2h &&
            !handledPekloLc
          ) {
            await handleBindFlow(db, api, msg, msg.text);
          }
        } catch (err) {
          console.error(
            "[top4-ping] message handler:",
            err instanceof Error ? err.message : err,
          );
          try {
            await api.sendMessage(
              msg.chat.id,
              "Ошибка. Попробуй /regpeklo, /h2h, /fpl, /ucl или /pihajme.",
            );
          } catch {
            /* ignore */
          }
        }
      }
    } catch (err) {
      console.error("[top4-ping] getUpdates:", err instanceof Error ? err.message : err);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

main().catch((err) => {
  console.error("[top4-ping] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
