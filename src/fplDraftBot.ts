/**
 * FPL 2026 draft notifications on the Din8sty Telegram bot (same token).
 *
 * Pick logs → forum topic https://t.me/c/2419087266/2
 * Transfer logs → same topic (drop/take or skip, then who is next)
 * Turn pings → DM when a mapped manager goes on the clock (draft or transfer).
 * Deadline reminders → DM (same UX as Top-4 /deadline: 1–3 offsets).
 * Email mapping: fpl_telegram_links ∪ top4_telegram_links ∪ h2h_telegram_links.
 *
 * /fpl — bind panenka email (for managers not already in Top-4 / H2H)
 * /testfpl — sample turn ping
 * /testfpllog — sample pick log to the FPL topic
 * /fpldeadline — lineup-deadline reminders (1–3 offsets)
 * /fpldeadline off — disable
 * /testfpldeadline — sample deadline reminder
 */
import type Database from "better-sqlite3";

const DRAFT_URL = "https://fantasy.panenka.games/fpl-2026/draft";
const LINEUP_URL = "https://fantasy.panenka.games/fpl-2026/lineup";
const TRANSFERS_URL = "https://fantasy.panenka.games/fpl-2026/transfers";
const PENDING_TTL_MS = 15 * 60_000;
const WARSAW_TZ = "Europe/Warsaw";
const DEADLINE_MAX_MINUTES = 14 * 24 * 60;

type TgUser = { id: number; username?: string; first_name?: string };
type TgChat = { id: number; type: string };
type TgMessage = {
  message_id: number;
  date: number;
  text?: string;
  chat: TgChat;
  from?: TgUser;
};

export type FplTelegramApi = {
  sendMessage: (chatId: number, text: string) => Promise<{ message_id: number }>;
  sendFplPickLog: (text: string) => Promise<{ message_id: number }>;
  fplPickLogReady: () => boolean;
};

type Link = { telegram_user_id: number; chat_id: number; email: string };

type FplPick = {
  pickNumber: number;
  round: number;
  auto: boolean;
  teamName: string;
  email: string;
  playerName: string;
  position: string;
  clubShort: string;
  clubName: string;
};

type FplMember = {
  email: string;
  teamName: string;
  displayName: string;
  draftSlot?: number | null;
  outOfDraft: boolean;
};

type FplDeadline = {
  gw: number;
  deadline_time: string;
};

type FplTransferAction = {
  id: number;
  kind: "transfer" | "skip";
  pass: number;
  teamName: string;
  email: string;
  outPlayerName: string | null;
  outPosition: string | null;
  outClubShort: string | null;
  inPlayerName: string | null;
  inPosition: string | null;
  inClubShort: string | null;
};

type FplTransferOnClock = {
  email: string;
  teamName: string;
  displayName: string;
  memberId: number;
  pass: number;
  turnKey: string;
};

type FplTransferWindowSnap = {
  windowId: string;
  pass: number;
  totalPasses: number;
  onClock: FplTransferOnClock | null;
  actions: FplTransferAction[];
};

type FplSnapshot = {
  ok?: boolean;
  error?: string;
  status: string;
  size: number;
  currentPickNo: number;
  maxPickNumber: number;
  totalPicks?: number;
  onClock: {
    email: string;
    teamName: string;
    displayName: string;
    outOfDraft: boolean;
    pickNo: number;
    round: number;
  } | null;
  picks: FplPick[];
  members: FplMember[];
  deadline?: FplDeadline | null;
  transferWindow?: FplTransferWindowSnap | null;
};

type DeadlineReminderRow = {
  telegram_user_id: number;
  chat_id: number;
  minutes_json: string;
  last_sent_gw: number | null;
  last_sent_offsets_json: string;
  enabled: number;
};

/** Fallback if an older panenka snapshot omits totalPicks (23 rounds). */
const FPL_PICKS_PER_MANAGER = 23;

const pendingFpl = new Map<number, { at: number }>();
const pendingFplDeadline = new Map<
  number,
  { step: "count" | "minutes"; count: number; minutes: number[]; at: number }
>();
let coverageLogged = false;

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
  "Где деньги, Зин? Где твой пик, менеджер?",
  "Спокойствие, только спокойствие… ладно, не спокойствие — ПИКАЙ УЖЕ!",
  "Я вас категорически приветствую! И категорически прошу сделать пик.",
] as const;

function pickPingPhrase(): string {
  return PING_PHRASES[Math.floor(Math.random() * PING_PHRASES.length)]!;
}

export function formatFplPingMessage(teamName?: string | null): string {
  const phrase = pickPingPhrase();
  const context = teamName?.trim()
    ? `Твоя очередь в драфте FPL 2026 — «${teamName.trim()}»`
    : "Твоя очередь в драфте FPL 2026";
  return `${phrase}\n\n${context}\n${DRAFT_URL}`;
}

export function formatFplTransferPingMessage(teamName?: string | null): string {
  const phrase = pickPingPhrase();
  const context = teamName?.trim()
    ? `Твоя очередь на трансфер FPL 2026 — «${teamName.trim()}»`
    : "Твоя очередь на трансфер FPL 2026";
  return `${phrase}\n\n${context}\n${TRANSFERS_URL}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Snake: round 1 = slots 1..N, round 2 = N..1, same as panenka memberSlotForPick. */
function memberSlotForPick(pickNo: number, size: number): number {
  const round = Math.ceil(pickNo / size);
  const idxInRound = ((pickNo - 1) % size) + 1;
  return round % 2 === 1 ? idxInRound : size - idxInRound + 1;
}

function totalPicksOf(snap: FplSnapshot): number {
  if (Number.isFinite(snap.totalPicks) && (snap.totalPicks ?? 0) > 0) {
    return snap.totalPicks!;
  }
  return Math.max(1, snap.size) * FPL_PICKS_PER_MANAGER;
}

type NextUp = {
  email: string;
  teamName: string;
  outOfDraft: boolean;
};

function nextUpAfterPick(pick: FplPick, snap: FplSnapshot): NextUp | "done" | null {
  const total = totalPicksOf(snap);
  if (pick.pickNumber >= total) return "done";

  const isLatest = pick.pickNumber === snap.maxPickNumber;
  if (isLatest && snap.status !== "drafting" && !snap.onClock) return "done";

  // Latest pick: whoever the site currently has on the clock (skips already-resolved OOD / GK skips).
  if (isLatest && snap.onClock) {
    return {
      email: snap.onClock.email,
      teamName: snap.onClock.teamName,
      outOfDraft: snap.onClock.outOfDraft,
    };
  }

  const nextNo = pick.pickNumber + 1;
  if (nextNo > total) return "done";
  if (!snap.size) return null;
  const slot = memberSlotForPick(nextNo, snap.size);
  const member = snap.members.find((m) => m.draftSlot === slot) ?? null;
  if (!member) return null;
  return {
    email: member.email,
    teamName: member.teamName,
    outOfDraft: member.outOfDraft,
  };
}

/** HTML pick-log line. Tag if this email is bound to a Telegram user. */
export function formatNextUpLine(
  next: NextUp,
  link: Link | null,
): string {
  const label = `«${escapeHtml(next.teamName)}»`;
  if (link) {
    return `Следующий: <a href="tg://user?id=${link.telegram_user_id}">${label}</a>`;
  }
  return `Следующий: ${label}`;
}

export function formatFplPickLog(pick: FplPick, nextLine?: string): string {
  const club = escapeHtml(pick.clubShort || pick.clubName || "?");
  const lines = [
    `🎯 Пик #${pick.pickNumber} · Раунд ${pick.round}`,
    `«${escapeHtml(pick.teamName)}» выбирает:`,
    `${escapeHtml(pick.playerName)} · ${escapeHtml(pick.position)} · ${club}`,
    pick.auto ? "авто" : "ручной",
  ];
  if (nextLine) lines.push(nextLine);
  return lines.join("\n");
}

export function formatFplTransferLog(
  action: FplTransferAction,
  totalPasses: number,
  nextLine?: string,
): string {
  const pass = `Проход ${action.pass} из ${totalPasses}`;
  if (action.kind === "skip") {
    const lines = [
      `⏭ Пропуск · ${pass}`,
      `«${escapeHtml(action.teamName)}» пропускает ход`,
    ];
    if (nextLine) lines.push(nextLine);
    return lines.join("\n");
  }
  const out = [
    escapeHtml(action.outPlayerName || "?"),
    escapeHtml(action.outPosition || "?"),
    escapeHtml(action.outClubShort || "?"),
  ].join(" · ");
  const inn = [
    escapeHtml(action.inPlayerName || "?"),
    escapeHtml(action.inPosition || "?"),
    escapeHtml(action.inClubShort || "?"),
  ].join(" · ");
  const lines = [
    `🔄 Трансфер · ${pass}`,
    `«${escapeHtml(action.teamName)}» отпускает:`,
    out,
    "берёт:",
    inn,
  ];
  if (nextLine) lines.push(nextLine);
  return lines.join("\n");
}

function panenkaOrigin(): string {
  return (
    process.env.H2H_BOT_API_ORIGIN?.trim() ||
    process.env.PANENKA_ORIGIN?.trim() ||
    "https://panenka.games"
  );
}

function botSecret(): string {
  return process.env.H2H_BOT_SECRET?.trim() || "";
}

async function fetchSnapshot(): Promise<FplSnapshot> {
  const secret = botSecret();
  if (!secret) throw new Error("H2H_BOT_SECRET missing");
  const url = new URL("/api/fpl/bot", panenkaOrigin());
  const res = await fetch(url, {
    headers: { "X-H2H-Bot-Secret": secret },
    cache: "no-store",
  });
  const data = (await res.json()) as FplSnapshot;
  if (!res.ok || data.ok === false) {
    throw new Error(String(data.error ?? `HTTP ${res.status}`));
  }
  return data;
}

export function ensureFplBotTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fpl_telegram_links (
      telegram_user_id INTEGER PRIMARY KEY,
      chat_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fpl_telegram_links_email
      ON fpl_telegram_links (email);
    CREATE TABLE IF NOT EXISTS fpl_bot_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_logged_pick_no INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS fpl_notify_state (
      telegram_user_id INTEGER PRIMARY KEY,
      last_notified_pick_no INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS fpl_transfer_bot_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_logged_action_id INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS fpl_transfer_notify_state (
      telegram_user_id INTEGER PRIMARY KEY,
      last_turn_key TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS fpl_deadline_reminders (
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
}

function getFplLink(db: Database.Database, telegramUserId: number): Link | null {
  return (
    (db
      .prepare(
        `SELECT telegram_user_id, chat_id, email FROM fpl_telegram_links
         WHERE telegram_user_id = ?`,
      )
      .get(telegramUserId) as Link | undefined) ?? null
  );
}

function upsertFplLink(
  db: Database.Database,
  opts: { telegramUserId: number; chatId: number; email: string },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO fpl_telegram_links
       (telegram_user_id, chat_id, email, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET
       chat_id = excluded.chat_id,
       email = excluded.email,
       updated_at = excluded.updated_at`,
  ).run(opts.telegramUserId, opts.chatId, opts.email.toLowerCase(), now, now);
}

function queryLinksByEmail(
  db: Database.Database,
  table: string,
  email: string,
): Link[] {
  return db
    .prepare(
      `SELECT telegram_user_id, chat_id, email FROM ${table}
       WHERE email = ? COLLATE NOCASE`,
    )
    .all(email.toLowerCase()) as Link[];
}

/** Union of FPL / Top-4 / H2H binds for this email (unique telegram user). */
function linksForEmail(db: Database.Database, email: string): Link[] {
  const seen = new Set<number>();
  const out: Link[] = [];
  for (const table of [
    "fpl_telegram_links",
    "top4_telegram_links",
    "h2h_telegram_links",
  ]) {
    let rows: Link[] = [];
    try {
      rows = queryLinksByEmail(db, table, email);
    } catch {
      continue;
    }
    for (const row of rows) {
      if (seen.has(row.telegram_user_id)) continue;
      seen.add(row.telegram_user_id);
      out.push(row);
    }
  }
  return out;
}

function allKnownEmails(db: Database.Database): Map<string, Link[]> {
  const byEmail = new Map<string, Link[]>();
  const add = (row: Link) => {
    const email = row.email.toLowerCase();
    const list = byEmail.get(email) ?? [];
    if (list.some((l) => l.telegram_user_id === row.telegram_user_id)) return;
    list.push(row);
    byEmail.set(email, list);
  };
  for (const table of [
    "fpl_telegram_links",
    "top4_telegram_links",
    "h2h_telegram_links",
  ]) {
    try {
      const rows = db
        .prepare(`SELECT telegram_user_id, chat_id, email FROM ${table}`)
        .all() as Link[];
      for (const row of rows) add(row);
    } catch {
      /* table may not exist yet */
    }
  }
  return byEmail;
}

function getLastLoggedPickNo(db: Database.Database): number {
  const row = db
    .prepare(`SELECT last_logged_pick_no FROM fpl_bot_state WHERE id = 1`)
    .get() as { last_logged_pick_no: number } | undefined;
  return row?.last_logged_pick_no ?? 0;
}

function setLastLoggedPickNo(db: Database.Database, n: number): void {
  db.prepare(
    `INSERT INTO fpl_bot_state (id, last_logged_pick_no) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET last_logged_pick_no = excluded.last_logged_pick_no`,
  ).run(n);
}

function lastNotifiedPickNo(db: Database.Database, telegramUserId: number): number {
  const row = db
    .prepare(
      `SELECT last_notified_pick_no FROM fpl_notify_state WHERE telegram_user_id = ?`,
    )
    .get(telegramUserId) as { last_notified_pick_no: number } | undefined;
  return row?.last_notified_pick_no ?? 0;
}

function markNotified(
  db: Database.Database,
  telegramUserId: number,
  pickNo: number,
): void {
  db.prepare(
    `INSERT INTO fpl_notify_state (telegram_user_id, last_notified_pick_no)
     VALUES (?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET
       last_notified_pick_no = excluded.last_notified_pick_no`,
  ).run(telegramUserId, pickNo);
}

function getLastLoggedTransferActionId(db: Database.Database): number {
  const row = db
    .prepare(`SELECT last_logged_action_id FROM fpl_transfer_bot_state WHERE id = 1`)
    .get() as { last_logged_action_id: number } | undefined;
  return row?.last_logged_action_id ?? 0;
}

function setLastLoggedTransferActionId(db: Database.Database, n: number): void {
  db.prepare(
    `INSERT INTO fpl_transfer_bot_state (id, last_logged_action_id) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET last_logged_action_id = excluded.last_logged_action_id`,
  ).run(n);
}

function ensureFplTransferLogState(db: Database.Database, maxActionId: number): void {
  const existing = db
    .prepare(`SELECT last_logged_action_id FROM fpl_transfer_bot_state WHERE id = 1`)
    .get() as { last_logged_action_id: number } | undefined;
  if (existing) return;
  setLastLoggedTransferActionId(db, maxActionId);
  console.log(
    `[fpl-bot] transfer-log state seeded last_logged_action_id=${maxActionId}`,
  );
}

function lastNotifiedTransferKey(
  db: Database.Database,
  telegramUserId: number,
): string {
  const row = db
    .prepare(
      `SELECT last_turn_key FROM fpl_transfer_notify_state WHERE telegram_user_id = ?`,
    )
    .get(telegramUserId) as { last_turn_key: string } | undefined;
  return row?.last_turn_key ?? "";
}

function markTransferNotified(
  db: Database.Database,
  telegramUserId: number,
  turnKey: string,
): void {
  db.prepare(
    `INSERT INTO fpl_transfer_notify_state (telegram_user_id, last_turn_key)
     VALUES (?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET
       last_turn_key = excluded.last_turn_key`,
  ).run(telegramUserId, turnKey);
}

function parseMinutesJson(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
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
         FROM fpl_deadline_reminders WHERE telegram_user_id = ?`,
      )
      .get(telegramUserId) as DeadlineReminderRow | undefined) ?? null
  );
}

function listEnabledDeadlineReminders(db: Database.Database): DeadlineReminderRow[] {
  return db
    .prepare(
      `SELECT telegram_user_id, chat_id, minutes_json, last_sent_gw,
              last_sent_offsets_json, enabled
       FROM fpl_deadline_reminders WHERE enabled = 1`,
    )
    .all() as DeadlineReminderRow[];
}

function upsertDeadlineReminder(
  db: Database.Database,
  opts: { telegramUserId: number; chatId: number; minutes: number[] },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO fpl_deadline_reminders
       (telegram_user_id, chat_id, minutes_json, last_sent_gw,
        last_sent_offsets_json, enabled, created_at, updated_at)
     VALUES (?, ?, ?, NULL, '[]', 1, ?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET
       chat_id = excluded.chat_id,
       minutes_json = excluded.minutes_json,
       enabled = 1,
       updated_at = excluded.updated_at`,
  ).run(opts.telegramUserId, opts.chatId, JSON.stringify(opts.minutes), now, now);
}

function disableDeadlineReminder(db: Database.Database, telegramUserId: number): void {
  db.prepare(
    `UPDATE fpl_deadline_reminders
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
    `UPDATE fpl_deadline_reminders
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

export function formatFplDeadlineReminderText(opts: {
  gw: number;
  deadlineIso: string;
  teamName: string;
}): string {
  const when = formatWarsawDeadline(opts.deadlineIso);
  const name = opts.teamName.trim() || "FPL";
  return [
    "DILDLINE IS COMING",
    "",
    `FPL GW${opts.gw} · ${when}`,
    `«${name}»`,
    LINEUP_URL,
  ].join("\n");
}

function formatMinutesList(minutes: number[]): string {
  return minutes.join(", ");
}

function deadlineStatusLine(deadline: FplDeadline | null | undefined): string {
  if (!deadline?.deadline_time) {
    return "Дедлайн пока неизвестен.";
  }
  return `Следующий дедлайн: GW${deadline.gw} · ${formatWarsawDeadline(deadline.deadline_time)} (Warsaw)`;
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

function memberTeamName(snap: FplSnapshot | null, email: string): string | null {
  if (!snap) return null;
  const needle = email.toLowerCase();
  return snap.members.find((m) => m.email.toLowerCase() === needle)?.teamName ?? null;
}

function snapshotDeadline(snap: FplSnapshot | null): FplDeadline | null {
  if (!snap?.deadline?.deadline_time) return null;
  const ms = Date.parse(snap.deadline.deadline_time);
  if (!Number.isFinite(ms)) return null;
  return snap.deadline;
}

async function fetchSnapshotOrNull(): Promise<FplSnapshot | null> {
  try {
    return await fetchSnapshot();
  } catch {
    return null;
  }
}

/** Seed cursor to current max so first deploy does not backfill-spam old picks. */
function ensureFplPickLogState(db: Database.Database, maxPick: number): void {
  const existing = db
    .prepare(`SELECT last_logged_pick_no FROM fpl_bot_state WHERE id = 1`)
    .get() as { last_logged_pick_no: number } | undefined;
  if (existing) return;
  setLastLoggedPickNo(db, maxPick);
  console.log(`[fpl-bot] pick-log state seeded last_logged_pick_no=${maxPick}`);
}

function logCoverage(snap: FplSnapshot, db: Database.Database): void {
  if (coverageLogged) return;
  coverageLogged = true;
  const known = allKnownEmails(db);
  const mapped: string[] = [];
  const missing: string[] = [];
  for (const m of snap.members) {
    const email = m.email.toLowerCase();
    if (!email) {
      missing.push(`${m.teamName} (no email)`);
      continue;
    }
    if (known.has(email)) mapped.push(`${email} «${m.teamName}»`);
    else missing.push(`${email} «${m.teamName}»`);
  }
  console.log(`[fpl-bot] email→telegram mapped (${mapped.length}): ${mapped.join("; ") || "—"}`);
  if (missing.length) {
    console.warn(
      `[fpl-bot] email→telegram MISSING (${missing.length}): ${missing.join("; ")} — /fpl email@x.com`,
    );
  }
}

export function fplHelpLine(): string {
  return "/fpl — email · /fpldeadline — дедлайн состава";
}

export async function handleFplMessage(
  db: Database.Database,
  api: FplTelegramApi,
  msg: TgMessage,
  text: string,
): Promise<boolean> {
  const from = msg.from;
  if (!from) return false;
  const userId = from.id;
  const chatId = msg.chat.id;
  const raw = text.trim();
  const parts = raw.split(/\s+/);
  const cmd = (parts[0] ?? "").toLowerCase().replace(/@\w+$/, "");

  const pending = pendingFpl.get(userId);
  if (pending && Date.now() - pending.at > PENDING_TTL_MS) {
    pendingFpl.delete(userId);
  }
  const deadlinePending = pendingFplDeadline.get(userId);
  if (deadlinePending && Date.now() - deadlinePending.at > PENDING_TTL_MS) {
    pendingFplDeadline.delete(userId);
  }

  if (cmd === "/start" || cmd === "/help") {
    pendingFpl.delete(userId);
    pendingFplDeadline.delete(userId);
    return false;
  }

  if (cmd === "/testfpl") {
    pendingFpl.delete(userId);
    pendingFplDeadline.delete(userId);
    const links = linksForEmailFromUser(db, userId);
    if (!links.length) {
      await api.sendMessage(chatId, "Сначала привяжи email: /fpl you@email.com");
      return true;
    }
    const team = links[0]!.email;
    await api.sendMessage(chatId, formatFplPingMessage(team));
    return true;
  }

  if (cmd === "/testfpllog") {
    pendingFpl.delete(userId);
    pendingFplDeadline.delete(userId);
    const links = linksForEmailFromUser(db, userId);
    if (!links.length) {
      await api.sendMessage(chatId, "Сначала привяжи email: /fpl you@email.com");
      return true;
    }
    if (!api.fplPickLogReady()) {
      await api.sendMessage(
        chatId,
        "Лог пиков FPL ещё не настроен (бот не смог достучаться до топика).",
      );
      return true;
    }
    try {
      await api.sendFplPickLog(
        formatFplPickLog(
          {
            pickNumber: 1,
            round: 1,
            auto: false,
            teamName: "тест",
            email: links[0]!.email,
            playerName: "Haaland",
            position: "FWD",
            clubShort: "MCI",
            clubName: "Manchester City",
          },
          formatNextUpLine(
            { email: links[0]!.email, teamName: "тест", outOfDraft: false },
            links[0]!,
          ),
        ),
      );
      await api.sendMessage(chatId, "Ок — тестовый лог FPL отправлен в топик.");
    } catch (err) {
      const msgText = err instanceof Error ? err.message : String(err);
      await api.sendMessage(chatId, `Не удалось отправить в лог FPL: ${msgText}`);
    }
    return true;
  }

  if (
    cmd === "/testfpldeadline" ||
    (cmd === "/testdeadline" &&
      !hasTop4Link(db, userId) &&
      linksForEmailFromUser(db, userId).length > 0)
  ) {
    pendingFpl.delete(userId);
    pendingFplDeadline.delete(userId);
    const links = linksForEmailFromUser(db, userId);
    if (!links.length) {
      await api.sendMessage(chatId, "Сначала привяжи email: /fpl you@email.com");
      return true;
    }
    const snap = await fetchSnapshotOrNull();
    const deadline = snapshotDeadline(snap);
    const teamName =
      memberTeamName(snap, links[0]!.email) ?? links[0]!.email;
    if (!deadline) {
      await api.sendMessage(
        chatId,
        `${deadlineStatusLine(null)}\nПример:\n\n${formatFplDeadlineReminderText({
          gw: 1,
          deadlineIso: "2026-08-16T14:00:00.000Z",
          teamName,
        })}`,
      );
      return true;
    }
    await api.sendMessage(
      chatId,
      formatFplDeadlineReminderText({
        gw: deadline.gw,
        deadlineIso: deadline.deadline_time,
        teamName,
      }),
    );
    return true;
  }

  if (
    cmd === "/fpldeadline" ||
    cmd === "/fpldildline" ||
    ((cmd === "/deadline" || cmd === "/dildline") &&
      !hasTop4Link(db, userId) &&
      linksForEmailFromUser(db, userId).length > 0)
  ) {
    pendingFpl.delete(userId);
    const links = linksForEmailFromUser(db, userId);
    if (!links.length) {
      pendingFplDeadline.delete(userId);
      await api.sendMessage(chatId, "Сначала привяжи email: /fpl you@email.com");
      return true;
    }
    const rest = parts.slice(1).join(" ").trim();
    if (isOffReply(rest)) {
      pendingFplDeadline.delete(userId);
      disableDeadlineReminder(db, userId);
      await api.sendMessage(
        chatId,
        "Напоминания о дедлайне FPL выключены. /fpldeadline — настроить снова.",
      );
      return true;
    }
    const existing = getDeadlineReminder(db, userId);
    const currentMins = existing ? parseMinutesJson(existing.minutes_json) : [];
    const currentLine = currentMins.length
      ? `Сейчас${existing && !existing.enabled ? " (выкл)" : ""}: ${currentMins.length}× — за ${formatMinutesList(currentMins)} мин.\n`
      : "";
    pendingFplDeadline.set(userId, {
      step: "count",
      count: 0,
      minutes: [],
      at: Date.now(),
    });
    const snap = await fetchSnapshotOrNull();
    const teamName =
      memberTeamName(snap, links[0]!.email) ?? links[0]!.email;
    await api.sendMessage(
      chatId,
      `Напоминания о дедлайне состава FPL «${teamName}».\n${currentLine}${deadlineStatusLine(snapshotDeadline(snap))}\n\nСколько напоминаний? Ответь 1, 2 или 3.\nПотом укажешь минуты до дедлайна для каждого (например 1440, 60, 15).\n/fpldeadline off — выключить.`,
    );
    return true;
  }

  if (cmd === "/fpl") {
    pendingFplDeadline.delete(userId);
    const emailArg = parts[1]?.trim();
    if (emailArg?.includes("@")) {
      upsertFplLink(db, {
        telegramUserId: userId,
        chatId,
        email: emailArg,
      });
      pendingFpl.delete(userId);
      await api.sendMessage(
        chatId,
        `FPL: привязан ${emailArg.toLowerCase()}.\nБуду писать, когда твой ход.\nДедлайн состава: /fpldeadline\n${DRAFT_URL}`,
      );
      return true;
    }

    const existing =
      getFplLink(db, userId) ?? linksForEmailFromUser(db, userId)[0] ?? null;
    if (existing) {
      await api.sendMessage(
        chatId,
        `FPL уже привязан: ${existing.email}\n/fpl you@email.com — сменить.\n/fpldeadline — напоминания дедлайна.\n${DRAFT_URL}`,
      );
      return true;
    }

    pendingFpl.set(userId, { at: Date.now() });
    await api.sendMessage(
      chatId,
      "FPL 2026: пришли email аккаунта panenka.games, или:\n/fpl you@email.com",
    );
    return true;
  }

  const liveDeadline = pendingFplDeadline.get(userId);
  if (liveDeadline) {
    const links = linksForEmailFromUser(db, userId);
    if (!links.length) {
      pendingFplDeadline.delete(userId);
      await api.sendMessage(chatId, "Сначала привяжи email: /fpl you@email.com");
      return true;
    }
    if (cmd.startsWith("/") && cmd !== "/fpldeadline" && cmd !== "/fpldildline") {
      pendingFplDeadline.delete(userId);
      return false;
    }
    if (isOffReply(raw)) {
      pendingFplDeadline.delete(userId);
      disableDeadlineReminder(db, userId);
      await api.sendMessage(
        chatId,
        "Напоминания о дедлайне FPL выключены. /fpldeadline — настроить снова.",
      );
      return true;
    }
    if (liveDeadline.step === "count") {
      const count = parseCountReply(raw);
      if (count == null) {
        await api.sendMessage(chatId, "Нужно число 1, 2 или 3. Или /fpldeadline off.");
        return true;
      }
      pendingFplDeadline.set(userId, {
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
    const minutes = parseMinutesReply(raw);
    if (minutes == null) {
      await api.sendMessage(
        chatId,
        `Нужно целое число минут от 1 до ${DEADLINE_MAX_MINUTES} (например 60).`,
      );
      return true;
    }
    if (liveDeadline.minutes.includes(minutes)) {
      await api.sendMessage(
        chatId,
        `Уже есть напоминание за ${minutes} мин. Укажи другое число минут.`,
      );
      return true;
    }
    const nextMinutes = [...liveDeadline.minutes, minutes];
    if (nextMinutes.length < liveDeadline.count) {
      pendingFplDeadline.set(userId, {
        step: "minutes",
        count: liveDeadline.count,
        minutes: nextMinutes,
        at: Date.now(),
      });
      await api.sendMessage(
        chatId,
        `За сколько минут до дедлайна прислать напоминание ${nextMinutes.length + 1}/${liveDeadline.count}?\nУже задано: ${formatMinutesList(nextMinutes)}. Минуты должны быть разными.`,
      );
      return true;
    }
    const stored = nextMinutes.slice().sort((a, b) => b - a);
    upsertDeadlineReminder(db, {
      telegramUserId: userId,
      chatId,
      minutes: stored,
    });
    pendingFplDeadline.delete(userId);
    const snap = await fetchSnapshotOrNull();
    await api.sendMessage(
      chatId,
      `Готово: ${stored.length} напоминани${stored.length === 1 ? "е" : "я"} за ${formatMinutesList(stored)} мин до дедлайна FPL.\n${deadlineStatusLine(snapshotDeadline(snap))}\nТекст: «DILDLINE IS COMING».`,
    );
    return true;
  }

  if (pendingFpl.has(userId)) {
    if (raw === "0" || cmd.startsWith("/")) {
      if (cmd.startsWith("/") && cmd !== "/fpl") {
        pendingFpl.delete(userId);
        return false;
      }
      pendingFpl.delete(userId);
      await api.sendMessage(chatId, "Отменено.");
      return true;
    }
    if (!raw.includes("@")) {
      await api.sendMessage(chatId, "Нужен email, например name@gmail.com (или 0 = отмена)");
      return true;
    }
    upsertFplLink(db, { telegramUserId: userId, chatId, email: raw });
    pendingFpl.delete(userId);
    await api.sendMessage(
      chatId,
      `FPL: привязан ${raw.toLowerCase()}.\nДедлайн состава: /fpldeadline\n${DRAFT_URL}`,
    );
    return true;
  }

  return false;
}

function linksForEmailFromUser(db: Database.Database, telegramUserId: number): Link[] {
  const fpl = getFplLink(db, telegramUserId);
  if (fpl) return [fpl];
  for (const table of ["top4_telegram_links", "h2h_telegram_links"]) {
    try {
      const row = db
        .prepare(
          `SELECT telegram_user_id, chat_id, email FROM ${table}
           WHERE telegram_user_id = ?`,
        )
        .get(telegramUserId) as Link | undefined;
      if (row) return [row];
    } catch {
      /* ignore */
    }
  }
  return [];
}

function hasTop4Link(db: Database.Database, telegramUserId: number): boolean {
  try {
    const row = db
      .prepare(`SELECT 1 FROM top4_telegram_links WHERE telegram_user_id = ?`)
      .get(telegramUserId);
    return Boolean(row);
  } catch {
    return false;
  }
}

export async function checkFplDraft(
  db: Database.Database,
  api: FplTelegramApi,
): Promise<void> {
  if (!botSecret()) return;

  let snap: FplSnapshot;
  try {
    snap = await fetchSnapshot();
  } catch (err) {
    console.error(
      "[fpl-bot] snapshot:",
      err instanceof Error ? err.message : err,
    );
    return;
  }

  ensureFplPickLogState(db, snap.maxPickNumber);
  logCoverage(snap, db);

  if (api.fplPickLogReady()) {
    let last = getLastLoggedPickNo(db);
    if (snap.maxPickNumber < last) {
      setLastLoggedPickNo(db, snap.maxPickNumber);
      last = snap.maxPickNumber;
      console.log(`[fpl-bot] pick-log cursor reset to ${last} (draft reset?)`);
    }
    const fresh = snap.picks.filter((p) => p.pickNumber > last);
    for (const pick of fresh) {
      try {
        const next = nextUpAfterPick(pick, snap);
        let nextLine: string | undefined;
        if (next === "done") {
          nextLine = "Драфт завершён";
        } else if (next) {
          const link = linksForEmail(db, next.email)[0] ?? null;
          nextLine = formatNextUpLine(next, link);
        }
        await api.sendFplPickLog(formatFplPickLog(pick, nextLine));
        setLastLoggedPickNo(db, pick.pickNumber);
        console.log(
          `[fpl-bot] pick-log #${pick.pickNumber} team=${pick.teamName} auto=${pick.auto}`,
        );
      } catch (err) {
        console.error(
          `[fpl-bot] pick-log send failed #${pick.pickNumber}:`,
          err instanceof Error ? err.message : err,
        );
        break;
      }
    }
  }

  const onClock = snap.onClock;
  if (snap.status === "drafting" && onClock && !onClock.outOfDraft) {
    if (!onClock.email) {
      console.warn(`[fpl-bot] on-clock has no email team=${onClock.teamName}`);
    } else {
      const links = linksForEmail(db, onClock.email);
      for (const link of links) {
        if (lastNotifiedPickNo(db, link.telegram_user_id) === onClock.pickNo) {
          continue;
        }
        try {
          await api.sendMessage(link.chat_id, formatFplPingMessage(onClock.teamName));
          markNotified(db, link.telegram_user_id, onClock.pickNo);
          console.log(
            `[fpl-bot] notified user=${link.telegram_user_id} team=${onClock.teamName} pick=#${onClock.pickNo}`,
          );
        } catch (err) {
          console.error(
            `[fpl-bot] send failed user=${link.telegram_user_id}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
  }

  await checkFplTransferWindow(db, api, snap);

  await checkFplDeadlineReminders(db, api, snap);
}

async function checkFplTransferWindow(
  db: Database.Database,
  api: FplTelegramApi,
  snap: FplSnapshot,
): Promise<void> {
  const win = snap.transferWindow ?? null;
  const actions = win?.actions ?? [];
  const maxActionId = actions.reduce((m, a) => Math.max(m, a.id), 0);
  ensureFplTransferLogState(db, maxActionId);

  if (api.fplPickLogReady() && win) {
    let last = getLastLoggedTransferActionId(db);
    if (maxActionId < last) {
      setLastLoggedTransferActionId(db, maxActionId);
      last = maxActionId;
      console.log(`[fpl-bot] transfer-log cursor reset to ${last}`);
    }
    const fresh = actions.filter((a) => a.id > last);
    const latestId = actions.length > 0 ? actions[actions.length - 1]!.id : 0;
    for (const action of fresh) {
      try {
        let nextLine: string | undefined;
        if (action.id === latestId) {
          if (win.onClock) {
            const link = linksForEmail(db, win.onClock.email)[0] ?? null;
            nextLine = formatNextUpLine(
              {
                email: win.onClock.email,
                teamName: win.onClock.teamName,
                outOfDraft: false,
              },
              link,
            );
          } else {
            nextLine = "Все проходы в этом окне завершены";
          }
        }
        await api.sendFplPickLog(
          formatFplTransferLog(action, win.totalPasses, nextLine),
        );
        setLastLoggedTransferActionId(db, action.id);
        console.log(
          `[fpl-bot] transfer-log ${action.kind} #${action.id} team=${action.teamName}`,
        );
      } catch (err) {
        console.error(
          `[fpl-bot] transfer-log send failed #${action.id}:`,
          err instanceof Error ? err.message : err,
        );
        break;
      }
    }
  }

  const onClock = win?.onClock ?? null;
  if (snap.status === "running" && onClock) {
    if (!onClock.email) {
      console.warn(`[fpl-bot] transfer on-clock has no email team=${onClock.teamName}`);
      return;
    }
    const links = linksForEmail(db, onClock.email);
    for (const link of links) {
      if (lastNotifiedTransferKey(db, link.telegram_user_id) === onClock.turnKey) {
        continue;
      }
      try {
        await api.sendMessage(
          link.chat_id,
          formatFplTransferPingMessage(onClock.teamName),
        );
        markTransferNotified(db, link.telegram_user_id, onClock.turnKey);
        console.log(
          `[fpl-bot] transfer notified user=${link.telegram_user_id} team=${onClock.teamName} key=${onClock.turnKey}`,
        );
      } catch (err) {
        console.error(
          `[fpl-bot] transfer send failed user=${link.telegram_user_id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
}

async function checkFplDeadlineReminders(
  db: Database.Database,
  api: FplTelegramApi,
  snap: FplSnapshot,
): Promise<void> {
  const deadline = snapshotDeadline(snap);
  if (!deadline) return;
  const deadlineMs = Date.parse(deadline.deadline_time);
  if (!Number.isFinite(deadlineMs)) return;

  const rows = listEnabledDeadlineReminders(db);
  if (!rows.length) return;

  const nowMs = Date.now();
  if (nowMs >= deadlineMs) return;

  for (const row of rows) {
    const minutes = parseMinutesJson(row.minutes_json);
    if (!minutes.length) continue;
    const link =
      getFplLink(db, row.telegram_user_id) ??
      linksForEmailFromUser(db, row.telegram_user_id)[0] ??
      null;
    if (!link) continue;
    const teamName = memberTeamName(snap, link.email);
    if (!teamName) continue;

    const sent =
      row.last_sent_gw === deadline.gw
        ? parseMinutesJson(row.last_sent_offsets_json)
        : [];

    for (const offset of minutes) {
      if (sent.includes(offset)) continue;
      const fireAt = deadlineMs - offset * 60_000;
      if (nowMs < fireAt) continue;
      const text = formatFplDeadlineReminderText({
        gw: deadline.gw,
        deadlineIso: deadline.deadline_time,
        teamName,
      });
      try {
        await api.sendMessage(row.chat_id || link.chat_id, text);
        markDeadlineSent(db, row.telegram_user_id, deadline.gw, offset);
        sent.push(offset);
        console.log(
          `[fpl-bot] deadline reminder user=${row.telegram_user_id} team=${teamName} gw=${deadline.gw} offset=${offset}m`,
        );
      } catch (err) {
        console.error(
          `[fpl-bot] deadline send failed user=${row.telegram_user_id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
}
