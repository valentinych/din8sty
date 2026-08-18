/**
 * FPL 2026 draft notifications on the Din8sty Telegram bot (same token).
 *
 * Pick logs → forum topic https://t.me/c/2419087266/2
 * Turn pings → DM when a mapped manager goes on the clock.
 * Email mapping: fpl_telegram_links ∪ top4_telegram_links ∪ h2h_telegram_links.
 *
 * /fpl — bind panenka email (for managers not already in Top-4 / H2H)
 * /testfpl — sample turn ping
 * /testfpllog — sample pick log to the FPL topic
 */
import type Database from "better-sqlite3";

const DRAFT_URL = "https://fantasy.panenka.games/fpl-2026/draft";
const PENDING_TTL_MS = 15 * 60_000;

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
};

/** Fallback if an older panenka snapshot omits totalPicks (23 rounds). */
const FPL_PICKS_PER_MANAGER = 23;

const pendingFpl = new Map<number, { at: number }>();
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
  return "/fpl — привязать email для пингов хода FPL 2026";
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

  if (cmd === "/testfpl") {
    pendingFpl.delete(userId);
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

  if (cmd === "/fpl") {
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
        `FPL: привязан ${emailArg.toLowerCase()}.\nБуду писать, когда твой ход.\n${DRAFT_URL}`,
      );
      return true;
    }

    const existing =
      getFplLink(db, userId) ?? linksForEmailFromUser(db, userId)[0] ?? null;
    if (existing) {
      await api.sendMessage(
        chatId,
        `FPL уже привязан: ${existing.email}\n/fpl you@email.com — сменить.\n${DRAFT_URL}`,
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
      `FPL: привязан ${raw.toLowerCase()}.\n${DRAFT_URL}`,
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
  if (snap.status !== "drafting" || !onClock) return;
  if (onClock.outOfDraft) return;
  if (!onClock.email) {
    console.warn(`[fpl-bot] on-clock has no email team=${onClock.teamName}`);
    return;
  }

  const links = linksForEmail(db, onClock.email);
  if (!links.length) {
    return;
  }

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
