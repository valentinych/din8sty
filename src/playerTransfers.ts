/**
 * player_transfers table + helpers.
 * Source: Transfermarkt ceapi transferHistory (cached in din8sty.db).
 */
import type Database from "better-sqlite3";

export type PlayerTransfer = {
  player_id: string;
  transfer_id: string | null;
  season: string | null;
  date: string | null;
  from_club_id: string | null;
  from_club_name: string | null;
  from_club_crest: string | null;
  to_club_id: string | null;
  to_club_name: string | null;
  to_club_crest: string | null;
  fee: string | null;
  market_value: string | null;
  upcoming: number;
  sort_order: number;
  synced_at: string | null;
};

export function ensurePlayerTransfersTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS player_transfers (
      player_id TEXT NOT NULL,
      transfer_id TEXT,
      season TEXT,
      date TEXT,
      from_club_id TEXT,
      from_club_name TEXT,
      from_club_crest TEXT,
      to_club_id TEXT,
      to_club_name TEXT,
      to_club_crest TEXT,
      fee TEXT,
      market_value TEXT,
      upcoming INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      synced_at TEXT,
      PRIMARY KEY (player_id, sort_order)
    );
    CREATE INDEX IF NOT EXISTS player_transfers_player ON player_transfers(player_id);
    CREATE INDEX IF NOT EXISTS player_transfers_from ON player_transfers(from_club_id);
    CREATE INDEX IF NOT EXISTS player_transfers_to ON player_transfers(to_club_id);
  `);
}

export function listPlayerTransfers(
  db: Database.Database,
  playerId: string,
): PlayerTransfer[] {
  const has = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='player_transfers'`)
    .get() as { ok: number } | undefined;
  if (!has) return [];
  return db
    .prepare(
      `SELECT * FROM player_transfers
       WHERE player_id = ?
       ORDER BY sort_order ASC`,
    )
    .all(playerId) as PlayerTransfer[];
}

export function playerHasTransfers(db: Database.Database, playerId: string): boolean {
  const has = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='player_transfers'`)
    .get() as { ok: number } | undefined;
  if (!has) return false;
  const row = db
    .prepare(`SELECT 1 AS ok FROM player_transfers WHERE player_id = ? LIMIT 1`)
    .get(playerId) as { ok: number } | undefined;
  return Boolean(row);
}

/** European season 2025/26 window (approx). */
export const SEASON_2526_START = "2025-07-01";
export const SEASON_2526_END = "2026-06-30";

/**
 * Clubs a player belonged to during 2025/26, derived from transfer timeline.
 * Excludes youth / special clubs when href contains markers (caller may filter further).
 */
export function clubsInSeason2526(transfers: PlayerTransfer[]): string[] {
  if (!transfers.length) return [];
  // Reconstruct tenure: sort ascending by date, walk intervals.
  const asc = [...transfers]
    .filter((t) => t.date && !t.upcoming)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (!asc.length) {
    // Fall back: any transfer tagged season 25/26.
    const ids = new Set<string>();
    for (const t of transfers) {
      if (t.season === "25/26" || t.season === "2025/26") {
        if (t.from_club_id) ids.add(t.from_club_id);
        if (t.to_club_id) ids.add(t.to_club_id);
      }
    }
    return [...ids];
  }

  type Stint = { clubId: string; start: string; end: string };
  const stints: Stint[] = [];
  // Before first transfer, player was at first.from
  const first = asc[0]!;
  if (first.from_club_id) {
    stints.push({
      clubId: first.from_club_id,
      start: "1900-01-01",
      end: first.date!,
    });
  }
  for (let i = 0; i < asc.length; i++) {
    const t = asc[i]!;
    if (!t.to_club_id) continue;
    const end = i + 1 < asc.length ? asc[i + 1]!.date! : "2099-12-31";
    stints.push({ clubId: t.to_club_id, start: t.date!, end });
  }

  const ids = new Set<string>();
  for (const s of stints) {
    // Overlap with [SEASON_2526_START, SEASON_2526_END]
    if (s.start <= SEASON_2526_END && s.end >= SEASON_2526_START) {
      ids.add(s.clubId);
    }
  }
  return [...ids];
}
