/**
 * Fantasy-style Gameweeks from kickoff UTC → Europe/London.
 *
 * GW boundaries: successive Fridays at 00:00:00 Europe/London (half-open).
 * A fixture belongs to the GW whose start Friday satisfies:
 *   start <= kickoff < start + 1 week
 *
 * Season 2026/27 anchor (GW1 start):
 *   Friday 2026-08-07 00:00:00 Europe/London
 * = the Friday that opens the week containing the earliest Top-8 fixtures
 *   (first kickoffs are Fri 7 Aug evening London).
 *
 * gameweek = 1 + (number of Friday boundaries from anchor Friday to the
 * Friday that starts the fixture's week). Uses calendar days (not raw ms)
 * so BST↔GMT transitions stay correct.
 */

const TZ = "Europe/London";

/** GW1 starts this London calendar Friday at midnight. */
export const GW1_START = { year: 2026, month: 8, day: 7 } as const;

const DOW: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

type Ymd = { year: number; month: number; day: number };

function getLondonParts(ms: number) {
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const o: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(ms))) {
    if (p.type !== "literal") o[p.type] = p.value;
  }
  return {
    year: Number(o.year),
    month: Number(o.month),
    day: Number(o.day),
    hour: Number(o.hour),
    minute: Number(o.minute),
    second: Number(o.second),
    weekday: o.weekday!,
  };
}

/** UTC ms for a wall-clock datetime in Europe/London (handles BST/GMT). */
export function londonLocalToUtcMs(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  let guess = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 4; i++) {
    const p = getLondonParts(guess);
    const got = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const want = Date.UTC(year, month - 1, day, hour, minute, second);
    const diff = want - got;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

function addCalendarDays(ymd: Ymd, delta: number): Ymd {
  const utc = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day + delta));
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
  };
}

function julianDay(ymd: Ymd): number {
  return Date.UTC(ymd.year, ymd.month - 1, ymd.day) / 86_400_000;
}

/** Friday 00:00 London that starts the GW containing this UTC kickoff. */
export function fridayStartContainingKickoff(kickoffUtc: string | Date): number {
  const ms = typeof kickoffUtc === "string" ? Date.parse(kickoffUtc) : kickoffUtc.getTime();
  if (!Number.isFinite(ms)) throw new Error(`Invalid kickoff: ${kickoffUtc}`);
  const p = getLondonParts(ms);
  const dow = DOW[p.weekday];
  if (dow == null) throw new Error(`Unknown weekday: ${p.weekday}`);
  const daysSinceFri = (dow - 5 + 7) % 7;
  const fri = addCalendarDays({ year: p.year, month: p.month, day: p.day }, -daysSinceFri);
  return londonLocalToUtcMs(fri.year, fri.month, fri.day, 0, 0, 0);
}

export function gameweekFromKickoff(kickoffUtc: string | Date): number {
  const friMs = fridayStartContainingKickoff(kickoffUtc);
  const fri = getLondonParts(friMs);
  const weeks = Math.round(
    (julianDay({ year: fri.year, month: fri.month, day: fri.day }) -
      julianDay(GW1_START)) /
      7,
  );
  return 1 + weeks;
}

export function gameweekRange(gw: number): {
  startMs: number;
  endMs: number;
  startYmd: Ymd;
  endInclusiveYmd: Ymd;
  label: string;
} {
  const startYmd = addCalendarDays(GW1_START, (gw - 1) * 7);
  const endInclusiveYmd = addCalendarDays(startYmd, 6); // Thursday
  const startMs = londonLocalToUtcMs(startYmd.year, startYmd.month, startYmd.day, 0, 0, 0);
  const next = addCalendarDays(startYmd, 7);
  const endMs = londonLocalToUtcMs(next.year, next.month, next.day, 0, 0, 0);

  const sameMonth = startYmd.month === endInclusiveYmd.month;
  const range = sameMonth
    ? `${startYmd.day}–${endInclusiveYmd.day} ${MONTH_SHORT[startYmd.month - 1]}`
    : `${startYmd.day} ${MONTH_SHORT[startYmd.month - 1]}–${endInclusiveYmd.day} ${MONTH_SHORT[endInclusiveYmd.month - 1]}`;

  return {
    startMs,
    endMs,
    startYmd,
    endInclusiveYmd,
    label: `GW${gw} · ${range}`,
  };
}

/**
 * Lineup lock / reveal deadline for a GW = Friday 00:00 Europe/London when that GW begins
 * (`gameweekRange(gw).startMs`). Before that instant, only the owner's XI+bench is visible;
 * at/after it, other teams' saved lineups for that GW may be read (still not editable).
 */
export function lineupDeadlinePassed(gw: number, nowMs = Date.now()): boolean {
  if (!Number.isInteger(gw) || gw < 1) return false;
  return nowMs >= gameweekRange(gw).startMs;
}

/**
 * Default GW for the Top-4 lineup editor when `?gw=` is omitted.
 * Fri–Sun London: current GW (the week that started Friday).
 * Mon–Thu London: next GW.
 */
export function defaultTop4LineupGw(now: Date = new Date()): number {
  const currentGw = Math.max(1, gameweekFromKickoff(now));
  const weekday = getLondonParts(now.getTime()).weekday;
  if (weekday === "Fri" || weekday === "Sat" || weekday === "Sun") {
    return currentGw;
  }
  return currentGw + 1;
}
