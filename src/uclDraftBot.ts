/**
 * Liga prvaka (UEFA ЛЧ 2026/27) notifications on the Din8sty Telegram bot.
 *
 * Topic log → https://t.me/c/2419087266/4 (UCL_PICK_LOG_CHAT_ID / _THREAD_ID):
 *   draft start / finish, pick log, transfer-window open, transfer log,
 *   league-wide matchday deadline announcement.
 * DMs → turn pings (draft + transfer) and personal deadline reminders.
 * Email mapping: ucl_telegram_links ∪ fpl_telegram_links ∪ top4_telegram_links
 * ∪ h2h_telegram_links — a manager bound for any league is reachable here.
 *
 * Turn pings say nothing about clocks: this league drafts without a pick timer
 * or autopick, and the copy must not promise a countdown it cannot honour.
 *
 * /ucl (/lch) — bind panenka email
 * /testucl — sample turn ping
 * /testucllog — sample pick log to the UCL topic
 * /ucldeadline (/ucldildline, /lchdeadline) — matchday reminders (1–3 offsets)
 * /ucldeadline off — disable
 * /testucldeadline — sample deadline reminder
 */
import type Database from "better-sqlite3";

const DRAFT_URL = "https://fantasy.panenka.games/liga-prvaka/draft";
const MATCHDAY_URL = "https://fantasy.panenka.games/liga-prvaka/matchday";
const TRANSFERS_URL = "https://fantasy.panenka.games/liga-prvaka/transfers";
const PENDING_TTL_MS = 15 * 60_000;
const WARSAW_TZ = "Europe/Warsaw";
const DEADLINE_MAX_MINUTES = 14 * 24 * 60;
/** League-wide heads-up in the topic, once per matchday. */
const TOPIC_DEADLINE_LEAD_MINUTES = 24 * 60;

type TgUser = { id: number; username?: string; first_name?: string };
type TgChat = { id: number; type: string };
type TgMessage = {
  message_id: number;
  date: number;
  text?: string;
  chat: TgChat;
  from?: TgUser;
};

export type UclTelegramApi = {
  sendMessage: (chatId: number, text: string) => Promise<{ message_id: number }>;
  sendUclLog: (text: string) => Promise<{ message_id: number }>;
  uclLogReady: () => boolean;
};

type Link = {
  telegram_user_id: number;
  chat_id: number;
  email: string;
  tg_username?: string | null;
};

type UclPick = {
  id: number;
  pickNumber: number;
  round: number;
  skipped: boolean;
  auto: boolean;
  teamName: string;
  email: string;
  playerName: string | null;
  position: string | null;
  clubShort: string | null;
  clubName: string | null;
};

type UclMember = {
  email: string;
  teamName: string;
  displayName: string;
  draftSlot?: number | null;
};

type UclOnClock = {
  email: string;
  teamName: string;
  displayName: string;
  pickNo: number;
  round: number;
  redeeming: boolean;
  picksLeft: number;
};

type UclDeadline = {
  matchday: number;
  round: string;
  deadline_time: string;
};

type UclTransferAction = {
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

type UclTransferOnClock = {
  email: string;
  teamName: string;
  displayName: string;
  memberId: number;
  pass: number;
  turnKey: string;
};

type UclTransferWindowSnap = {
  windowId: string;
  matchday: number;
  opensAt: string;
  closesAt: string;
  transfersAllowed: number;
  pass: number;
  totalPasses: number;
  onClock: UclTransferOnClock | null;
  actions: UclTransferAction[];
};

type UclSnapshot = {
  ok?: boolean;
  error?: string;
  status: string;
  managers: number;
  size: number;
  currentPickNo: number;
  totalPicks: number;
  draftFinished: boolean;
  maxPickId: number;
  onClock: UclOnClock | null;
  picks: UclPick[];
  members: UclMember[];
  deadline?: UclDeadline | null;
  transferWindow?: UclTransferWindowSnap | null;
};

type DeadlineReminderRow = {
  telegram_user_id: number;
  chat_id: number;
  minutes_json: string;
  last_sent_matchday: number | null;
  last_sent_offsets_json: string;
  enabled: number;
};

const pendingUcl = new Map<number, { at: number }>();
const pendingUclDeadline = new Map<
  number,
  { step: "count" | "minutes"; count: number; minutes: number[]; at: number }
>();
let coverageLogged = false;

/**
 * Никаких таймеров и автопиков: в ЛЧ ход ждёт менеджера столько, сколько
 * нужно. Поэтому фразы торопят, но ничем не угрожают.
 */
const PING_PHRASES = [
  "Ваш выход, маэстро! Лига чемпионов ждёт твой пик.",
  "Огласите весь список, пожалуйста! Начни со своего пика.",
  "Йес! Твоя очередь в драфте ЛЧ — забирай, кого присмотрел.",
  "Птичку жалко… а хорошего игрока — упустить ещё жальче. Твой ход!",
  "Наши люди в булочную на такси не ездят. А на драфт — уже пора.",
  "Муля, не нервируй меня — просто сделай пик.",
  "Тепловоз! Твой слот открыт, вагон игроков подан.",
  "Éto vsyo? Нет, это твой ход в Лиге чемпионов. Выбирай.",
  "Studenti, komsomolci, prosto krasavtsy — и все ждут твоего пика.",
  "Свободу попугаям! И одного игрока — себе в ростер.",
  "Такова селяви. А селяви сейчас такова: твой ход в драфте ЛЧ.",
  "Шампанское по утрам пьют или аристократы, или те, кто уже пикнул.",
  "Гони гусей! То есть — выбирай игрока, очередь твоя.",
  "Ку! В Лиге чемпионов твой ход, пацак.",
  "Лёгким движением руки ростер превращается… в чемпионский. Пикай!",
] as const;

function pickPingPhrase(): string {
  return PING_PHRASES[Math.floor(Math.random() * PING_PHRASES.length)]!;
}

export function formatUclPingMessage(opts: {
  teamName?: string | null;
  pickNo?: number;
  round?: number;
  redeeming?: boolean;
  picksLeft?: number;
}): string {
  const phrase = pickPingPhrase();
  const team = opts.teamName?.trim();
  const context = team
    ? `Твоя очередь в драфте Лиги чемпионов — «${team}»`
    : "Твоя очередь в драфте Лиги чемпионов";
  const lines = [phrase, "", context];
  if (opts.pickNo && opts.round) {
    lines.push(
      `Пик #${opts.pickNo} · раунд ${opts.round}${opts.redeeming ? " · отложенный слот" : ""}`,
    );
  }
  if (opts.picksLeft && opts.picksLeft > 1) {
    lines.push(`Подряд твоих пиков: ${opts.picksLeft}`);
  }
  lines.push(DRAFT_URL);
  return lines.join("\n");
}

export function formatUclTransferPingMessage(opts: {
  teamName?: string | null;
  matchday?: number;
  pass?: number;
  totalPasses?: number;
}): string {
  const phrase = pickPingPhrase();
  const team = opts.teamName?.trim();
  const context = team
    ? `Твоя очередь на трансфер в Лиге чемпионов — «${team}»`
    : "Твоя очередь на трансфер в Лиге чемпионов";
  const lines = [phrase, "", context];
  if (opts.matchday) lines.push(`Окно перед ${opts.matchday} туром`);
  if (opts.pass && opts.totalPasses) {
    lines.push(`Проход ${opts.pass} из ${opts.totalPasses}`);
  }
  lines.push(TRANSFERS_URL);
  return lines.join("\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function ruCount(n: number, one: string, few: string, many: string): string {
  const mod10 = Math.abs(n) % 10;
  const mod100 = Math.abs(n) % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}

type NextUp = { email: string; teamName: string };

/** HTML pick-log tail. Tag the manager if this email is bound to a Telegram user. */
export function formatUclNextUpLine(next: NextUp, link: Link | null): string {
  const label = `«${escapeHtml(next.teamName)}»`;
  const uname = link?.tg_username?.replace(/^@/, "").trim();
  if (uname) return `Следующий: @${escapeHtml(uname)} ${label}`;
  if (link) {
    return `Следующий: <a href="tg://user?id=${link.telegram_user_id}">${label}</a>`;
  }
  return `Следующий: ${label}`;
}

export function formatUclPickLog(pick: UclPick, nextLine?: string): string {
  const lines: string[] = [];
  if (pick.skipped) {
    lines.push(
      `⏭ Пропуск · пик #${pick.pickNumber} · раунд ${pick.round}`,
      `«${escapeHtml(pick.teamName)}» откладывает слот`,
    );
  } else {
    const club = escapeHtml(pick.clubShort || pick.clubName || "?");
    lines.push(
      `🎯 Пик #${pick.pickNumber} · раунд ${pick.round}`,
      `«${escapeHtml(pick.teamName)}» выбирает:`,
      `${escapeHtml(pick.playerName || "?")} · ${escapeHtml(pick.position || "?")} · ${club}`,
    );
  }
  if (nextLine) lines.push(nextLine);
  return lines.join("\n");
}

export function formatUclDraftStart(managers: number, totalPicks: number): string {
  return [
    "🏆 Драфт Лиги чемпионов начался",
    `${ruCount(managers, "менеджер", "менеджера", "менеджеров")} · ${totalPicks} пиков · снейк по 25 раундов`,
    "Ростер 25: GK 3 / DEF 8 / MID 9 / FWD 5, не больше одного игрока из клуба",
    DRAFT_URL,
  ].join("\n");
}

export function formatUclDraftFinish(): string {
  return [
    "🏁 Драфт Лиги чемпионов завершён",
    "Все ростеры собраны. Дальше — туры и трансферные окна.",
    MATCHDAY_URL,
  ].join("\n");
}

export function formatUclTransferWindowOpen(opts: {
  matchday: number;
  transfersAllowed: number;
  pass: number;
  totalPasses: number;
  closesAt?: string;
  nextLine?: string;
}): string {
  const lines = [
    `🔁 Трансферное окно перед ${opts.matchday} туром открыто`,
    `${ruCount(opts.transfersAllowed, "замена", "замены", "замен")} на менеджера`,
    "Порядок: с последнего места в таблице к лидеру",
    `Проход ${opts.pass} из ${opts.totalPasses}`,
  ];
  if (opts.closesAt) {
    lines.push(`Закрывается ${formatWarsawStamp(opts.closesAt)} (Warsaw)`);
  }
  if (opts.nextLine) lines.push(opts.nextLine);
  lines.push(TRANSFERS_URL);
  return lines.join("\n");
}

export function formatUclTransferLog(
  action: UclTransferAction,
  totalPasses: number,
  nextLine?: string,
): string {
  const pass = `Проход ${action.pass} из ${totalPasses}`;
  if (action.kind === "skip") {
    const lines = [
      `⏭ Пропуск · ${pass}`,
      `«${escapeHtml(action.teamName)}» пропускает трансфер`,
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

/** League-wide heads-up in the topic — no team name, no personal settings. */
export function formatUclTopicDeadline(deadline: UclDeadline): string {
  return [
    `⏰ ${deadline.matchday} тур Лиги чемпионов начинается`,
    `${formatWarsawStamp(deadline.deadline_time)} (Warsaw) — первый свисток`,
    "Трансферное окно к этому туру уже закрыто.",
    MATCHDAY_URL,
  ].join("\n");
}

function formatWarsawStamp(iso: string): string {
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
  if (!day || !month) return iso;
  return `${day}.${month} ${String(get("hour")).padStart(2, "0")}:${String(get("minute")).padStart(2, "0")}`;
}

export function formatUclDeadlineReminderText(opts: {
  matchday: number;
  deadlineIso: string;
  teamName: string;
}): string {
  return [
    "DILDLINE IS COMING",
    "",
    `Лига чемпионов · ${opts.matchday} тур · ${formatWarsawStamp(opts.deadlineIso)}`,
    `«${opts.teamName.trim() || "ЛЧ"}»`,
    MATCHDAY_URL,
  ].join("\n");
}

/**
 * Which configured offsets are due now. Pure so the scheduling rule can be
 * pinned by a test: fire once per (matchday, offset), never after kickoff.
 */
export function dueUclDeadlineOffsets(opts: {
  minutes: number[];
  alreadySent: number[];
  deadlineMs: number;
  nowMs: number;
}): number[] {
  if (!Number.isFinite(opts.deadlineMs) || opts.nowMs >= opts.deadlineMs) return [];
  const sent = new Set(opts.alreadySent);
  return opts.minutes
    .filter((m) => Number.isInteger(m) && m > 0)
    .filter((m) => !sent.has(m))
    .filter((m) => opts.nowMs >= opts.deadlineMs - m * 60_000)
    .sort((a, b) => b - a);
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

async function fetchSnapshot(): Promise<UclSnapshot> {
  const secret = botSecret();
  if (!secret) throw new Error("H2H_BOT_SECRET missing");
  const url = new URL("/api/liga-prvaka/bot", panenkaOrigin());
  const res = await fetch(url, {
    headers: { "X-H2H-Bot-Secret": secret },
    cache: "no-store",
  });
  const data = (await res.json()) as UclSnapshot;
  if (!res.ok || data.ok === false) {
    throw new Error(String(data.error ?? `HTTP ${res.status}`));
  }
  return data;
}

async function fetchSnapshotOrNull(): Promise<UclSnapshot | null> {
  try {
    return await fetchSnapshot();
  } catch {
    return null;
  }
}

export function ensureUclBotTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ucl_telegram_links (
      telegram_user_id INTEGER PRIMARY KEY,
      chat_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      tg_username TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ucl_telegram_links_email
      ON ucl_telegram_links (email);
    CREATE TABLE IF NOT EXISTS ucl_bot_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_logged_pick_id INTEGER NOT NULL DEFAULT 0,
      last_logged_action_id INTEGER NOT NULL DEFAULT 0,
      last_logged_window_id TEXT NOT NULL DEFAULT '',
      announced_status TEXT NOT NULL DEFAULT '',
      announced_deadline_matchday INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS ucl_notify_state (
      telegram_user_id INTEGER PRIMARY KEY,
      last_notified_pick_no INTEGER NOT NULL DEFAULT 0,
      last_turn_key TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS ucl_deadline_reminders (
      telegram_user_id INTEGER PRIMARY KEY,
      chat_id INTEGER NOT NULL,
      minutes_json TEXT NOT NULL,
      last_sent_matchday INTEGER,
      last_sent_offsets_json TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

type UclBotState = {
  last_logged_pick_id: number;
  last_logged_action_id: number;
  last_logged_window_id: string;
  announced_status: string;
  announced_deadline_matchday: number;
};

const EMPTY_STATE: UclBotState = {
  last_logged_pick_id: 0,
  last_logged_action_id: 0,
  last_logged_window_id: "",
  announced_status: "",
  announced_deadline_matchday: 0,
};

function readState(db: Database.Database): UclBotState | null {
  return (
    (db
      .prepare(
        `SELECT last_logged_pick_id, last_logged_action_id, last_logged_window_id,
                announced_status, announced_deadline_matchday
         FROM ucl_bot_state WHERE id = 1`,
      )
      .get() as UclBotState | undefined) ?? null
  );
}

/** Seed cursors to the current max so the first deploy does not backfill-spam. */
function ensureState(db: Database.Database, snap: UclSnapshot): UclBotState {
  const existing = readState(db);
  if (existing) return existing;
  const maxActionId = (snap.transferWindow?.actions ?? []).reduce(
    (m, a) => Math.max(m, a.id),
    0,
  );
  const seeded: UclBotState = {
    ...EMPTY_STATE,
    last_logged_pick_id: snap.maxPickId,
    last_logged_action_id: maxActionId,
    last_logged_window_id: snap.transferWindow?.windowId ?? "",
    announced_status: snap.status,
    announced_deadline_matchday: snap.deadline?.matchday ?? 0,
  };
  db.prepare(
    `INSERT INTO ucl_bot_state
       (id, last_logged_pick_id, last_logged_action_id, last_logged_window_id,
        announced_status, announced_deadline_matchday)
     VALUES (1, ?, ?, ?, ?, ?)`,
  ).run(
    seeded.last_logged_pick_id,
    seeded.last_logged_action_id,
    seeded.last_logged_window_id,
    seeded.announced_status,
    seeded.announced_deadline_matchday,
  );
  console.log(
    `[ucl-bot] state seeded pick_id=${seeded.last_logged_pick_id} action_id=${seeded.last_logged_action_id} window=${seeded.last_logged_window_id || "—"} status=${seeded.announced_status}`,
  );
  return seeded;
}

function setState(
  db: Database.Database,
  patch: Partial<UclBotState>,
): void {
  const cols = Object.keys(patch);
  if (!cols.length) return;
  db.prepare(
    `UPDATE ucl_bot_state SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = 1`,
  ).run(...cols.map((c) => patch[c as keyof UclBotState] as never));
}

function getUclLink(db: Database.Database, telegramUserId: number): Link | null {
  return (
    (db
      .prepare(
        `SELECT telegram_user_id, chat_id, email, tg_username FROM ucl_telegram_links
         WHERE telegram_user_id = ?`,
      )
      .get(telegramUserId) as Link | undefined) ?? null
  );
}

function upsertUclLink(
  db: Database.Database,
  opts: {
    telegramUserId: number;
    chatId: number;
    email: string;
    tgUsername?: string | null;
  },
): void {
  const now = new Date().toISOString();
  const uname = opts.tgUsername?.replace(/^@/, "").trim() || null;
  db.prepare(
    `INSERT INTO ucl_telegram_links
       (telegram_user_id, chat_id, email, tg_username, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET
       chat_id = excluded.chat_id,
       email = excluded.email,
       tg_username = COALESCE(excluded.tg_username, ucl_telegram_links.tg_username),
       updated_at = excluded.updated_at`,
  ).run(opts.telegramUserId, opts.chatId, opts.email.toLowerCase(), uname, now, now);
}

const LINK_TABLES = [
  "ucl_telegram_links",
  "fpl_telegram_links",
  "top4_telegram_links",
  "h2h_telegram_links",
] as const;

function queryLinksByEmail(
  db: Database.Database,
  table: string,
  email: string,
): Link[] {
  try {
    return db
      .prepare(
        `SELECT telegram_user_id, chat_id, email, tg_username FROM ${table}
         WHERE email = ? COLLATE NOCASE`,
      )
      .all(email.toLowerCase()) as Link[];
  } catch {
    return db
      .prepare(
        `SELECT telegram_user_id, chat_id, email FROM ${table}
         WHERE email = ? COLLATE NOCASE`,
      )
      .all(email.toLowerCase()) as Link[];
  }
}

function tgUsernameOf(db: Database.Database, telegramUserId: number): string | null {
  for (const table of LINK_TABLES) {
    try {
      const row = db
        .prepare(`SELECT tg_username FROM ${table} WHERE telegram_user_id = ?`)
        .get(telegramUserId) as { tg_username: string | null } | undefined;
      const u = row?.tg_username?.replace(/^@/, "").trim();
      if (u) return u;
    } catch {
      /* column or table may not exist */
    }
  }
  return null;
}

/** Union of UCL / FPL / Top-4 / H2H binds for this email (unique telegram user). */
function linksForEmail(db: Database.Database, email: string): Link[] {
  if (!email) return [];
  const seen = new Set<number>();
  const out: Link[] = [];
  for (const table of LINK_TABLES) {
    let rows: Link[] = [];
    try {
      rows = queryLinksByEmail(db, table, email);
    } catch {
      continue;
    }
    for (const row of rows) {
      if (seen.has(row.telegram_user_id)) continue;
      seen.add(row.telegram_user_id);
      out.push({
        ...row,
        tg_username: row.tg_username || tgUsernameOf(db, row.telegram_user_id),
      });
    }
  }
  return out;
}

function linksForEmailFromUser(
  db: Database.Database,
  telegramUserId: number,
): Link[] {
  const ucl = getUclLink(db, telegramUserId);
  if (ucl) return [ucl];
  for (const table of LINK_TABLES.slice(1)) {
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

function allKnownEmails(db: Database.Database): Set<string> {
  const out = new Set<string>();
  for (const table of LINK_TABLES) {
    try {
      const rows = db.prepare(`SELECT email FROM ${table}`).all() as {
        email: string;
      }[];
      for (const r of rows) out.add(r.email.toLowerCase());
    } catch {
      /* table may not exist yet */
    }
  }
  return out;
}

function lastNotifiedPickNo(db: Database.Database, telegramUserId: number): number {
  const row = db
    .prepare(
      `SELECT last_notified_pick_no FROM ucl_notify_state WHERE telegram_user_id = ?`,
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
    `INSERT INTO ucl_notify_state (telegram_user_id, last_notified_pick_no)
     VALUES (?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET
       last_notified_pick_no = excluded.last_notified_pick_no`,
  ).run(telegramUserId, pickNo);
}

function lastNotifiedTransferKey(
  db: Database.Database,
  telegramUserId: number,
): string {
  const row = db
    .prepare(`SELECT last_turn_key FROM ucl_notify_state WHERE telegram_user_id = ?`)
    .get(telegramUserId) as { last_turn_key: string } | undefined;
  return row?.last_turn_key ?? "";
}

function markTransferNotified(
  db: Database.Database,
  telegramUserId: number,
  turnKey: string,
): void {
  db.prepare(
    `INSERT INTO ucl_notify_state (telegram_user_id, last_turn_key)
     VALUES (?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET
       last_turn_key = excluded.last_turn_key`,
  ).run(telegramUserId, turnKey);
}

function parseMinutesJson(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0);
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
        `SELECT telegram_user_id, chat_id, minutes_json, last_sent_matchday,
                last_sent_offsets_json, enabled
         FROM ucl_deadline_reminders WHERE telegram_user_id = ?`,
      )
      .get(telegramUserId) as DeadlineReminderRow | undefined) ?? null
  );
}

function listEnabledDeadlineReminders(db: Database.Database): DeadlineReminderRow[] {
  return db
    .prepare(
      `SELECT telegram_user_id, chat_id, minutes_json, last_sent_matchday,
              last_sent_offsets_json, enabled
       FROM ucl_deadline_reminders WHERE enabled = 1`,
    )
    .all() as DeadlineReminderRow[];
}

function upsertDeadlineReminder(
  db: Database.Database,
  opts: { telegramUserId: number; chatId: number; minutes: number[] },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO ucl_deadline_reminders
       (telegram_user_id, chat_id, minutes_json, last_sent_matchday,
        last_sent_offsets_json, enabled, created_at, updated_at)
     VALUES (?, ?, ?, NULL, '[]', 1, ?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET
       chat_id = excluded.chat_id,
       minutes_json = excluded.minutes_json,
       enabled = 1,
       updated_at = excluded.updated_at`,
  ).run(opts.telegramUserId, opts.chatId, JSON.stringify(opts.minutes), now, now);
}

function disableDeadlineReminder(
  db: Database.Database,
  telegramUserId: number,
): void {
  db.prepare(
    `UPDATE ucl_deadline_reminders SET enabled = 0, updated_at = ?
     WHERE telegram_user_id = ?`,
  ).run(new Date().toISOString(), telegramUserId);
}

function markDeadlineSent(
  db: Database.Database,
  telegramUserId: number,
  matchday: number,
  minutes: number,
): void {
  const row = getDeadlineReminder(db, telegramUserId);
  const sent =
    row && row.last_sent_matchday === matchday
      ? parseMinutesJson(row.last_sent_offsets_json)
      : [];
  if (!sent.includes(minutes)) sent.push(minutes);
  db.prepare(
    `UPDATE ucl_deadline_reminders
     SET last_sent_matchday = ?, last_sent_offsets_json = ?, updated_at = ?
     WHERE telegram_user_id = ?`,
  ).run(matchday, JSON.stringify(sent), new Date().toISOString(), telegramUserId);
}

function deadlineStatusLine(deadline: UclDeadline | null | undefined): string {
  if (!deadline?.deadline_time) {
    return "Ближайший тур пока не известен — сетка плей-офф ещё не жеребьёвана.";
  }
  return `Ближайший тур: ${deadline.matchday} · ${formatWarsawStamp(deadline.deadline_time)} (Warsaw)`;
}

function snapshotDeadline(snap: UclSnapshot | null): UclDeadline | null {
  if (!snap?.deadline?.deadline_time) return null;
  return Number.isFinite(Date.parse(snap.deadline.deadline_time))
    ? snap.deadline
    : null;
}

function memberTeamName(snap: UclSnapshot | null, email: string): string | null {
  if (!snap) return null;
  const needle = email.toLowerCase();
  return snap.members.find((m) => m.email.toLowerCase() === needle)?.teamName ?? null;
}

function parseCountReply(raw: string): number | null {
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 1 && n <= 3 ? n : null;
}

function parseMinutesReply(raw: string): number | null {
  const m = raw.trim().match(/^(\d+)\s*(?:мин|min|m)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 1 && n <= DEADLINE_MAX_MINUTES ? n : null;
}

function isOffReply(raw: string): boolean {
  const t = raw.trim().toLowerCase();
  return t === "off" || t === "стоп" || t === "выкл" || t === "выключить";
}

function logCoverage(snap: UclSnapshot, db: Database.Database): void {
  if (coverageLogged) return;
  coverageLogged = true;
  const known = allKnownEmails(db);
  const mapped: string[] = [];
  const missing: string[] = [];
  for (const m of snap.members) {
    const email = m.email.toLowerCase();
    if (!email) missing.push(`${m.teamName} (no email)`);
    else if (known.has(email)) mapped.push(`${email} «${m.teamName}»`);
    else missing.push(`${email} «${m.teamName}»`);
  }
  console.log(
    `[ucl-bot] email→telegram mapped (${mapped.length}): ${mapped.join("; ") || "—"}`,
  );
  if (missing.length) {
    console.warn(
      `[ucl-bot] email→telegram MISSING (${missing.length}): ${missing.join("; ")} — /ucl email@x.com`,
    );
  }
}

export function uclHelpLine(): string {
  return "/ucl — email · /ucldeadline — дедлайн тура";
}

/** `/lch…` is an accepted alias of `/ucl…` — «Liga prvaka» / ЛЧ. */
function normalizeUclCommand(cmd: string): string {
  return cmd.startsWith("/lch") ? `/ucl${cmd.slice(4)}` : cmd;
}

export async function handleUclMessage(
  db: Database.Database,
  api: UclTelegramApi,
  msg: TgMessage,
  text: string,
): Promise<boolean> {
  const from = msg.from;
  if (!from) return false;
  const userId = from.id;
  const chatId = msg.chat.id;
  const raw = text.trim();
  const parts = raw.split(/\s+/);
  const cmd = normalizeUclCommand(
    (parts[0] ?? "").toLowerCase().replace(/@\w+$/, ""),
  );

  const pending = pendingUcl.get(userId);
  if (pending && Date.now() - pending.at > PENDING_TTL_MS) pendingUcl.delete(userId);
  const deadlinePending = pendingUclDeadline.get(userId);
  if (deadlinePending && Date.now() - deadlinePending.at > PENDING_TTL_MS) {
    pendingUclDeadline.delete(userId);
  }

  if (cmd === "/start" || cmd === "/help") {
    pendingUcl.delete(userId);
    pendingUclDeadline.delete(userId);
    return false;
  }

  if (cmd === "/testucl") {
    pendingUcl.delete(userId);
    pendingUclDeadline.delete(userId);
    const links = linksForEmailFromUser(db, userId);
    if (!links.length) {
      await api.sendMessage(chatId, "Сначала привяжи email: /ucl you@email.com");
      return true;
    }
    const snap = await fetchSnapshotOrNull();
    const team = memberTeamName(snap, links[0]!.email) ?? links[0]!.email;
    await api.sendMessage(
      chatId,
      formatUclPingMessage({ teamName: team, pickNo: 1, round: 1 }),
    );
    return true;
  }

  if (cmd === "/testucllog") {
    pendingUcl.delete(userId);
    pendingUclDeadline.delete(userId);
    const links = linksForEmailFromUser(db, userId);
    if (!links.length) {
      await api.sendMessage(chatId, "Сначала привяжи email: /ucl you@email.com");
      return true;
    }
    if (!api.uclLogReady()) {
      await api.sendMessage(
        chatId,
        "Топик Лиги чемпионов ещё не настроен (бот не смог до него достучаться).",
      );
      return true;
    }
    const snap = await fetchSnapshotOrNull();
    const team = memberTeamName(snap, links[0]!.email) ?? "тест";
    try {
      await api.sendUclLog(
        formatUclPickLog(
          {
            id: 0,
            pickNumber: 1,
            round: 1,
            skipped: false,
            auto: false,
            teamName: team,
            email: links[0]!.email,
            playerName: "Мбаппе",
            position: "FWD",
            clubShort: "RMA",
            clubName: "Real Madrid",
          },
          formatUclNextUpLine({ email: links[0]!.email, teamName: team }, links[0]!),
        ),
      );
      await api.sendMessage(chatId, "Ок — тестовый лог ЛЧ отправлен в топик.");
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      await api.sendMessage(chatId, `Не удалось отправить в топик ЛЧ: ${m}`);
    }
    return true;
  }

  if (cmd === "/testucldeadline") {
    pendingUcl.delete(userId);
    pendingUclDeadline.delete(userId);
    const links = linksForEmailFromUser(db, userId);
    if (!links.length) {
      await api.sendMessage(chatId, "Сначала привяжи email: /ucl you@email.com");
      return true;
    }
    const snap = await fetchSnapshotOrNull();
    const deadline = snapshotDeadline(snap);
    const teamName = memberTeamName(snap, links[0]!.email) ?? links[0]!.email;
    if (!deadline) {
      await api.sendMessage(
        chatId,
        `${deadlineStatusLine(null)}\nПример:\n\n${formatUclDeadlineReminderText({
          matchday: 1,
          deadlineIso: "2026-09-08T16:45:00.000Z",
          teamName,
        })}`,
      );
      return true;
    }
    await api.sendMessage(
      chatId,
      formatUclDeadlineReminderText({
        matchday: deadline.matchday,
        deadlineIso: deadline.deadline_time,
        teamName,
      }),
    );
    return true;
  }

  if (cmd === "/ucldeadline" || cmd === "/ucldildline") {
    pendingUcl.delete(userId);
    const links = linksForEmailFromUser(db, userId);
    if (!links.length) {
      pendingUclDeadline.delete(userId);
      await api.sendMessage(chatId, "Сначала привяжи email: /ucl you@email.com");
      return true;
    }
    const rest = parts.slice(1).join(" ").trim();
    if (isOffReply(rest)) {
      pendingUclDeadline.delete(userId);
      disableDeadlineReminder(db, userId);
      await api.sendMessage(
        chatId,
        "Напоминания о турах ЛЧ выключены. /ucldeadline — настроить снова.",
      );
      return true;
    }
    const existing = getDeadlineReminder(db, userId);
    const currentMins = existing ? parseMinutesJson(existing.minutes_json) : [];
    const currentLine = currentMins.length
      ? `Сейчас${existing && !existing.enabled ? " (выкл)" : ""}: ${currentMins.length}× — за ${currentMins.join(", ")} мин.\n`
      : "";
    pendingUclDeadline.set(userId, {
      step: "count",
      count: 0,
      minutes: [],
      at: Date.now(),
    });
    const snap = await fetchSnapshotOrNull();
    const teamName = memberTeamName(snap, links[0]!.email) ?? links[0]!.email;
    await api.sendMessage(
      chatId,
      `Напоминания о начале тура Лиги чемпионов «${teamName}».\n${currentLine}${deadlineStatusLine(snapshotDeadline(snap))}\n\nСколько напоминаний? Ответь 1, 2 или 3.\nПотом укажешь минуты до первого свистка для каждого (например 1440, 60, 15).\n/ucldeadline off — выключить.`,
    );
    return true;
  }

  if (cmd === "/ucl") {
    pendingUclDeadline.delete(userId);
    const emailArg = parts[1]?.trim();
    if (emailArg?.includes("@")) {
      upsertUclLink(db, {
        telegramUserId: userId,
        chatId,
        email: emailArg,
        tgUsername: from.username,
      });
      pendingUcl.delete(userId);
      await api.sendMessage(
        chatId,
        `Лига чемпионов: привязан ${emailArg.toLowerCase()}.\nБуду писать, когда твой ход в драфте или трансфере.\nНапоминания о турах: /ucldeadline\n${DRAFT_URL}`,
      );
      return true;
    }

    const existing =
      getUclLink(db, userId) ?? linksForEmailFromUser(db, userId)[0] ?? null;
    if (existing) {
      await api.sendMessage(
        chatId,
        `Лига чемпионов уже привязана: ${existing.email}\n/ucl you@email.com — сменить.\n/ucldeadline — напоминания о турах.\n${DRAFT_URL}`,
      );
      return true;
    }

    pendingUcl.set(userId, { at: Date.now() });
    await api.sendMessage(
      chatId,
      "Лига чемпионов 2026/27: пришли email аккаунта panenka.games, или:\n/ucl you@email.com",
    );
    return true;
  }

  const liveDeadline = pendingUclDeadline.get(userId);
  if (liveDeadline) {
    const links = linksForEmailFromUser(db, userId);
    if (!links.length) {
      pendingUclDeadline.delete(userId);
      await api.sendMessage(chatId, "Сначала привяжи email: /ucl you@email.com");
      return true;
    }
    if (cmd.startsWith("/") && cmd !== "/ucldeadline" && cmd !== "/ucldildline") {
      pendingUclDeadline.delete(userId);
      return false;
    }
    if (isOffReply(raw)) {
      pendingUclDeadline.delete(userId);
      disableDeadlineReminder(db, userId);
      await api.sendMessage(
        chatId,
        "Напоминания о турах ЛЧ выключены. /ucldeadline — настроить снова.",
      );
      return true;
    }
    if (liveDeadline.step === "count") {
      const count = parseCountReply(raw);
      if (count == null) {
        await api.sendMessage(chatId, "Нужно число 1, 2 или 3. Или /ucldeadline off.");
        return true;
      }
      pendingUclDeadline.set(userId, {
        step: "minutes",
        count,
        minutes: [],
        at: Date.now(),
      });
      await api.sendMessage(
        chatId,
        `За сколько минут до первого свистка прислать напоминание 1/${count}?\nЦелое число больше 0, например 60.`,
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
      pendingUclDeadline.set(userId, {
        step: "minutes",
        count: liveDeadline.count,
        minutes: nextMinutes,
        at: Date.now(),
      });
      await api.sendMessage(
        chatId,
        `За сколько минут до первого свистка прислать напоминание ${nextMinutes.length + 1}/${liveDeadline.count}?\nУже задано: ${nextMinutes.join(", ")}. Минуты должны быть разными.`,
      );
      return true;
    }
    const stored = nextMinutes.slice().sort((a, b) => b - a);
    upsertDeadlineReminder(db, { telegramUserId: userId, chatId, minutes: stored });
    pendingUclDeadline.delete(userId);
    const snap = await fetchSnapshotOrNull();
    await api.sendMessage(
      chatId,
      `Готово: ${stored.length} напоминани${stored.length === 1 ? "е" : "я"} за ${stored.join(", ")} мин до первого свистка тура ЛЧ.\n${deadlineStatusLine(snapshotDeadline(snap))}\nТекст: «DILDLINE IS COMING».`,
    );
    return true;
  }

  if (pendingUcl.has(userId)) {
    if (raw === "0" || cmd.startsWith("/")) {
      if (cmd.startsWith("/") && cmd !== "/ucl") {
        pendingUcl.delete(userId);
        return false;
      }
      pendingUcl.delete(userId);
      await api.sendMessage(chatId, "Отменено.");
      return true;
    }
    if (!raw.includes("@")) {
      await api.sendMessage(
        chatId,
        "Нужен email, например name@gmail.com (или 0 = отмена)",
      );
      return true;
    }
    upsertUclLink(db, {
      telegramUserId: userId,
      chatId,
      email: raw,
      tgUsername: from.username,
    });
    pendingUcl.delete(userId);
    await api.sendMessage(
      chatId,
      `Лига чемпионов: привязан ${raw.toLowerCase()}.\nНапоминания о турах: /ucldeadline\n${DRAFT_URL}`,
    );
    return true;
  }

  return false;
}

export async function checkUclDraft(
  db: Database.Database,
  api: UclTelegramApi,
): Promise<void> {
  if (!botSecret()) return;

  let snap: UclSnapshot;
  try {
    snap = await fetchSnapshot();
  } catch (err) {
    console.error("[ucl-bot] snapshot:", err instanceof Error ? err.message : err);
    return;
  }

  ensureState(db, snap);
  logCoverage(snap, db);

  await announceDraftStatus(db, api, snap);
  await logPicks(db, api, snap);
  await pingDraftTurn(db, snap, api);
  await checkTransferWindow(db, api, snap);
  await announceTopicDeadline(db, api, snap);
  await checkDeadlineReminders(db, api, snap);
}

/** Draft start / finish, once per transition. */
async function announceDraftStatus(
  db: Database.Database,
  api: UclTelegramApi,
  snap: UclSnapshot,
): Promise<void> {
  if (!api.uclLogReady()) return;
  const state = readState(db);
  if (!state || state.announced_status === snap.status) return;

  let text: string | null = null;
  if (snap.status === "drafting") {
    text = formatUclDraftStart(snap.managers, snap.totalPicks);
  } else if (state.announced_status === "drafting") {
    text = formatUclDraftFinish();
  }
  if (!text) {
    setState(db, { announced_status: snap.status });
    return;
  }
  try {
    await api.sendUclLog(text);
    setState(db, { announced_status: snap.status });
    console.log(`[ucl-bot] status announced ${state.announced_status}→${snap.status}`);
  } catch (err) {
    console.error(
      `[ucl-bot] status announce failed ${snap.status}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

async function logPicks(
  db: Database.Database,
  api: UclTelegramApi,
  snap: UclSnapshot,
): Promise<void> {
  if (!api.uclLogReady()) return;
  const state = readState(db);
  if (!state) return;

  let last = state.last_logged_pick_id;
  if (snap.maxPickId < last) {
    setState(db, { last_logged_pick_id: snap.maxPickId });
    last = snap.maxPickId;
    console.log(`[ucl-bot] pick-log cursor reset to ${last} (draft reset?)`);
  }
  const fresh = snap.picks.filter((p) => p.id > last);
  if (!fresh.length) return;

  const latestId = fresh[fresh.length - 1]!.id;
  for (const pick of fresh) {
    try {
      // Только у самого свежего пика хвост «Следующий» — для старых записей
      // очередь уже не та, что была в момент пика.
      let nextLine: string | undefined;
      if (pick.id === latestId) {
        if (snap.draftFinished) nextLine = "Драфт завершён";
        else if (snap.onClock) {
          const link = linksForEmail(db, snap.onClock.email)[0] ?? null;
          nextLine = formatUclNextUpLine(
            { email: snap.onClock.email, teamName: snap.onClock.teamName },
            link,
          );
        }
      }
      await api.sendUclLog(formatUclPickLog(pick, nextLine));
      setState(db, { last_logged_pick_id: pick.id });
      console.log(
        `[ucl-bot] pick-log #${pick.pickNumber} team=${pick.teamName} skipped=${pick.skipped}`,
      );
    } catch (err) {
      console.error(
        `[ucl-bot] pick-log send failed #${pick.pickNumber}:`,
        err instanceof Error ? err.message : err,
      );
      break;
    }
  }
}

async function pingDraftTurn(
  db: Database.Database,
  snap: UclSnapshot,
  api: UclTelegramApi,
): Promise<void> {
  const onClock = snap.onClock;
  if (snap.status !== "drafting" || !onClock) return;
  if (!onClock.email) {
    console.warn(`[ucl-bot] on-clock has no email team=${onClock.teamName}`);
    return;
  }
  const links = linksForEmail(db, onClock.email);
  if (!links.length) {
    console.warn(
      `[ucl-bot] on-clock unbound team=${onClock.teamName} email=${onClock.email} — /ucl not done`,
    );
    return;
  }
  for (const link of links) {
    if (lastNotifiedPickNo(db, link.telegram_user_id) === onClock.pickNo) continue;
    try {
      await api.sendMessage(
        link.chat_id,
        formatUclPingMessage({
          teamName: onClock.teamName,
          pickNo: onClock.pickNo,
          round: onClock.round,
          redeeming: onClock.redeeming,
          picksLeft: onClock.picksLeft,
        }),
      );
      markNotified(db, link.telegram_user_id, onClock.pickNo);
      console.log(
        `[ucl-bot] notified user=${link.telegram_user_id} team=${onClock.teamName} pick=#${onClock.pickNo}`,
      );
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.error(`[ucl-bot] send failed user=${link.telegram_user_id}:`, m);
      if (/can't initiate conversation|bot was blocked/i.test(m)) {
        markNotified(db, link.telegram_user_id, onClock.pickNo);
      }
    }
  }
}

async function checkTransferWindow(
  db: Database.Database,
  api: UclTelegramApi,
  snap: UclSnapshot,
): Promise<void> {
  const win = snap.transferWindow ?? null;
  if (!win) return;
  const state = readState(db);
  if (!state) return;

  const nextLineFor = (): string => {
    if (!win.onClock) return "Все проходы в этом окне завершены";
    const link = linksForEmail(db, win.onClock.email)[0] ?? null;
    return formatUclNextUpLine(
      { email: win.onClock.email, teamName: win.onClock.teamName },
      link,
    );
  };

  if (api.uclLogReady()) {
    if (win.windowId !== state.last_logged_window_id) {
      try {
        await api.sendUclLog(
          formatUclTransferWindowOpen({
            matchday: win.matchday,
            transfersAllowed: win.transfersAllowed,
            pass: win.pass,
            totalPasses: win.totalPasses,
            closesAt: win.closesAt,
            nextLine: nextLineFor(),
          }),
        );
        setState(db, { last_logged_window_id: win.windowId });
        console.log(`[ucl-bot] transfer-window-open ${win.windowId}`);
      } catch (err) {
        console.error(
          `[ucl-bot] transfer-window-open send failed ${win.windowId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    const maxActionId = win.actions.reduce((m, a) => Math.max(m, a.id), 0);
    let last = state.last_logged_action_id;
    if (maxActionId < last) {
      setState(db, { last_logged_action_id: maxActionId });
      last = maxActionId;
      console.log(`[ucl-bot] transfer-log cursor reset to ${last}`);
    }
    const fresh = win.actions.filter((a) => a.id > last);
    const latestId = win.actions.length
      ? win.actions[win.actions.length - 1]!.id
      : 0;
    for (const action of fresh) {
      try {
        await api.sendUclLog(
          formatUclTransferLog(
            action,
            win.totalPasses,
            action.id === latestId ? nextLineFor() : undefined,
          ),
        );
        setState(db, { last_logged_action_id: action.id });
        console.log(
          `[ucl-bot] transfer-log ${action.kind} #${action.id} team=${action.teamName}`,
        );
      } catch (err) {
        console.error(
          `[ucl-bot] transfer-log send failed #${action.id}:`,
          err instanceof Error ? err.message : err,
        );
        break;
      }
    }
  }

  const onClock = win.onClock;
  if (snap.status !== "running" || !onClock) return;
  if (!onClock.email) {
    console.warn(`[ucl-bot] transfer on-clock has no email team=${onClock.teamName}`);
    return;
  }
  const links = linksForEmail(db, onClock.email);
  if (!links.length) {
    console.warn(
      `[ucl-bot] transfer on-clock unbound team=${onClock.teamName} email=${onClock.email} — topic announced, no DM`,
    );
    return;
  }
  for (const link of links) {
    if (lastNotifiedTransferKey(db, link.telegram_user_id) === onClock.turnKey) {
      continue;
    }
    try {
      await api.sendMessage(
        link.chat_id,
        formatUclTransferPingMessage({
          teamName: onClock.teamName,
          matchday: win.matchday,
          pass: onClock.pass,
          totalPasses: win.totalPasses,
        }),
      );
      markTransferNotified(db, link.telegram_user_id, onClock.turnKey);
      console.log(
        `[ucl-bot] transfer notified user=${link.telegram_user_id} team=${onClock.teamName} key=${onClock.turnKey}`,
      );
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.error(`[ucl-bot] transfer send failed user=${link.telegram_user_id}:`, m);
      if (/can't initiate conversation|bot was blocked/i.test(m)) {
        markTransferNotified(db, link.telegram_user_id, onClock.turnKey);
      }
    }
  }
}

/** One league-wide heads-up per matchday, 24h before the first kickoff. */
async function announceTopicDeadline(
  db: Database.Database,
  api: UclTelegramApi,
  snap: UclSnapshot,
): Promise<void> {
  if (!api.uclLogReady()) return;
  const deadline = snapshotDeadline(snap);
  if (!deadline) return;
  const state = readState(db);
  if (!state || state.announced_deadline_matchday === deadline.matchday) return;

  const deadlineMs = Date.parse(deadline.deadline_time);
  const nowMs = Date.now();
  if (nowMs >= deadlineMs) return;
  if (nowMs < deadlineMs - TOPIC_DEADLINE_LEAD_MINUTES * 60_000) return;

  try {
    await api.sendUclLog(formatUclTopicDeadline(deadline));
    setState(db, { announced_deadline_matchday: deadline.matchday });
    console.log(`[ucl-bot] topic deadline announced md=${deadline.matchday}`);
  } catch (err) {
    console.error(
      `[ucl-bot] topic deadline send failed md=${deadline.matchday}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

async function checkDeadlineReminders(
  db: Database.Database,
  api: UclTelegramApi,
  snap: UclSnapshot,
): Promise<void> {
  const deadline = snapshotDeadline(snap);
  if (!deadline) return;
  const deadlineMs = Date.parse(deadline.deadline_time);
  const nowMs = Date.now();

  const rows = listEnabledDeadlineReminders(db);
  for (const row of rows) {
    const link =
      getUclLink(db, row.telegram_user_id) ??
      linksForEmailFromUser(db, row.telegram_user_id)[0] ??
      null;
    if (!link) continue;
    const teamName = memberTeamName(snap, link.email);
    if (!teamName) continue;

    const due = dueUclDeadlineOffsets({
      minutes: parseMinutesJson(row.minutes_json),
      alreadySent:
        row.last_sent_matchday === deadline.matchday
          ? parseMinutesJson(row.last_sent_offsets_json)
          : [],
      deadlineMs,
      nowMs,
    });
    for (const offset of due) {
      try {
        await api.sendMessage(
          row.chat_id || link.chat_id,
          formatUclDeadlineReminderText({
            matchday: deadline.matchday,
            deadlineIso: deadline.deadline_time,
            teamName,
          }),
        );
        markDeadlineSent(db, row.telegram_user_id, deadline.matchday, offset);
        console.log(
          `[ucl-bot] deadline reminder user=${row.telegram_user_id} team=${teamName} md=${deadline.matchday} offset=${offset}m`,
        );
      } catch (err) {
        console.error(
          `[ucl-bot] deadline send failed user=${row.telegram_user_id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
}
