import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOP8_IDS, TOP8_LEAGUES } from "../src/leagues.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const outDir = path.join(root, "data");
const outDb = path.join(outDir, "din8sty.db");

const tmDbPath =
  process.env.TM_DB_PATH ??
  path.resolve(root, "..", "transfermarkt", "data", "app.db");

if (!fs.existsSync(tmDbPath)) {
  console.error(`Transfermarkt DB not found: ${tmDbPath}`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
if (fs.existsSync(outDb)) fs.unlinkSync(outDb);

const tm = new Database(tmDbPath, { readonly: true });
const db = new Database(outDb);

db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE leagues (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  sort_order INTEGER NOT NULL
);

CREATE TABLE clubs (
  id TEXT PRIMARY KEY,
  league_id TEXT NOT NULL,
  name TEXT NOT NULL,
  short_name TEXT,
  club_code TEXT,
  crest_url TEXT,
  market_value REAL,
  ranking INTEGER,
  FOREIGN KEY (league_id) REFERENCES leagues(id)
);

CREATE TABLE players (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL,
  league_id TEXT NOT NULL,
  name TEXT NOT NULL,
  age INTEGER,
  date_of_birth TEXT,
  height REAL,
  preferred_foot TEXT,
  position TEXT,
  detail_role TEXT,
  detail_label TEXT,
  side_role TEXT,
  shirt_number INTEGER,
  nationality TEXT,
  market_value_eur INTEGER,
  contract_until TEXT,
  portrait_url TEXT,
  tm_url TEXT,
  -- FMInside
  fm_rating INTEGER,
  fm_potential INTEGER,
  fm_wage_pw INTEGER,
  fm_wage_display TEXT,
  fm_url TEXT,
  fm_matched_name TEXT,
  fm_synced_at TEXT,
  -- Capology (weekly gross, EUR)
  capology_wage_pw INTEGER,
  capology_wage_display TEXT,
  capology_currency_orig TEXT,
  capology_synced_at TEXT,
  FOREIGN KEY (club_id) REFERENCES clubs(id),
  FOREIGN KEY (league_id) REFERENCES leagues(id)
);

CREATE INDEX players_league ON players(league_id);
CREATE INDEX players_club ON players(club_id);
CREATE INDEX players_rating ON players(fm_rating);
CREATE INDEX players_name ON players(name);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

const insertLeague = db.prepare(
  `INSERT INTO leagues (id, name, country, sort_order) VALUES (?, ?, ?, ?)`,
);
const insertClub = db.prepare(
  `INSERT INTO clubs (id, league_id, name, short_name, club_code, crest_url, market_value, ranking)
   VALUES (@id, @league_id, @name, @short_name, @club_code, @crest_url, @market_value, @ranking)`,
);
const insertPlayer = db.prepare(
  `INSERT INTO players (
     id, club_id, league_id, name, age, date_of_birth, height, preferred_foot,
     position, detail_role, detail_label, side_role, shirt_number, nationality,
     market_value_eur, contract_until, portrait_url, tm_url
   ) VALUES (
     @id, @club_id, @league_id, @name, @age, @date_of_birth, @height, @preferred_foot,
     @position, @detail_role, @detail_label, @side_role, @shirt_number, @nationality,
     @market_value_eur, @contract_until, @portrait_url, @tm_url
   )`,
);

const placeholders = TOP8_IDS.map(() => "?").join(",");

const clubs = tm
  .prepare(
    `SELECT cc.competition_id AS league_id, cc.ranking, cl.id, cl.name, cl.short_name,
            json_extract(cl.raw_json, '$.preferences.clubCode') AS club_code,
            cl.crest_url, cl.market_value
     FROM tm_competition_clubs cc
     JOIN tm_clubs cl ON cl.id = cc.club_id
     WHERE cc.competition_id IN (${placeholders})
     ORDER BY cc.competition_id, COALESCE(cc.ranking, 999), cl.name`,
  )
  .all(...TOP8_IDS) as Array<{
  league_id: string;
  ranking: number | null;
  id: string;
  name: string;
  short_name: string | null;
  club_code: string | null;
  crest_url: string | null;
  market_value: number | null;
}>;

const players = tm
  .prepare(
    `SELECT sp.player_id AS id, sp.club_id, cc.competition_id AS league_id, sp.name, sp.age,
            sp.date_of_birth, sp.height, sp.preferred_foot, sp.position, sp.detail_role,
            sp.detail_label, sp.side_role, sp.shirt_number, sp.nationality,
            sp.market_value_eur, sp.contract_until, sp.portrait_url, sp.relative_url AS tm_url
     FROM tm_squad_players sp
     JOIN tm_competition_clubs cc ON cc.club_id = sp.club_id
     WHERE cc.competition_id IN (${placeholders})
     ORDER BY cc.competition_id, sp.club_id, COALESCE(sp.market_value_eur, 0) DESC`,
  )
  .all(...TOP8_IDS) as Array<Record<string, unknown>>;

const tx = db.transaction(() => {
  TOP8_LEAGUES.forEach((l, i) => insertLeague.run(l.id, l.name, l.country, i + 1));
  for (const c of clubs) {
    insertClub.run({
      id: c.id,
      league_id: c.league_id,
      name: c.name,
      short_name: c.short_name,
      club_code: c.club_code,
      crest_url: c.crest_url,
      market_value: c.market_value,
      ranking: c.ranking,
    });
  }
  for (const p of players) {
    insertPlayer.run({
      id: String(p.id),
      club_id: String(p.club_id),
      league_id: String(p.league_id),
      name: String(p.name),
      age: p.age ?? null,
      date_of_birth: p.date_of_birth ?? null,
      height: p.height ?? null,
      preferred_foot: p.preferred_foot ?? null,
      position: p.position ?? null,
      detail_role: p.detail_role ?? null,
      detail_label: p.detail_label ?? null,
      side_role: p.side_role ?? null,
      shirt_number: p.shirt_number ?? null,
      nationality: p.nationality ?? null,
      market_value_eur: p.market_value_eur ?? null,
      contract_until: p.contract_until ?? null,
      portrait_url: p.portrait_url ?? null,
      tm_url: p.tm_url ? `https://www.transfermarkt.com${p.tm_url}` : null,
    });
  }
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)`).run(
    "built_at",
    new Date().toISOString(),
  );
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)`).run("tm_db", tmDbPath);
});

tx();

const stats = db
  .prepare(
    `SELECT league_id, COUNT(*) AS n FROM players GROUP BY league_id ORDER BY league_id`,
  )
  .all();

console.log(`Built ${outDb}`);
console.log(`Clubs: ${clubs.length}, players: ${players.length}`);
console.log(stats);

tm.close();
db.close();
