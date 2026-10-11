/**
 * Two-phase Top-4 transfer windows.
 * On a turn: dump XOR pick. Max 5 dumps and 5 picks = 10 rounds.
 * Round order: last place → leader from overall results.
 */
import type Database from "better-sqlite3";
import { gameweekFromKickoff } from "./gameweeks.js";
import {
  isTop4LeagueId,
  TOP4_MAX_PER_CLUB,
  TOP4_MV_CAP,
  TOP4_WAGE_CAP,
} from "./top4League.js";
import { loadTop4PlayersByIds, loadTop4Pool } from "./top4Draft.js";
import { getTop4SquadsPublic, type Top4SquadPlayer } from "./top4LiveDraft.js";
import { computeTop4Results } from "./top4GwResults.js";

export const TRANSFER_WINDOW_GWS = [4, 15, 26, 37] as const;
export const TRANSFER_MAX_DUMPS = 5;
export const TRANSFER_MAX_PICKS = 5;
export const TRANSFER_ROUNDS = 10;

export type TransferWindowStatus = "closed" | "open" | "complete";

export type TransferOrderEntry = {
  team_id: number;
  email: string;
  name: string;
  code: string | null;
  total: number;
};

export type TransferMove = {
  id: number;
  after_gw: number;
  round: number;
  team_id: number;
  email: string;
  kind: "dump" | "pick" | "pass";
  player_id: string | null;
  player_name: string | null;
  at: string;
};

type WindowRow = {
  after_gw: number;
  status: TransferWindowStatus;
  order_json: string;
  current_round: number;
  current_index: number;
  opened_at: string;
  opened_by: string;
};

export function ensureTop4TransferSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS top4_transfer_windows (
      after_gw INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      order_json TEXT NOT NULL,
      current_round INTEGER NOT NULL,
      current_index INTEGER NOT NULL,
      opened_at TEXT NOT NULL,
      opened_by TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS top4_transfer_moves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      after_gw INTEGER NOT NULL,
      round INTEGER NOT NULL,
      team_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      kind TEXT NOT NULL,
      player_id TEXT,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS top4_transfer_moves_gw
      ON top4_transfer_moves(after_gw, id);
    CREATE TABLE IF NOT EXISTS top4_former_players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      after_gw INTEGER NOT NULL,
      team_id INTEGER NOT NULL,
      player_id TEXT NOT NULL,
      dumped_at TEXT NOT NULL,
      UNIQUE(team_id, player_id, after_gw)
    );
    CREATE INDEX IF NOT EXISTS top4_former_players_team
      ON top4_former_players(team_id, player_id);
  `);
  backfillFormerFromDumps(db);
}

function backfillFormerFromDumps(db: Database.Database): void {
  db.prepare(
    `INSERT OR IGNORE INTO top4_former_players (after_gw, team_id, player_id, dumped_at)
     SELECT after_gw, team_id, player_id, at
     FROM top4_transfer_moves
     WHERE kind = 'dump' AND player_id IS NOT NULL`,
  ).run();
}

export function previewTransferGw(now = new Date()): number | null {
  const gw = Math.max(1, gameweekFromKickoff(now));
  return (TRANSFER_WINDOW_GWS as readonly number[]).includes(gw) ? gw : null;
}

function getWindow(db: Database.Database, afterGw: number): WindowRow | null {
  return (
    (db
      .prepare(
        `SELECT after_gw, status, order_json, current_round, current_index,
                opened_at, opened_by
         FROM top4_transfer_windows WHERE after_gw = ?`,
      )
      .get(afterGw) as WindowRow | undefined) ?? null
  );
}

function openWindowRow(db: Database.Database): WindowRow | null {
  return (
    (db
      .prepare(
        `SELECT after_gw, status, order_json, current_round, current_index,
                opened_at, opened_by
         FROM top4_transfer_windows WHERE status = 'open' LIMIT 1`,
      )
      .get() as WindowRow | undefined) ?? null
  );
}

function parseOrder(raw: string): TransferOrderEntry[] {
  try {
    const parsed = JSON.parse(raw) as TransferOrderEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function standingsLastToFirst(db: Database.Database): TransferOrderEntry[] {
  const results = computeTop4Results(db);
  const squads = getTop4SquadsPublic(db);
  const emailById = new Map(
    squads.teams.map((t) => [t.team_id, t.email] as const),
  );
  return results.teams
    .slice()
    .sort((a, b) => {
      if (a.total !== b.total) return a.total - b.total;
      return String(a.code || a.name).localeCompare(String(b.code || b.name));
    })
    .map((t) => ({
      team_id: t.team_id,
      email: emailById.get(t.team_id) || "",
      name: t.name,
      code: t.code ?? null,
      total: t.total,
    }))
    .filter((t) => t.email);
}

function countsForTeam(
  db: Database.Database,
  afterGw: number,
  teamId: number,
): { dumps: number; picks: number } {
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN kind = 'dump' THEN 1 ELSE 0 END) AS dumps,
         SUM(CASE WHEN kind = 'pick' THEN 1 ELSE 0 END) AS picks
       FROM top4_transfer_moves WHERE after_gw = ? AND team_id = ?`,
    )
    .get(afterGw, teamId) as { dumps: number | null; picks: number | null };
  return { dumps: Number(row?.dumps) || 0, picks: Number(row?.picks) || 0 };
}

function listMoves(db: Database.Database, afterGw: number): TransferMove[] {
  const rows = db
    .prepare(
      `SELECT id, after_gw, round, team_id, email, kind, player_id, at
       FROM top4_transfer_moves WHERE after_gw = ? ORDER BY id ASC`,
    )
    .all(afterGw) as Array<
    Omit<TransferMove, "player_name"> & { player_id: string | null }
  >;
  const ids = rows.map((r) => r.player_id).filter((id): id is string => Boolean(id));
  const names = new Map(
    loadTop4PlayersByIds(db, ids).map((p) => [p.id, p.name] as const),
  );
  return rows.map((r) => ({
    ...r,
    kind: r.kind as TransferMove["kind"],
    player_name: r.player_id ? names.get(r.player_id) ?? r.player_id : null,
  }));
}

function rosterSums(players: Top4SquadPlayer[]) {
  let mv = 0;
  let wage = 0;
  const clubs = new Map<string, number>();
  for (const p of players) {
    mv += Number(p.market_value_eur) || 0;
    wage += Number(p.wage_pw) || 0;
    if (p.club_id) clubs.set(p.club_id, (clubs.get(p.club_id) ?? 0) + 1);
  }
  return { mv, wage, clubs };
}

function dropPlayerFromFutureLineups(
  db: Database.Database,
  playerId: string,
  afterGw: number,
): void {
  const exists = db
    .prepare(
      `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'top4_lineups'`,
    )
    .get() as { ok: number } | undefined;
  if (!exists) return;
  const rows = db
    .prepare(`SELECT team_id, gw, slots_json FROM top4_lineups WHERE gw > ?`)
    .all(afterGw) as Array<{ team_id: number; gw: number; slots_json: string }>;
  const upd = db.prepare(
    `UPDATE top4_lineups SET slots_json = ? WHERE team_id = ? AND gw = ?`,
  );
  const strip = (id: unknown) =>
    id == null || String(id) === playerId ? null : id;
  for (const row of rows) {
    if (!row.slots_json.includes(playerId)) continue;
    try {
      const parsed = JSON.parse(row.slots_json) as unknown;
      if (Array.isArray(parsed)) {
        upd.run(JSON.stringify(parsed.map(strip)), row.team_id, row.gw);
        continue;
      }
      if (parsed && typeof parsed === "object") {
        const obj = parsed as {
          slots?: unknown[];
          players?: unknown[];
          bench?: unknown[];
        };
        if (Array.isArray(obj.slots)) obj.slots = obj.slots.map(strip);
        if (Array.isArray(obj.players)) obj.players = obj.players.map(strip);
        if (Array.isArray(obj.bench)) obj.bench = obj.bench.map(strip);
        upd.run(JSON.stringify(obj), row.team_id, row.gw);
      }
    } catch {
      /* leave lineup */
    }
  }
}

function onClock(win: WindowRow): TransferOrderEntry | null {
  const order = parseOrder(win.order_json);
  return order[win.current_index] ?? null;
}

function advanceTurn(db: Database.Database, win: WindowRow): WindowRow {
  const order = parseOrder(win.order_json);
  let round = win.current_round;
  let index = win.current_index + 1;
  if (index >= order.length) {
    index = 0;
    round += 1;
  }
  const status: TransferWindowStatus =
    round > TRANSFER_ROUNDS ? "complete" : "open";
  const nextRound = status === "complete" ? TRANSFER_ROUNDS : round;
  const nextIndex = status === "complete" ? Math.max(0, order.length - 1) : index;
  db.prepare(
    `UPDATE top4_transfer_windows
     SET status = ?, current_round = ?, current_index = ?
     WHERE after_gw = ?`,
  ).run(status, nextRound, nextIndex, win.after_gw);
  return {
    ...win,
    status,
    current_round: nextRound,
    current_index: nextIndex,
  };
}

function requireOnClock(
  db: Database.Database,
  email: string,
): { win: WindowRow; clock: TransferOrderEntry } {
  const win = openWindowRow(db);
  if (!win) throw new Error("window_not_open");
  const clock = onClock(win);
  if (!clock) throw new Error("window_not_open");
  if (clock.email.toLowerCase() !== email.toLowerCase()) {
    throw new Error("not_your_turn");
  }
  return { win, clock };
}

export function openTransferWindow(
  db: Database.Database,
  adminEmail: string,
  now = new Date(),
): WindowRow {
  ensureTop4TransferSchema(db);
  const gw = previewTransferGw(now);
  if (gw == null) throw new Error("window_not_preview");
  const existing = getWindow(db, gw);
  if (existing?.status === "open") throw new Error("window_already_open");
  if (existing?.status === "complete") throw new Error("window_complete");
  const order = standingsLastToFirst(db);
  if (!order.length) throw new Error("no_standings");
  const openedAt = now.toISOString();
  db.prepare(
    `INSERT INTO top4_transfer_windows
       (after_gw, status, order_json, current_round, current_index, opened_at, opened_by)
     VALUES (?, 'open', ?, 1, 0, ?, ?)`,
  ).run(gw, JSON.stringify(order), openedAt, adminEmail.toLowerCase());
  return getWindow(db, gw)!;
}

function insertMove(
  db: Database.Database,
  win: WindowRow,
  clock: TransferOrderEntry,
  kind: TransferMove["kind"],
  playerId: string | null,
): void {
  db.prepare(
    `INSERT INTO top4_transfer_moves
       (after_gw, round, team_id, email, kind, player_id, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    win.after_gw,
    win.current_round,
    clock.team_id,
    clock.email.toLowerCase(),
    kind,
    playerId,
    new Date().toISOString(),
  );
}

export function dumpTransferPlayer(
  db: Database.Database,
  email: string,
  playerId: string,
): void {
  ensureTop4TransferSchema(db);
  const id = String(playerId || "").trim();
  if (!id) throw new Error("player_id_required");
  const { win, clock } = requireOnClock(db, email);
  const used = countsForTeam(db, win.after_gw, clock.team_id);
  if (used.dumps >= TRANSFER_MAX_DUMPS) throw new Error("dump_limit");
  const pick = db
    .prepare(
      `SELECT pick_number, team_id, player_id FROM top4_draft_picks
       WHERE player_id = ? AND team_id = ?`,
    )
    .get(id, clock.team_id) as
    | { pick_number: number; team_id: number; player_id: string }
    | undefined;
  if (!pick) throw new Error("player_not_on_roster");
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM top4_draft_picks WHERE pick_number = ?`).run(
      pick.pick_number,
    );
    dropPlayerFromFutureLineups(db, id, win.after_gw);
    db.prepare(
      `INSERT OR IGNORE INTO top4_former_players
         (after_gw, team_id, player_id, dumped_at)
       VALUES (?, ?, ?, ?)`,
    ).run(win.after_gw, clock.team_id, id, new Date().toISOString());
    insertMove(db, win, clock, "dump", id);
    advanceTurn(db, win);
  });
  tx();
}

export function pickTransferPlayer(
  db: Database.Database,
  email: string,
  playerId: string,
): void {
  ensureTop4TransferSchema(db);
  const id = String(playerId || "").trim();
  if (!id) throw new Error("player_id_required");
  const { win, clock } = requireOnClock(db, email);
  const used = countsForTeam(db, win.after_gw, clock.team_id);
  if (used.picks >= TRANSFER_MAX_PICKS) throw new Error("pick_limit");
  const taken = db
    .prepare(`SELECT team_id FROM top4_draft_picks WHERE player_id = ?`)
    .get(id) as { team_id: number } | undefined;
  if (taken) throw new Error("player_taken");
  const pool = new Map(loadTop4Pool(db).map((p) => [p.id, p]));
  const player = pool.get(id);
  if (!player || !isTop4LeagueId(player.league_id)) {
    throw new Error("player_not_eligible");
  }
  const squads = getTop4SquadsPublic(db);
  const team = squads.teams.find((t) => t.team_id === clock.team_id);
  if (!team) throw new Error("team_not_found");
  const sums = rosterSums(team.players);
  if (sums.mv + player.market_value_eur > TOP4_MV_CAP) {
    throw new Error("over_mv");
  }
  if (sums.wage + player.wage_pw > TOP4_WAGE_CAP) {
    throw new Error("over_wage");
  }
  if (
    player.club_id &&
    (sums.clubs.get(player.club_id) ?? 0) + 1 > TOP4_MAX_PER_CLUB
  ) {
    throw new Error("club_limit");
  }
  const maxPick = (
    db.prepare(`SELECT COALESCE(MAX(pick_number), 0) AS n FROM top4_draft_picks`)
      .get() as { n: number }
  ).n;
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO top4_draft_picks
         (pick_number, team_id, email, player_id, auto, picked_at, set_by)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      maxPick + 1,
      clock.team_id,
      clock.email.toLowerCase(),
      id,
      new Date().toISOString(),
      "transfer",
    );
    insertMove(db, win, clock, "pick", id);
    advanceTurn(db, win);
  });
  tx();
}

export function passTransferTurn(db: Database.Database, email: string): void {
  ensureTop4TransferSchema(db);
  const { win, clock } = requireOnClock(db, email);
  const tx = db.transaction(() => {
    insertMove(db, win, clock, "pass", null);
    advanceTurn(db, win);
  });
  tx();
}

/** Admin: pass whoever is on the clock (does not consume dump/pick). */
export function adminPassCurrentTurn(db: Database.Database): void {
  ensureTop4TransferSchema(db);
  const win = openWindowRow(db);
  if (!win) throw new Error("window_not_open");
  const clock = onClock(win);
  if (!clock) throw new Error("window_not_open");
  const tx = db.transaction(() => {
    insertMove(db, win, clock, "pass", null);
    advanceTurn(db, win);
  });
  tx();
}

export function getTransferSummary(
  db: Database.Database,
  opts: { isAdmin: boolean; now?: Date },
) {
  ensureTop4TransferSchema(db);
  const now = opts.now ?? new Date();
  const currentGw = Math.max(1, gameweekFromKickoff(now));
  const previewGw = previewTransferGw(now);
  const open = openWindowRow(db);
  const previewRow = previewGw != null ? getWindow(db, previewGw) : null;
  const canOpen = Boolean(
    opts.isAdmin &&
      previewGw != null &&
      previewRow?.status !== "open" &&
      previewRow?.status !== "complete",
  );
  return {
    current_gw: currentGw,
    preview_gw: previewGw,
    is_admin: opts.isAdmin,
    can_open: canOpen,
    window: open
      ? {
          after_gw: open.after_gw,
          status: open.status,
          round: open.current_round,
          rounds: TRANSFER_ROUNDS,
          on_clock: onClock(open),
        }
      : previewRow?.status === "complete"
        ? {
            after_gw: previewRow.after_gw,
            status: previewRow.status,
            round: previewRow.current_round,
            rounds: TRANSFER_ROUNDS,
            on_clock: null,
          }
        : null,
  };
}

export function getTransferBoard(
  db: Database.Database,
  opts: { email?: string | null; isAdmin: boolean },
) {
  ensureTop4TransferSchema(db);
  const summary = getTransferSummary(db, { isAdmin: opts.isAdmin });
  const open = openWindowRow(db);
  if (!open) {
    return {
      ...summary,
      order: [] as TransferOrderEntry[],
      moves: [] as TransferMove[],
      my: null as null,
    };
  }
  const order = parseOrder(open.order_json);
  const clock = onClock(open);
  const squads = getTop4SquadsPublic(db);
  const email = (opts.email || "").toLowerCase();
  const myTeam = squads.teams.find((t) => t.email.toLowerCase() === email);
  const myCounts = myTeam
    ? countsForTeam(db, open.after_gw, myTeam.team_id)
    : { dumps: 0, picks: 0 };
  const sums = myTeam ? rosterSums(myTeam.players) : { mv: 0, wage: 0, clubs: new Map() };
  const myTurn = Boolean(
    clock && email && clock.email.toLowerCase() === email,
  );
  return {
    ...summary,
    order,
    moves: listMoves(db, open.after_gw),
    my: myTeam
      ? {
          team_id: myTeam.team_id,
          email: myTeam.email,
          name: myTeam.team_name,
          dumps: myCounts.dumps,
          picks: myCounts.picks,
          dump_left: Math.max(0, TRANSFER_MAX_DUMPS - myCounts.dumps),
          pick_left: Math.max(0, TRANSFER_MAX_PICKS - myCounts.picks),
          mv: sums.mv,
          wage: sums.wage,
          mv_left: TOP4_MV_CAP - sums.mv,
          wage_left: TOP4_WAGE_CAP - sums.wage,
          my_turn: myTurn,
          players: myTeam.players,
        }
      : null,
  };
}

export type FormerSquadPlayer = {
  id: string;
  name: string;
  position_display: string;
  club_id: string;
  club_name: string;
  league_id: string;
  market_value_eur: number;
  wage_pw: number;
  after_gw: number;
};

/** Dumped players still off that team's current roster (latest dump per player). */
export function listFormerPlayersByTeam(
  db: Database.Database,
): Map<number, FormerSquadPlayer[]> {
  ensureTop4TransferSchema(db);
  const rows = db
    .prepare(
      `SELECT f.team_id, f.player_id, f.after_gw
       FROM top4_former_players f
       INNER JOIN (
         SELECT team_id, player_id, MAX(after_gw) AS after_gw
         FROM top4_former_players
         GROUP BY team_id, player_id
       ) latest
         ON latest.team_id = f.team_id
        AND latest.player_id = f.player_id
        AND latest.after_gw = f.after_gw
       ORDER BY f.after_gw ASC, f.id ASC`,
    )
    .all() as Array<{ team_id: number; player_id: string; after_gw: number }>;
  if (!rows.length) return new Map();
  const onRoster = new Set(
    (
      db
        .prepare(`SELECT team_id, player_id FROM top4_draft_picks`)
        .all() as Array<{ team_id: number; player_id: string }>
    ).map((p) => `${p.team_id}:${p.player_id}`),
  );
  const kept = rows.filter((r) => !onRoster.has(`${r.team_id}:${r.player_id}`));
  const byId = new Map(
    loadTop4PlayersByIds(
      db,
      kept.map((r) => r.player_id),
    ).map((p) => [p.id, p] as const),
  );
  const out = new Map<number, FormerSquadPlayer[]>();
  for (const r of kept) {
    const p = byId.get(r.player_id);
    const list = out.get(r.team_id) ?? [];
    list.push({
      id: p?.id ?? r.player_id,
      name: p?.name ?? r.player_id,
      position_display: p?.position_display ?? "",
      club_id: p?.club_id ?? "",
      club_name: p?.club_name ?? "",
      league_id: p?.league_id ?? "",
      market_value_eur: p?.market_value_eur ?? 0,
      wage_pw: p?.wage_pw ?? 0,
      after_gw: r.after_gw,
    });
    out.set(r.team_id, list);
  }
  return out;
}

export function getTransferBotView(db: Database.Database) {
  ensureTop4TransferSchema(db);
  const open = openWindowRow(db);
  return {
    window: open
      ? {
          after_gw: open.after_gw,
          status: open.status,
          round: open.current_round,
          rounds: TRANSFER_ROUNDS,
          on_clock: onClock(open),
        }
      : null,
    order: open ? parseOrder(open.order_json) : [],
    moves: open ? listMoves(db, open.after_gw) : [],
  };
}
