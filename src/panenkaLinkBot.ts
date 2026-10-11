/**
 * /panenka — link this Telegram account to a panenka.games Player.
 *
 * Talks to the panenka.games bot bridge (`/api/bot/panenka`) — auth via
 * X-Panenka-Bot-Secret. Local mirror of the link lives in `panenka_links` so
 * we can show the last state offline; source of truth stays on panenka.games.
 *
 * Commands:
 *   /panenka          — show current link, or auto-match by @username, or prompt for ID.
 *   /panenka yes      — confirm the pending auto-match (15 min TTL).
 *   /panenka 42       — bind a specific player ID.
 *   /panenka who      — show current linkage.
 *   /panenka off      — unlink.
 */
import type Database from "better-sqlite3";

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

type TelegramApiLike = {
  sendMessage: (
    chatId: number,
    text: string,
    opts?: { parseMode?: "HTML" },
  ) => Promise<{ message_id: number }>;
};

type PanenkaPlayer = {
  id: number;
  fullName?: string | null;
  nickname?: string | null;
  telegramUserId?: number | string | null;
  telegramLinked?: boolean;
};

const pendingPanenka = new Map<number, { player: PanenkaPlayer; at: number }>();

function panenkaOrigin(): string {
  return (
    process.env.PANENKA_BOT_API_ORIGIN?.trim() ||
    process.env.PANENKA_ORIGIN?.trim() ||
    "https://panenka.games"
  );
}

function botSecret(): string {
  return process.env.PANENKA_BOT_SECRET?.trim() || "";
}

function profileUrl(): string {
  return `${panenkaOrigin()}/profile`;
}

function playersUrl(): string {
  return `${panenkaOrigin()}/players`;
}

function configOk(): boolean {
  return Boolean(botSecret());
}

type BotResponse = { ok?: boolean; error?: string; player?: PanenkaPlayer };

async function botGet(params: Record<string, string | number>): Promise<BotResponse> {
  const url = new URL("/api/bot/panenka", panenkaOrigin());
  url.searchParams.set("action", "lookup");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: { "X-Panenka-Bot-Secret": botSecret() },
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as BotResponse;
  if (!res.ok || !data.ok) {
    throw new Error(String(data.error ?? `HTTP ${res.status}`));
  }
  return data;
}

async function botPost(body: Record<string, unknown>): Promise<BotResponse & { status: number }> {
  const res = await fetch(new URL("/api/bot/panenka", panenkaOrigin()), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Panenka-Bot-Secret": botSecret(),
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as BotResponse;
  return { status: res.status, ...data };
}

export function ensurePanenkaLinkTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS panenka_links (
      telegram_user_id INTEGER PRIMARY KEY,
      chat_id INTEGER NOT NULL,
      player_id INTEGER NOT NULL,
      full_name TEXT,
      nickname TEXT,
      tg_username TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_panenka_links_player
      ON panenka_links (player_id);
  `);
}

function getLocalLink(
  db: Database.Database,
  telegramUserId: number,
): { player_id: number; full_name: string | null; nickname: string | null } | null {
  return (
    (db
      .prepare(
        `SELECT player_id, full_name, nickname
         FROM panenka_links WHERE telegram_user_id = ?`,
      )
      .get(telegramUserId) as
      | { player_id: number; full_name: string | null; nickname: string | null }
      | undefined) ?? null
  );
}

function upsertLocalLink(
  db: Database.Database,
  opts: {
    telegramUserId: number;
    chatId: number;
    playerId: number;
    fullName: string | null;
    nickname: string | null;
    tgUsername: string | null;
  },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `DELETE FROM panenka_links WHERE player_id = ? AND telegram_user_id != ?`,
  ).run(opts.playerId, opts.telegramUserId);
  db.prepare(
    `INSERT INTO panenka_links
       (telegram_user_id, chat_id, player_id, full_name, nickname, tg_username,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET
       chat_id = excluded.chat_id,
       player_id = excluded.player_id,
       full_name = excluded.full_name,
       nickname = excluded.nickname,
       tg_username = excluded.tg_username,
       updated_at = excluded.updated_at`,
  ).run(
    opts.telegramUserId,
    opts.chatId,
    opts.playerId,
    opts.fullName,
    opts.nickname,
    opts.tgUsername,
    now,
    now,
  );
}

function deleteLocalLink(db: Database.Database, telegramUserId: number): void {
  db.prepare(`DELETE FROM panenka_links WHERE telegram_user_id = ?`).run(telegramUserId);
}

function playerLine(p: PanenkaPlayer): string {
  const full = (p.fullName || "—").toString();
  const nick = p.nickname ? ` (@${p.nickname})` : "";
  return `#${p.id} ${full}${nick}`;
}

function purgeStalePending(userId: number): void {
  const p = pendingPanenka.get(userId);
  if (p && Date.now() - p.at > PENDING_TTL_MS) pendingPanenka.delete(userId);
}

async function doLink(
  db: Database.Database,
  api: TelegramApiLike,
  msg: TgMessage,
  telegramUserId: number,
  playerId: number,
): Promise<void> {
  const chatId = msg.chat.id;
  let result;
  try {
    result = await botPost({
      action: "link",
      playerId,
      telegramUserId,
    });
  } catch (err) {
    await api.sendMessage(
      chatId,
      `Не удалось привязать: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  if (result.status !== 200 || !result.ok) {
    await api.sendMessage(chatId, `Не удалось привязать: ${result.error || "неизвестная ошибка"}`);
    return;
  }
  const player = result.player;
  if (!player) {
    await api.sendMessage(chatId, "Не удалось привязать: пустой ответ.");
    return;
  }
  upsertLocalLink(db, {
    telegramUserId,
    chatId,
    playerId: Number(player.id ?? playerId),
    fullName: player.fullName ?? null,
    nickname: player.nickname ?? null,
    tgUsername: msg.from?.username ?? null,
  });
  pendingPanenka.delete(telegramUserId);
  await api.sendMessage(
    chatId,
    `Привязал этот Telegram к игроку ${playerLine(player)} на panenka.games.\n` +
      `Профиль: ${profileUrl()}\n` +
      `Отвязать: /panenka off`,
  );
}

async function handleById(
  db: Database.Database,
  api: TelegramApiLike,
  msg: TgMessage,
  telegramUserId: number,
  playerId: number,
): Promise<void> {
  const chatId = msg.chat.id;
  let player: PanenkaPlayer | null = null;
  try {
    const res = await botGet({ playerId });
    player = res.player ?? null;
  } catch (err) {
    console.error("[panenka-bot] lookup by id failed:", err instanceof Error ? err.message : err);
    await api.sendMessage(chatId, "Не могу связаться с panenka.games, попробуй позже.");
    return;
  }
  if (!player) {
    await api.sendMessage(
      chatId,
      `Игрок с ID ${playerId} не найден. Открой ${profileUrl()} и проверь свой ID.`,
    );
    return;
  }
  if (
    player.telegramLinked &&
    String(player.telegramUserId ?? "") !== String(telegramUserId)
  ) {
    await api.sendMessage(
      chatId,
      `К игроку ${playerLine(player)} уже привязан другой Telegram-аккаунт. Обратись к админу, если это ошибка.`,
    );
    return;
  }
  await doLink(db, api, msg, telegramUserId, Number(player.id));
}

export function panenkaLinkHelpLine(): string {
  return "/panenka — привязка к panenka.games (yes/off/who/N)";
}

export async function handlePanenkaMessage(
  db: Database.Database,
  api: TelegramApiLike,
  msg: TgMessage,
  text: string,
): Promise<boolean> {
  const from = msg.from;
  if (!from) return false;
  const userId = from.id;
  const chatId = msg.chat.id;
  purgeStalePending(userId);

  const raw = text.trim();
  const parts = raw.split(/\s+/);
  const cmd = (parts[0] ?? "").toLowerCase().replace(/@\w+$/, "");
  if (cmd !== "/panenka") return false;

  if (!configOk()) {
    await api.sendMessage(chatId, "Связка с panenka.games не настроена (нет PANENKA_BOT_SECRET).");
    return true;
  }

  const arg = (parts[1] ?? "").trim().replace(/^@/, "").toLowerCase();

  if (["off", "unlink", "disable", "logout"].includes(arg)) {
    const local = getLocalLink(db, userId);
    if (!local) {
      // Try remote too — a link may exist on panenka.games from before local storage.
      try {
        const res = await botGet({ telegramUserId: userId });
        if (!res.player) {
          await api.sendMessage(chatId, "Этот Telegram и так не привязан.");
          return true;
        }
      } catch {
        await api.sendMessage(chatId, "Этот Telegram и так не привязан.");
        return true;
      }
    }
    try {
      await botPost({ action: "unlink", telegramUserId: userId });
    } catch (err) {
      console.error(
        "[panenka-bot] unlink remote failed:",
        err instanceof Error ? err.message : err,
      );
    }
    deleteLocalLink(db, userId);
    pendingPanenka.delete(userId);
    await api.sendMessage(chatId, "Отвязал. Запусти /panenka, если захочешь заново.");
    return true;
  }

  if (["who", "me", "status"].includes(arg)) {
    let player: PanenkaPlayer | null = null;
    try {
      const res = await botGet({ telegramUserId: userId });
      player = res.player ?? null;
    } catch (err) {
      console.error(
        "[panenka-bot] status lookup failed:",
        err instanceof Error ? err.message : err,
      );
      await api.sendMessage(chatId, "Не могу связаться с panenka.games, попробуй позже.");
      return true;
    }
    if (!player) {
      await api.sendMessage(chatId, "Этот Telegram пока не привязан. Отправь /panenka.");
      return true;
    }
    await api.sendMessage(chatId, `Ты — ${playerLine(player)} на panenka.games.`);
    return true;
  }

  if (["yes", "y", "ok", "да", "confirm"].includes(arg)) {
    const pending = pendingPanenka.get(userId);
    if (!pending || Date.now() - pending.at > PENDING_TTL_MS) {
      pendingPanenka.delete(userId);
      await api.sendMessage(
        chatId,
        "Нет активного предложения. Отправь /panenka заново или укажи ID: /panenka 42.",
      );
      return true;
    }
    await doLink(db, api, msg, userId, Number(pending.player.id));
    return true;
  }

  if (["no", "n", "нет", "cancel"].includes(arg)) {
    pendingPanenka.delete(userId);
    await api.sendMessage(
      chatId,
      `Ок, отмена. Укажи свой ID: /panenka 42. ID можно найти на ${profileUrl()}.`,
    );
    return true;
  }

  if (arg && /^\d+$/.test(arg)) {
    await handleById(db, api, msg, userId, Number(arg));
    return true;
  }

  if (arg) {
    await api.sendMessage(
      chatId,
      "Не понял. Использование: /panenka, /panenka 42, /panenka yes, /panenka off.",
    );
    return true;
  }

  // Bare /panenka
  let existing: PanenkaPlayer | null = null;
  try {
    const res = await botGet({ telegramUserId: userId });
    existing = res.player ?? null;
  } catch (err) {
    console.error(
      "[panenka-bot] self lookup failed:",
      err instanceof Error ? err.message : err,
    );
    await api.sendMessage(chatId, "Не могу связаться с panenka.games, попробуй позже.");
    return true;
  }
  if (existing) {
    await api.sendMessage(
      chatId,
      `Этот Telegram уже привязан к ${playerLine(existing)}.\nОтвязать: /panenka off.`,
    );
    return true;
  }

  const tgUsername = (from.username || "").trim();
  if (tgUsername) {
    let candidate: PanenkaPlayer | null = null;
    try {
      const res = await botGet({ nickname: tgUsername });
      candidate = res.player ?? null;
    } catch (err) {
      console.error(
        "[panenka-bot] nick lookup failed:",
        err instanceof Error ? err.message : err,
      );
    }
    if (candidate) {
      if (candidate.telegramLinked) {
        await api.sendMessage(
          chatId,
          `Никнейм @${tgUsername} найден: ${playerLine(candidate)}, но к нему уже привязан другой Telegram. Введи свой ID вручную: /panenka N. ID тут: ${profileUrl()}.`,
        );
        return true;
      }
      pendingPanenka.set(userId, { player: candidate, at: Date.now() });
      await api.sendMessage(
        chatId,
        `Нашёл по никнейму @${tgUsername}: ${playerLine(candidate)}.\nЭто ты? Подтверди: /panenka yes, отмена: /panenka no, или укажи свой ID: /panenka 42.`,
      );
      return true;
    }
  }

  const hint = tgUsername
    ? `Не нашёл никнейм @${tgUsername} на ${playersUrl()}. `
    : "У этого Telegram нет @username. ";
  await api.sendMessage(
    chatId,
    `${hint}Введи свой ID вручную: /panenka 42. ID можно найти на ${profileUrl()}.`,
  );
  return true;
}
