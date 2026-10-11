/**
 * Load precomputed Top-4 season scores (JSON cache next to DB).
 */
import fs from "node:fs";
import path from "node:path";
import type { SeasonScorePayload } from "./top4SeasonFpts.js";
import { TOP4_SEASON_SLUG } from "./top4SeasonFpts.js";

export function top4SeasonJsonPath(dataDir: string, slug = TOP4_SEASON_SLUG): string {
  return path.join(dataDir, `top4-season-${slug}.json`);
}

export function loadTop4SeasonScores(
  dataDir: string,
  slug = TOP4_SEASON_SLUG,
): SeasonScorePayload | null {
  const p = top4SeasonJsonPath(dataDir, slug);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw) as SeasonScorePayload;
  } catch {
    return null;
  }
}
