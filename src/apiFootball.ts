/**
 * Minimal API-Football client (mirrors transfermarkt rate-limit + auth headers).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://v3.football.api-sports.io";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

export type AfFixture = {
  fixture: {
    id: number;
    date: string;
    status: {
      short: string;
      elapsed?: number | null;
      extra?: number | null;
    };
    venue?: { id: number | null; name: string | null; city: string | null } | null;
  };
  league: {
    id: number;
    name: string;
    country?: string | null;
    /** "League" | "Cup" when AF provides it. */
    type?: string | null;
    round: string;
    season?: number;
  };
  teams: {
    home: { id: number; name: string };
    away: { id: number; name: string };
  };
  goals: { home: number | null; away: number | null };
};

type AfResponse<T> = {
  response: T;
  results: number;
  errors?: unknown;
};

const recent: number[] = [];
let lastIssued = 0;
let chain: Promise<void> = Promise.resolve();

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Max ~4 req/s with ≥250ms gap (same as transfermarkt). */
async function rateLimit4perSec(): Promise<void> {
  const previous = chain;
  let release!: () => void;
  chain = new Promise<void>((r) => {
    release = r;
  });
  try {
    await previous;
    for (;;) {
      const now = Date.now();
      const gap = now - lastIssued;
      if (gap < 250) {
        await sleep(250 - gap);
        continue;
      }
      while (recent.length > 0 && now - recent[0]! >= 1000) recent.shift();
      if (recent.length >= 4) {
        await sleep(1000 - (now - recent[0]!) + 5);
        continue;
      }
      recent.push(now);
      lastIssued = now;
      return;
    }
  } finally {
    release();
  }
}

function readEnvKey(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*API_FOOTBALL_KEY\s*=\s*(.+?)\s*$/);
    if (m) {
      const v = m[1]!.replace(/^["']|["']$/g, "").trim();
      if (v && v !== "your_api_sports_key_here") return v;
    }
  }
  return null;
}

export function requireApiKey(): string {
  const fromEnv = process.env.API_FOOTBALL_KEY?.trim();
  if (fromEnv && fromEnv !== "your_api_sports_key_here") return fromEnv;

  const local = readEnvKey(path.join(root, ".env"));
  if (local) return local;

  const tm = readEnvKey(path.resolve(root, "..", "transfermarkt", ".env"));
  if (tm) return tm;

  throw new Error(
    "API_FOOTBALL_KEY missing. Set it in Din8sty/.env or ../transfermarkt/.env",
  );
}

export class ApiFootballError extends Error {
  readonly errors: unknown;
  constructor(path: string, errors: unknown) {
    super(`API-Football error on ${path}: ${JSON.stringify(errors)}`);
    this.errors = errors;
  }
}

function errorObject(
  errors: unknown,
): Record<string, unknown> | null {
  if (!errors || typeof errors !== "object" || Array.isArray(errors)) return null;
  return errors as Record<string, unknown>;
}

export function afErrorIsQuota(err: unknown): boolean {
  if (err instanceof ApiFootballError) {
    const o = errorObject(err.errors);
    return !!(o && ("requests" in o || "rateLimit" in o));
  }
  return false;
}

export function afErrorIsPlan(err: unknown): boolean {
  if (err instanceof ApiFootballError) {
    const o = errorObject(err.errors);
    return !!(o && "plan" in o);
  }
  return false;
}

async function get<T>(apiPath: string, params: Record<string, string | number>): Promise<AfResponse<T>> {
  await rateLimit4perSec();

  const url = new URL(BASE + apiPath);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const res = await fetch(url, {
    headers: { "x-apisports-key": requireApiKey() },
  });

  if (!res.ok) {
    throw new Error(`API-Football ${apiPath} failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as AfResponse<T>;
  if (data.errors && Object.keys(data.errors as object).length > 0) {
    throw new ApiFootballError(apiPath, data.errors);
  }
  return data;
}

export function fixtures(league: number, season: number) {
  return get<AfFixture[]>("/fixtures", { league, season });
}

/** All competitions for one team in a season (league + cups + Europe + friendlies). */
export function fixturesByTeam(team: number, season: number) {
  return get<AfFixture[]>("/fixtures", { team, season });
}

/** Currently live fixtures worldwide. Free plans allow `live`; `ids` is Pro-only. */
export function fixturesLive() {
  return get<AfFixture[]>("/fixtures", { live: "all" });
}

/** All fixtures on a calendar date (YYYY-MM-DD). */
export function fixturesOnDate(date: string) {
  return get<AfFixture[]>("/fixtures", { date });
}

/** Single fixture by id (all plans). Prefer live/date batching when possible. */
export function fixtureById(id: number) {
  return get<AfFixture[]>("/fixtures", { id });
}

/** Up to 20 fixture ids (hyphenated `ids`). Mega/Pro; free plans throw `plan`. */
export function fixturesByIds(ids: number[]) {
  const uniq = [...new Set(ids.filter((id) => Number.isFinite(id)))].slice(
    0,
    20,
  );
  if (!uniq.length) {
    return Promise.resolve({ response: [] as AfFixture[], results: 0 });
  }
  return get<AfFixture[]>("/fixtures", { ids: uniq.join("-") });
}

export type AfFixturePlayerTeam = {
  team: { id: number; name: string; logo?: string | null };
  players: Array<{
    player: { id: number; name: string; photo?: string | null };
    statistics: Array<{
      games?: {
        minutes?: number | null;
        position?: string | null;
        number?: number | null;
        rating?: string | null;
        captain?: boolean | null;
        substitute?: boolean | null;
      } | null;
      goals?: {
        total?: number | null;
        conceded?: number | null;
        assists?: number | null;
        saves?: number | null;
      } | null;
      cards?: {
        yellow?: number | null;
        red?: number | null;
      } | null;
      penalty?: {
        won?: number | null;
        /** AF typo: committed foul that conceded a penalty. */
        commited?: number | null;
        scored?: number | null;
        missed?: number | null;
        saved?: number | null;
      } | null;
    }>;
  }>;
};

/** Per-fixture player minutes/stats (two teams). */
export function fixturePlayers(fixtureId: number) {
  return get<AfFixturePlayerTeam[]>("/fixtures/players", { fixture: fixtureId });
}

export type AfFixtureEvent = {
  time: { elapsed: number | null; extra: number | null };
  team: { id: number; name?: string | null };
  player: { id: number | null; name?: string | null };
  assist: { id: number | null; name?: string | null } | null;
  type: string;
  detail: string | null;
};

/** Goals, cards, substitutions for one fixture. */
export function fixtureEvents(fixtureId: number) {
  return get<AfFixtureEvent[]>("/fixtures/events", { fixture: fixtureId });
}

export type AfTeamRow = {
  team: { id: number; name: string; logo?: string | null };
  venue?: { name?: string | null } | null;
};

/** Clubs in a competition for a season (may include playoff-only sides). */
export function teamsByLeague(league: number, season: number) {
  return get<AfTeamRow[]>("/teams", { league, season });
}

export type AfStandingTeam = {
  rank: number;
  team: { id: number; name: string; logo?: string | null };
  all?: { played?: number | null };
};

export type AfStandingsBlock = {
  league: {
    id: number;
    name: string;
    country?: string | null;
    season?: number;
    /** Usually one table; some cups return multiple groups. */
    standings: AfStandingTeam[][];
  };
};

/**
 * Regular-season league table. Prefer this over `/teams` for Top-4 squads —
 * `/teams?league=&season=` can include relegation-playoff clubs (e.g. Paderborn in BL).
 */
export function standingsByLeague(league: number, season: number) {
  return get<AfStandingsBlock[]>("/standings", { league, season });
}

/** Unique team ids from standings response (all tables). */
export function standingTeamRows(response: AfStandingsBlock[] | undefined): AfStandingTeam[] {
  const out: AfStandingTeam[] = [];
  const seen = new Set<number>();
  for (const block of response || []) {
    for (const table of block.league?.standings || []) {
      for (const row of table || []) {
        const id = row.team?.id;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(row);
      }
    }
  }
  return out;
}

export type AfPlayerSeasonRow = {
  player: {
    id: number;
    name: string;
    firstname?: string | null;
    lastname?: string | null;
    photo?: string | null;
  };
  statistics: Array<{
    team: { id: number; name: string; logo?: string | null };
    league: {
      id: number;
      name: string;
      country?: string | null;
      season?: number | null;
    };
    games: {
      appearences: number | null;
      lineups: number | null;
      minutes: number | null;
      position: string | null;
      rating?: string | null;
    };
    goals: {
      total: number | null;
      conceded: number | null;
      assists: number | null;
      saves: number | null;
    };
    cards: {
      yellow: number | null;
      yellowred: number | null;
      red: number | null;
    };
    penalty: {
      won?: number | null;
      commited?: number | null;
      scored: number | null;
      missed: number | null;
      saved: number | null;
    };
  }>;
};

export type AfPlayersPage = AfResponse<AfPlayerSeasonRow[]> & {
  paging?: { current: number; total: number };
};

/** Paginated player season stats for one team (all competitions). */
export function playersByTeam(team: number, season: number, page = 1) {
  return get<AfPlayerSeasonRow[]>("/players", { team, season, page }) as Promise<AfPlayersPage>;
}

export type AfInjuryRow = {
  player: {
    id: number;
    name: string;
    photo?: string | null;
    type?: string | null;
    reason?: string | null;
  };
  team: { id: number; name: string };
  fixture: { id: number; date: string; timestamp?: number | null };
  league: { id: number; season?: number | null; name?: string | null };
};

/** Injuries + suspensions for one league season. Empty when coverage.injuries is false. */
export function injuriesByLeague(league: number, season: number) {
  return get<AfInjuryRow[]>("/injuries", { league, season });
}
