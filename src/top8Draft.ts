/**
 * Run Top-8 snake draft from DB using lottery team order (Primer caps/leagues).
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
import {
  TOP8_IDS,
  TOP8_MAX_PER_CLUB,
  TOP8_MIN_GK,
  TOP8_MIN_PER_LEAGUE,
  TOP8_MV_CAP,
  TOP8_ROUNDS,
  TOP8_TEAM_COUNT,
  TOP8_WAGE_CAP,
  type Top8LotteryEntry,
} from "./top8League.js";

export const TOP8_DRAFT_CONFIG: DraftConfig = {
  teamCount: TOP8_TEAM_COUNT,
  rounds: TOP8_ROUNDS,
  mvCap: TOP8_MV_CAP,
  wageCap: TOP8_WAGE_CAP,
  minPerLeague: TOP8_MIN_PER_LEAGUE,
  maxPerClub: TOP8_MAX_PER_CLUB,
  minGk: TOP8_MIN_GK,
  maxExtraRounds: 20,
  leagueIds: TOP8_IDS,
  // Match Primer reserves
  reserveMv: 4_000_000,
  reserveWage: 55_000,
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
    fm_rating: Number(r.fm_rating),
    market_value_eur: Number(r.market_value_eur) || 0,
    wage_pw: Number(r.wage_pw) || 0,
    position_display: formatPositionDisplay(fields),
    portrait_url: r.portrait_url != null ? String(r.portrait_url) : null,
    ...fields,
  };
}

/** All rated players in Primer Top-8 leagues — full pools, no quota cap. */
function loadTop8Pool(db: Database.Database): DraftPlayer[] {
  const placeholders = TOP8_IDS.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.position, p.detail_role, p.detail_label, p.side_role,
              p.club_id, p.league_id, p.fm_rating,
              COALESCE(p.market_value_eur, 0) AS market_value_eur,
              p.capology_wage_pw, p.fm_wage_pw, p.portrait_url,
              c.name AS club_name, l.name AS league_name
       FROM players p
       JOIN clubs c ON c.id = p.club_id
       JOIN leagues l ON l.id = p.league_id
       WHERE p.fm_rating IS NOT NULL AND p.league_id IN (${placeholders})`,
    )
    .all(...TOP8_IDS) as Array<Record<string, unknown>>;
  const peers = loadWagePeers(db);
  return rows.map((r) => toDraftPlayer(withTrustedWageAsWagePw(r, peers)));
}

export function runTop8SnakeDraft(
  db: Database.Database,
  lottery: Top8LotteryEntry[],
): PrimerDraftResult & {
  lottery: Top8LotteryEntry[];
  managers: Array<{ team_id: number; team_name: string; email: string; name: string | null }>;
} {
  const pool = loadTop8Pool(db);
  // Full Top-4 pool is pickable; no separate overflow (was only for beyond-quota fillers).

  const teamNames = lottery
    .slice()
    .sort((a, b) => a.draft_slot - b.draft_slot)
    .map((e) => e.team_name);

  const draft = runPrimerDraft(pool, [], teamNames, TOP8_DRAFT_CONFIG);

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
