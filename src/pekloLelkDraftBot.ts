/**
 * Peklo ЛЄ+ЛК 2026/27 club draft via @draftmantra_bot.
 *
 * /reglelk — register if TG @nick (or id) matches LELK roster
 * LE/LK turn: bot sends remaining clubs; reply with club code
 * After LE: lower Σ picks LK snake seat (reply 1–6)
 */
import type Database from "better-sqlite3";

const PAGE_URL = "https://peklo.panenka.games/lelk-2026-27";
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
  lkSeatsTaken: number[];
  lkQueueRemaining: number[];
  managers: Array<{
    seat: number;
    name: string;
    registered: boolean;
    lkSnakeSeat: number | null;
    leRatingSum: number;
    lkRatingSum: number;
    lePicks: Array<{ code: string }>;
    lkPicks: Array<{ code: string }>;
  }>;
  remaining: Array<{ code: string; name: string; rating: number }>;
};

const pendingTurn = new Map<number, { at: number; kind: "club" | "lk_seat" }>();

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
  const url = new URL("/api/peklo/lelk-draft/bot", panenkaOrigin());
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
  const res = await fetch(new URL("/api/peklo/lelk-draft/bot", panenkaOrigin()), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-H2H-Bot-Secret": secret,
    },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
}

export function ensurePekloLelkBotTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS peklo_lelk_telegram_links (
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
    `INSERT INTO peklo_lelk_telegram_links
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
         FROM peklo_lelk_telegram_links WHERE telegram_user_id = ?`,
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
      `UPDATE peklo_lelk_telegram_links SET last_turn_key = ?, updated_at = ? WHERE telegram_user_id = ?`,
    ).run(keys.turnKey, now, userId);
  }
  if (keys.pickKey != null) {
    db.prepare(
      `UPDATE peklo_lelk_telegram_links SET last_pick_key = ?, updated_at = ? WHERE telegram_user_id = ?`,
    ).run(keys.pickKey, now, userId);
  }
}

function formatRemaining(board: Board): string {
  return board.remaining
    .map((c) => `${c.code} ${c.name} ${c.rating.toFixed(3)}`)
    .join("\n");
}

function formatSummary(board: Board): string {
  const phaseLabel =
    board.status === "ready"
      ? "старт"
      : board.status === "le"
        ? `ЛЄ ${board.pickIndex}/36`
        : board.status === "lk_queue"
          ? `выбор № ЛК (${board.lkSeatsTaken.length}/6)`
          : board.status === "lk"
            ? `ЛК ${board.pickIndex}/36`
            : "готово";
  const lines = [`Группа ${board.groupId} · ${phaseLabel}`];
  if (board.onClockName) {
    lines.push(
      board.status === "lk_queue"
        ? `Выбирает номер: ${board.onClockName}`
        : `Ход: ${board.onClockName}`,
    );
  }
  for (const m of board.managers) {
    const le = m.lePicks.map((p) => p.code).join(" ") || "—";
    const lk = m.lkPicks.map((p) => p.code).join(" ") || "—";
    const lkN = m.lkSnakeSeat != null ? ` №${m.lkSnakeSeat}` : "";
    lines.push(
      `${m.registered ? "✓" : "…"} ${m.seat}. ${m.name}${lkN} ΣLE ${m.leRatingSum.toFixed(3)}: ${le}`,
    );
    if (
      m.lkPicks.length ||
      board.status === "lk" ||
      board.status === "complete"
    ) {
      lines.push(`   ΣLK ${m.lkRatingSum.toFixed(3)}: ${lk}`);
    }
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

async function sendClubTurn(
  api: TelegramApiLike,
  chatId: number,
  board: Board,
): Promise<void> {
  const label = board.status === "lk" ? "ЛК" : "ЛЄ";
  const text = [
    `Твой ход в драфте ${label} 2026/27.`,
    formatSummary(board),
    "",
    "Оставшиеся клубы (код · клуб · рейтинг UEFA):",
    formatRemaining(board),
    "",
    "Ответь кодом клуба, например: B04",
    PAGE_URL,
  ].join("\n");
  if (text.length <= 4000) {
    await api.sendMessage(chatId, text);
    return;
  }
  await api.sendMessage(
    chatId,
    [
      `Твой ход в драфте ${label} 2026/27.`,
      formatSummary(board),
      "",
      "Оставшиеся (код рейтинг):",
      board.remaining.map((c) => `${c.code} ${c.rating.toFixed(3)}`).join("\n"),
      "",
      "Ответь кодом, напр. B04",
      PAGE_URL,
    ].join("\n"),
  );
}

async function sendLkSeatTurn(
  api: TelegramApiLike,
  chatId: number,
  board: Board,
): Promise<void> {
  const taken = board.lkSeatsTaken.length
    ? board.lkSeatsTaken.join(", ")
    : "пока никто";
  await api.sendMessage(
    chatId,
    [
      "ЛЄ завершена. Выбери номер (1–6) в змейке ЛК.",
      "Меньшая Σ рейтинга ЛЄ выбирает раньше.",
      formatSummary(board),
      "",
      `Уже заняты: ${taken}`,
      "Ответь одной цифрой 1–6.",
      PAGE_URL,
    ].join("\n"),
  );
}

async function notifyOnClock(
  db: Database.Database,
  api: TelegramApiLike,
  groupId: string,
): Promise<void> {
  const targets = (await apiGet("notify")).targets as Array<{
    telegramUserId: number;
    myTurn: boolean;
    turnKind: "club" | "lk_seat" | "none";
    board: Board;
    turnKey: string;
  }>;
  for (const t of targets) {
    if (!t.myTurn || t.board.groupId !== groupId) continue;
    if (t.turnKind === "club") {
      pendingTurn.set(t.telegramUserId, { at: Date.now(), kind: "club" });
      await sendClubTurn(api, t.telegramUserId, t.board);
    } else if (t.turnKind === "lk_seat") {
      pendingTurn.set(t.telegramUserId, { at: Date.now(), kind: "lk_seat" });
      await sendLkSeatTurn(api, t.telegramUserId, t.board);
    }
    setKeys(db, t.telegramUserId, { turnKey: t.turnKey });
  }
}

export function pekloLelkHelpLine(): string {
  return "/reglelk — опционально привязать TG к драфту ЛЄ+ЛК 2026/27 (драфт уже идёт; можно просто прислать код на своём ходу)";
}

export async function handlePekloLelkMessage(
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

  // Soft-bind on any private message from a roster @nick (no /reglelk required).
  if (msg.chat.type === "private" && username && !raw.startsWith("/")) {
    try {
      const res = await apiPost({
        action: "register",
        telegramUserId: userId,
        chatId: dmId,
        username,
      });
      if (res.ok) {
        upsertLink(db, userId, dmId);
        if (res.started) {
          await notifyOnClock(db, api, (res.board as Board).groupId);
        }
      }
    } catch {
      /* ignore — pick/lk handlers may still succeed */
    }
  }

  if (cmd === "/reglelk") {
    try {
      const res = await apiPost({
        action: "register",
        telegramUserId: userId,
        chatId: dmId,
        username,
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
      if (res.started) {
        await notifyOnClock(db, api, board.groupId);
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

  // LK seat digit 1–6
  if (/^[1-6]$/.test(raw)) {
    const link = getLink(db, userId);
    const pend = pendingTurn.get(userId);
    const likely =
      (pend && pend.kind === "lk_seat" && Date.now() - pend.at < PENDING_TTL_MS) ||
      !!link ||
      (msg.chat.type === "private" && !!username);
    if (msg.chat.type !== "private" && !link) return false;
    if (!likely && msg.chat.type !== "private") return false;
    try {
      const res = await apiPost({
        action: "lk_seat",
        telegramUserId: userId,
        lkSnakeSeat: Number(raw),
        username,
      });
      if (!res.ok) {
        const err = String(res.error ?? "");
        if (
          (err.includes("/reglelk") || err.includes("ником из ростера")) &&
          !link
        ) {
          return false;
        }
        // Not in lk_queue — don't steal digits from other bots
        if (
          err.includes("закончить драфт ЛЄ") ||
          err.includes("уже выбраны") ||
          err.includes("Сначала нужно")
        ) {
          return false;
        }
        await api.sendMessage(dmId, err || "Не удалось выбрать номер");
        return true;
      }
      upsertLink(db, userId, dmId);
      pendingTurn.delete(userId);
      const announce = String(res.announce ?? "");
      const notifyUserIds = (res.notifyChatIds as number[]) ?? [];
      const board = res.board as Board;
      const picksUntilByUserId = res.picksUntilByUserId as
        | Record<string, number>
        | undefined;
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
      if (res.lkStarted) {
        for (const uid of notifyUserIds) {
          try {
            await api.sendMessage(
              uid,
              `Все выбрали номера — стартует драфт ЛК!\n${formatSummary(board)}\n${PAGE_URL}`,
            );
          } catch {
            /* ignore */
          }
        }
      }
      await notifyOnClock(db, api, board.groupId);
      return true;
    } catch {
      return false;
    }
  }

  // Club code pick: 2–4 letters
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const looksLikeCode =
    !raw.startsWith("/") &&
    code.length >= 2 &&
    code.length <= 4 &&
    /^[A-Z0-9]+$/.test(code);

  if (looksLikeCode) {
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
        username,
      });
      if (!res.ok) {
        const err = String(res.error ?? "");
        if (
          (err.includes("/reglelk") || err.includes("ником из ростера")) &&
          !link
        ) {
          return false;
        }
        // Not their LELK turn / wrong phase — let LC handler try
        if (
          err.includes("Сейчас ходит") ||
          err.includes("выбор номера") ||
          err.includes("ещё не начался") ||
          err.includes("уже завершён")
        ) {
          return false;
        }
        await api.sendMessage(dmId, err || "Не удалось пикнуть");
        return true;
      }
      upsertLink(db, userId, dmId);
      pendingTurn.delete(userId);
      const announce = String(res.announce ?? "");
      const notifyUserIds = (res.notifyChatIds as number[]) ?? [];
      const board = res.board as Board;
      const picksUntilByUserId = res.picksUntilByUserId as
        | Record<string, number>
        | undefined;
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
      if (res.phaseChanged === "lk_queue") {
        for (const uid of notifyUserIds) {
          try {
            await api.sendMessage(
              uid,
              `Драфт ЛЄ группы ${board.groupId} завершён. Дальше — выбор номера для змейки ЛК (меньшая Σ раньше).\n${formatSummary(board)}\n${PAGE_URL}`,
            );
          } catch {
            /* ignore */
          }
        }
      } else if (res.phaseChanged === "complete") {
        for (const uid of notifyUserIds) {
          try {
            await api.sendMessage(
              uid,
              `Драфт ЛЄ+ЛК группы ${board.groupId} завершён.\n${formatSummary(board)}\n${PAGE_URL}`,
            );
          } catch {
            /* ignore */
          }
        }
      }
      await notifyOnClock(db, api, board.groupId);
      return true;
    } catch {
      return false;
    }
  }

  if (msg.chat.type !== "private") return false;
  const pend = pendingTurn.get(userId);
  if (pend && Date.now() - pend.at < PENDING_TTL_MS && !raw.startsWith("/")) {
    if (pend.kind === "lk_seat") {
      await api.sendMessage(dmId, "Пришли цифру 1–6 для змейки ЛК.");
    } else {
      await api.sendMessage(
        dmId,
        "Пришли код клуба из списка (например B04).",
      );
    }
    return true;
  }

  return false;
}

export async function checkPekloLelkNotifications(
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
    turnKind: "club" | "lk_seat" | "none";
  }>) ?? [];

  for (const t of targets) {
    const dmId = t.telegramUserId;
    upsertLink(db, t.telegramUserId, dmId);
    const link = getLink(db, t.telegramUserId);
    if (!link) continue;

    if (t.myTurn && link.last_turn_key !== t.turnKey) {
      try {
        if (t.turnKind === "club") {
          pendingTurn.set(t.telegramUserId, { at: Date.now(), kind: "club" });
          await sendClubTurn(api, dmId, t.board);
        } else if (t.turnKind === "lk_seat") {
          pendingTurn.set(t.telegramUserId, {
            at: Date.now(),
            kind: "lk_seat",
          });
          await sendLkSeatTurn(api, dmId, t.board);
        }
        setKeys(db, t.telegramUserId, { turnKey: t.turnKey });
      } catch (err) {
        console.error(
          "[peklo-lelk] turn notify:",
          err instanceof Error ? err.message : err,
        );
      }
    } else if (!t.myTurn && link.last_turn_key !== t.turnKey) {
      setKeys(db, t.telegramUserId, { turnKey: t.turnKey });
    }
  }
}
