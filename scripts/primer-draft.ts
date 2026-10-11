/**
 * Precompute a 16-team snake fantasy draft (≥26 players each) + per-GW lineups
 * into data/primer-draft.json.
 * Usage: npm run primer:draft
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { formatPositionDisplay } from "../src/positions.js";
import { TOP8_IDS } from "../src/leagues.js";
import {
  buildQuotaPoolQuery,
  applyTrustedQuotaPool,
  CELESTIAL_TEAM_NAMES,
  MAX_PER_CLUB,
  MIN_GK,
  MIN_PER_LEAGUE,
  MV_CAP,
  WAGE_CAP,
  runPrimerDraft,
  type DraftPlayer,
} from "../src/primerDraft.js";
import { loadWagePeers, withTrustedWageAsWagePw } from "../src/trustedWage.js";
import {
  buildTeamGameweeks,
  ingestFixtureRow,
  type ClubGwFixtures,
} from "../src/primerLineups.js";
import {
  excludeIgnoredFixturesWhere,
  seasonGameweekWhere,
} from "../src/fixturesFilter.js";
import { clubCodeLabel } from "../src/clubCode.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const dbPath = process.env.DIN8STY_DB ?? path.join(root, "data", "din8sty.db");
const outPath = path.join(root, "data", "primer-draft.json");

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

function loadClubFixtures(db: Database.Database): {
  clubFixtures: ClubGwFixtures;
  gameweeks: number[];
} {
  const clubFixtures: ClubGwFixtures = new Map();
  const hasFixtures = !!db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'fixtures'`)
    .get();
  const hasMap = !!db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'club_af_map'`)
    .get();

  if (!hasFixtures || !hasMap) {
    return { clubFixtures, gameweeks: [] };
  }

  const where = `${seasonGameweekWhere("f")} AND ${excludeIgnoredFixturesWhere("f")}`;
  const rows = db
    .prepare(
      `SELECT f.gameweek AS gw,
              hm.club_id AS home_club_id,
              am.club_id AS away_club_id,
              f.home_name,
              f.away_name,
              hc.club_code AS home_club_code,
              ac.club_code AS away_club_code
       FROM fixtures f
       LEFT JOIN club_af_map hm ON hm.af_team_id = f.home_af_id
       LEFT JOIN club_af_map am ON am.af_team_id = f.away_af_id
       LEFT JOIN clubs hc ON hc.id = hm.club_id
       LEFT JOIN clubs ac ON ac.id = am.club_id
       WHERE ${where}
       ORDER BY f.gameweek, f.date`,
    )
    .all() as Array<{
    gw: number;
    home_club_id: string | null;
    away_club_id: string | null;
    home_name: string;
    away_name: string;
    home_club_code: string | null;
    away_club_code: string | null;
  }>;

  const gwSet = new Set<number>();
  for (const r of rows) {
    const gw = Number(r.gw);
    if (!Number.isFinite(gw) || gw < 1) continue;
    gwSet.add(gw);
    ingestFixtureRow(
      clubFixtures,
      r.home_club_id,
      gw,
      true,
      clubCodeLabel(r.away_club_code, r.away_name),
    );
    ingestFixtureRow(
      clubFixtures,
      r.away_club_id,
      gw,
      false,
      clubCodeLabel(r.home_club_code, r.home_name),
    );
  }

  return {
    clubFixtures,
    gameweeks: [...gwSet].sort((a, b) => a - b),
  };
}

function wageK(n: number): string {
  return `€${Math.round(n / 1000).toLocaleString("en-US")}K`;
}

function main() {
  const db = new Database(dbPath, { readonly: true });
  const peers = loadWagePeers(db);
  const { sql, params, quotas } = buildQuotaPoolQuery();
  const pool = applyTrustedQuotaPool(
    db.prepare(sql).all(...params) as Array<Record<string, unknown>>,
    peers,
    quotas,
  ).map(toDraftPlayer);
  const poolIds = new Set(pool.map((p) => p.id));

  // Cheap overflow: rated players outside quota, lowest trusted wage first (wage-cap fillers).
  const leaguePlaceholders = TOP8_IDS.map(() => "?").join(", ");
  const overflowRows = (
    db
      .prepare(
        `SELECT
           p.id,
           p.name,
           p.position,
           p.detail_role,
           p.detail_label,
           p.side_role,
           p.club_id,
           p.league_id,
           p.fm_rating,
           COALESCE(p.market_value_eur, 0) AS market_value_eur,
           p.capology_wage_pw,
           p.fm_wage_pw,
           p.portrait_url,
           c.name AS club_name,
           l.name AS league_name
         FROM players p
         JOIN clubs c ON c.id = p.club_id
         JOIN leagues l ON l.id = p.league_id
         WHERE p.fm_rating IS NOT NULL
           AND p.league_id IN (${leaguePlaceholders})`,
      )
      .all(...TOP8_IDS) as Array<Record<string, unknown>>
  )
    .map((r) => withTrustedWageAsWagePw(r, peers))
    .sort(
      (a, b) =>
        (Number(a.wage_pw) || 0) - (Number(b.wage_pw) || 0) ||
        (Number(a.market_value_eur) || 0) - (Number(b.market_value_eur) || 0) ||
        (Number(b.fm_rating) || 0) - (Number(a.fm_rating) || 0) ||
        String(a.name ?? "").localeCompare(String(b.name ?? "")),
    );

  const overflow = overflowRows.map(toDraftPlayer).filter((p) => !poolIds.has(p.id));

  console.log(`Pool: ${pool.length} quota + ${overflow.length} overflow fillers`);
  console.log(`Teams: ${CELESTIAL_TEAM_NAMES.join(", ")}`);
  console.log(
    `Rules: MV≤€${MV_CAP / 1e6}M wage≤${wageK(WAGE_CAP)} ≥${MIN_PER_LEAGUE}/league ≤${MAX_PER_CLUB}/club ≥${MIN_GK} GK`,
  );

  const result = runPrimerDraft(pool, overflow, CELESTIAL_TEAM_NAMES);

  const { clubFixtures, gameweeks } = loadClubFixtures(db);
  console.log(`Fixtures: ${gameweeks.length} gameweeks (GW≥1, no friendlies)`);

  // Rebuild DraftPlayer lists with position fields for lineup selection.
  const playersById = new Map<string, DraftPlayer>();
  for (const p of [...pool, ...overflow]) playersById.set(p.id, p);

  for (const team of result.teams) {
    const squad: DraftPlayer[] = team.players.map((p) => {
      const full = playersById.get(p.id);
      if (full) return full;
      return {
        id: p.id,
        name: p.name,
        club_id: p.club_id,
        club_name: p.club_name,
        league_id: p.league_id,
        league_name: p.league_name,
        fm_rating: p.fm_rating,
        market_value_eur: p.market_value_eur,
        wage_pw: p.wage_pw,
        position_display: p.position_display,
        portrait_url: p.portrait_url,
        position: null,
        detail_role: null,
        detail_label: null,
        side_role: null,
      };
    });
    team.gameweeks = buildTeamGameweeks(squad, gameweeks, clubFixtures);
  }

  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

  const { summary, teams } = result;
  console.log("\n=== Primer draft ===");
  console.log(`Teams with ≥26: ${teams.filter((t) => t.player_count >= 26).length}/16`);
  console.log(`All within budget: ${summary.all_within_budget}`);
  console.log(`All ≥3/league: ${summary.all_leagues_ok}`);
  console.log(`All ≤3/club: ${summary.all_clubs_ok}`);
  console.log(`All ≥3 GK: ${summary.all_gk_ok}`);
  console.log(`All field a formation: ${summary.all_field_formation}`);
  console.log(`Unselected (quota): ${summary.unselected_count}`);

  console.log("\nPer team:");
  for (const t of teams) {
    const forms = t.formations.length ? t.formations.join(", ") : "—";
    const gws = t.gameweeks?.length ?? 0;
    const sample = t.gameweeks?.[0];
    const sampleTxt = sample
      ? `GW${sample.gw} ${sample.formation} xPts=${sample.xPtsTotal}`
      : "no lineups";
    const leagueTxt = TOP8_IDS.map((id) => `${id}:${t.leagues[id] ?? 0}`).join(" ");
    const flags = [
      t.sum_wage_pw <= WAGE_CAP ? "wage✓" : "wage✗",
      t.leagues_ok ? "lig✓" : "lig✗",
      t.clubs_ok ? "club✓" : "club✗",
      t.gk_ok ? "gk✓" : "gk✗",
    ].join(" ");
    console.log(
      `  ${t.name}: ${t.player_count} · MV €${(t.sum_market_value_eur / 1e6).toFixed(0)}M · wage ${wageK(t.sum_wage_pw)} · maxClub ${t.max_club} · ${t.groups.GK}/${t.groups.DEF}/${t.groups.MID}/${t.groups.ATT} · ${flags}`,
    );
    console.log(`    ${leagueTxt}`);
    console.log(`    ${forms} · ${gws} GW · ${sampleTxt}`);
  }
  console.log(`\nWrote ${outPath}`);
  db.close();

  const ok =
    summary.all_have_26 &&
    summary.all_within_budget &&
    summary.all_leagues_ok &&
    summary.all_clubs_ok &&
    summary.all_gk_ok;
  if (!ok) {
    process.exitCode = 1;
  }
}

main();
