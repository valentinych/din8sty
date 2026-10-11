/**
 * Match FMInside scrape (data/fminside_raw.json) onto din8sty.db players.
 *
 * 1. Same club + normalized name (greedy by score), using TM name aliases
 * 2. Previous-club pass for movers still on old FM squad
 *    (data/fm_previous_clubs.json + TM clubAssignments)
 * 2b. 2025/26 season-club pass (data/fm_season_clubs.json from transfers:sync)
 *    — same scoring/age guards as previous-club; covers clubs beyond the
 *    immediate NEW_SIGNING source (e.g. mid-season stints).
 * 3. Cross-club fallback: exact/high-score name + age (±1), unique only
 *
 * TM aliases (artistName / displayName / shortName / passportName) are loaded
 * from the transfermarkt DB when available. First-name diminutives / spelling
 * variants also count when surnames match. Mononyms / artist names (e.g.
 * Costinha) score as exact when FM uses the same short name. Nickname /
 * reordered forms (FM "Ez Abde" ↔ TM "Abde Ezzalzouli") match when every
 * token of the shorter name covers onto the longer via exact/related/prefix.
 *
 * Apostrophes: strip before tokenizing so FM "N'Diaye" / "N'Dicka" align with
 * TM "Ndiaye" / "Ndicka" (otherwise the apostrophe becomes a space and the
 * surname splits into "n" + "diaye", killing same-club and global surname match).
 *
 * Short given-name transliterations (Tay↔Tai, Musa↔Mousa) match via edit
 * distance 1 when the surname is exact (namesRelatedBeyondSurname).
 *
 * Previous-club coverage: main scrape only visits top-8 league clubs. Movers
 * from relegated / lower-league sides (e.g. West Ham → Spurs, Nürnberg → Köln)
 * need their old club scraped via scrape_previous_clubs.py and listed in
 * fm_previous_clubs.json. That scrape must include all transferId-signaled
 * movers (no high market-value gate) — clubAssignments often omits the prior
 * senior club and only lists current + national team.
 *
 * Short TM club names (LASK) fail FMInside search unless aliased (LASK Linz)
 * or listed in KNOWN_FM_URLS — otherwise phase 2/2b has no squad pack.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const dbPath = path.join(root, "data", "din8sty.db");
const rawPath = path.join(root, "data", "fminside_raw.json");
const prevClubsPath = path.join(root, "data", "fm_previous_clubs.json");
const seasonClubsPath = path.join(root, "data", "fm_season_clubs.json");
const tmDbPath =
  process.env.TM_DB_PATH ?? path.resolve(root, "..", "transfermarkt", "data", "app.db");

/** Min score for same-club matching. */
const CLUB_MIN_SCORE = 70;
/** Min score for cross-club fallback (common names need age + uniqueness). */
const GLOBAL_MIN_SCORE = 90;
/** Allowed age drift between TM and FM (season timing). */
const AGE_TOLERANCE = 1;

/**
 * TM youth/reserve club → senior club (mainClubId). Transfer API often cites
 * U20/U21 sides while FMInside only has the senior squad.
 */
const YOUTH_TO_SENIOR: Record<string, string> = {
  "14876": "199", // SC Corinthians U20 → Sport Club Corinthians Paulista
  "12124": "405", // Aston Villa U21 → Aston Villa
  "15038": "679", // Athletico Paranaense U20
  "16653": "537", // Botafogo FR U20
  "2517": "79", // VfB Stuttgart U19
};

function seniorClubId(clubId: string): string {
  return YOUTH_TO_SENIOR[clubId] ?? clubId;
}

/** Known given-name groups (diminutives / language variants). */
const FIRST_NAME_GROUPS: string[][] = [
  ["konstantinos", "constantinos", "constantine", "kostas", "costas", "dino"],
  ["dimitrios", "demetrios", "dimitris", "dimos"],
  ["vasilios", "vasilis", "vassilis", "basil"],
  ["anastasios", "tasos"],
  ["charalampos", "charalambos", "babis", "harry"],
  ["nikolaos", "nikola", "nikos", "nicholas", "nick", "nico"],
  ["ioannis", "giannis", "yannis", "yiannis", "john"],
  ["georgios", "giorgos", "yorgos", "george"],
  // Ukrainian Георгій: TM "Georgiy" ↔ FM "Heorhii" (different Latinization).
  ["georgiy", "heorhii", "heorhiy", "georgii", "georgi"],
  ["aleksandr", "aleksander", "aleksandar", "alexander", "alexandr", "alex", "sasha"],
  ["benjamin", "ben", "benja"],
  ["samuel", "sam", "sammie"],
  ["thomas", "tom", "tommy", "tomas", "tomasz"],
  ["daniel", "dan", "danny"],
  ["william", "will", "billy", "liam"],
  ["christopher", "chris"],
  ["mohamed", "mohammed", "muhammad", "muhamed"],
  ["mousa", "musa", "moussa"],
  ["yassine", "yacine"],
  ["yasser", "yassir"],
  ["sergiy", "serhiy", "sergey", "sergei"],
  ["ilya", "illia", "ilia", "iliya"],
  ["djordje", "djorde"],
  ["philip", "philipp", "phillipp", "philippe"],
  ["eberechi", "ebere"],
  ["rodri", "rodrigo"],
  ["frank", "franck"],
];

const FIRST_NAME_TO_GROUP = new Map<string, number>();
for (let i = 0; i < FIRST_NAME_GROUPS.length; i++) {
  for (const n of FIRST_NAME_GROUPS[i]!) FIRST_NAME_TO_GROUP.set(n, i);
}

/** Particles / articles that must not count as given-name overlap. */
const GIVEN_STOP = new Set([
  "da",
  "de",
  "do",
  "dos",
  "das",
  "di",
  "del",
  "della",
  "van",
  "von",
  "der",
  "den",
  "la",
  "le",
  "el",
  "al",
  "bin",
  "ibn",
  "of",
  "the",
  "y",
  "e",
]);

type FmPlayer = {
  name: string;
  url?: string;
  ca?: number | null;
  pa?: number | null;
  age?: number | null;
  wage_pw?: number | null;
  wage_display?: string | null;
};

type FmEntry = {
  clubId: string;
  fi: number;
  player: FmPlayer;
  key: string;
};

function norm(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    // Latin letters that NFKD does not fold to ASCII
    .replace(/ł/gi, "l")
    .replace(/đ/gi, "d")
    .replace(/ø/gi, "o")
    .replace(/æ/gi, "ae")
    .replace(/œ/gi, "oe")
    .replace(/ß/g, "ss")
    .toLowerCase()
    .replace(/\b(jr|junior|ii|iii)\b/g, "")
    // Glue elided consonants: N'Diaye→ndiaye, O'Brien→obrien, M'Baye→mbaye.
    .replace(/[''`´\u2019\u02bc]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function lastFirstTokens(s: string): { last: string; tokens: string[] } {
  const tokens = norm(s).split(" ").filter(Boolean);
  return { last: tokens.at(-1) ?? "", tokens };
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
}

/** True when two given-name tokens are the same person form. */
function givenTokensRelated(a: string, b: string): boolean {
  if (!a || !b || GIVEN_STOP.has(a) || GIVEN_STOP.has(b)) return false;
  if (a === b) return true;
  const ga = FIRST_NAME_TO_GROUP.get(a);
  const gb = FIRST_NAME_TO_GROUP.get(b);
  if (ga != null && gb != null && ga === gb) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length >= 3 && longer.startsWith(shorter)) return true;
  // Spelling / transliteration variants — same initial required.
  // Short: Tay↔Tai, Musa↔Mousa (edit distance 1).
  // Longer: Phillipp↔Philipp, Mohamed↔Mohammed (edit distance ≤2).
  if (a[0] === b[0]) {
    const minLen = Math.min(a.length, b.length);
    const dist = levenshtein(a, b);
    if (minLen >= 3 && dist <= 1) return true;
    if (minLen >= 5 && dist <= 2) return true;
  }
  return false;
}

/** Surname match + related given names (any non-surname token pair). */
function namesRelatedBeyondSurname(a: string, b: string): boolean {
  const ta = lastFirstTokens(a).tokens;
  const tb = lastFirstTokens(b).tokens;
  if (ta.length < 2 || tb.length < 2) return false;
  const la = ta.at(-1)!;
  const lb = tb.at(-1)!;
  if (la !== lb) return false;
  const ga = ta.slice(0, -1).filter((t) => !GIVEN_STOP.has(t));
  const gb = tb.slice(0, -1).filter((t) => !GIVEN_STOP.has(t));
  for (const x of ga) {
    for (const y of gb) {
      if (givenTokensRelated(x, y)) return true;
    }
  }
  return false;
}

/** Token pair match: exact, related given-name, or abbreviation prefix (Ez↔Ezzalzouli). */
function tokensAlign(a: string, b: string): boolean {
  if (!a || !b || GIVEN_STOP.has(a) || GIVEN_STOP.has(b)) return false;
  if (a === b || givenTokensRelated(a, b)) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  // FM nicknames often truncate the surname/given (Ez Abde ↔ Abde Ezzalzouli).
  return shorter.length >= 2 && longer.startsWith(shorter);
}

/**
 * Every token in `need` maps onto a distinct token in `have` (exact / related /
 * prefix). Covers reordered nickname forms like FM "Ez Abde" vs TM "Abde Ezzalzouli".
 */
function tokensFullyCovered(need: string[], have: string[]): boolean {
  if (!need.length || need.length > have.length) return false;
  const used = new Set<number>();
  for (const n of need) {
    let found = -1;
    for (let i = 0; i < have.length; i++) {
      if (used.has(i)) continue;
      if (tokensAlign(n, have[i]!)) {
        found = i;
        break;
      }
    }
    if (found < 0) return false;
    used.add(found);
  }
  return true;
}

function scoreNames(a: string, b: string): number {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  // Mononym / artist name: FM "Costinha" vs multi-token TM formal name that
  // still lists Costinha as a distinctive token (or vice versa).
  const ta = na.split(" ").filter(Boolean);
  const tb = nb.split(" ").filter(Boolean);
  if (ta.length === 1 && tb.includes(ta[0]!) && ta[0]!.length >= 4) return 95;
  if (tb.length === 1 && ta.includes(tb[0]!) && tb[0]!.length >= 4) return 95;
  // Nickname / reordered form: all tokens of the shorter name cover onto the longer.
  if (
    (ta.length >= 2 && tb.length >= 2) &&
    (tokensFullyCovered(ta, tb) || tokensFullyCovered(tb, ta))
  ) {
    return 92;
  }
  if (na.includes(nb) || nb.includes(na)) return 85;
  const sa = new Set(ta);
  const sb = new Set(tb);
  const inter = [...sa].filter((t) => sb.has(t)).length;
  const union = new Set([...sa, ...sb]).size;
  const jacc = union ? inter / union : 0;
  const { last: la } = lastFirstTokens(a);
  const { last: lb } = lastFirstTokens(b);
  let score = Math.round(jacc * 70);
  if (la && la === lb) score += 20;
  // Surname match + known diminutive / spelling variant of given name.
  if (score < 90 && namesRelatedBeyondSurname(a, b)) score = Math.max(score, 90);
  return score;
}

/** Best score across all TM name variants vs one FM name. */
function bestScore(tmNames: string[], fmName: string): number {
  let best = 0;
  for (const n of tmNames) {
    const s = scoreNames(n, fmName);
    if (s > best) best = s;
  }
  return best;
}

function ageOk(tmAge: number | null | undefined, fmAge: number | null | undefined): boolean {
  if (tmAge == null || fmAge == null) return false;
  return Math.abs(tmAge - fmAge) <= AGE_TOLERANCE;
}

function fmKey(clubId: string, fi: number, player: FmPlayer): string {
  return player.url ? `url:${player.url}` : `idx:${clubId}:${fi}`;
}

/** Collect TM-provided name variants; skip initialisms like "K. Tsimikas". */
function aliasesFromRaw(primaryName: string, rawJson: string | null): string[] {
  const out = new Set<string>();
  if (primaryName.trim()) out.add(primaryName.trim());
  if (!rawJson) return [...out];
  try {
    const raw = JSON.parse(rawJson) as Record<string, unknown>;
    for (const key of ["artistName", "displayName", "shortName"] as const) {
      const v = typeof raw[key] === "string" ? raw[key].trim() : "";
      if (!v) continue;
      if (key === "shortName") {
        const tokens = norm(v).split(" ").filter(Boolean);
        // "K. Tsimikas" → ["k","tsimikas"] — too weak / substring-risky
        if (tokens.some((t) => t.length === 1)) continue;
      }
      out.add(v);
    }
    // Passport / formal name (e.g. "Mateus Gonçalo Espanha Fernandes").
    const nat = raw.nationalityDetails as Record<string, unknown> | undefined;
    const passport = typeof nat?.passportName === "string" ? nat.passportName.trim() : "";
    if (passport) out.add(passport);
  } catch {
    // ignore malformed raw_json
  }
  return [...out];
}

/** Assignment types that are not a previous senior club. */
const SKIP_ASSIGN_TYPES = new Set([
  "current",
  "nationalTeam",
  "national",
  "youth",
  "youthNationalTeam",
]);

/** Most recent non-current senior club from TM clubAssignments. */
function prevClubFromAssignments(rawJson: string | null, currentClubId: string): string | null {
  if (!rawJson) return null;
  try {
    const raw = JSON.parse(rawJson) as { clubAssignments?: unknown };
    const assigns = Array.isArray(raw.clubAssignments) ? raw.clubAssignments : [];
    const cands: Array<{ start: string; clubId: string }> = [];
    for (const a of assigns) {
      if (!a || typeof a !== "object") continue;
      const row = a as Record<string, unknown>;
      const atype = String(row.type ?? "");
      if (SKIP_ASSIGN_TYPES.has(atype)) continue;
      const cid = row.clubId != null ? String(row.clubId) : "";
      if (!cid || cid === currentClubId) continue;
      const start = String(row.start ?? row.end ?? row.debut ?? "");
      cands.push({ start, clubId: cid });
    }
    if (!cands.length) return null;
    cands.sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : 0));
    return cands[0]!.clubId;
  } catch {
    return null;
  }
}

function loadTmAliases(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (!fs.existsSync(tmDbPath)) {
    console.warn(`TM DB not found (${tmDbPath}) — matching without artistName aliases`);
    return map;
  }
  const tm = new Database(tmDbPath, { readonly: true });
  try {
    const rows = tm
      .prepare(`SELECT player_id, name, raw_json FROM tm_squad_players`)
      .all() as Array<{ player_id: string; name: string | null; raw_json: string | null }>;
    for (const row of rows) {
      const id = String(row.player_id);
      const aliases = aliasesFromRaw(row.name ?? "", row.raw_json);
      const prev = map.get(id);
      if (!prev) {
        map.set(id, aliases);
      } else {
        const merged = new Set([...prev, ...aliases]);
        map.set(id, [...merged]);
      }
    }
  } finally {
    tm.close();
  }
  return map;
}

/**
 * player_id → previous TM club_id.
 * Primary source: data/fm_previous_clubs.json (transfer-resolved by scrape_previous_clubs.py).
 * Supplement: TM clubAssignments for currently unmatched players (no network).
 * Transfer-API resolutions win over assignments.
 */
function loadPreviousClubs(
  din: InstanceType<typeof Database>,
  tmRawByPlayer: Map<string, string>,
): Map<string, string> {
  const map = new Map<string, string>();
  const unmatched = din
    .prepare(`SELECT id, club_id FROM players WHERE fm_rating IS NULL`)
    .all() as Array<{ id: string; club_id: string }>;
  for (const row of unmatched) {
    const prev = prevClubFromAssignments(tmRawByPlayer.get(String(row.id)) ?? null, row.club_id);
    if (prev) map.set(String(row.id), prev);
  }
  if (!fs.existsSync(prevClubsPath)) return map;
  try {
    const raw = JSON.parse(fs.readFileSync(prevClubsPath, "utf8")) as Record<string, string>;
    for (const [id, clubId] of Object.entries(raw)) {
      if (id && clubId) map.set(String(id), seniorClubId(String(clubId)));
    }
  } catch {
    console.warn(`Could not parse ${prevClubsPath}`);
  }
  // Also promote assignment-derived entries.
  for (const [id, clubId] of [...map.entries()]) {
    map.set(id, seniorClubId(clubId));
  }
  return map;
}

/**
 * player_id → TM club ids played for in season 2025/26
 * (from data/fm_season_clubs.json, built by transfers:sync).
 */
function loadSeasonClubs(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (!fs.existsSync(seasonClubsPath)) return map;
  try {
    const raw = JSON.parse(fs.readFileSync(seasonClubsPath, "utf8")) as Record<
      string,
      string[] | string
    >;
    for (const [id, clubs] of Object.entries(raw)) {
      const list = Array.isArray(clubs) ? clubs : clubs ? [String(clubs)] : [];
      const cleaned = [
        ...new Set(list.map(String).filter(Boolean).map(seniorClubId)),
      ];
      if (cleaned.length) map.set(String(id), cleaned);
    }
  } catch {
    console.warn(`Could not parse ${seasonClubsPath}`);
  }
  return map;
}

/** player_id → raw_json from TM (first row wins). */
function loadTmRawByPlayer(): Map<string, string> {
  const map = new Map<string, string>();
  if (!fs.existsSync(tmDbPath)) return map;
  const tm = new Database(tmDbPath, { readonly: true });
  try {
    const rows = tm
      .prepare(`SELECT player_id, raw_json FROM tm_squad_players`)
      .all() as Array<{ player_id: string; raw_json: string | null }>;
    for (const row of rows) {
      const id = String(row.player_id);
      if (map.has(id) || !row.raw_json) continue;
      map.set(id, row.raw_json);
    }
  } finally {
    tm.close();
  }
  return map;
}

if (!fs.existsSync(dbPath)) {
  console.error("Missing data/din8sty.db — run npm run db:build");
  process.exit(1);
}
if (!fs.existsSync(rawPath)) {
  console.error("Missing data/fminside_raw.json — run npm run fm:scrape");
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(rawPath, "utf8")) as {
  clubs: Record<string, { players: FmPlayer[] }>;
};

const tmAliases = loadTmAliases();
console.log(`Loaded TM aliases for ${tmAliases.size} players from ${tmDbPath}`);

const db = new Database(dbPath);

// Build previous-club + season-club maps BEFORE wiping FM fields.
const previousClubs = loadPreviousClubs(db, loadTmRawByPlayer());
console.log(`Loaded previous-club map for ${previousClubs.size} players`);
const seasonClubs = loadSeasonClubs();
console.log(`Loaded 2025/26 season-club map for ${seasonClubs.size} players`);

db.exec(`
UPDATE players SET
  fm_rating = NULL, fm_potential = NULL, fm_wage_pw = NULL,
  fm_wage_display = NULL, fm_url = NULL, fm_matched_name = NULL, fm_synced_at = NULL;
`);

const update = db.prepare(
  `UPDATE players SET
     fm_rating = @fm_rating,
     fm_potential = @fm_potential,
     fm_wage_pw = @fm_wage_pw,
     fm_wage_display = @fm_wage_display,
     fm_url = @fm_url,
     fm_matched_name = @fm_matched_name,
     fm_synced_at = @fm_synced_at
   WHERE id = @id`,
);

function applyMatch(id: string, fm: FmPlayer, now: string) {
  update.run({
    id,
    fm_rating: fm.ca ?? null,
    fm_potential: fm.pa ?? null,
    fm_wage_pw: fm.wage_pw ?? null,
    fm_wage_display: fm.wage_display ?? null,
    fm_url: fm.url ? `https://fminside.net${fm.url}` : null,
    fm_matched_name: fm.name,
    fm_synced_at: now,
  });
}

/**
 * FM uses nicknames TM raw_json omits (empty artistName). Only high-evidence
 * same-club cases — never youth/guess-only mononyms.
 */
const KNOWN_FM_NAME_ALIASES: Record<string, string[]> = {
  "426620": ["Pote"], // Pedro Gonçalves @ Sporting
  "419936": ["Chuchu Ramírez", "Chuchu Ramirez"], // Jesús Ramírez @ Nacional
};

function nameVariants(id: string, primaryName: string): string[] {
  const out = new Set<string>();
  if (primaryName.trim()) out.add(primaryName.trim());
  for (const a of tmAliases.get(id) ?? []) {
    if (a.trim()) out.add(a.trim());
  }
  for (const a of KNOWN_FM_NAME_ALIASES[id] ?? []) {
    if (a.trim()) out.add(a.trim());
  }
  return out.size ? [...out] : [primaryName];
}

const now = new Date().toISOString();
let matchedClub = 0;
let matchedPrev = 0;
let matchedSeason = 0;
let matchedGlobal = 0;
let clubsDone = 0;
const unmatchedSamples: string[] = [];

const usedFm = new Set<string>();
const usedTm = new Set<string>();

const allFm: FmEntry[] = [];
for (const [clubId, pack] of Object.entries(raw.clubs ?? {})) {
  for (let fi = 0; fi < (pack.players?.length ?? 0); fi++) {
    const player = pack.players[fi]!;
    allFm.push({ clubId, fi, player, key: fmKey(clubId, fi, player) });
  }
}

function matchClubPack(
  clubId: string,
  pack: { players: FmPlayer[] },
  tmPlayers: Array<{ id: string; name: string; age: number | null }>,
  counter: "club" | "prev" | "season",
) {
  if (!tmPlayers.length || !pack.players?.length) return;
  const pairs: Array<{ ti: number; fi: number; score: number }> = [];
  for (let ti = 0; ti < tmPlayers.length; ti++) {
    const variants = nameVariants(tmPlayers[ti]!.id, tmPlayers[ti]!.name);
    for (let fi = 0; fi < pack.players.length; fi++) {
      const score = bestScore(variants, pack.players[fi]!.name);
      if (score >= CLUB_MIN_SCORE) pairs.push({ ti, fi, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score);

  for (const p of pairs) {
    const tm = tmPlayers[p.ti]!;
    const fm = pack.players[p.fi]!;
    const key = fmKey(clubId, p.fi, fm);
    if (usedTm.has(tm.id) || usedFm.has(key)) continue;
    // Previous / season club: require age when both known (avoid wrong mononym collisions).
    // Same-club fuzzy/mononym (<100): also require age — otherwise FM mononym "Rafa"
    // can bind to "Rafa Obrador" before "Rafa Silva".
    if (
      (counter === "prev" || counter === "season" || p.score < 100) &&
      !ageOk(tm.age, fm.age) &&
      tm.age != null &&
      fm.age != null
    ) {
      continue;
    }
    usedTm.add(tm.id);
    usedFm.add(key);
    applyMatch(tm.id, fm, now);
    if (counter === "club") matchedClub += 1;
    else if (counter === "prev") matchedPrev += 1;
    else matchedSeason += 1;
  }
}

const tx = db.transaction(() => {
  // --- Phase 1: same club ---
  for (const [clubId, pack] of Object.entries(raw.clubs ?? {})) {
    const tmPlayers = db
      .prepare(`SELECT id, name, age FROM players WHERE club_id = ?`)
      .all(clubId) as Array<{ id: string; name: string; age: number | null }>;
    if (!tmPlayers.length || !pack.players?.length) continue;
    clubsDone += 1;
    matchClubPack(clubId, pack, tmPlayers, "club");
  }

  // --- Phase 2: previous club (movers still on old FM squad) ---
  const byPrevClub = new Map<string, Array<{ id: string; name: string; age: number | null }>>();
  for (const [tmId, prevClubId] of previousClubs) {
    if (usedTm.has(tmId)) continue;
    const row = db
      .prepare(`SELECT id, name, age FROM players WHERE id = ? AND fm_rating IS NULL`)
      .get(tmId) as { id: string; name: string; age: number | null } | undefined;
    if (!row) continue;
    const list = byPrevClub.get(prevClubId) ?? [];
    list.push(row);
    byPrevClub.set(prevClubId, list);
  }
  for (const [prevClubId, tmPlayers] of byPrevClub) {
    const pack = raw.clubs?.[prevClubId];
    if (!pack?.players?.length) continue;
    matchClubPack(prevClubId, pack, tmPlayers, "prev");
  }

  // --- Phase 2b: 2025/26 season clubs (beyond immediate previous) ---
  const bySeasonClub = new Map<string, Array<{ id: string; name: string; age: number | null }>>();
  for (const [tmId, clubIds] of seasonClubs) {
    if (usedTm.has(tmId)) continue;
    const row = db
      .prepare(`SELECT id, name, age, club_id FROM players WHERE id = ? AND fm_rating IS NULL`)
      .get(tmId) as
      | { id: string; name: string; age: number | null; club_id: string }
      | undefined;
    if (!row) continue;
    for (const clubId of clubIds) {
      if (!clubId || clubId === row.club_id) continue;
      // Already tried as immediate previous in phase 2 — still OK to retry if
      // pack was missing then; usedTm/usedFm guards prevent double-assign.
      const list = bySeasonClub.get(clubId) ?? [];
      if (!list.some((p) => p.id === row.id)) list.push(row);
      bySeasonClub.set(clubId, list);
    }
  }
  for (const [clubId, tmPlayers] of bySeasonClub) {
    const pack = raw.clubs?.[clubId];
    if (!pack?.players?.length) continue;
    matchClubPack(clubId, pack, tmPlayers, "season");
  }

  // --- Phase 3: cross-club (movers) — name+age, unique only ---
  const unmatched = db
    .prepare(
      `SELECT id, name, age, club_id FROM players
       WHERE fm_rating IS NULL`,
    )
    .all() as Array<{ id: string; name: string; age: number | null; club_id: string }>;

  const globalPairs: Array<{
    tmId: string;
    clubId: string;
    tmName: string;
    fm: FmPlayer;
    key: string;
    score: number;
  }> = [];

  for (const tm of unmatched) {
    if (usedTm.has(tm.id)) continue;
    const variants = nameVariants(tm.id, tm.name);
    const cands: Array<{ entry: FmEntry; score: number }> = [];
    for (const entry of allFm) {
      if (usedFm.has(entry.key)) continue;
      const score = bestScore(variants, entry.player.name);
      if (score < GLOBAL_MIN_SCORE) continue;
      // Exact name may pass without age; fuzzy needs age agreement.
      if (score < 100 && !ageOk(tm.age, entry.player.age)) continue;
      if (score === 100 && tm.age != null && entry.player.age != null && !ageOk(tm.age, entry.player.age)) {
        continue;
      }
      cands.push({ entry, score });
    }
    // Collapse duplicate FM identities (same player listed under multiple clubs).
    const byKey = new Map<string, { entry: FmEntry; score: number }>();
    for (const c of cands) {
      const prev = byKey.get(c.entry.key);
      if (!prev || c.score > prev.score) byKey.set(c.entry.key, c);
    }
    const unique = [...byKey.values()];
    if (unique.length !== 1) continue;
    const only = unique[0]!;
    globalPairs.push({
      tmId: tm.id,
      clubId: tm.club_id,
      tmName: tm.name,
      fm: only.entry.player,
      key: only.entry.key,
      score: only.score,
    });
  }

  globalPairs.sort((a, b) => b.score - a.score);
  for (const p of globalPairs) {
    if (usedTm.has(p.tmId) || usedFm.has(p.key)) continue;
    usedTm.add(p.tmId);
    usedFm.add(p.key);
    applyMatch(p.tmId, p.fm, now);
    matchedGlobal += 1;
  }

  const stillUnmatched = db
    .prepare(
      `SELECT p.club_id, p.name FROM players p
       WHERE p.fm_rating IS NULL
       ORDER BY COALESCE(p.market_value_eur, 0) DESC
       LIMIT 30`,
    )
    .all() as Array<{ club_id: string; name: string }>;
  for (const tm of stillUnmatched) {
    unmatchedSamples.push(`${tm.club_id}: ${tm.name}`);
  }

  const matched = matchedClub + matchedPrev + matchedSeason + matchedGlobal;
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('fm_matched_at', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(now);
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('fm_matched_count', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(matched));
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('fm_matched_club', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(matchedClub));
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('fm_matched_prev', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(matchedPrev));
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('fm_matched_season', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(matchedSeason));
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('fm_matched_global', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(matchedGlobal));
});

tx();

const total = (db.prepare(`SELECT COUNT(*) AS n FROM players`).get() as { n: number }).n;
const matched = matchedClub + matchedPrev + matchedSeason + matchedGlobal;
console.log(
  `Matched ${matched}/${total} players across ${clubsDone} clubs` +
    ` (club=${matchedClub}, prev=${matchedPrev}, season25/26=${matchedSeason}, global/movers=${matchedGlobal})`,
);

const samples = db
  .prepare(
    `SELECT id, name, club_id, fm_rating, fm_wage_display, fm_matched_name, fm_url
     FROM players WHERE id IN ('1004301', '338070', '539252', '880245', '1282860', '1261640', '923757')`,
  )
  .all() as Array<{
  id: string;
  name: string;
  club_id: string;
  fm_rating: number | null;
  fm_wage_display: string | null;
  fm_matched_name: string | null;
  fm_url: string | null;
}>;
for (const p of samples) {
  console.log(
    `Player ${p.id} ${p.name}: rating=${p.fm_rating} wage=${p.fm_wage_display}` +
      ` matched_name=${p.fm_matched_name} url=${p.fm_url}`,
  );
}

if (unmatchedSamples.length) {
  console.log("Unmatched samples (by market value):");
  for (const s of unmatchedSamples.slice(0, 15)) console.log(" -", s);
}
db.close();
