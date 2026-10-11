/**
 * Unofficial FotMob JSON (fotmob.com/api/data/*). Injuries live on team squads.
 * No auth. Be polite: ~2 req/s.
 */

const BASE = "https://www.fotmob.com/api/data";

export const FOTMOB_TOP4_LEAGUES = [
  { tm: "GB1", id: 47 },
  { tm: "ES1", id: 87 },
  { tm: "IT1", id: 55 },
  { tm: "L1", id: 54 },
] as const;

export type FotmobTableTeam = { id: number; name: string };
export type FotmobSquadPlayer = {
  id: number;
  name: string;
  injured: boolean;
  expectedReturn: string | null;
};

const recent: number[] = [];
let lastIssued = 0;
let chain: Promise<void> = Promise.resolve();

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function rateLimit(): Promise<void> {
  const previous = chain;
  let release!: () => void;
  chain = new Promise<void>((r) => {
    release = r;
  });
  try {
    await previous;
    for (;;) {
      const now = Date.now();
      if (lastIssued && now - lastIssued < 400) {
        await sleep(400 - (now - lastIssued));
        continue;
      }
      while (recent.length && now - recent[0]! >= 1000) recent.shift();
      if (recent.length >= 2) {
        await sleep(1000 - (now - recent[0]!) + 20);
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

async function getJson(apiPath: string, params: Record<string, string | number>): Promise<unknown> {
  await rateLimit();
  const url = new URL(BASE + apiPath);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`FotMob ${apiPath} failed: ${res.status}`);
  }
  const text = await res.text();
  return JSON.parse(text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")) as unknown;
}

export async function fotmobLeagueTeams(leagueId: number): Promise<FotmobTableTeam[]> {
  const data = (await getJson("/leagues", { id: leagueId })) as {
    table?: Array<{ data?: { table?: { all?: Array<{ id: number; name?: string; shortName?: string }> } } }>;
  };
  const all = data.table?.[0]?.data?.table?.all ?? [];
  const out: FotmobTableTeam[] = [];
  const seen = new Set<number>();
  for (const row of all) {
    const id = Number(row.id);
    if (!Number.isFinite(id) || seen.has(id)) continue;
    seen.add(id);
    const name = String(row.name || row.shortName || "").trim();
    if (!name) continue;
    out.push({ id, name });
  }
  return out;
}

export async function fotmobTeamSquad(teamId: number): Promise<FotmobSquadPlayer[]> {
  const data = (await getJson("/teams", { id: teamId })) as {
    squad?: { squad?: Array<{ title?: string; members?: unknown[] }> };
  };
  const groups = data.squad?.squad ?? [];
  const out: FotmobSquadPlayer[] = [];
  for (const g of groups) {
    const title = String(g.title || "").toLowerCase();
    if (title === "coach" || title === "staff") continue;
    for (const raw of g.members ?? []) {
      const m = raw as {
        id?: number;
        name?: string;
        injured?: boolean;
        injury?: { expectedReturn?: string } | null;
      };
      const id = Number(m.id);
      const name = String(m.name || "").trim();
      if (!Number.isFinite(id) || !name) continue;
      const inj = m.injury && typeof m.injury === "object" ? m.injury : null;
      out.push({
        id,
        name,
        injured: Boolean(m.injured) || Boolean(inj),
        expectedReturn: inj?.expectedReturn ? String(inj.expectedReturn) : null,
      });
    }
  }
  return out;
}
