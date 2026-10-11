/**
 * Load precomputed Top-8 season scores (JSON cache next to DB).
 */
import fs from "node:fs";
import path from "node:path";
import type { SeasonScorePayload } from "./top8SeasonFpts.js";
import { TOP8_SEASON_SLUG } from "./top8SeasonFpts.js";

export function top8SeasonJsonPath(dataDir: string, slug = TOP8_SEASON_SLUG): string {
  return path.join(dataDir, `top8-season-${slug}.json`);
}

export function loadTop8SeasonScores(
  dataDir: string,
  slug = TOP8_SEASON_SLUG,
): SeasonScorePayload | null {
  const p = top8SeasonJsonPath(dataDir, slug);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw) as SeasonScorePayload;
  } catch {
    return null;
  }
}
