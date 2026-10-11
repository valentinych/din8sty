/** Top-8 UEFA club coefficient domestic leagues (TM competition codes). */
export const TOP8_LEAGUES = [
  { id: "GB1", name: "Premier League", country: "England", afId: 39 },
  { id: "L1", name: "Bundesliga", country: "Germany", afId: 78 },
  { id: "ES1", name: "LaLiga", country: "Spain", afId: 140 },
  { id: "IT1", name: "Serie A", country: "Italy", afId: 135 },
  { id: "FR1", name: "Ligue 1", country: "France", afId: 61 },
  { id: "PO1", name: "Liga Portugal", country: "Portugal", afId: 94 },
  { id: "BE1", name: "Jupiler Pro League", country: "Belgium", afId: 144 },
  { id: "NL1", name: "Eredivisie", country: "Netherlands", afId: 88 },
] as const;

export type LeagueId = (typeof TOP8_LEAGUES)[number]["id"];

export const TOP8_IDS = TOP8_LEAGUES.map((l) => l.id);

/**
 * Mixed quota pool: top N per league by FM rating (same ranking as top-26).
 * Codes ENG/SPA/… map to TM ids GB1/ES1/…
 */
export const QUOTA_POOL: ReadonlyArray<{ id: LeagueId; n: number }> = [
  { id: "GB1", n: 66 }, // ENG Premier League
  { id: "ES1", n: 62 }, // SPA LaLiga
  { id: "L1", n: 58 }, // GER Bundesliga
  { id: "FR1", n: 54 }, // FRA Ligue 1
  { id: "IT1", n: 50 }, // ITA Serie A
  { id: "PO1", n: 46 }, // POR Liga Portugal
  { id: "NL1", n: 42 }, // NED Eredivisie
  { id: "BE1", n: 38 }, // BEL Jupiler Pro League
];

export const QUOTA_POOL_TOTAL = QUOTA_POOL.reduce((s, q) => s + q.n, 0); // 416

/** TM competition code → API-Football league id. */
export const TM_TO_AF: Record<LeagueId, number> = Object.fromEntries(
  TOP8_LEAGUES.map((l) => [l.id, l.afId]),
) as Record<LeagueId, number>;

/** API-Football league id → TM competition code. */
export const AF_TO_TM: Record<number, LeagueId> = Object.fromEntries(
  TOP8_LEAGUES.map((l) => [l.afId, l.id]),
) as Record<number, LeagueId>;

/** Default AF season = starting year of the campaign (2026 = 2026/27). */
export const AF_SEASON = 2026;

/** FMInside league filter labels (Male senior divisions). */
export const FMINSIDE_LEAGUE_LABEL: Record<LeagueId, string> = {
  GB1: "Premier League",
  L1: "Bundesliga",
  ES1: "LaLiga",
  IT1: "Serie A",
  FR1: "Ligue 1",
  PO1: "Liga Portugal",
  BE1: "Jupiler Pro League",
  NL1: "Eredivisie",
};
