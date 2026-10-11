import type Database from "better-sqlite3";

export type TrustedWageSource = "capology" | "fm" | "league_ca" | "league_mv" | "default";

export type TrustedWage = {
  trusted_wage_pw: number;
  trusted_wage_source: TrustedWageSource;
};

export type PeerRow = {
  id: string;
  league_id: string;
  fm_rating: number | null;
  market_value_eur: number | null;
  capology_wage_pw: number | null;
  fm_wage_pw: number | null;
};

/** Capology if > 0, else FM if > 0, else null (no real wage). */
export function realWagePw(
  capology: number | null | undefined,
  fm: number | null | undefined,
): { wage: number; source: "capology" | "fm" } | null {
  const c = capology == null ? null : Number(capology);
  if (c != null && Number.isFinite(c) && c > 0) return { wage: c, source: "capology" };
  const f = fm == null ? null : Number(fm);
  if (f != null && Number.isFinite(f) && f > 0) return { wage: f, source: "fm" };
  return null;
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function avgWage(wages: number[]): number | null {
  if (!wages.length) return null;
  return Math.round(wages.reduce((s, w) => s + w, 0) / wages.length);
}

/**
 * Trusted weekly wage cascade:
 * 1. Capology > 0
 * 2. FM > 0
 * 3. Avg real wages (Capology/FM only) in league among CA ±3 peers
 * 4. Avg real wages in league among MV ±20% peers (requires own MV)
 * 5. €500
 */
export function computeTrustedWage(
  player: {
    id?: unknown;
    league_id?: unknown;
    fm_rating?: unknown;
    market_value_eur?: unknown;
    capology_wage_pw?: unknown;
    fm_wage_pw?: unknown;
  },
  peers: PeerRow[],
): TrustedWage {
  const own = realWagePw(num(player.capology_wage_pw), num(player.fm_wage_pw));
  if (own) {
    return { trusted_wage_pw: own.wage, trusted_wage_source: own.source };
  }

  const leagueId = String(player.league_id ?? "");
  const selfId = String(player.id ?? "");
  const leaguePeers = peers.filter((p) => p.league_id === leagueId && p.id !== selfId);

  const ca = num(player.fm_rating);
  if (ca != null) {
    const wages: number[] = [];
    for (const p of leaguePeers) {
      if (p.fm_rating == null) continue;
      if (Math.abs(p.fm_rating - ca) > 3) continue;
      const rw = realWagePw(p.capology_wage_pw, p.fm_wage_pw);
      if (rw) wages.push(rw.wage);
    }
    const avg = avgWage(wages);
    if (avg != null) {
      return { trusted_wage_pw: avg, trusted_wage_source: "league_ca" };
    }
  }

  const mv = num(player.market_value_eur);
  if (mv != null && mv > 0) {
    const lo = mv * 0.8;
    const hi = mv * 1.2;
    const wages: number[] = [];
    for (const p of leaguePeers) {
      if (p.market_value_eur == null || p.market_value_eur <= 0) continue;
      if (p.market_value_eur < lo || p.market_value_eur > hi) continue;
      const rw = realWagePw(p.capology_wage_pw, p.fm_wage_pw);
      if (rw) wages.push(rw.wage);
    }
    const avg = avgWage(wages);
    if (avg != null) {
      return { trusted_wage_pw: avg, trusted_wage_source: "league_mv" };
    }
  }

  return { trusted_wage_pw: 500, trusted_wage_source: "default" };
}

const PEER_SQL = `SELECT id, league_id, fm_rating, market_value_eur, capology_wage_pw, fm_wage_pw
                  FROM players`;

/** Load lean peer rows once per request (DB is small). */
export function loadWagePeers(db: Database.Database): PeerRow[] {
  return db.prepare(PEER_SQL).all() as PeerRow[];
}

export function withTrustedWage<T extends Record<string, unknown>>(
  player: T,
  peers: PeerRow[],
): T & TrustedWage {
  return { ...player, ...computeTrustedWage(player, peers) };
}

/** Primary wage_pw = trusted (keeps Capology/FM fields untouched). */
export function withTrustedWageAsWagePw<T extends Record<string, unknown>>(
  player: T,
  peers: PeerRow[],
): T & TrustedWage & { wage_pw: number } {
  const tw = computeTrustedWage(player, peers);
  return { ...player, ...tw, wage_pw: tw.trusted_wage_pw };
}

export function mapWithTrustedWage<T extends Record<string, unknown>>(
  players: T[],
  peers: PeerRow[],
): Array<T & TrustedWage> {
  return players.map((p) => withTrustedWage(p, peers));
}

/** Lookup trusted wage by player id (peers table is enough input). */
export function trustedWageMap(
  peers: PeerRow[],
  playerIds?: Iterable<string>,
): Map<string, TrustedWage> {
  const wanted = playerIds ? new Set(playerIds) : null;
  const out = new Map<string, TrustedWage>();
  for (const p of peers) {
    if (wanted && !wanted.has(p.id)) continue;
    out.set(p.id, computeTrustedWage(p, peers));
  }
  return out;
}

/** Sort key: FM rating ↓, trusted wage ↓, MV ↓ (same as top26 / quota pool). */
export function compareRatingWageMv(
  a: { fm_rating?: unknown; wage_pw?: unknown; market_value_eur?: unknown; name?: unknown },
  b: { fm_rating?: unknown; wage_pw?: unknown; market_value_eur?: unknown; name?: unknown },
): number {
  const ra = Number(a.fm_rating) || 0;
  const rb = Number(b.fm_rating) || 0;
  if (rb !== ra) return rb - ra;
  const wa = Number(a.wage_pw) || 0;
  const wb = Number(b.wage_pw) || 0;
  if (wb !== wa) return wb - wa;
  const ma = Number(a.market_value_eur) || 0;
  const mb = Number(b.market_value_eur) || 0;
  if (mb !== ma) return mb - ma;
  return String(a.name ?? "").localeCompare(String(b.name ?? ""));
}
