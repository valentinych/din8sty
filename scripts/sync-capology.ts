/**
 * Scrape Capology club salary pages → match onto din8sty.db players.
 *
 * - Club pages: https://www.capology.com/club/{slug}/salaries/
 * - Weekly wage = annual_gross_{native} / 52, converted to EUR via Frankfurter
 *   (ECB reference rates): https://www.frankfurter.app/
 * - BE / NL leagues are not on Capology → skipped.
 *
 * Usage:
 *   npm run capology:sync
 *   npm run capology:sync -- --limit 3
 *   npm run capology:sync -- --match-only
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const dbPath = path.join(root, "data", "din8sty.db");
const rawPath = path.join(root, "data", "capology_raw.json");
const clubMapPath = path.join(root, "data", "capology_club_map.json");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Capology league salary index → Din8sty league_id + native currency. */
const LEAGUES: Array<{
  leagueId: string;
  path: string;
  currency: "GBP" | "EUR";
}> = [
  { leagueId: "GB1", path: "uk/premier-league/salaries/", currency: "GBP" },
  { leagueId: "L1", path: "de/1-bundesliga/salaries/", currency: "EUR" },
  { leagueId: "ES1", path: "es/la-liga/salaries/", currency: "EUR" },
  { leagueId: "IT1", path: "it/serie-a/salaries/", currency: "EUR" },
  { leagueId: "FR1", path: "fr/ligue-1/salaries/", currency: "EUR" },
  { leagueId: "PO1", path: "pt/primeira-liga/salaries/", currency: "EUR" },
];

/** TM club id → Capology slug (hard cases / aliases). */
const CLUB_OVERRIDES: Record<string, string> = {
  "583": "psg", // Paris Saint-Germain
  "621": "athletic-club", // Athletic Bilbao
  "13": "atletico-madrid",
  "1108": "alaves",
  "897": "deportivo",
  "940": "celta-vigo",
  "714": "espanyol",
  "150": "real-betis",
  "1237": "brighton",
  "989": "bournemouth",
  "762": "newcastle",
  "148": "tottenham",
  "3": "koln",
  "18": "monchengladbach",
  "23826": "leipzig",
  "15": "bayer-leverkusen",
  "89": "union-berlin",
  "39": "mainz",
  "533": "hoffenheim",
  "33": "schalke-04",
  "127": "paderborn",
  "64": "elversberg",
  "46": "inter-milan",
  "5": "ac-milan",
  "12": "roma",
  "6195": "napoli",
  "2919": "monza",
  "336": "sporting-lisbon",
  "2420": "vitoria-sc",
  "244": "marseille",
  "1041": "lyon",
  "273": "rennes",
  "3911": "brest",
  "667": "strasbourg",
  "1082": "lille",
  "826": "lens",
  "162": "monaco",
};

const CLUB_MIN_SCORE = 70;
const AGE_TOLERANCE = 1;
const REQUEST_GAP_MS = 2500;

type CapPlayer = {
  name: string;
  url?: string;
  age?: number | null;
  annual_orig?: number | null;
  weekly_orig?: number | null;
  currency_orig?: string | null;
  weekly_eur?: number | null;
  wage_display?: string | null;
};

type CapClubEntry = {
  tm_id: string;
  tm_name: string;
  league_id: string;
  slug: string;
  url: string;
  currency: string;
  players: CapPlayer[];
  scraped_at: string;
  error?: string;
};

type RawFile = {
  fx?: {
    source: string;
    date: string;
    rates: Record<string, number>;
  };
  clubs: Record<string, CapClubEntry>;
};

type DinPlayer = {
  id: string;
  name: string;
  club_id: string;
  age: number | null;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function clubNorm(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/ł/gi, "l")
    .replace(/ø/gi, "o")
    .replace(/ß/g, "ss")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(
      /\b(fc|cf|afc|sc|ac|as|ss|ud|rc|rsc|kv|sv|bv|vfl|vfb|tsg|ssc|usc|calcio|club|football|de|da|do|la|le|el|the|1\.|1899|1909|1907|1913|04|05|07|29)\b/g,
      " ",
    )
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toSlug(s: string): string {
  return clubNorm(s).replace(/\s+/g, "-");
}

function playerNorm(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/ł/gi, "l")
    .replace(/đ/gi, "d")
    .replace(/ø/gi, "o")
    .replace(/æ/gi, "ae")
    .replace(/œ/gi, "oe")
    .replace(/ß/g, "ss")
    .toLowerCase()
    .replace(/\b(jr|junior|ii|iii)\b/g, "")
    .replace(/[''`´\u2019\u02bc]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreNames(a: string, b: string): number {
  const na = playerNorm(a);
  const nb = playerNorm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  const ta = na.split(" ").filter(Boolean);
  const tb = nb.split(" ").filter(Boolean);
  if (ta.length === 1 && tb.includes(ta[0]!) && ta[0]!.length >= 4) return 95;
  if (tb.length === 1 && ta.includes(tb[0]!) && tb[0]!.length >= 4) return 95;
  if (na.includes(nb) || nb.includes(na)) return 85;
  const sa = new Set(ta);
  const sb = new Set(tb);
  const inter = [...sa].filter((t) => sb.has(t)).length;
  const union = new Set([...sa, ...sb]).size;
  const jacc = union ? inter / union : 0;
  const la = ta.at(-1) ?? "";
  const lb = tb.at(-1) ?? "";
  let score = Math.round(jacc * 70);
  if (la && la === lb) score += 20;
  return score;
}

function ageOk(tmAge: number | null | undefined, capAge: number | null | undefined): boolean {
  if (tmAge == null || capAge == null) return true;
  return Math.abs(tmAge - capAge) <= AGE_TOLERANCE;
}

function formatEurWeekly(n: number): string {
  if (n >= 1_000_000) return `€${(n / 1_000_000).toFixed(n >= 100_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `€${Math.round(n / 1_000)}K`;
  return `€${n}`;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "en-US,en;q=0.9",
      Accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** Frankfurter.app — ECB reference FX rates (free, no key). */
async function fetchFx(): Promise<{ source: string; date: string; rates: Record<string, number> }> {
  const url = "https://api.frankfurter.app/latest?from=EUR&to=GBP,USD";
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`FX HTTP ${res.status}`);
  const data = (await res.json()) as {
    date: string;
    base: string;
    rates: Record<string, number>;
  };
  // We need CUR→EUR. Frankfurter returns EUR→CUR; invert.
  const rates: Record<string, number> = { EUR: 1 };
  for (const [cur, eurToCur] of Object.entries(data.rates)) {
    if (eurToCur > 0) rates[cur] = 1 / eurToCur;
  }
  return {
    source: "https://www.frankfurter.app/ (ECB reference rates)",
    date: data.date,
    rates,
  };
}

function parseClubPage(
  html: string,
  currency: "GBP" | "EUR",
  rates: Record<string, number>,
): CapPlayer[] {
  const m = html.match(/var data = (\[[\s\S]*?\]);\s*\n/);
  if (!m) return [];
  const block = m[1]!;
  const players: CapPlayer[] = [];

  for (const obj of block.matchAll(/\{[^{}]*?'name':\s*"([\s\S]*?)"[^{}]*?\}/g)) {
    const chunk = obj[0];
    const nameHtml = obj[1]!;
    const nameM = nameHtml.match(/>([^<]+)<\/a>/);
    const name = nameM?.[1]?.trim();
    if (!name) continue;
    const hrefM = nameHtml.match(/href='([^']+)'/);
    const ageM = chunk.match(/'age':\s*Math\.round\("(\d+)"\)/);
    const annualKey = `annual_gross_${currency.toLowerCase()}`;
    const annualM = chunk.match(new RegExp(`'${annualKey}':accounting\\.formatMoney\\("([\\d.]+)"`));
    if (!annualM) {
      players.push({
        name,
        url: hrefM?.[1],
        age: ageM ? Number(ageM[1]) : null,
        annual_orig: null,
        weekly_orig: null,
        currency_orig: currency,
        weekly_eur: null,
        wage_display: null,
      });
      continue;
    }
    const annualOrig = Number(annualM[1]);
    const weeklyOrig = Math.round(annualOrig / 52);
    const rate = rates[currency] ?? (currency === "EUR" ? 1 : NaN);
    const weeklyEur = Number.isFinite(rate) ? Math.round(weeklyOrig * rate) : null;
    players.push({
      name,
      url: hrefM?.[1],
      age: ageM ? Number(ageM[1]) : null,
      annual_orig: annualOrig,
      weekly_orig: weeklyOrig,
      currency_orig: currency,
      weekly_eur: weeklyEur,
      wage_display: weeklyEur != null ? formatEurWeekly(weeklyEur) : null,
    });
  }
  return players;
}

function extractSlugs(html: string): string[] {
  return [...new Set([...html.matchAll(/href="\/club\/([^"/]+)\/salaries\/"/g)].map((m) => m[1]!))];
}

function mapClubs(
  dinClubs: Array<{ id: string; name: string; short_name: string | null; league_id: string }>,
  slugsByLeague: Record<string, string[]>,
): { map: Record<string, string>; unmatched: string[]; unused: Record<string, string[]> } {
  const map: Record<string, string> = {};
  const unmatched: string[] = [];
  const unused: Record<string, string[]> = {};

  for (const league of LEAGUES) {
    const slugs = new Set(slugsByLeague[league.leagueId] ?? []);
    const used = new Set<string>();
    const clubs = dinClubs.filter((c) => c.league_id === league.leagueId);

    for (const club of clubs) {
      const override = CLUB_OVERRIDES[club.id];
      if (override && slugs.has(override)) {
        map[club.id] = override;
        used.add(override);
        continue;
      }

      const candidates = [
        toSlug(club.name),
        toSlug(club.short_name || ""),
        toSlug(club.name.replace(/^1\./, "")),
      ].filter(Boolean);

      let hit: string | null = null;
      for (const cand of candidates) {
        if (slugs.has(cand) && !used.has(cand)) {
          hit = cand;
          break;
        }
      }

      if (!hit) {
        // Token overlap against remaining slugs
        const cn = clubNorm(club.name);
        const csn = clubNorm(club.short_name || "");
        let best: { slug: string; score: number } | null = null;
        for (const slug of slugs) {
          if (used.has(slug)) continue;
          const sn = slug.replace(/-/g, " ");
          const score = Math.max(scoreNames(cn, sn), scoreNames(csn, sn), scoreNames(club.name, sn));
          // Also reward slug containment
          let adj = score;
          if (cn.includes(sn) || sn.includes(cn) || csn.includes(sn)) adj = Math.max(adj, 90);
          if (!best || adj > best.score) best = { slug, score: adj };
        }
        if (best && best.score >= 85) hit = best.slug;
      }

      if (hit) {
        map[club.id] = hit;
        used.add(hit);
      } else {
        unmatched.push(`${club.league_id}:${club.id}:${club.name}`);
      }
    }

    unused[league.leagueId] = [...slugs].filter((s) => !used.has(s)).sort();
  }

  return { map, unmatched, unused };
}

function ensureColumns(db: Database.Database) {
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(players)`).all() as Array<{ name: string }>).map((c) => c.name),
  );
  const adds: Array<[string, string]> = [
    ["capology_wage_pw", "INTEGER"],
    ["capology_wage_display", "TEXT"],
    ["capology_currency_orig", "TEXT"],
    ["capology_synced_at", "TEXT"],
  ];
  for (const [name, typ] of adds) {
    if (!cols.has(name)) {
      db.exec(`ALTER TABLE players ADD COLUMN ${name} ${typ}`);
      console.log(`  + players.${name}`);
    }
  }
}

function setMeta(db: Database.Database, key: string, value: string) {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

function parseArgs() {
  const args = process.argv.slice(2);
  let limit: number | null = null;
  let matchOnly = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit") limit = Number(args[++i]);
    if (args[i] === "--match-only") matchOnly = true;
  }
  return { limit, matchOnly };
}

async function scrapeAll(opts: {
  limit: number | null;
  map: Record<string, string>;
  dinClubs: Array<{ id: string; name: string; league_id: string }>;
  rates: Record<string, number>;
  existing: RawFile;
}): Promise<RawFile> {
  const currencyByLeague = Object.fromEntries(LEAGUES.map((l) => [l.leagueId, l.currency]));
  const out: RawFile = {
    fx: opts.existing.fx,
    clubs: { ...opts.existing.clubs },
  };

  const targets = opts.dinClubs.filter((c) => opts.map[c.id]);
  const capped = opts.limit != null ? targets.slice(0, opts.limit) : targets;
  console.log(`Scraping ${capped.length} / ${targets.length} mapped clubs…`);

  let i = 0;
  for (const club of capped) {
    i++;
    const slug = opts.map[club.id]!;
    const currency = (currencyByLeague[club.league_id] ?? "EUR") as "GBP" | "EUR";
    const url = `https://www.capology.com/club/${slug}/salaries/`;
    const prev = out.clubs[club.id];
    if (prev?.players?.length && !prev.error) {
      console.log(`  [${i}/${capped.length}] skip (cached) ${club.name} → ${slug}`);
      continue;
    }
    // Clear previous error so a successful scrape overwrites it
    if (prev?.error) delete out.clubs[club.id];

    process.stdout.write(`  [${i}/${capped.length}] ${club.name} → ${slug} … `);
    try {
      await sleep(REQUEST_GAP_MS);
      const html = await fetchText(url);
      const players = parseClubPage(html, currency, opts.rates);
      out.clubs[club.id] = {
        tm_id: club.id,
        tm_name: club.name,
        league_id: club.league_id,
        slug,
        url,
        currency,
        players,
        scraped_at: new Date().toISOString(),
      };
      console.log(`${players.length} players`);
      fs.writeFileSync(rawPath, JSON.stringify(out, null, 2));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`FAIL ${msg}`);
      out.clubs[club.id] = {
        tm_id: club.id,
        tm_name: club.name,
        league_id: club.league_id,
        slug,
        url,
        currency,
        players: [],
        scraped_at: new Date().toISOString(),
        error: msg,
      };
      fs.writeFileSync(rawPath, JSON.stringify(out, null, 2));
      if (msg.includes("429")) {
        console.log("  rate-limited — waiting 20s");
        await sleep(20_000);
      }
    }
  }

  return out;
}

function matchIntoDb(db: Database.Database, raw: RawFile, rates: Record<string, number>) {
  const now = new Date().toISOString();
  db.exec(`
    UPDATE players SET
      capology_wage_pw = NULL,
      capology_wage_display = NULL,
      capology_currency_orig = NULL,
      capology_synced_at = NULL;
  `);

  const update = db.prepare(
    `UPDATE players SET
       capology_wage_pw = @wage_pw,
       capology_wage_display = @wage_display,
       capology_currency_orig = @currency_orig,
       capology_synced_at = @synced_at
     WHERE id = @id`,
  );

  const dinPlayers = db
    .prepare(`SELECT id, name, club_id, age FROM players`)
    .all() as DinPlayer[];

  const byClub = new Map<string, DinPlayer[]>();
  for (const p of dinPlayers) {
    const list = byClub.get(p.club_id) ?? [];
    list.push(p);
    byClub.set(p.club_id, list);
  }

  function toEur(cap: CapPlayer): { weekly_eur: number; display: string; currency: string } | null {
    const currency = (cap.currency_orig || "EUR").toUpperCase();
    const weeklyOrig = cap.weekly_orig;
    if (weeklyOrig == null) return null;
    const rate = rates[currency] ?? (currency === "EUR" ? 1 : undefined);
    if (rate == null || !Number.isFinite(rate)) return null;
    const weekly_eur = Math.round(weeklyOrig * rate);
    return { weekly_eur, display: formatEurWeekly(weekly_eur), currency };
  }

  let matched = 0;
  let clubsOk = 0;
  let capPlayers = 0;
  const apply = db.transaction(() => {
    for (const [clubId, entry] of Object.entries(raw.clubs)) {
      if (!entry.players?.length) continue;
      clubsOk++;
      const pool = [...(byClub.get(clubId) ?? [])];

      type Cand = { din: DinPlayer; cap: CapPlayer; score: number };
      const cands: Cand[] = [];
      for (const cap of entry.players) {
        capPlayers++;
        for (const din of pool) {
          const score = scoreNames(din.name, cap.name);
          if (score < CLUB_MIN_SCORE) continue;
          if (!ageOk(din.age, cap.age)) continue;
          cands.push({ din, cap, score });
        }
      }
      cands.sort((a, b) => b.score - a.score);

      const used = new Set<string>();
      const usedCap = new Set<string>();
      for (const c of cands) {
        const capKey = c.cap.url ?? c.cap.name;
        if (used.has(c.din.id) || usedCap.has(capKey)) continue;
        const eurWage = toEur(c.cap);
        if (!eurWage) continue;
        used.add(c.din.id);
        usedCap.add(capKey);
        update.run({
          id: c.din.id,
          wage_pw: eurWage.weekly_eur,
          wage_display: eurWage.display,
          currency_orig: eurWage.currency,
          synced_at: now,
        });
        matched++;
      }
    }
  });
  apply();

  return { matched, clubsOk, capPlayers };
}

async function main() {
  const { limit, matchOnly } = parseArgs();
  if (!fs.existsSync(dbPath)) {
    console.error("Missing data/din8sty.db — run npm run db:build");
    process.exit(1);
  }

  const db = new Database(dbPath);
  console.log("Ensuring Capology columns…");
  ensureColumns(db);

  const dinClubs = db
    .prepare(
      `SELECT id, name, short_name, league_id FROM clubs
       WHERE league_id IN (${LEAGUES.map((l) => `'${l.leagueId}'`).join(",")})
       ORDER BY league_id, name`,
    )
    .all() as Array<{ id: string; name: string; short_name: string | null; league_id: string }>;

  let existing: RawFile = { clubs: {} };
  if (fs.existsSync(rawPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(rawPath, "utf8")) as RawFile;
    } catch {
      existing = { clubs: {} };
    }
  }

  let fx = existing.fx;
  if (!matchOnly || !fx?.rates) {
    console.log("Fetching FX rates (Frankfurter / ECB)…");
    fx = await fetchFx();
    console.log(
      `  date=${fx.date} GBP→EUR=${fx.rates.GBP?.toFixed(4)} source=${fx.source}`,
    );
  } else {
    console.log(
      `Reusing FX date=${fx.date} GBP→EUR=${fx.rates.GBP?.toFixed(4)}`,
    );
  }

  // Discover Capology club slugs per league (reuse previous map/raw on 429)
  const slugsByLeague: Record<string, string[]> = {};
  if (fs.existsSync(clubMapPath)) {
    try {
      const prevMap = JSON.parse(fs.readFileSync(clubMapPath, "utf8")) as {
        map?: Record<string, string>;
        unused_capology_slugs?: Record<string, string[]>;
      };
      if (prevMap.unused_capology_slugs) {
        for (const [lid, unused] of Object.entries(prevMap.unused_capology_slugs)) {
          const used = Object.entries(prevMap.map ?? {})
            .filter(([id]) => dinClubs.some((c) => c.id === id && c.league_id === lid))
            .map(([, slug]) => slug);
          slugsByLeague[lid] = [...new Set([...(unused ?? []), ...used])];
        }
      }
      // Also seed from map values keyed by din club league
      for (const [id, slug] of Object.entries(prevMap.map ?? {})) {
        const club = dinClubs.find((c) => c.id === id);
        if (!club) continue;
        const list = slugsByLeague[club.league_id] ?? [];
        if (!list.includes(slug)) list.push(slug);
        slugsByLeague[club.league_id] = list;
      }
    } catch {
      /* ignore */
    }
  }
  for (const entry of Object.values(existing.clubs)) {
    const list = slugsByLeague[entry.league_id] ?? [];
    if (entry.slug && !list.includes(entry.slug)) list.push(entry.slug);
    slugsByLeague[entry.league_id] = list;
  }

  if (!matchOnly) {
    for (const league of LEAGUES) {
      const url = `https://www.capology.com/${league.path}`;
      process.stdout.write(`League ${league.leagueId} ${league.path} … `);
      await sleep(REQUEST_GAP_MS);
      try {
        const html = await fetchText(url);
        const slugs = extractSlugs(html);
        if (slugs.length) {
          slugsByLeague[league.leagueId] = [
            ...new Set([...(slugsByLeague[league.leagueId] ?? []), ...slugs]),
          ];
          console.log(`${slugs.length} clubs`);
        } else {
          console.log(`0 clubs (keeping ${slugsByLeague[league.leagueId]?.length ?? 0} cached)`);
        }
      } catch (e) {
        const n = slugsByLeague[league.leagueId]?.length ?? 0;
        console.log(`FAIL ${e instanceof Error ? e.message : e} (keeping ${n} cached)`);
        if (String(e).includes("429")) await sleep(15_000);
      }
    }
  }

  const { map, unmatched, unused } = mapClubs(dinClubs, slugsByLeague);
  fs.writeFileSync(
    clubMapPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        map,
        unmatched,
        unused_capology_slugs: unused,
      },
      null,
      2,
    ),
  );
  console.log(
    `Club map: ${Object.keys(map).length} matched, ${unmatched.length} unmatched Din8sty clubs`,
  );
  if (unmatched.length) {
    console.log("  unmatched:", unmatched.slice(0, 15).join(" | "));
  }

  let raw = existing;
  raw.fx = fx;
  if (!matchOnly) {
    raw = await scrapeAll({
      limit,
      map,
      dinClubs,
      rates: fx!.rates,
      existing: raw,
    });
    raw.fx = fx;
    fs.writeFileSync(rawPath, JSON.stringify(raw, null, 2));
  } else if (!fs.existsSync(rawPath)) {
    console.error("Missing data/capology_raw.json for --match-only");
    process.exit(1);
  } else {
    raw = JSON.parse(fs.readFileSync(rawPath, "utf8")) as RawFile;
  }

  console.log("Matching Capology → Din8sty players…");
  const { matched, clubsOk, capPlayers } = matchIntoDb(db, raw, fx!.rates);

  const scrapedClubs = Object.values(raw.clubs).filter((c) => c.players.length > 0).length;
  const failedClubs = Object.values(raw.clubs).filter((c) => c.error).length;

  setMeta(db, "capology_synced_at", new Date().toISOString());
  setMeta(db, "capology_fx_source", fx!.source);
  setMeta(db, "capology_fx_date", fx!.date);
  setMeta(db, "capology_fx_gbp_eur", String(fx!.rates.GBP ?? ""));
  setMeta(db, "capology_clubs_scraped", String(scrapedClubs));
  setMeta(db, "capology_clubs_mapped", String(Object.keys(map).length));
  setMeta(db, "capology_players_matched", String(matched));
  setMeta(db, "capology_players_raw", String(capPlayers));

  // Sample Aston Villa
  const villa = db
    .prepare(
      `SELECT name, capology_wage_display, capology_wage_pw, capology_currency_orig
       FROM players WHERE club_id = '405' AND capology_wage_pw IS NOT NULL
       ORDER BY capology_wage_pw DESC LIMIT 5`,
    )
    .all() as Array<{
    name: string;
    capology_wage_display: string;
    capology_wage_pw: number;
    capology_currency_orig: string;
  }>;

  console.log("\n=== Capology sync summary ===");
  console.log(`FX: GBP→EUR ${fx!.rates.GBP?.toFixed(4)} (${fx!.date}, ${fx!.source})`);
  console.log(`Clubs mapped: ${Object.keys(map).length}`);
  console.log(`Clubs scraped with players: ${scrapedClubs} (errors: ${failedClubs})`);
  console.log(`Capology player rows: ${capPlayers}`);
  console.log(`Matched onto Din8sty: ${matched}`);
  console.log(`BE1/NL1: not available on Capology — skipped`);
  if (villa.length) {
    console.log("Aston Villa sample:");
    for (const p of villa) {
      console.log(
        `  ${p.name}: ${p.capology_wage_display} (${p.capology_wage_pw} EUR/w, orig ${p.capology_currency_orig})`,
      );
    }
  }

  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
