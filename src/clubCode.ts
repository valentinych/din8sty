/** TM preferences.clubCode when available; otherwise a short derived label. */

const NOISE = new Set([
  "fc",
  "cf",
  "sc",
  "afc",
  "ac",
  "as",
  "ss",
  "rcd",
  "ud",
  "cd",
  "sd",
  "kv",
  "rsc",
  "sv",
  "vfb",
  "vfl",
  "tsv",
  "bsc",
  "osc",
  "the",
  "de",
  "di",
  "da",
  "do",
  "of",
]);

/** Prefer Transfermarkt clubCode; fall back to a compact derived code. */
export function clubCodeLabel(
  clubCode: string | null | undefined,
  name: string | null | undefined,
): string {
  const code = (clubCode || "").trim().toUpperCase();
  if (code) return code;
  return deriveClubCode(name || "");
}

export function formatHaOpponent(isHome: boolean, opponent: string | null): string {
  return `${isHome ? "H" : "A"} · ${opponent || "—"}`;
}

/** Compact GW chip: `(H) ARS` / `(A) ATM`. */
export function formatParenHaOpponent(
  isHome: boolean,
  opponent: string | null,
): string {
  return `(${isHome ? "H" : "A"}) ${opponent || "—"}`;
}

/** Last-resort 2–3 letter code from an opponent display name. */
export function deriveClubCode(name: string): string {
  const cleaned = name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .trim();
  if (!cleaned) return "—";
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  const significant = tokens.filter((t) => !NOISE.has(t.toLowerCase()));
  const use = significant.length ? significant : tokens;
  const first = use[0]!;
  if (/^[A-Za-z0-9]{2,3}$/.test(first) && use.length <= 2) {
    return first.toUpperCase();
  }
  if (use.length >= 3) {
    return use
      .slice(0, 3)
      .map((t) => t[0]!.toUpperCase())
      .join("");
  }
  if (use.length === 2) {
    const a = use[0]!;
    const b = use[1]!;
    if (a.length >= 2) return (a.slice(0, 2) + b[0]!).toUpperCase();
    return (a[0]! + b.slice(0, 2)).toUpperCase();
  }
  return first.slice(0, 3).toUpperCase();
}
