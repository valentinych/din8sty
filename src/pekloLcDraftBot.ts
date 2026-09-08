/**
 * Peklo ЛЧ 2026/27 club draft via @draftmantra_bot.
 *
 * /regpeklo — register if TG @nick (or id) matches roster
 * On your turn: bot sends remaining clubs; reply with 3-letter code (e.g. LIL)
 * Broadcasts each pick to all registered members of the group.
 */
import type Database from "better-sqlite3";

const PAGE_URL = "https://peklo.panenka.games/lc-2026-27";
const PENDING_TTL_MS = 30 * 60_000;

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

type Board = {
  groupId: string;
  status: string;
  pickIndex: number;
  onClockSeat: number | null;
  onClockName: string | null;
  managers: Array<{
    seat: number;
    name: string;
    registered: boolean;
    ratingSum: number;
    picks: Array<{ code: string }>;
  }>;
  remaining: Array<{ code: string; name: string; rating: number }>;
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
  const url = new URL("/api/peklo/lc-draft/bot", panenkaOrigin());
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
  const res = await fetch(new URL("/api/peklo/lc-draft/bot", panenkaOrigin()), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-H2H-Bot-Secret": secret,
    },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
}

export function ensurePekloLcBotTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS peklo_lc_telegram_links (
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
    `INSERT INTO peklo_lc_telegram_links
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
         FROM peklo_lc_telegram_links WHERE telegram_user_id = ?`,
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
      `UPDATE peklo_lc_telegram_links SET last_turn_key = ?, updated_at = ? WHERE telegram_user_id = ?`,
    ).run(keys.turnKey, now, userId);
  }
  if (keys.pickKey != null) {
    db.prepare(
      `UPDATE peklo_lc_telegram_links SET last_pick_key = ?, updated_at = ? WHERE telegram_user_id = ?`,
    ).run(keys.pickKey, now, userId);
  }
}

function formatRemaining(board: Board): string {
  return board.remaining
    .map((c) => `${c.code} ${c.name} ${c.rating.toFixed(3)}`)
    .join("\n");
}

function formatSummary(board: Board): string {
  const lines = [
    `Группа ${board.groupId} · ${board.status} · пик ${board.pickIndex}/36`,
  ];
  if (board.onClockName) lines.push(`Ход: ${board.onClockName}`);
  for (const m of board.managers) {
    const codes = m.picks.map((p) => p.code).join(" ") || "—";
    lines.push(
      `${m.registered ? "✓" : "…"} ${m.seat}. ${m.name} Σ${m.ratingSum.toFixed(3)}: ${codes}`,
    );
  }
  return lines.join("\n");
}

async function sendTurnBoard(
  api: TelegramApiLike,
  chatId: number,
  board: Board,
): Promise<void> {
  const text = [
    "Твой ход в драфте ЛЧ 2026/27.",
    formatSummary(board),
    "",
    "Оставшиеся клубы (код · клуб · рейтинг UEFA):",
    formatRemaining(board),
    "",
    "Ответь трёхбуквенным кодом, например: LIL",
    PAGE_URL,
  ].join("\n");
  // Telegram 4096 limit — split if needed
  if (text.length <= 4000) {
    await api.sendMessage(chatId, text);
    return;
  }
  await api.sendMessage(
    chatId,
    [
      "Твой ход в драфте ЛЧ 2026/27.",
      formatSummary(board),
      "",
      "Оставшиеся (код рейтинг):",
      board.remaining.map((c) => `${c.code} ${c.rating.toFixed(3)}`).join("\n"),
      "",
      "Ответь кодом, напр. LIL",
      PAGE_URL,
    ].join("\n"),
  );
}

export function pekloLcHelpLine(): string {
  return "/regpeklo — регистрация в драфт ЛЧ 2026/27 (нужен @ник из группы)";
}

export async function handlePekloLcMessage(
  db: Database.Database,
  api: TelegramApiLike,
  msg: TgMessage,
  text: string,
): Promise<boolean> {
  const from = msg.from;
  if (!from) return false;
  const userId = from.id;
  /** Always DM the player — never post to group chats. */
  const dmId = userId;
  const raw = text.trim();
  const cmd = (raw.split(/\s+/)[0] ?? "")
    .toLowerCase()
    .replace(/@\w+$/, "");

  if (cmd === "/regpeklo") {
    try {
      const res = await apiPost({
        action: "register",
        telegramUserId: userId,
        chatId: dmId,
        username: from.username ?? null,
      });
      if (!res.ok) {
        await api.sendMessage(dmId, String(res.error ?? "Ошибка регистрации"));
        return true;
      }
      upsertLink(db, userId, dmId);
      const board = res.board as Board;
      await api.sendMessage(
        dmId,
        [String(res.message), "", formatSummary(board), "", PAGE_URL].join("\n"),
      );
      if (res.started && board.onClockSeat != null) {
        const targets = (await apiGet("notify")).targets as Array<{
          telegramUserId: number;
          myTurn: boolean;
          board: Board;
          turnKey: string;
        }>;
        for (const t of targets) {
          if (!t.myTurn || t.board.groupId !== board.groupId) continue;
          pendingPick.set(t.telegramUserId, { at: Date.now() });
          await sendTurnBoard(api, t.telegramUserId, t.board);
          setKeys(db, t.telegramUserId, { turnKey: t.turnKey });
        }
      }
      return true;
    } catch (err) {
      await api.sendMessage(
        dmId,
        `Ошибка: ${err instanceof Error ? err.message : String(err)}`,
      );
      return true;
    }
  }

  // Club code pick: 2–4 letters
  const code = raw.toUpperCase().replace(/[^A-Z]/g, "");
  const looksLikeCode =
    !raw.startsWith("/") && code.length >= 2 && code.length <= 4 && /^[A-Z]+$/.test(code);

  if (looksLikeCode) {
    // Ignore club-code spam in groups unless this user is in the draft
    if (msg.chat.type !== "private") {
      const link = getLink(db, userId);
      if (!link) return false;
    }
    const link = getLink(db, userId);
    try {
      const res = await apiPost({
        action: "pick",
        telegramUserId: userId,
        clubCode: code,
      });
      if (!res.ok) {
        const err = String(res.error ?? "");
        if (err.includes("/regpeklo") && !link) return false;
        await api.sendMessage(dmId, err || "Не удалось пикнуть");
        return true;
      }
      upsertLink(db, userId, dmId);
      pendingPick.delete(userId);
      const announce = String(res.announce ?? "");
      const notifyUserIds = (res.notifyChatIds as number[]) ?? [];
      const board = res.board as Board;
      for (const uid of notifyUserIds) {
        try {
          await api.sendMessage(uid, announce);
        } catch {
          /* ignore */
        }
      }
      if (board.status === "drafting" && board.onClockName) {
        const targets = (await apiGet("notify")).targets as Array<{
          myTurn: boolean;
          board: Board;
          telegramUserId: number;
          turnKey: string;
        }>;
        for (const t of targets) {
          if (t.myTurn && t.board.groupId === board.groupId) {
            pendingPick.set(t.telegramUserId, { at: Date.now() });
            await sendTurnBoard(api, t.telegramUserId, t.board);
            setKeys(db, t.telegramUserId, { turnKey: t.turnKey });
          }
        }
      } else if (board.status === "complete") {
        for (const uid of notifyUserIds) {
          try {
            await api.sendMessage(
              uid,
              `Драфт группы ${board.groupId} завершён.\n${formatSummary(board)}\n${PAGE_URL}`,
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

  // Claim bare DM messages only while waiting for a pick
  if (msg.chat.type !== "private") return false;
  const pend = pendingPick.get(userId);
  if (pend && Date.now() - pend.at < PENDING_TTL_MS && !raw.startsWith("/")) {
    await api.sendMessage(
      dmId,
      "Пришли трёхбуквенный код клуба из списка (например LIL).",
    );
    return true;
  }

  return false;
}

export async function checkPekloLcNotifications(
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
  }>) ?? [];

  for (const t of targets) {
    const dmId = t.telegramUserId;
    upsertLink(db, t.telegramUserId, dmId);
    const link = getLink(db, t.telegramUserId);
    if (!link) continue;

    if (t.myTurn && link.last_turn_key !== t.turnKey) {
      pendingPick.set(t.telegramUserId, { at: Date.now() });
      try {
        await sendTurnBoard(api, dmId, t.board);
        setKeys(db, t.telegramUserId, { turnKey: t.turnKey });
      } catch (err) {
        console.error(
          "[peklo-lc] turn notify:",
          err instanceof Error ? err.message : err,
        );
      }
    } else if (!t.myTurn && link.last_turn_key !== t.turnKey) {
      setKeys(db, t.telegramUserId, { turnKey: t.turnKey });
    }
  }
}
