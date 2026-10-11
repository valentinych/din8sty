/**
 * Fetch Transfermarkt transfer history and persist into player_transfers.
 * Used by scripts/sync-transfers.ts and lazy fill on GET /api/players/:id.
 */
import type Database from "better-sqlite3";
import { deriveClubCode } from "./clubCode.js";
import {
  ensurePlayerTransfersTable,
  listPlayerTransfers,
  type PlayerTransfer,
} from "./playerTransfers.js";
import { tmEnqueue } from "./tmRateLimit.js";

/** League id for dest clubs that are not in the Top-8 `leagues` table. */
const OUTSIDE_LEAGUE = "OTH";

const CEAPI = "https://www.transfermarkt.com/ceapi/transferHistory/list";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

type CeapiClub = {
  href?: string;
  clubName?: string;
  "clubEmblem-1x"?: string;
  isSpecial?: boolean;
};

type CeapiTransfer = {
  url?: string;
  from?: CeapiClub;
  to?: CeapiClub;
  dateUnformatted?: string;
  date?: string;
  season?: string;
  fee?: string;
  marketValue?: string;
  upcoming?: boolean;
  futureTransfer?: number;
};

function clubIdFromHref(href: string | undefined): string | null {
  if (!href) return null;
  const m = href.match(/\/verein\/(\d+)/);
  return m?.[1] ?? null;
}

function transferIdFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const m = url.match(/transfer_id\/(\d+)/);
  return m?.[1] ?? null;
}

export async function fetchTransfersFromTm(playerId: string): Promise<CeapiTransfer[]> {
  return tmEnqueue(async () => {
    const res = await fetch(`${CEAPI}/${playerId}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": UA,
        "Accept-Language": "en-US,en;q=0.9",
        "X-Requested-With": "XMLHttpRequest",
        Referer: `https://www.transfermarkt.com/x/transfers/spieler/${playerId}`,
      },
    });
    if (!res.ok) {
      console.warn(`  ! ceapi ${playerId}: HTTP ${res.status}`);
      return [];
    }
    const text = await res.text();
    if (!text.trim()) {
      console.warn(`  ! ceapi ${playerId}: empty body`);
      return [];
    }
    let body: { transfers?: CeapiTransfer[] };
    try {
      body = JSON.parse(text) as { transfers?: CeapiTransfer[] };
    } catch {
      console.warn(`  ! ceapi ${playerId}: non-JSON body (${text.slice(0, 80)})`);
      return [];
    }
    return Array.isArray(body.transfers) ? body.transfers : [];
  });
}

export function mapTransferRows(
  playerId: string,
  raw: CeapiTransfer[],
  syncedAt: string,
): PlayerTransfer[] {
  return raw.map((t, i) => ({
    player_id: playerId,
    transfer_id: transferIdFromUrl(t.url),
    season: t.season ?? null,
    date: t.dateUnformatted || t.date || null,
    from_club_id: clubIdFromHref(t.from?.href),
    from_club_name: t.from?.clubName ?? null,
    from_club_crest: t.from?.["clubEmblem-1x"] ?? null,
    to_club_id: clubIdFromHref(t.to?.href),
    to_club_name: t.to?.clubName ?? null,
    to_club_crest: t.to?.["clubEmblem-1x"] ?? null,
    fee: t.fee && t.fee !== "-" ? t.fee : null,
    market_value: t.marketValue && t.marketValue !== "-" ? t.marketValue : null,
    upcoming: t.upcoming || t.futureTransfer ? 1 : 0,
    sort_order: i,
    synced_at: syncedAt,
  }));
}

export function replacePlayerTransfers(
  db: Database.Database,
  playerId: string,
  rows: PlayerTransfer[],
): void {
  ensurePlayerTransfersTable(db);
  const del = db.prepare(`DELETE FROM player_transfers WHERE player_id = ?`);
  const ins = db.prepare(
    `INSERT INTO player_transfers (
       player_id, transfer_id, season, date,
       from_club_id, from_club_name, from_club_crest,
       to_club_id, to_club_name, to_club_crest,
       fee, market_value, upcoming, sort_order, synced_at
     ) VALUES (
       @player_id, @transfer_id, @season, @date,
       @from_club_id, @from_club_name, @from_club_crest,
       @to_club_id, @to_club_name, @to_club_crest,
       @fee, @market_value, @upcoming, @sort_order, @synced_at
     )`,
  );
  const tx = db.transaction(() => {
    del.run(playerId);
    for (const row of rows) ins.run(row);
  });
  tx();
}

/** In-flight de-dupe + short cooldown after failed/empty TM responses. */
const inflight = new Map<string, Promise<PlayerTransfer[]>>();
const cooldownUntil = new Map<string, number>();
const COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Return cached transfers, or fetch from TM (rate-limited) and persist.
 * No-op when writeDb is null (readonly-only deployments).
 * Note: TM often blocks datacenter IPs — batch `npm run transfers:sync` on a
 * residential/desktop host, then deploy the DB for reliable coverage.
 */
export async function ensurePlayerTransfers(
  writeDb: Database.Database | null,
  playerId: string,
  existing?: PlayerTransfer[],
): Promise<PlayerTransfer[]> {
  const cached = existing ?? (writeDb ? listPlayerTransfers(writeDb, playerId) : []);
  if (cached.length) return cached;
  if (!writeDb) return cached;
  const until = cooldownUntil.get(playerId) ?? 0;
  if (until > Date.now()) return cached;

  const pending = inflight.get(playerId);
  if (pending) return pending;

  const job = (async () => {
    try {
      const raw = await fetchTransfersFromTm(playerId);
      const rows = mapTransferRows(playerId, raw, new Date().toISOString());
      // Only persist on a real TM payload. Empty can mean a blocked/truncated
      // response from the host — apply cooldown, don't write a tombstone.
      if (rows.length) {
        replacePlayerTransfers(writeDb, playerId, rows);
        cooldownUntil.delete(playerId);
        return rows;
      }
      cooldownUntil.set(playerId, Date.now() + COOLDOWN_MS);
      return [];
    } catch (err) {
      console.warn(
        `transfer lazy-sync ${playerId}:`,
        err instanceof Error ? err.message : err,
      );
      cooldownUntil.set(playerId, Date.now() + COOLDOWN_MS);
      return [];
    } finally {
      inflight.delete(playerId);
    }
  })();

  inflight.set(playerId, job);
  return job;
}

function ensureClubFromTransfer(
  db: Database.Database,
  t: PlayerTransfer,
): { id: string; league_id: string | null } | null {
  const toId = t.to_club_id;
  if (!toId) return null;
  const existing = db
    .prepare(`SELECT id, league_id FROM clubs WHERE id = ?`)
    .get(toId) as { id: string; league_id: string | null } | undefined;
  if (existing) return existing;
  const name = (t.to_club_name || "").trim() || "Unknown";
  db.prepare(
    `INSERT OR IGNORE INTO leagues (id, name, country, sort_order)
     VALUES (?, 'Outside', '—', 99)`,
  ).run(OUTSIDE_LEAGUE);
  db.prepare(
    `INSERT INTO clubs (id, league_id, name, short_name, club_code, crest_url)
     VALUES (?, ?, ?, NULL, ?, ?)`,
  ).run(toId, OUTSIDE_LEAGUE, name, deriveClubCode(name), t.to_club_crest);
  return { id: toId, league_id: OUTSIDE_LEAGUE };
}

/**
 * Point `players.club_id` at the latest completed transfer destination
 * (loans: the loanee club; skip `upcoming`). Inserts the dest club if missing.
 */
export function applyLatestCompletedClub(
  db: Database.Database,
  playerId: string,
): boolean {
  const current = db
    .prepare(`SELECT club_id FROM players WHERE id = ?`)
    .get(playerId) as { club_id: string | null } | undefined;
  if (!current) return false;
  const rows = listPlayerTransfers(db, playerId);
  for (const t of rows) {
    if (t.upcoming) continue;
    const club = ensureClubFromTransfer(db, t);
    if (!club) continue;
    if (String(current.club_id || "") === String(club.id)) return false;
    db.prepare(
      `UPDATE players SET club_id = ?, league_id = COALESCE(?, league_id) WHERE id = ?`,
    ).run(club.id, club.league_id, playerId);
    return true;
  }
  return false;
}

/** Force-refetch TM history and point `players.club_id` at the latest completed destination. */
export async function refreshPlayerCurrentClub(
  db: Database.Database,
  playerId: string,
): Promise<boolean> {
  const raw = await fetchTransfersFromTm(playerId);
  const rows = mapTransferRows(playerId, raw, new Date().toISOString());
  // Empty TM response is often a blocked datacenter; do not apply a stale
  // player_transfers cache (that reverts squad-scrape club updates).
  if (!rows.length) return false;
  replacePlayerTransfers(db, playerId, rows);
  return applyLatestCompletedClub(db, playerId);
}
