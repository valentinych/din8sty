/**
 * player_coaches table + helpers.
 * Source: Transfermarkt tmapi /player/{id}/performance-game (aggregated by coach).
 */
import type Database from "better-sqlite3";

export type PlayerCoach = {
  player_id: string;
  trainer_id: string;
  trainer_name: string | null;
  apps: number;
  first_date: string | null;
  last_date: string | null;
  sort_order: number;
  synced_at: string | null;
};

export function ensurePlayerCoachesTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS player_coaches (
      player_id TEXT NOT NULL,
      trainer_id TEXT NOT NULL,
      trainer_name TEXT,
      apps INTEGER NOT NULL DEFAULT 0,
      first_date TEXT,
      last_date TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      synced_at TEXT,
      PRIMARY KEY (player_id, trainer_id)
    );
    CREATE INDEX IF NOT EXISTS player_coaches_player ON player_coaches(player_id);
  `);
}

export function listPlayerCoaches(
  db: Database.Database,
  playerId: string,
): PlayerCoach[] {
  const has = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='player_coaches'`)
    .get() as { ok: number } | undefined;
  if (!has) return [];
  return db
    .prepare(
      `SELECT * FROM player_coaches
       WHERE player_id = ?
       ORDER BY sort_order ASC`,
    )
    .all(playerId) as PlayerCoach[];
}

export function playerHasCoaches(db: Database.Database, playerId: string): boolean {
  const has = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='player_coaches'`)
    .get() as { ok: number } | undefined;
  if (!has) return false;
  const row = db
    .prepare(`SELECT 1 AS ok FROM player_coaches WHERE player_id = ? LIMIT 1`)
    .get(playerId) as { ok: number } | undefined;
  return Boolean(row);
}
