/**
 * Admin helper: scrape one FMInside player and write match fields onto din8sty.db.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const scrapeScript = path.join(root, "scripts", "scrape_fm_player.py");

export type FmScrapePlayer = {
  name: string;
  url: string | null;
  fm_id?: string | null;
  ca: number;
  pa: number | null;
  age?: number | null;
  wage_display: string | null;
  wage_pw: number | null;
  page_url?: string;
};

export type FmMissingRow = {
  id: string;
  name: string;
  club_id: string;
  club_name: string;
  market_value_eur: number | null;
  tm_url: string | null;
};

export function listPlayersMissingFm(
  db: Database.Database,
  limit = 200,
): { total: number; players: FmMissingRow[] } {
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM players WHERE fm_rating IS NULL`).get() as {
      n: number;
    }
  ).n;
  const players = db
    .prepare(
      `SELECT p.id, p.name, p.club_id, c.name AS club_name,
              p.market_value_eur, p.tm_url
       FROM players p
       JOIN clubs c ON c.id = p.club_id
       WHERE p.fm_rating IS NULL
       ORDER BY COALESCE(p.market_value_eur, 0) DESC, p.name
       LIMIT ?`,
    )
    .all(limit) as FmMissingRow[];
  return { total, players };
}

export function scrapeFmPlayer(
  urlOrId: string,
  nameHint?: string | null,
): FmScrapePlayer {
  const args = ["python3", scrapeScript, urlOrId];
  if (nameHint?.trim()) {
    args.push("--name", nameHint.trim());
  }
  const res = spawnSync(args[0]!, args.slice(1), {
    encoding: "utf8",
    timeout: 120_000,
    cwd: root,
    env: process.env,
  });
  const out = (res.stdout || "").trim();
  const errTail = (res.stderr || "").trim().slice(-500);
  if (!out) {
    throw new Error(
      res.error?.message ||
        errTail ||
        (res.status != null ? `scrape_exit_${res.status}` : "scrape_empty"),
    );
  }
  let parsed: { ok?: boolean; error?: string; player?: FmScrapePlayer };
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error(`scrape_bad_json: ${out.slice(0, 200)}`);
  }
  if (!parsed.ok || !parsed.player) {
    throw new Error(parsed.error || "scrape_failed");
  }
  if (parsed.player.ca == null) {
    throw new Error("scrape_missing_ca");
  }
  return parsed.player;
}

export function applyFmMatch(
  dbWrite: Database.Database,
  playerId: string,
  fm: FmScrapePlayer,
): {
  id: string;
  fm_rating: number;
  fm_potential: number | null;
  fm_wage_display: string | null;
  fm_url: string;
  fm_matched_name: string;
  fm_synced_at: string;
} {
  const now = new Date().toISOString();
  const fmUrl = fm.page_url
    ? fm.page_url.startsWith("http")
      ? fm.page_url
      : `https://fminside.net${fm.page_url}`
    : fm.url
      ? fm.url.startsWith("http")
        ? fm.url
        : `https://fminside.net${fm.url}`
      : null;
  if (!fmUrl) throw new Error("missing_fm_url");

  const info = dbWrite
    .prepare(
      `UPDATE players SET
         fm_rating = @fm_rating,
         fm_potential = @fm_potential,
         fm_wage_pw = @fm_wage_pw,
         fm_wage_display = @fm_wage_display,
         fm_url = @fm_url,
         fm_matched_name = @fm_matched_name,
         fm_synced_at = @fm_synced_at
       WHERE id = @id`,
    )
    .run({
      id: playerId,
      fm_rating: fm.ca,
      fm_potential: fm.pa ?? null,
      fm_wage_pw: fm.wage_pw ?? null,
      fm_wage_display: fm.wage_display ?? null,
      fm_url: fmUrl,
      fm_matched_name: fm.name,
      fm_synced_at: now,
    });
  if (info.changes !== 1) throw new Error("player_not_found");

  return {
    id: playerId,
    fm_rating: fm.ca,
    fm_potential: fm.pa ?? null,
    fm_wage_display: fm.wage_display ?? null,
    fm_url: fmUrl,
    fm_matched_name: fm.name,
    fm_synced_at: now,
  };
}
