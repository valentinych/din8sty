/**
 * Peklo Ліга Націй 2026/27 national-team draft via @draftmantra_bot.
 *
 * Accounts are pre-bound from LC/LELK. Reply with FIFA code (e.g. FRA) on your turn.
 * Broadcasts each pick + upcoming queue. DM-only. Does not start the draft.
 */
import type Database from "better-sqlite3";

const PAGE_URL = "https://peklo.panenka.games/unl-2026-27";
const PENDING_TTL_MS = 30 * 60_000;
/** FIFA codes of UNL A/B/C 2026/27 — ignore LC/LELK club codes. */
const UNL_CODES = new Set([
  "FRA", "ITA", "BEL", "TUR",
  "GER", "NED", "SRB", "GRE",
  "ENG", "ESP", "CRO", "CZE",
  "POR", "DEN", "NOR", "WAL",
  "SUI", "SCO", "SVN", "MKD",
  "UKR", "HUN", "GEO", "NIR",
  "AUT", "IRL", "ISR", "KOS",
  "POL", "SWE", "BIH", "ROU",
  "ALB", "FIN", "BLR", "SMR",
  "ARM", "MNE", "CYP", "LVA",
  "SVK", "KAZ", "MDA", "FRO",
  "ISL", "BUL", "LUX", "EST",
]);

type TgUser = { id: number; username?: string; first_name?: string };
type TgChat = { id: number; type: string };
type TgMessage = {
  message_id: number;
  date: number;
  text?: string;
  chat: TgChat;
  from?: TgUser;
};

type TelegramApiLike = {
  sendMessage: (chatId: number, text: string) => Promise<{ message_id: number }>;
};

type LinkRow = {
  telegram_user_id: number;
  chat_id: number;
  last_turn_key: string | null;
  last_pick_key: string | null;
};

type FootballTeam = {
  code: string;
  name: string;
  groupId: string;
  taken: boolean;
  ownerName: string | null;
  legal: boolean;
};

type Board = {
  groupId: string;
  groupLabel: string;
  status: string;
  pickIndex: number;
  picksMade?: number;
  onClockSeat: number | null;
  onClockName: string | null;
  managers: Array<{
    seat: number;
    name: string;
    registered: boolean;
    ownedGroups: string[];
    picks: Array<{ code: string; footballGroup: string }>;
  }>;
  footballGroups: Array<{
    id: string;
    league: string;
    teams: FootballTeam[];
  }>;
  pickQueue: Array<{ name: string; onClock: boolean }>;
  remaining: Array<{ code: string; name: string; groupId: string }>;
};

const pendingPick = new Map<number, { at: number }>();

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

async function apiGet(
  action: string,
  params: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const secret = botSecret();
  if (!secret) throw new Error("H2H_BOT_SECRET missing");
  const url = new URL("/api/peklo/unl-draft/bot", panenkaOrigin());
  url.searchParams.set("action", action);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { "X-H2H-Bot-Secret": secret },
    cache: "no-store",
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok || !data.ok) {
    throw new Error(String(data.error ?? `HTTP ${res.status}`));
  }
  return data;
}

async function apiPost(
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const secret = botSecret();
  if (!secret) throw new Error("H2H_BOT_SECRET missing");
  const res = await fetch(new URL("/api/peklo/unl-draft/bot", panenkaOrigin()), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-H2H-Bot-Secret": secret,
    },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
}

export function ensurePekloUnlBotTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS peklo_unl_telegram_links (
      telegram_user_id INTEGER PRIMARY KEY,
      chat_id INTEGER NOT NULL,
      last_turn_key TEXT,
      last_pick_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function upsertLink(
  db: Database.Database,
  userId: number,
  chatId: number,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO peklo_unl_telegram_links
      (telegram_user_id, chat_id, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET
      chat_id = excluded.chat_id,
      updated_at = excluded.updated_at`,
  ).run(userId, chatId, now, now);
}

function getLink(db: Database.Database, userId: number): LinkRow | null {
  return (
    (db
      .prepare(
        `SELECT telegram_user_id, chat_id, last_turn_key, last_pick_key
         FROM peklo_unl_telegram_links WHERE telegram_user_id = ?`,
      )
      .get(userId) as LinkRow | undefined) ?? null
  );
}

function setKeys(
  db: Database.Database,
  userId: number,
  keys: { turnKey?: string; pickKey?: string },
): void {
  const now = new Date().toISOString();
  if (keys.turnKey != null) {
    db.prepare(
      `UPDATE peklo_unl_telegram_links SET last_turn_key = ?, updated_at = ? WHERE telegram_user_id = ?`,
    ).run(keys.turnKey, now, userId);
  }
  if (keys.pickKey != null) {
    db.prepare(
      `UPDATE peklo_unl_telegram_links SET last_pick_key = ?, updated_at = ? WHERE telegram_user_id = ?`,
    ).run(keys.pickKey, now, userId);
  }
}

function formatRemaining(board: Board, forSeat?: number | null): string {
  const owned = new Set(
    forSeat != null
      ? (board.managers.find((m) => m.seat === forSeat)?.ownedGroups ?? [])
      : [],
  );
  const lines: string[] = [];
  for (const g of board.footballGroups ?? []) {
    lines.push(g.id);
    for (const t of g.teams) {
      if (t.taken) {
        lines.push(`  ${t.code} ${t.name} — ${t.ownerName ?? "?"}`);
      } else if (owned.has(t.groupId) || t.legal === false) {
        lines.push(`  ${t.code} ${t.name} — ✕`);
      } else {
        lines.push(`  ${t.code} ${t.name}`);
      }
    }
  }
  if (lines.length) return lines.join("\n");
  return (board.remaining ?? [])
    .map((t) => `${t.code} ${t.name} ${t.groupId}`)
    .join("\n");
}

function formatQueue(board: Board, limit = 8): string | null {
  const q = (board.pickQueue ?? []).slice(0, limit);
  if (!q.length) return null;
  return `Очередь: ${q.map((e) => e.name).join(" → ")}`;
}

function formatSummary(board: Board): string {
  const statusLabel =
    board.status === "ready"
      ? "ожидает старта"
      : board.status === "drafting"
        ? `пик ${board.picksMade ?? board.pickIndex}/48`
        : "готово";
  const lines = [`Группа ${board.groupLabel ?? board.groupId} · ${statusLabel}`];
  if (board.onClockName) lines.push(`Ход: ${board.onClockName}`);
  const queue = formatQueue(board);
  if (queue) lines.push(queue);
  for (const m of board.managers) {
    const codes =
      m.picks.map((p) => `${p.code}/${p.footballGroup}`).join(" ") || "—";
    lines.push(
      `${m.registered ? "✓" : "…"} ${m.seat}. ${m.name}: ${codes}`,
    );
  }
  return lines.join("\n");
}

function russianPickWord(n: number): string {
  const n100 = Math.abs(n) % 100;
  const n10 = n100 % 10;
  if (n100 >= 11 && n100 <= 14) return "пиков";
  if (n10 === 1) return "пик";
  if (n10 >= 2 && n10 <= 4) return "пика";
  return "пиков";
}

function personalizedAnnounce(
  announce: string,
  uid: number,
  picksUntilByUserId: Record<string, number> | undefined,
): string {
  if (!announce || picksUntilByUserId == null) return announce;
  const n = picksUntilByUserId[uid] ?? picksUntilByUserId[String(uid)];
  if (typeof n !== "number" || !Number.isFinite(n)) return announce;
  return `${announce}\nДо тебя: ${n} ${russianPickWord(n)}`;
}

async function sendTurnBoard(
  api: TelegramApiLike,
  chatId: number,
  board: Board,
  turnMessage?: string | null,
): Promise<void> {
  const text = (turnMessage && turnMessage.trim()) || [
    "Твой ход в драфте Ліги Націй 2026/27.",
    formatSummary(board),
    "",
    "Кто что взял и что свободно (✕ = у тебя уже есть эта группа):",
    formatRemaining(board, board.onClockSeat),
    "",
    "Ответь кодом, например: FRA",
    PAGE_URL,
  ].join("\n");
  const withUrl = text.includes(PAGE_URL) ? text : `${text}\n${PAGE_URL}`;
  if (withUrl.length <= 4000) {
    await api.sendMessage(chatId, withUrl);
    return;
  }
  const free = (board.footballGroups ?? [])
    .flatMap((g) => g.teams)
    .filter((t) => !t.taken && t.legal !== false)
    .map((t) => `${t.code} ${t.name} ${t.groupId}`)
    .join("\n");
  await api.sendMessage(
    chatId,
    [
      "Твой ход в драфте Ліги Націй 2026/27.",
      formatSummary(board),
      "",
      "Доступные:",
      free,
      "",
      "Ответь кодом, напр. FRA",
      PAGE_URL,
    ].join("\n"),
  );
}

export function pekloUnlHelpLine(): string {
  return "Ліга Націй 2026/27 — на своём ходу пришли код сборной (FRA, GER…). Аккаунты уже привязаны с прошлых драфтов.";
}

function looksLikeUnlCode(raw: string): string | null {
  const code = raw.toUpperCase().replace(/[^A-Z]/g, "");
  if (raw.startsWith("/")) return null;
  if (code.length !== 3) return null;
  return UNL_CODES.has(code) ? code : null;
}

async function notifyOnClock(
  db: Database.Database,
  api: TelegramApiLike,
  groupId: string,
): Promise<void> {
  const targets = (await apiGet("notify")).targets as Array<{
    telegramUserId: number;
    myTurn: boolean;
    board: Board;
    turnKey: string;
    turnMessage?: string | null;
  }>;
  for (const t of targets) {
    if (!t.myTurn || t.board.groupId !== groupId) continue;
    pendingPick.set(t.telegramUserId, { at: Date.now() });
    await sendTurnBoard(api, t.telegramUserId, t.board, t.turnMessage);
    setKeys(db, t.telegramUserId, { turnKey: t.turnKey });
  }
}

export async function handlePekloUnlMessage(
  db: Database.Database,
  api: TelegramApiLike,
  msg: TgMessage,
  text: string,
): Promise<boolean> {
  const from = msg.from;
  if (!from) return false;
  const userId = from.id;
  const dmId = userId;
  const username = from.username ?? null;
  const raw = text.trim();
  const cmd = (raw.split(/\s+/)[0] ?? "")
    .toLowerCase()
    .replace(/@\w+$/, "");

  if (msg.chat.type === "private") {
    try {
      const res = await apiPost({
        action: "register",
        telegramUserId: userId,
        chatId: dmId,
        username,
      });
      if (res.ok) upsertLink(db, userId, dmId);
    } catch {
      /* pick handler may still succeed via pre-bound ids */
    }
  }

  if (cmd === "/regunl") {
    try {
      const res = await apiPost({
        action: "register",
        telegramUserId: userId,
        chatId: dmId,
        username,
      });
      if (!res.ok) {
        await api.sendMessage(dmId, String(res.error ?? "Ошибка"));
        return true;
      }
      upsertLink(db, userId, dmId);
      const board = res.board as Board;
      await api.sendMessage(
        dmId,
        [String(res.message), "", formatSummary(board), "", PAGE_URL].join("\n"),
      );
      return true;
    } catch (err) {
      await api.sendMessage(
        dmId,
        `Ошибка: ${err instanceof Error ? err.message : String(err)}`,
      );
      return true;
    }
  }

  const code = looksLikeUnlCode(raw);
  if (code) {
    if (msg.chat.type !== "private") {
      const link = getLink(db, userId);
      if (!link) return false;
    }
    const link = getLink(db, userId);
    try {
      const res = await apiPost({
        action: "pick",
        telegramUserId: userId,
        teamCode: code,
        username,
      });
      if (!res.ok) {
        const err = String(res.error ?? "");
        const reason = String(res.reason ?? "");
        if (
          reason === "unknown_code" ||
          reason === "not_registered" ||
          reason === "not_started" ||
          reason === "not_your_turn" ||
          reason === "complete"
        ) {
          return false;
        }
        if (
          (err.includes("не в списке") || err.includes("не привязан")) &&
          !link
        ) {
          return false;
        }
        if (
          err.includes("Сейчас ходит") ||
          err.includes("ещё не начался") ||
          err.includes("уже завершён")
        ) {
          return false;
        }
        await api.sendMessage(dmId, err || "Не удалось пикнуть");
        return true;
      }
      upsertLink(db, userId, dmId);
      pendingPick.delete(userId);
      const announce = String(res.announce ?? "");
      const notifyUserIds = (res.notifyChatIds as number[]) ?? [];
      const board = res.board as Board;
      const picksUntilByUserId = res.picksUntilByUserId as
        | Record<string, number>
        | undefined;
      const onClockMessage = (res.onClockMessage as string | null) ?? null;
      for (const uid of notifyUserIds) {
        try {
          await api.sendMessage(
            uid,
            personalizedAnnounce(announce, uid, picksUntilByUserId),
          );
        } catch {
          /* ignore */
        }
      }
      if (board.status === "drafting" && board.onClockName) {
        const targets = (await apiGet("notify")).targets as Array<{
          telegramUserId: number;
          myTurn: boolean;
          board: Board;
          turnKey: string;
          turnMessage?: string | null;
        }>;
        for (const t of targets) {
          if (!t.myTurn || t.board.groupId !== board.groupId) continue;
          pendingPick.set(t.telegramUserId, { at: Date.now() });
          await sendTurnBoard(
            api,
            t.telegramUserId,
            t.board,
            t.turnMessage ?? onClockMessage,
          );
          setKeys(db, t.telegramUserId, { turnKey: t.turnKey });
        }
      } else if (board.status === "complete") {
        for (const uid of notifyUserIds) {
          try {
            await api.sendMessage(
              uid,
              `Драфт группы ${board.groupLabel ?? board.groupId} завершён.\n${formatSummary(board)}\n${PAGE_URL}`,
            );
          } catch {
            /* ignore */
          }
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  if (msg.chat.type !== "private") return false;
  const pend = pendingPick.get(userId);
  if (pend && Date.now() - pend.at < PENDING_TTL_MS && !raw.startsWith("/")) {
    await api.sendMessage(
      dmId,
      "Пришли код сборной из списка (например FRA).",
    );
    return true;
  }

  return false;
}

export async function checkPekloUnlNotifications(
  db: Database.Database,
  api: TelegramApiLike,
): Promise<void> {
  if (!botSecret()) return;
  let data: Record<string, unknown>;
  try {
    data = await apiGet("notify");
  } catch {
    return;
  }
  const targets = (data.targets as Array<{
    telegramUserId: number;
    turnKey: string;
    pickKey: string;
    board: Board;
    myTurn: boolean;
    turnMessage?: string | null;
  }>) ?? [];

  for (const t of targets) {
    // Do not DM while boards are idle — only after an explicit start (status=drafting).
    if (t.board.status !== "drafting") continue;
    const dmId = t.telegramUserId;
    upsertLink(db, t.telegramUserId, dmId);
    const link = getLink(db, t.telegramUserId);
    if (!link) continue;

    if (t.myTurn && link.last_turn_key !== t.turnKey) {
      pendingPick.set(t.telegramUserId, { at: Date.now() });
      try {
        await sendTurnBoard(api, dmId, t.board, t.turnMessage);
        setKeys(db, t.telegramUserId, { turnKey: t.turnKey });
      } catch (err) {
        console.error(
          "[peklo-unl] turn notify:",
          err instanceof Error ? err.message : err,
        );
      }
    } else if (!t.myTurn && link.last_turn_key !== t.turnKey) {
      setKeys(db, t.telegramUserId, { turnKey: t.turnKey });
    }
  }
}
