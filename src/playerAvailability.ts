/**
 * Current injuries / suspensions from API-Football `/injuries`,
 * supplemented by FotMob squad `injured` flags (PL/Serie A/Bundesliga/La Liga).
 * Mapped to TM players by club + name. FotMob ids stored in player_fotmob_map.
 */
import type Database from "better-sqlite3";
import { injuriesByLeague, type AfInjuryRow } from "./apiFootball.js";
import {
  FOTMOB_TOP4_LEAGUES,
  fotmobLeagueTeams,
  fotmobTeamSquad,
} from "./fotmob.js";
import { gameweekFromKickoff } from "./gameweeks.js";
import { AF_SEASON } from "./leagues.js";

/** Sentinel fixture id for FotMob-sourced rows (not tied to an AF fixture). */
const FOTMOB_FIXTURE_ID = 0;

const TOP4_AF_LEAGUES = [39, 140, 135, 78] as const;
const SYNC_COOLDOWN_MS = 15 * 60 * 1000;
const SUSPEND_RE =
  /suspend|red card|yellow card|disqualif|banned|disciplinary|accumulation/i;

export type AvailabilityKind = "injury" | "suspension";

export type PlayerAvailability = {
  kind: AvailabilityKind;
  reason: string;
};

type StoredRow = {
  player_id: string;
  kind: AvailabilityKind;
  reason: string;
  gameweek: number | null;
  fixture_date: string | null;
};

let lastSyncAt = 0;
let inflight: Promise<void> | null = null;

function normName(input: string): string {
  return input
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ø/gi, "o")
    .replace(/æ/gi, "ae")
    .replace(/œ/gi, "oe")
    .replace(/ł/gi, "l")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function classify(reason: string): AvailabilityKind {
  return SUSPEND_RE.test(reason) ? "suspension" : "injury";
}

export function ensurePlayerAvailabilityTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS player_availability (
      player_id TEXT NOT NULL,
      af_fixture_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      reason TEXT,
      af_player_id INTEGER,
      fixture_date TEXT,
      gameweek INTEGER,
      synced_at TEXT NOT NULL,
      PRIMARY KEY (player_id, af_fixture_id)
    );
    CREATE INDEX IF NOT EXISTS player_availability_gw ON player_availability(gameweek);
    CREATE INDEX IF NOT EXISTS player_availability_player ON player_availability(player_id);
    CREATE TABLE IF NOT EXISTS club_fotmob_map (
      fotmob_team_id INTEGER PRIMARY KEY,
      club_id TEXT NOT NULL,
      fotmob_name TEXT
    );
    CREATE INDEX IF NOT EXISTS club_fotmob_map_club ON club_fotmob_map(club_id);
    CREATE TABLE IF NOT EXISTS player_fotmob_map (
      player_id TEXT PRIMARY KEY,
      fotmob_id INTEGER NOT NULL,
      fotmob_name TEXT,
      club_id TEXT
    );
    CREATE INDEX IF NOT EXISTS player_fotmob_map_fm ON player_fotmob_map(fotmob_id);
  `);
}

function clubKey(input: string): string {
  return input
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ø/gi, "o")
    .replace(/æ/gi, "ae")
    .replace(/œ/gi, "oe")
    .replace(/ł/gi, "l")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(fc|cf|sc|afc|ac|as|ss|rcd|ud|cd|sd|kv|rsc|sv|vfb|vfl|tsv|bsc|osc)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function expandClubNames(name: string): string[] {
  const k = clubKey(name);
  const extra: Record<string, string[]> = {
    "athletic club": ["Athletic Bilbao"],
    inter: ["Internazionale", "Inter Milan"],
    milan: ["AC Milan"],
    "bayern munchen": ["Bayern Munich"],
    "1 fc koln": ["1. FC Köln", "Cologne"],
    "deportivo a coruna": ["Deportivo de La Coruña"],
    "brighton hove albion": ["Brighton"],
    "tottenham hotspur": ["Tottenham"],
  };
  return [name, ...(extra[k] ?? [])];
}

function clubNamesMatch(a: string, b: string): boolean {
  const na = clubKey(a);
  const nb = clubKey(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) {
    const shorter = na.length <= nb.length ? na : nb;
    return shorter.length >= 5;
  }
  const ta = na.split(" ").filter((t) => t.length > 2);
  const tb = nb.split(" ").filter((t) => t.length > 2);
  const inter = ta.filter((t) => tb.includes(t));
  return inter.length >= 2 || (inter.length === 1 && (ta.length === 1 || tb.length === 1));
}

function loadClubAf(db: Database.Database): Map<number, string> {
  const map = new Map<number, string>();
  const rows = db
    .prepare(`SELECT af_team_id, club_id FROM club_af_map`)
    .all() as Array<{ af_team_id: number; club_id: string }>;
  for (const r of rows) map.set(Number(r.af_team_id), String(r.club_id));
  return map;
}

function loadPlayersByClub(
  db: Database.Database,
  clubIds: string[],
): Map<string, Array<{ id: string; name: string }>> {
  const out = new Map<string, Array<{ id: string; name: string }>>();
  if (!clubIds.length) return out;
  const rows = db
    .prepare(
      `SELECT id, name, club_id FROM players
       WHERE club_id IN (${clubIds.map(() => "?").join(",")})`,
    )
    .all(...clubIds) as Array<{ id: string; name: string; club_id: string }>;
  for (const r of rows) {
    const list = out.get(r.club_id) ?? [];
    list.push({ id: String(r.id), name: r.name });
    out.set(r.club_id, list);
  }
  return out;
}

function matchTmPlayer(
  afName: string,
  clubPlayers: Array<{ id: string; name: string }>,
): string | null {
  const want = normName(afName);
  if (!want || !clubPlayers.length) return null;

  const exact: string[] = [];
  const fuzzy: string[] = [];
  const wantTokens = want.split(" ").filter((t) => t.length > 1);
  const last = wantTokens[wantTokens.length - 1];

  for (const p of clubPlayers) {
    const key = normName(p.name);
    if (!key) continue;
    if (key === want) {
      exact.push(p.id);
      continue;
    }
    if (key.includes(want) || want.includes(key)) {
      fuzzy.push(p.id);
      continue;
    }
    if (last && last.length >= 4 && key.split(" ").includes(last)) {
      fuzzy.push(p.id);
    }
  }
  const uniq = [...new Set(exact.length ? exact : fuzzy)];
  return uniq.length === 1 ? uniq[0]! : null;
}

function fixtureMeta(
  db: Database.Database,
  afFixtureId: number,
): { gameweek: number | null; status: string | null; date: string | null } {
  const row = db
    .prepare(`SELECT gameweek, status, date FROM fixtures WHERE id = ?`)
    .get(afFixtureId) as
    | { gameweek: number | null; status: string | null; date: string | null }
    | undefined;
  return {
    gameweek: row?.gameweek != null ? Number(row.gameweek) : null,
    status: row?.status ? String(row.status) : null,
    date: row?.date ? String(row.date) : null,
  };
}

function isCurrentInjury(
  fixtureDate: string | null,
  status: string | null,
  gameweek: number | null,
  currentGw: number,
): boolean {
  const st = (status || "").toUpperCase();
  if (st === "FT" || st === "AET" || st === "PEN") return false;
  if (gameweek != null && gameweek >= currentGw) return true;
  if (!fixtureDate) return true;
  const t = Date.parse(fixtureDate);
  if (!Number.isFinite(t)) return true;
  return t >= Date.now() - 12 * 60 * 60 * 1000;
}

function pickRow(rows: StoredRow[]): PlayerAvailability | null {
  if (!rows.length) return null;
  const dsq = rows.find((r) => r.kind === "suspension");
  const row = dsq ?? rows[0]!;
  return { kind: row.kind, reason: row.reason };
}

function loadClubsByLeague(
  db: Database.Database,
  leagueId: string,
): Array<{ id: string; name: string; short_name: string | null }> {
  return db
    .prepare(`SELECT id, name, short_name FROM clubs WHERE league_id = ?`)
    .all(leagueId) as Array<{ id: string; name: string; short_name: string | null }>;
}

async function syncFotmobClubMap(db: Database.Database): Promise<number> {
  const upsert = db.prepare(
    `INSERT INTO club_fotmob_map (fotmob_team_id, club_id, fotmob_name)
     VALUES (@fotmob_team_id, @club_id, @fotmob_name)
     ON CONFLICT(fotmob_team_id) DO UPDATE SET
       club_id = excluded.club_id,
       fotmob_name = excluded.fotmob_name`,
  );
  let mapped = 0;
  for (const league of FOTMOB_TOP4_LEAGUES) {
    let teams: Awaited<ReturnType<typeof fotmobLeagueTeams>> = [];
    try {
      teams = await fotmobLeagueTeams(league.id);
    } catch (err) {
      console.warn(
        `fotmob league ${league.tm}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    const clubs = loadClubsByLeague(db, league.tm);
    const used = new Set<string>();
    for (const t of teams) {
      const names = expandClubNames(t.name);
      const hit =
        clubs.find(
          (c) =>
            !used.has(c.id) && names.some((n) => clubNamesMatch(n, c.name)),
        ) ??
        clubs.find(
          (c) =>
            !used.has(c.id) &&
            c.short_name &&
            names.some((n) => clubNamesMatch(n, c.short_name!)),
        );
      if (!hit) continue;
      used.add(hit.id);
      upsert.run({
        fotmob_team_id: t.id,
        club_id: hit.id,
        fotmob_name: t.name,
      });
      mapped++;
    }
  }
  return mapped;
}

type AvailRow = {
  player_id: string;
  af_fixture_id: number;
  kind: AvailabilityKind;
  reason: string;
  af_player_id: number | null;
  fixture_date: string | null;
  gameweek: number | null;
  synced_at: string;
};

function playerHasKind(mapped: Map<string, AvailRow>, playerId: string, kind: AvailabilityKind): boolean {
  for (const row of mapped.values()) {
    if (row.player_id === playerId && row.kind === kind) return true;
  }
  return false;
}

function persistFotmobRows(
  db: Database.Database,
  mapped: Map<string, AvailRow>,
  now: string,
): number {
  const extra = [...mapped.values()].filter(
    (r) => r.af_fixture_id === FOTMOB_FIXTURE_ID,
  );
  const insFm = db.prepare(
    `INSERT INTO player_availability (
       player_id, af_fixture_id, kind, reason, af_player_id, fixture_date, gameweek, synced_at
     ) VALUES (
       @player_id, @af_fixture_id, @kind, @reason, @af_player_id, @fixture_date, @gameweek, @synced_at
     )
     ON CONFLICT(player_id, af_fixture_id) DO UPDATE SET
       kind = excluded.kind,
       reason = excluded.reason,
       synced_at = excluded.synced_at`,
  );
  const add = db.transaction(() => {
    for (const row of extra) insFm.run(row);
    db.prepare(
      `INSERT INTO meta(key,value) VALUES('player_availability_synced_at',?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run(now);
  });
  add();
  return extra.length;
}

async function mergeFotmobInjuries(
  db: Database.Database,
  mapped: Map<string, AvailRow>,
  now: string,
  onlyClubIds?: string[],
  resyncClubs = false,
): Promise<{ linked: number; injured: number }> {
  const existingMaps = (
    db.prepare(`SELECT COUNT(*) AS n FROM club_fotmob_map`).get() as { n: number }
  ).n;
  if (existingMaps < 20 || resyncClubs) await syncFotmobClubMap(db);
  let clubs = db
    .prepare(`SELECT fotmob_team_id, club_id FROM club_fotmob_map`)
    .all() as Array<{ fotmob_team_id: number; club_id: string }>;
  if (onlyClubIds?.length) {
    const want = new Set(onlyClubIds);
    clubs = clubs.filter((c) => want.has(c.club_id));
  }
  const byClub = loadPlayersByClub(
    db,
    clubs.map((c) => c.club_id),
  );
  const upsertLink = db.prepare(
    `INSERT INTO player_fotmob_map (player_id, fotmob_id, fotmob_name, club_id)
     VALUES (@player_id, @fotmob_id, @fotmob_name, @club_id)
     ON CONFLICT(player_id) DO UPDATE SET
       fotmob_id = excluded.fotmob_id,
       fotmob_name = excluded.fotmob_name,
       club_id = excluded.club_id`,
  );
  let linked = 0;
  let injured = 0;
  for (const club of clubs) {
    let squad: Awaited<ReturnType<typeof fotmobTeamSquad>> = [];
    try {
      squad = await fotmobTeamSquad(club.fotmob_team_id);
    } catch (err) {
      console.warn(
        `fotmob squad ${club.fotmob_team_id}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    const pool = byClub.get(club.club_id) ?? [];
    for (const p of squad) {
      const tmId = matchTmPlayer(p.name, pool);
      if (!tmId) continue;
      upsertLink.run({
        player_id: tmId,
        fotmob_id: p.id,
        fotmob_name: p.name,
        club_id: club.club_id,
      });
      linked++;
      if (!p.injured) continue;
      if (playerHasKind(mapped, tmId, "suspension")) continue;
      if (playerHasKind(mapped, tmId, "injury")) continue;
      const reason = p.expectedReturn
        ? `Injured · ${p.expectedReturn}`
        : "Injured";
      mapped.set(`${tmId}:${FOTMOB_FIXTURE_ID}`, {
        player_id: tmId,
        af_fixture_id: FOTMOB_FIXTURE_ID,
        kind: "injury",
        reason,
        af_player_id: null,
        fixture_date: null,
        gameweek: null,
        synced_at: now,
      });
      injured++;
    }
  }
  return { linked, injured };
}

export async function ensureAvailabilitySynced(
  db: Database.Database,
): Promise<void> {
  ensurePlayerAvailabilityTable(db);
  if (Date.now() - lastSyncAt < SYNC_COOLDOWN_MS) return;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      await syncAvailability(db);
      lastSyncAt = Date.now();
    } catch (err) {
      console.warn(
        "player availability sync:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function loadAvailabilitySyncedAt(db: Database.Database): string | null {
  try {
    const row = db
      .prepare(`SELECT value FROM meta WHERE key = 'player_availability_synced_at'`)
      .get() as { value: string } | undefined;
    const v = row?.value ? String(row.value).trim() : "";
    return v || null;
  } catch {
    return null;
  }
}

export async function forceSyncAvailability(db: Database.Database): Promise<{
  fetched: number;
  stored: number;
  lastUpdated: string | null;
}> {
  ensurePlayerAvailabilityTable(db);
  if (inflight) await inflight;
  let result = { fetched: 0, stored: 0 };
  const job = (async () => {
    try {
      result = await syncAvailability(db, {
        awaitFotmob: true,
        resyncClubs: true,
      });
      lastSyncAt = Date.now();
    } finally {
      inflight = null;
    }
  })();
  inflight = job;
  await job;
  return {
    ...result,
    lastUpdated: loadAvailabilitySyncedAt(db),
  };
}

export async function syncAvailability(
  db: Database.Database,
  opts?: { awaitFotmob?: boolean; resyncClubs?: boolean },
): Promise<{
  fetched: number;
  stored: number;
}> {
  ensurePlayerAvailabilityTable(db);
  const currentGw = Math.max(1, gameweekFromKickoff(new Date()));
  const all: AfInjuryRow[] = [];
  for (const league of TOP4_AF_LEAGUES) {
    try {
      const { response } = await injuriesByLeague(league, AF_SEASON);
      if (Array.isArray(response)) all.push(...response);
    } catch (err) {
      console.warn(
        `injuries league ${league}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const clubAf = loadClubAf(db);
  const clubIds = [
    ...new Set(
      all
        .map((r) => clubAf.get(Number(r.team?.id)))
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const byClub = loadPlayersByClub(db, clubIds);
  const now = new Date().toISOString();
  const mapped = new Map<
    string,
    {
      player_id: string;
      af_fixture_id: number;
      kind: AvailabilityKind;
      reason: string;
      af_player_id: number | null;
      fixture_date: string | null;
      gameweek: number | null;
      synced_at: string;
    }
  >();

  for (const row of all) {
    const clubId = clubAf.get(Number(row.team?.id));
    if (!clubId) continue;
    const tmId = matchTmPlayer(row.player?.name || "", byClub.get(clubId) ?? []);
    if (!tmId) continue;
    const fixtureId = Number(row.fixture?.id);
    if (!Number.isFinite(fixtureId)) continue;
    const meta = fixtureMeta(db, fixtureId);
    const fixtureDate = row.fixture?.date || meta.date;
    if (!isCurrentInjury(fixtureDate, meta.status, meta.gameweek, currentGw)) {
      continue;
    }
    const reason = String(row.player?.reason || "").trim() || "Unavailable";
    const next = {
      player_id: tmId,
      af_fixture_id: fixtureId,
      kind: classify(reason),
      reason,
      af_player_id: Number.isFinite(row.player?.id) ? Number(row.player.id) : null,
      fixture_date: fixtureDate,
      gameweek: meta.gameweek,
      synced_at: now,
    };
    const key = `${next.player_id}:${next.af_fixture_id}`;
    const prev = mapped.get(key);
    if (!prev || (next.kind === "suspension" && prev.kind !== "suspension")) {
      mapped.set(key, next);
    }
  }

  const ins = db.prepare(
    `INSERT INTO player_availability (
       player_id, af_fixture_id, kind, reason, af_player_id, fixture_date, gameweek, synced_at
     ) VALUES (
       @player_id, @af_fixture_id, @kind, @reason, @af_player_id, @fixture_date, @gameweek, @synced_at
     )`,
  );
  const tx = db.transaction(() => {
    db.exec(`DELETE FROM player_availability`);
    for (const row of mapped.values()) ins.run(row);
    db.prepare(
      `INSERT INTO meta(key,value) VALUES('player_availability_synced_at',?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run(now);
  });
  tx();

  const runFotmob = async (): Promise<void> => {
    const fm = await mergeFotmobInjuries(
      db,
      mapped,
      now,
      undefined,
      Boolean(opts?.resyncClubs),
    );
    persistFotmobRows(db, mapped, new Date().toISOString());
    console.log(
      `fotmob availability: linked ${fm.linked} players, ${fm.injured} injuries`,
    );
  };

  if (opts?.awaitFotmob) {
    try {
      await runFotmob();
    } catch (err) {
      console.warn(
        "fotmob availability:",
        err instanceof Error ? err.message : err,
      );
    }
  } else {
    void runFotmob().catch((err) => {
      console.warn(
        "fotmob availability:",
        err instanceof Error ? err.message : err,
      );
    });
  }

  return { fetched: all.length, stored: mapped.size };
}

export function loadAvailabilityForGw(
  db: Database.Database,
  playerIds: string[],
  gw: number,
): Map<string, PlayerAvailability> {
  const out = new Map<string, PlayerAvailability>();
  if (!playerIds.length) return out;
  ensurePlayerAvailabilityTable(db);
  const rows = db
    .prepare(
      `SELECT player_id, kind, reason, gameweek, fixture_date
       FROM player_availability
       WHERE player_id IN (${playerIds.map(() => "?").join(",")})
         AND (gameweek = ? OR gameweek IS NULL)`,
    )
    .all(...playerIds, gw) as StoredRow[];

  const byPlayer = new Map<string, StoredRow[]>();
  for (const r of rows) {
    const list = byPlayer.get(r.player_id) ?? [];
    list.push(r);
    byPlayer.set(r.player_id, list);
  }
  for (const [id, list] of byPlayer) {
    const picked = pickRow(list);
    if (picked) out.set(id, picked);
  }
  return out;
}

export function loadAvailabilityForPlayers(
  db: Database.Database,
  playerIds: string[],
): Map<string, PlayerAvailability> {
  const out = new Map<string, PlayerAvailability>();
  if (!playerIds.length) return out;
  ensurePlayerAvailabilityTable(db);
  const currentGw = Math.max(1, gameweekFromKickoff(new Date()));
  const want = new Set(playerIds);
  const scanAll = playerIds.length > 200;
  const rows = (
    scanAll
      ? (db
          .prepare(
            `SELECT player_id, kind, reason, gameweek, fixture_date
             FROM player_availability
             WHERE gameweek IS NULL OR gameweek >= ?`,
          )
          .all(currentGw) as StoredRow[])
      : (db
          .prepare(
            `SELECT player_id, kind, reason, gameweek, fixture_date
             FROM player_availability
             WHERE player_id IN (${playerIds.map(() => "?").join(",")})
               AND (gameweek IS NULL OR gameweek >= ?)`,
          )
          .all(...playerIds, currentGw) as StoredRow[])
  );
  const byPlayer = new Map<string, StoredRow[]>();
  for (const r of rows) {
    if (scanAll && !want.has(r.player_id)) continue;
    const list = byPlayer.get(r.player_id) ?? [];
    list.push(r);
    byPlayer.set(r.player_id, list);
  }
  for (const [id, list] of byPlayer) {
    const picked = pickRow(list);
    if (picked) out.set(id, picked);
  }
  return out;
}

export function loadAvailabilityForPlayer(
  db: Database.Database,
  playerId: string,
): PlayerAvailability | null {
  return loadAvailabilityForPlayers(db, [playerId]).get(playerId) ?? null;
}

/** Targeted AF + FotMob refresh for one squad (does not wipe other players). */
export async function refreshAvailabilityForSquad(
  db: Database.Database,
  playerIds: string[],
  clubIds: string[],
): Promise<{ injured: number }> {
  ensurePlayerAvailabilityTable(db);
  if (!playerIds.length) return { injured: 0 };
  const want = new Set(playerIds);
  const currentGw = Math.max(1, gameweekFromKickoff(new Date()));
  const all: AfInjuryRow[] = [];
  for (const league of TOP4_AF_LEAGUES) {
    try {
      const { response } = await injuriesByLeague(league, AF_SEASON);
      if (Array.isArray(response)) all.push(...response);
    } catch (err) {
      console.warn(
        `injuries league ${league}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  const clubAf = loadClubAf(db);
  const byClub = loadPlayersByClub(db, clubIds);
  const now = new Date().toISOString();
  const mapped = new Map<string, AvailRow>();
  for (const row of all) {
    const clubId = clubAf.get(Number(row.team?.id));
    if (!clubId) continue;
    const tmId = matchTmPlayer(row.player?.name || "", byClub.get(clubId) ?? []);
    if (!tmId || !want.has(tmId)) continue;
    const fixtureId = Number(row.fixture?.id);
    if (!Number.isFinite(fixtureId) || fixtureId === FOTMOB_FIXTURE_ID) continue;
    const meta = fixtureMeta(db, fixtureId);
    const fixtureDate = row.fixture?.date || meta.date;
    if (!isCurrentInjury(fixtureDate, meta.status, meta.gameweek, currentGw)) {
      continue;
    }
    const reason = String(row.player?.reason || "").trim() || "Unavailable";
    const next: AvailRow = {
      player_id: tmId,
      af_fixture_id: fixtureId,
      kind: classify(reason),
      reason,
      af_player_id: Number.isFinite(row.player?.id) ? Number(row.player.id) : null,
      fixture_date: fixtureDate,
      gameweek: meta.gameweek,
      synced_at: now,
    };
    const key = `${next.player_id}:${next.af_fixture_id}`;
    const prev = mapped.get(key);
    if (!prev || (next.kind === "suspension" && prev.kind !== "suspension")) {
      mapped.set(key, next);
    }
  }

  await mergeFotmobInjuries(db, mapped, now, clubIds);

  const ins = db.prepare(
    `INSERT INTO player_availability (
       player_id, af_fixture_id, kind, reason, af_player_id, fixture_date, gameweek, synced_at
     ) VALUES (
       @player_id, @af_fixture_id, @kind, @reason, @af_player_id, @fixture_date, @gameweek, @synced_at
     )
     ON CONFLICT(player_id, af_fixture_id) DO UPDATE SET
       kind = excluded.kind,
       reason = excluded.reason,
       af_player_id = excluded.af_player_id,
       fixture_date = excluded.fixture_date,
       gameweek = excluded.gameweek,
       synced_at = excluded.synced_at`,
  );
  const placeholders = playerIds.map(() => "?").join(",");
  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM player_availability WHERE player_id IN (${placeholders})`,
    ).run(...playerIds);
    for (const row of mapped.values()) {
      if (want.has(row.player_id)) ins.run(row);
    }
  });
  tx();
  return {
    injured: [...mapped.values()].filter((r) => want.has(r.player_id)).length,
  };
}
