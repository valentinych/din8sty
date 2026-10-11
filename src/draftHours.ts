export type DraftHoursConfig = {
  timezone: string;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
};

export const DEFAULT_DRAFT_HOURS: DraftHoursConfig = {
  timezone: "Europe/Warsaw",
  startHour: 10,
  startMinute: 0,
  endHour: 20,
  endMinute: 0,
};

/** Admin may choose start ≥ 09:00 and end ≤ 20:00 (Warsaw). */
export const DRAFT_HOURS_EARLIEST_START = 9;
export const DRAFT_HOURS_LATEST_END = 20;

const TIME_RE = /^(\d{1,2}):(\d{2})$/;

export function formatHm(h: number, m = 0): string {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function parseTimeHm(value: string, fallback: { h: number; m: number }) {
  const m = TIME_RE.exec(value.trim());
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return fallback;
  return { h, m: min };
}

export type ParsedDraftHours = {
  timezone: string;
  start: string;
  end: string;
};

/**
 * Validate admin-chosen Warsaw draft window.
 * Allowed band: start ≥ 09:00, end ≤ 20:00, start < end.
 */
export function parseAdminDraftHours(input: {
  start?: string | null;
  end?: string | null;
  timezone?: string | null;
}): ParsedDraftHours {
  const startRaw = (input.start ?? "").trim() || formatHm(DEFAULT_DRAFT_HOURS.startHour);
  const endRaw = (input.end ?? "").trim() || formatHm(DEFAULT_DRAFT_HOURS.endHour);
  const start = parseTimeHm(startRaw, { h: -1, m: 0 });
  const end = parseTimeHm(endRaw, { h: -1, m: 0 });
  if (start.h < 0 || end.h < 0) {
    throw new Error("invalid_draft_hours");
  }
  const startMin = start.h * 60 + start.m;
  const endMin = end.h * 60 + end.m;
  const earliest = DRAFT_HOURS_EARLIEST_START * 60;
  const latest = DRAFT_HOURS_LATEST_END * 60;
  if (startMin < earliest || endMin > latest || startMin >= endMin) {
    throw new Error("invalid_draft_hours");
  }
  const tz = (input.timezone ?? "").trim() || DEFAULT_DRAFT_HOURS.timezone;
  return {
    timezone: tz,
    start: formatHm(start.h, start.m),
    end: formatHm(end.h, end.m),
  };
}

export function draftHoursFromLeague(league: {
  draftHoursTz?: string | null;
  draftHoursStart?: string | null;
  draftHoursEnd?: string | null;
}): DraftHoursConfig {
  const start = parseTimeHm(league.draftHoursStart ?? "10:00", {
    h: 10,
    m: 0,
  });
  const end = parseTimeHm(league.draftHoursEnd ?? "20:00", { h: 20, m: 0 });
  return {
    timezone: league.draftHoursTz?.trim() || DEFAULT_DRAFT_HOURS.timezone,
    startHour: start.h,
    startMinute: start.m,
    endHour: end.h,
    endMinute: end.m,
  };
}

function datePartsInTz(ms: number, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    y: get("year"),
    m: get("month"),
    d: get("day"),
    h: get("hour"),
    min: get("minute"),
  };
}

/** UTC ms для локального wall-clock в заданной TZ. */
function utcMsFromWallClock(
  y: number,
  m: number,
  d: number,
  h: number,
  min: number,
  tz: string
): number {
  let utc = Date.UTC(y, m - 1, d, h, min, 0);
  for (let i = 0; i < 4; i++) {
    const p = datePartsInTz(utc, tz);
    const desired = Date.UTC(y, m - 1, d, h, min, 0);
    const actual = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, 0);
    utc += desired - actual;
  }
  return utc;
}

function addCalendarDays(y: number, m: number, d: number, days: number, tz: string) {
  const base = utcMsFromWallClock(y, m, d, 12, 0, tz);
  return datePartsInTz(base + days * 86_400_000, tz);
}

/** Сколько миллисекунд из [startMs, endMs] попало в рабочие окна. */
export function countWorkingMs(
  startMs: number,
  endMs: number,
  config: DraftHoursConfig
): number {
  if (endMs <= startMs) return 0;
  const { timezone: tz, startHour, startMinute, endHour, endMinute } = config;
  const windowLen =
    (endHour * 60 + endMinute - (startHour * 60 + startMinute)) * 60_000;
  if (windowLen <= 0) return endMs - startMs;

  let total = 0;
  let { y, m, d } = datePartsInTz(startMs, tz);
  const endParts = datePartsInTz(endMs, tz);
  const guard = 400;
  let n = 0;

  while (n++ < guard) {
    const dayStart = utcMsFromWallClock(y, m, d, startHour, startMinute, tz);
    const dayEnd = utcMsFromWallClock(y, m, d, endHour, endMinute, tz);
    const from = Math.max(startMs, dayStart);
    const to = Math.min(endMs, dayEnd);
    if (to > from) total += to - from;

    if (y > endParts.y || (y === endParts.y && m > endParts.m) ||
        (y === endParts.y && m === endParts.m && d >= endParts.d)) {
      break;
    }
    ({ y, m, d } = addCalendarDays(y, m, d, 1, tz));
  }
  return total;
}

export function isWithinDraftHours(nowMs: number, config: DraftHoursConfig): boolean {
  const { timezone: tz, startHour, startMinute, endHour, endMinute } = config;
  const { y, m, d } = datePartsInTz(nowMs, tz);
  const ws = utcMsFromWallClock(y, m, d, startHour, startMinute, tz);
  const we = utcMsFromWallClock(y, m, d, endHour, endMinute, tz);
  return nowMs >= ws && nowMs < we;
}

export function pickTimerRemainingMs(
  pickAtMs: number,
  nowMs: number,
  timeoutSec: number,
  config: DraftHoursConfig
): number {
  const used = countWorkingMs(pickAtMs, nowMs, config);
  return Math.max(0, timeoutSec * 1000 - used);
}

export function isPickTimerExpired(
  pickAtMs: number,
  nowMs: number,
  timeoutSec: number,
  config: DraftHoursConfig
): boolean {
  return pickTimerRemainingMs(pickAtMs, nowMs, timeoutSec, config) <= 0;
}

const DATETIME_LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** Значение для input[type=datetime-local] в заданной TZ. */
export function formatWallDatetimeLocal(d: Date, tz: string): string {
  const p = datePartsInTz(d.getTime(), tz);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}T${pad2(p.h)}:${pad2(p.min)}`;
}

export function parseWallDatetimeLocal(
  isoLocal: string,
  tz: string
): Date | null {
  const m = DATETIME_LOCAL_RE.exec(isoLocal.trim());
  if (!m) return null;
  return new Date(
    utcMsFromWallClock(+m[1], +m[2], +m[3], +m[4], +m[5], tz)
  );
}

export function formatWallDatetimeLabel(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: tz,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

export function formatDraftHoursLabel(config: DraftHoursConfig): string {
  const pad = (h: number, m: number) =>
    `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  return `${pad(config.startHour, config.startMinute)}–${pad(config.endHour, config.endMinute)} (${config.timezone})`;
}
