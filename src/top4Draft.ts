/**
 * Run Top-4 snake draft from DB using lottery team order.
 */
import type Database from "better-sqlite3";
import { formatPositionDisplay } from "./positions.js";
import {
  runPrimerDraft,
  type DraftConfig,
  type DraftPlayer,
  type PrimerDraftResult,
} from "./primerDraft.js";
import { loadWagePeers, withTrustedWageAsWagePw } from "./trustedWage.js";
import { resolvePlayerAvatarUrl } from "./playerAvatar.js";
import {
  TOP4_IDS,
  TOP4_MAX_PER_CLUB,
  TOP4_MIN_GK,
  TOP4_MIN_PER_LEAGUE,
  TOP4_MV_CAP,
  TOP4_ROUNDS,
  TOP4_TEAM_COUNT,
  TOP4_WAGE_CAP,
  listTop4Wishlist,
  type Top4LotteryEntry,
} from "./top4League.js";

export const TOP4_DRAFT_CONFIG: DraftConfig = {
  teamCount: TOP4_TEAM_COUNT,
  rounds: TOP4_ROUNDS,
  mvCap: TOP4_MV_CAP,
  wageCap: TOP4_WAGE_CAP,
  minPerLeague: TOP4_MIN_PER_LEAGUE,
  maxPerClub: TOP4_MAX_PER_CLUB,
  minGk: TOP4_MIN_GK,
  maxExtraRounds: 12,
  leagueIds: TOP4_IDS,
  reserveMv: 5_000_000,
  reserveWage: 70_000,
};

function toDraftPlayer(r: Record<string, unknown>): DraftPlayer {
  const fields = {
    position: (r.position as string) ?? null,
    detail_role: (r.detail_role as string) ?? null,
    detail_label: (r.detail_label as string) ?? null,
    side_role: (r.side_role as string) ?? null,
  };
  return {
    id: String(r.id),
    name: String(r.name),
    club_id: String(r.club_id ?? ""),
    club_name: String(r.club_name),
    league_id: String(r.league_id),
    league_name: String(r.league_name),
    fm_rating: r.fm_rating == null ? 0 : Number(r.fm_rating),
    market_value_eur: Number(r.market_value_eur) || 0,
    wage_pw: Number(r.wage_pw) || 0,
    position_display: formatPositionDisplay(fields),
    portrait_url: resolvePlayerAvatarUrl(
      r.portrait_url as string | null,
      r.club_crest as string | null,
    ),
    ...fields,
  };
}

/**
 * All players in ENG/SPA/ITA/GER — full league pools, no per-league cap.
 * Include unrated (fm_rating NULL) so new transfers still show in the UI pool
 * and can be wishlisted / drafted; rating is treated as 0 for autopick ranking.
 */
export function loadTop4Pool(db: Database.Database): DraftPlayer[] {
  const placeholders = TOP4_IDS.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.position, p.detail_role, p.detail_label, p.side_role,
              p.club_id, p.league_id, p.fm_rating,
              COALESCE(p.market_value_eur, 0) AS market_value_eur,
              p.capology_wage_pw, p.fm_wage_pw, p.portrait_url,
              c.name AS club_name, c.crest_url AS club_crest, l.name AS league_name
       FROM players p
       JOIN clubs c ON c.id = p.club_id
       JOIN leagues l ON l.id = p.league_id
       WHERE p.league_id IN (${placeholders})`,
    )
    .all(...TOP4_IDS) as Array<Record<string, unknown>>;
  const peers = loadWagePeers(db);
  return rows.map((r) => toDraftPlayer(withTrustedWageAsWagePw(r, peers)));
}

export type Top4ListedPlayer = DraftPlayer & { club_league_id: string };

/**
 * Drafted (or any) players by id — no Top-4 league filter, so leavers still
 * resolve for squads after they move outside GB1/ES1/IT1/L1.
 */
export function loadTop4PlayersByIds(
  db: Database.Database,
  ids: string[],
): Top4ListedPlayer[] {
  if (!ids.length) return [];
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.position, p.detail_role, p.detail_label, p.side_role,
              p.club_id, p.league_id, p.fm_rating,
              COALESCE(p.market_value_eur, 0) AS market_value_eur,
              p.capology_wage_pw, p.fm_wage_pw, p.portrait_url,
              COALESCE(c.name, '') AS club_name, c.crest_url AS club_crest,
              COALESCE(l.name, '') AS league_name,
              c.league_id AS club_league_id
       FROM players p
       LEFT JOIN clubs c ON c.id = p.club_id
       LEFT JOIN leagues l ON l.id = p.league_id
       WHERE p.id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids) as Array<Record<string, unknown>>;
  const peers = loadWagePeers(db);
  return rows.map((r) => ({
    ...toDraftPlayer(withTrustedWageAsWagePw(r, peers)),
    club_league_id: String(r.club_league_id ?? ""),
  }));
}

export function runTop4SnakeDraft(
  db: Database.Database,
  lottery: Top4LotteryEntry[],
): PrimerDraftResult & {
  lottery: Top4LotteryEntry[];
  managers: Array<{ team_id: number; team_name: string; email: string; name: string | null }>;
} {
  const pool = loadTop4Pool(db);
  // Full Top-4 pool is pickable; no separate overflow (was only for beyond-quota fillers).

  const ordered = lottery
    .slice()
    .sort((a, b) => a.draft_slot - b.draft_slot);
  const teamNames = ordered.map((e) => e.team_name);

  // team index 0-based → wishlist player ids (manager list; may be filled by consigliere)
  const wishlists = new Map<number, string[]>();
  ordered.forEach((entry, ti) => {
    const ids = listTop4Wishlist(db, entry.email).map((w) => w.player_id);
    if (ids.length) wishlists.set(ti, ids);
  });

  const draft = runPrimerDraft(
    pool,
    [],
    teamNames,
    TOP4_DRAFT_CONFIG,
    wishlists,
  );

  // Attach manager emails to teams by draft_slot / team id.
  const bySlot = new Map(lottery.map((e) => [e.draft_slot, e]));
  const managers = draft.teams.map((t) => {
    const entry = bySlot.get(t.id);
    return {
      team_id: t.id,
      team_name: t.name,
      email: entry?.email ?? "",
      name: entry?.name ?? null,
    };
  });

  return { ...draft, lottery, managers };
}
