/**
 * Fetch Transfermarkt coach performance history and persist into player_coaches.
 *
 * TM's list page is a web component that aggregates
 *   GET tmapi /player/{id}/performance-game
 * by club.coachId (appearances = participationState === "played").
 * We do the same aggregation server-side — no HTML scrape, no per-coach detail pages.
 *
 * Used by scripts/sync-coaches.ts and lazy fill on GET /api/players/:id.
 */
import type Database from "better-sqlite3";
import {
  ensurePlayerCoachesTable,
  listPlayerCoaches,
  type PlayerCoach,
} from "./playerCoaches.js";
import { tmEnqueue } from "./tmRateLimit.js";

const TMAPI = "https://tmapi-alpha.transfermarkt.technology";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

type PerfGame = {
  gameInformation?: {
    date?: { dateTimeUTC?: string };
  };
  clubsInformation?: {
    club?: { coachId?: string | number | null };
  };
  statistics?: {
    generalStatistics?: { participationState?: string | null };
  };
};

type PerfResponse = {
  success?: boolean;
  data?: {
    playerId?: string;
    performance?: PerfGame[];
  };
};

type CoachEntity = {
  id?: string | number;
  name?: string;
};

async function tmGetJson<T>(path: string): Promise<T | null> {
  return tmEnqueue(async () => {
    const res = await fetch(`${TMAPI}${path}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": UA,
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://www.transfermarkt.com/",
      },
    });
    if (!res.ok) {
      console.warn(`  ! tmapi ${path}: HTTP ${res.status}`);
      return null;
    }
    const text = await res.text();
    if (!text.trim()) {
      console.warn(`  ! tmapi ${path}: empty body`);
      return null;
    }
    try {
      const clean = [...text]
        .map((ch) => ((ch.codePointAt(0) ?? 0) >= 32 || "\n\r\t".includes(ch) ? ch : " "))
        .join("");
      return JSON.parse(clean) as T;
    } catch {
      console.warn(`  ! tmapi ${path}: non-JSON body (${text.slice(0, 80)})`);
      return null;
    }
  });
}

export async function fetchPerformanceGames(playerId: string): Promise<PerfGame[]> {
  const body = await tmGetJson<PerfResponse>(`/player/${playerId}/performance-game`);
  const list = body?.data?.performance;
  return Array.isArray(list) ? list : [];
}

export async function fetchCoachNames(trainerIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(trainerIds.map(String).filter((id) => id && id !== "0"))];
  for (let i = 0; i < unique.length; i += 20) {
    const chunk = unique.slice(i, i + 20);
    const qs = chunk.map((id) => `ids[]=${encodeURIComponent(id)}`).join("&");
    const body = await tmGetJson<{ success?: boolean; data?: CoachEntity[] }>(
      `/coaches?${qs}`,
    );
    for (const c of body?.data ?? []) {
      if (c?.id != null && c.name) out.set(String(c.id), c.name);
    }
  }
  return out;
}

type Agg = { apps: number; first: string | null; last: string | null };

function dateIso(game: PerfGame): string | null {
  const raw = game.gameInformation?.date?.dateTimeUTC;
  if (!raw) return null;
  const iso = String(raw).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
}

/** Aggregate played appearances by the player's club coach. */
export function aggregateCoachesByApps(games: PerfGame[]): Map<string, Agg> {
  const by = new Map<string, Agg>();
  for (const g of games) {
    const state = g.statistics?.generalStatistics?.participationState;
    if (state !== "played") continue;
    const rawId = g.clubsInformation?.club?.coachId;
    if (rawId == null || rawId === "" || rawId === 0 || rawId === "0") continue;
    const id = String(rawId);
    const d = dateIso(g);
    const cur = by.get(id) ?? { apps: 0, first: null, last: null };
    cur.apps += 1;
    if (d) {
      if (!cur.first || d < cur.first) cur.first = d;
      if (!cur.last || d > cur.last) cur.last = d;
    }
    by.set(id, cur);
  }
  return by;
}

export function mapCoachRows(
  playerId: string,
  agg: Map<string, Agg>,
  names: Map<string, string>,
  syncedAt: string,
): PlayerCoach[] {
  const rows = [...agg.entries()].map(([trainerId, a]) => ({
    player_id: playerId,
    trainer_id: trainerId,
    trainer_name: names.get(trainerId) ?? null,
    apps: a.apps,
    first_date: a.first,
    last_date: a.last,
    sort_order: 0,
    synced_at: syncedAt,
  }));
  // Most apps first; tie-break by most recent last game.
  rows.sort((a, b) => {
    if (b.apps !== a.apps) return b.apps - a.apps;
    return String(b.last_date ?? "").localeCompare(String(a.last_date ?? ""));
  });
  return rows.map((r, i) => ({ ...r, sort_order: i }));
}

export function replacePlayerCoaches(
  db: Database.Database,
  playerId: string,
  rows: PlayerCoach[],
): void {
  ensurePlayerCoachesTable(db);
  const del = db.prepare(`DELETE FROM player_coaches WHERE player_id = ?`);
  const ins = db.prepare(
    `INSERT INTO player_coaches (
       player_id, trainer_id, trainer_name, apps, first_date, last_date, sort_order, synced_at
     ) VALUES (
       @player_id, @trainer_id, @trainer_name, @apps, @first_date, @last_date, @sort_order, @synced_at
     )`,
  );
  const tx = db.transaction(() => {
    del.run(playerId);
    for (const row of rows) ins.run(row);
  });
  tx();
}

/** Fetch, aggregate, resolve names, persist. Returns rows (may be empty). */
export async function syncPlayerCoaches(
  db: Database.Database,
  playerId: string,
): Promise<PlayerCoach[]> {
  const games = await fetchPerformanceGames(playerId);
  const agg = aggregateCoachesByApps(games);
  if (!agg.size) {
    // Persist empty by clearing — only when we got a real (possibly empty) payload.
    // fetchPerformanceGames returns [] on HTTP failure too; caller should treat
    // empty carefully. We only clear when the API returned success with data.
    return [];
  }
  const names = await fetchCoachNames([...agg.keys()]);
  const rows = mapCoachRows(playerId, agg, names, new Date().toISOString());
  replacePlayerCoaches(db, playerId, rows);
  return rows;
}

const inflight = new Map<string, Promise<PlayerCoach[]>>();
const cooldownUntil = new Map<string, number>();
const COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Return cached coaches, or fetch from TM (rate-limited) and persist.
 * No-op when writeDb is null. Empty TM responses get a cooldown (no tombstone).
 */
export async function ensurePlayerCoaches(
  writeDb: Database.Database | null,
  playerId: string,
  existing?: PlayerCoach[],
): Promise<PlayerCoach[]> {
  const cached = existing ?? (writeDb ? listPlayerCoaches(writeDb, playerId) : []);
  if (cached.length) return cached;
  if (!writeDb) return cached;
  const until = cooldownUntil.get(playerId) ?? 0;
  if (until > Date.now()) return cached;

  const pending = inflight.get(playerId);
  if (pending) return pending;

  const job = (async () => {
    try {
      const rows = await syncPlayerCoaches(writeDb, playerId);
      if (rows.length) {
        cooldownUntil.delete(playerId);
        return rows;
      }
      cooldownUntil.set(playerId, Date.now() + COOLDOWN_MS);
      return [];
    } catch (err) {
      console.warn(
        `coach lazy-sync ${playerId}:`,
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
