/**
 * H2H draft assistant for the Din8sty Telegram bot (same token as Top-4 ping).
 *
 * /h2h — paused (no draft DMs until explicitly re-enabled)
 * Polls for turn + opponent-pick notifications are disabled.
 */
import type Database from "better-sqlite3";

const DRAFT_URL = "https://peklo.panenka.games/h2h/draft";
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

type H2hLinkRow = {
  telegram_user_id: number;
  chat_id: number;
  email: string;
  last_turn_key: string | null;
  last_pick_key: string | null;
};

type MatchRow = {
  n: number;
  fixtureId: number;
  home: string;
  away: string;
  oddsHome: number | null;
  oddsAway: number | null;
  league: string;
  date: string;
};

type MatchupState = {
  matchupId: number;
  slug: string;
  complete: boolean;
  mySlot: 1 | 2;
  myTurn: boolean;
  nextTurnIndex: number;
  pickCount: number;
  p1Label: string;
  p2Label: string;
  opponentLabel: string;
  undrafted: MatchRow[];
  lastPick: {
    clubName: string;
    home: string;
    away: string;
    byMe: boolean;
  } | null;
};

type Pending =
  | { step: "await_email"; at: number }
  | {
      step: "pick_match";
      matchupId: number;
      slug: string;
      matches: MatchRow[];
      at: number;
    }
  | {
      step: "pick_side";
      matchupId: number;
      slug: string;
      matches: MatchRow[];
      selected: MatchRow;
      at: number;
    };

const pendingH2h = new Map<number, Pending>();

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

async function botGet(
  action: "draft" | "notify",
  email: string,
): Promise<Record<string, unknown>> {
  const secret = botSecret();
  if (!secret) throw new Error("H2H_BOT_SECRET missing");
  const url = new URL("/api/h2h/bot", panenkaOrigin());
  url.searchParams.set("action", action);
  url.searchParams.set("email", email);
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

async function botPick(opts: {
  email: string;
  matchupId: number;
  fixtureId: number;
  side: "home" | "away";
}): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const secret = botSecret();
  if (!secret) return { ok: false, error: "H2H_BOT_SECRET missing" };
  const res = await fetch(new URL("/api/h2h/bot", panenkaOrigin()), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-H2H-Bot-Secret": secret,
    },
    body: JSON.stringify({ action: "pick", ...opts }),
  });
  return (await res.json()) as {
    ok: true;
    message: string;
  } | { ok: false; error: string };
}

export function ensureH2hBotTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS h2h_telegram_links (
      telegram_user_id INTEGER PRIMARY KEY,
      chat_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      last_turn_key TEXT,
      last_pick_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_h2h_telegram_links_email
      ON h2h_telegram_links (email);
  `);
  // Optional username for LC badges / contact display.
  try {
    db.exec(`ALTER TABLE h2h_telegram_links ADD COLUMN tg_username TEXT`);
  } catch {
    /* already present */
  }
}

function getH2hLink(db: Database.Database, telegramUserId: number): H2hLinkRow | null {
  return (
    (db
      .prepare(
        `SELECT telegram_user_id, chat_id, email, last_turn_key, last_pick_key
         FROM h2h_telegram_links WHERE telegram_user_id = ?`,
      )
      .get(telegramUserId) as H2hLinkRow | undefined) ?? null
  );
}

function listH2hLinks(db: Database.Database): H2hLinkRow[] {
  return db
    .prepare(
      `SELECT telegram_user_id, chat_id, email, last_turn_key, last_pick_key
       FROM h2h_telegram_links`,
    )
    .all() as H2hLinkRow[];
}

function upsertH2hLink(
  db: Database.Database,
  opts: {
    telegramUserId: number;
    chatId: number;
    email: string;
    tgUsername?: string | null;
  },
): void {
  const now = new Date().toISOString();
  const tg = opts.tgUsername?.replace(/^@/, "").trim() || null;
  db.prepare(
    `INSERT INTO h2h_telegram_links
       (telegram_user_id, chat_id, email, last_turn_key, last_pick_key, created_at, updated_at, tg_username)
     VALUES (?, ?, ?, NULL, NULL, ?, ?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET
       chat_id = excluded.chat_id,
       email = excluded.email,
       updated_at = excluded.updated_at,
       tg_username = COALESCE(excluded.tg_username, h2h_telegram_links.tg_username)`,
  ).run(opts.telegramUserId, opts.chatId, opts.email.toLowerCase(), now, now, tg);
}

/** Per-matchup dedupe maps stored as JSON in last_*_key (legacy single key supported). */
function parseKeyMap(raw: string | null): Record<string, string> {
  if (!raw) return {};
  if (raw.startsWith("{")) {
    try {
      const o = JSON.parse(raw) as Record<string, unknown>;
      if (!o || typeof o !== "object" || Array.isArray(o)) return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    } catch {
      return {};
    }
  }
  const m = /^(\d+):/.exec(raw);
  return m ? { [m[1]]: raw } : {};
}

function serializeKeyMap(map: Record<string, string>): string {
  return JSON.stringify(map);
}

function updateNotifyKeyMaps(
  db: Database.Database,
  telegramUserId: number,
  turnMap: Record<string, string> | null,
  pickMap: Record<string, string> | null,
): void {
  db.prepare(
    `UPDATE h2h_telegram_links
     SET last_turn_key = COALESCE(?, last_turn_key),
         last_pick_key = COALESCE(?, last_pick_key),
         updated_at = ?
     WHERE telegram_user_id = ?`,
  ).run(
    turnMap ? serializeKeyMap(turnMap) : null,
    pickMap ? serializeKeyMap(pickMap) : null,
    new Date().toISOString(),
    telegramUserId,
  );
}

function formatOdds(n: number | null): string {
  return n != null && Number.isFinite(n) ? n.toFixed(2) : "—";
}

function formatMatchList(matches: MatchRow[]): string {
  if (!matches.length) return "Свободных матчей нет.";
  return matches
    .map(
      (m) =>
        `${m.n}. ${formatOdds(m.oddsHome)} ${m.home} — ${m.away} ${formatOdds(m.oddsAway)} (${m.league})`,
    )
    .join("\n");
}

function formatSidePrompt(m: MatchRow): string {
  return (
    `Матч:\n${formatOdds(m.oddsHome)} ${m.home} — ${m.away} ${formatOdds(m.oddsAway)}\n\n` +
    `1 = ${m.home} (${formatOdds(m.oddsHome)})\n` +
    `2 = ${m.away} (${formatOdds(m.oddsAway)})\n` +
    `0 = назад к списку`
  );
}

function purgeStalePending(userId: number): void {
  const p = pendingH2h.get(userId);
  if (p && Date.now() - p.at > PENDING_TTL_MS) pendingH2h.delete(userId);
}

async function loadPrimaryMatchup(email: string): Promise<MatchupState | null> {
  const data = await botGet("draft", email);
  const matchups = (data.matchups as MatchupState[]) ?? [];
  const open = matchups.find((m) => !m.complete && m.myTurn);
  if (open) return open;
  const incomplete = matchups.find((m) => !m.complete);
  return incomplete ?? matchups[0] ?? null;
}

async function sendTurnBoard(
  api: TelegramApiLike,
  chatId: number,
  m: MatchupState,
): Promise<void> {
  const header =
    `H2H ${m.slug.toUpperCase()} · пара #${m.matchupId}\n` +
    `${m.p1Label} vs ${m.p2Label}\n` +
    (m.complete
      ? "Драфт завершён.\n"
      : m.myTurn
        ? `Твой ход (пик ${m.pickCount + 1}/8).\n`
        : `Ход соперника (${m.opponentLabel}).\n`) +
    `${DRAFT_URL}?gw=${m.slug}&matchup=${m.matchupId}\n\n`;
  if (!m.myTurn || m.complete) {
    await api.sendMessage(chatId, header + (m.lastPick ? `Последний пик: ${m.lastPick.byMe ? "ты" : "соперник"} — ${m.lastPick.clubName}` : ""));
    return;
  }
  await api.sendMessage(
    chatId,
    header +
      "Выбери матч цифрой:\n" +
      formatMatchList(m.undrafted) +
      "\n\n0 = отмена",
  );
}

export async function handleH2hMessage(
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

  // H2H draft DMs off until explicitly re-enabled.
  if (cmd === "/h2h" || pendingH2h.has(userId)) {
    pendingH2h.delete(userId);
    await api.sendMessage(chatId, "Драфт H2H на паузе");
    return true;
  }

  // /start /help — let Top-4 handler own; only claim /h2h*
  if (cmd === "/h2h") {
    const emailArg = parts[1]?.trim();
    if (emailArg?.includes("@")) {
      upsertH2hLink(db, {
        telegramUserId: userId,
        chatId,
        email: emailArg,
        tgUsername: from.username ?? null,
      });
      pendingH2h.delete(userId);
      try {
        const m = await loadPrimaryMatchup(emailArg.toLowerCase());
        await api.sendMessage(
          chatId,
          `H2H: привязан ${emailArg.toLowerCase()}.`,
        );
        if (!m) {
          await api.sendMessage(
            chatId,
            "Пока нет опубликованных дуэлей с этим email. Когда админ добавит пару — придёт пинг.",
          );
        } else {
          pendingH2h.set(userId, {
            step: "pick_match",
            matchupId: m.matchupId,
            slug: m.slug,
            matches: m.undrafted,
            at: Date.now(),
          });
          await sendTurnBoard(api, chatId, m);
        }
      } catch (err) {
        await api.sendMessage(
          chatId,
          `Привязал email, но не смог загрузить драфт: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return true;
    }

    const link = getH2hLink(db, userId);
    if (!link) {
      pendingH2h.set(userId, { step: "await_email", at: Date.now() });
      await api.sendMessage(
        chatId,
        "H2H драфт (Пекло).\nПришли email, которым тебя добавили в пару на peklo.panenka.games/h2h — или:\n/h2h you@email.com",
      );
      return true;
    }

    try {
      const m = await loadPrimaryMatchup(link.email);
      if (!m) {
        await api.sendMessage(chatId, `Привязка: ${link.email}\nАктивных дуэлей нет.`);
        return true;
      }
      pendingH2h.set(userId, {
        step: "pick_match",
        matchupId: m.matchupId,
        slug: m.slug,
        matches: m.undrafted,
        at: Date.now(),
      });
      await sendTurnBoard(api, chatId, m);
    } catch (err) {
      await api.sendMessage(
        chatId,
        `Ошибка загрузки: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return true;
  }

  const pending = pendingH2h.get(userId);
  const link = getH2hLink(db, userId);

  if (pending?.step === "await_email") {
    if (!raw.includes("@")) {
      await api.sendMessage(chatId, "Нужен email, например name@gmail.com (или 0 = отмена)");
      if (raw === "0") pendingH2h.delete(userId);
      return true;
    }
    if (raw === "0") {
      pendingH2h.delete(userId);
      await api.sendMessage(chatId, "Отменено.");
      return true;
    }
    upsertH2hLink(db, {
      telegramUserId: userId,
      chatId,
      email: raw,
      tgUsername: from.username ?? null,
    });
    pendingH2h.delete(userId);
    await api.sendMessage(chatId, `Привязан ${raw.toLowerCase()}. Открой /h2h`);
    return true;
  }

  // Numeric flow for draft
  if (pending && (pending.step === "pick_match" || pending.step === "pick_side")) {
    if (!/^-?\d+$/.test(raw)) {
      // not a number — don't steal other commands
      if (cmd.startsWith("/")) return false;
      await api.sendMessage(
        chatId,
        pending.step === "pick_side"
          ? "1 или 2 — выбрать клуб, 0 — назад"
          : "Номер матча из списка, 0 — отмена, /h2h — обновить",
      );
      return true;
    }
    const n = Number(raw);

    if (pending.step === "pick_side") {
      if (n === 0) {
        pendingH2h.set(userId, {
          step: "pick_match",
          matchupId: pending.matchupId,
          slug: pending.slug,
          matches: pending.matches,
          at: Date.now(),
        });
        await api.sendMessage(
          chatId,
          "Список матчей:\n" + formatMatchList(pending.matches) + "\n\n0 = отмена",
        );
        return true;
      }
      if (n !== 1 && n !== 2) {
        await api.sendMessage(chatId, "1 = хозяева, 2 = гости, 0 = назад");
        return true;
      }
      if (!link) {
        await api.sendMessage(chatId, "Сначала /h2h и привязка email");
        return true;
      }
      const side = n === 1 ? "home" : "away";
      const res = await botPick({
        email: link.email,
        matchupId: pending.matchupId,
        fixtureId: pending.selected.fixtureId,
        side,
      });
      if (!res.ok) {
        await api.sendMessage(chatId, res.error);
        return true;
      }
      pendingH2h.delete(userId);
      await api.sendMessage(chatId, res.message);
      try {
        const m = await loadPrimaryMatchup(link.email);
        if (m && !m.complete) {
          pendingH2h.set(userId, {
            step: "pick_match",
            matchupId: m.matchupId,
            slug: m.slug,
            matches: m.undrafted,
            at: Date.now(),
          });
          if (m.myTurn) await sendTurnBoard(api, chatId, m);
        }
      } catch {
        /* ignore */
      }
      return true;
    }

    // pick_match
    if (n === 0) {
      pendingH2h.delete(userId);
      await api.sendMessage(chatId, "Ок, вышел из выбора. /h2h — снова.");
      return true;
    }
    const selected = pending.matches.find((m) => m.n === n);
    if (!selected) {
      await api.sendMessage(chatId, `Нет пункта ${n}. Выбери номер из списка или 0.`);
      return true;
    }
    pendingH2h.set(userId, {
      step: "pick_side",
      matchupId: pending.matchupId,
      slug: pending.slug,
      matches: pending.matches,
      selected,
      at: Date.now(),
    });
    await api.sendMessage(chatId, formatSidePrompt(selected));
    return true;
  }

  return false;
}

export async function checkH2hNotifications(
  _db: Database.Database,
  _api: TelegramApiLike,
): Promise<void> {
  // H2H draft DMs off until explicitly re-enabled.
  // Do not poll /api/h2h/bot or send turn boards / "Твой ход" from here.
  return;
}

export function h2hHelpLine(): string {
  return "/h2h — драфт H2H (Пекло): привязка email, пики цифрами, 0 = назад";
}
