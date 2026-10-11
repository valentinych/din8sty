/**
 * On-pitch CS / conceded from AF fixture events.
 *
 * CS minutes: regular time only (elapsed 0–90; 45+x and 90+x do not add).
 * Conceded-while-on-pitch: includes stoppage if the player was still on.
 */
export type AfMatchEvent = {
  elapsed: number;
  extra: number | null;
  team_id: number | null;
  player_id: number | null;
  assist_id: number | null;
  type: string;
  detail: string | null;
};

export type OnPitchFpts = {
  /** Regular-time minutes on pitch (0–90). Null if the window cannot be proved. */
  regularMinutes: number | null;
  /** Goals conceded by the club while this player was on. Null if unknown. */
  conceded: number | null;
};

type Clock = { elapsed: number; extra: number };

function nzElapsed(n: number | null | undefined): number {
  return Number.isFinite(n as number) ? Math.max(0, Number(n)) : 0;
}

function clockOf(elapsed: number, extra: number | null | undefined): Clock {
  return { elapsed: nzElapsed(elapsed), extra: nzElapsed(extra) };
}

function clockKey(c: Clock): number {
  return c.elapsed * 100 + c.extra;
}

function clockLte(a: Clock, b: Clock): boolean {
  return clockKey(a) <= clockKey(b);
}

/** Regular-time clock position: 45+3 → 45, 90+5 → 90, 70 → 70. */
export function regularElapsed(elapsed: number): number {
  return Math.min(90, Math.max(0, nzElapsed(elapsed)));
}

function normType(ev: AfMatchEvent): string {
  return String(ev.type || "").toLowerCase();
}

function normDetail(ev: AfMatchEvent): string {
  return String(ev.detail || "").toLowerCase();
}

function isSubst(ev: AfMatchEvent): boolean {
  const t = normType(ev);
  return t === "subst" || t === "substitution";
}

function isRedOff(ev: AfMatchEvent): boolean {
  if (normType(ev) !== "card") return false;
  const d = normDetail(ev);
  return d.includes("red") || d.includes("second yellow");
}

/** Scored penalty (not a miss). AF: type Goal, detail Penalty. */
export function isConvertedPenalty(ev: AfMatchEvent): boolean {
  if (normType(ev) !== "goal") return false;
  const d = normDetail(ev);
  if (d.includes("missed")) return false;
  return d.includes("penalty");
}

/**
 * Goal against `teamId`. AF `team_id` is the side credited on the scoreboard
 * (scorer's club, or the **benefitting** club on an own goal — not the OG
 * scorer's club). A Rayo own goal is tagged Barcelona; that is a Barça goal,
 * not a conceded. Do not invert OG (`team_id === teamId`).
 */
export function isGoalConcededByTeam(ev: AfMatchEvent, teamId: number): boolean {
  if (normType(ev) !== "goal") return false;
  const d = normDetail(ev);
  if (d.includes("missed")) return false;
  return ev.team_id != null && ev.team_id !== teamId;
}

export function countTeamGoalsAgainstEvents(
  events: AfMatchEvent[],
  teamId: number,
): number {
  return events.reduce((n, ev) => n + (isGoalConcededByTeam(ev, teamId) ? 1 : 0), 0);
}

function eventClock(ev: AfMatchEvent): Clock {
  return clockOf(ev.elapsed, ev.extra);
}

type PitchWindow = { from: Clock; to: Clock | null };

function playerPitchWindow(
  events: AfMatchEvent[],
  playerId: number,
  isSubstitute: boolean,
): PitchWindow | null {
  const subIn = events.find((ev) => isSubst(ev) && ev.assist_id === playerId);
  const subOut = events.find((ev) => isSubst(ev) && ev.player_id === playerId);
  const red = events.find((ev) => isRedOff(ev) && ev.player_id === playerId);

  let from: Clock;
  if (subIn) from = eventClock(subIn);
  else if (!isSubstitute) from = clockOf(0, 0);
  else return null;

  let to: Clock | null = null;
  if (subOut) to = eventClock(subOut);
  if (red) {
    const redAt = eventClock(red);
    if (!to || clockLte(redAt, to)) to = redAt;
  }
  return { from, to };
}

function regularMinutesOnPitch(
  window: PitchWindow,
  finished: boolean,
  regularNow: number | null,
): number | null {
  const fromR = regularElapsed(window.from.elapsed);
  if (window.to) return Math.max(0, regularElapsed(window.to.elapsed) - fromR);
  if (finished) return Math.max(0, 90 - fromR);
  if (regularNow == null) return null;
  return Math.max(0, regularElapsed(regularNow) - fromR);
}

function concededOnPitch(
  events: AfMatchEvent[],
  teamId: number,
  window: PitchWindow,
): number {
  let n = 0;
  for (const ev of events) {
    if (!isGoalConcededByTeam(ev, teamId)) continue;
    const at = eventClock(ev);
    if (!clockLte(window.from, at)) continue;
    if (window.to && !clockLte(at, window.to)) continue;
    n += 1;
  }
  return n;
}

/**
 * CS / conceded inputs. Null conceded or regularMinutes → cannot prove CS.
 * Incomplete goal events vs the scoreline also refuse CS (conceded stays
 * null when we saw none, so a 2–2 with missing events cannot get CS).
 */
export function onPitchFptsInputs(opts: {
  events: AfMatchEvent[];
  eventsSynced: boolean;
  playerId: number;
  teamId: number;
  isSubstitute: boolean;
  finished: boolean;
  regularNow: number | null;
  scoreGoalsAgainst: number | null;
}): OnPitchFpts {
  if (!opts.eventsSynced) return { regularMinutes: null, conceded: null };

  const window = playerPitchWindow(
    opts.events,
    opts.playerId,
    opts.isSubstitute,
  );
  if (!window) return { regularMinutes: null, conceded: null };

  const regularMinutes = regularMinutesOnPitch(
    window,
    opts.finished,
    opts.regularNow,
  );
  const conceded = concededOnPitch(opts.events, opts.teamId, window);
  const eventGa = countTeamGoalsAgainstEvents(opts.events, opts.teamId);
  const scoreGa = opts.scoreGoalsAgainst;
  if (scoreGa != null && eventGa < scoreGa) {
    return { regularMinutes, conceded: conceded > 0 ? conceded : null };
  }
  return { regularMinutes, conceded };
}

/**
 * AF `/fixtures/players` often lags subst minutes (bench row stays at 0').
 * Prefer event-derived regular minutes when they prove more time on pitch.
 */
export function appearanceMinutes(opts: {
  afMinutes: number;
  regularMinutes: number | null;
  isSubstitute: boolean;
  playerId: number;
  events: AfMatchEvent[];
}): number {
  const af = Math.max(0, Number(opts.afMinutes) || 0);
  const fromEvents = opts.regularMinutes;
  if (fromEvents == null || fromEvents <= af) return af;
  if (opts.isSubstitute || af > 0) return fromEvents;
  const involved = opts.events.some(
    (ev) =>
      ev.player_id === opts.playerId ||
      (isSubst(ev) && ev.assist_id === opts.playerId),
  );
  return involved ? fromEvents : af;
}

export function teamGoalsAgainstFromScore(
  teamId: number,
  homeAfId: number,
  awayAfId: number,
  homeGoals: number | null,
  awayGoals: number | null,
): number | null {
  if (homeGoals == null || awayGoals == null) return null;
  if (teamId === homeAfId) return nzElapsed(awayGoals);
  if (teamId === awayAfId) return nzElapsed(homeGoals);
  return null;
}

/** Event with optional AF player names (from `/fixtures/events`). */
export type AfNamedMatchEvent = AfMatchEvent & {
  player_name?: string | null;
  assist_name?: string | null;
};

export type DerivedPlayerStat = {
  af_team_id: number;
  af_player_id: number;
  player_name: string;
  minutes: number;
  substitute: number;
  goals: number;
  assists: number;
  yellow: number;
  red: number;
};

function isPlayerGoal(ev: AfMatchEvent): boolean {
  if (normType(ev) !== "goal") return false;
  const d = normDetail(ev);
  if (d.includes("missed") || d.includes("own")) return false;
  return true;
}

function preferName(cur: string, next: string | null | undefined): string {
  const n = String(next || "").trim();
  if (!n) return cur;
  if (!cur) return n;
  return n.length > cur.length ? n : cur;
}

/**
 * Build per-player minutes/goals/cards when `/fixtures/players` is empty.
 * Common for early cup rounds vs amateur sides: AF still publishes events.
 */
export function derivePlayerStatsFromEvents(
  events: AfNamedMatchEvent[],
  opts: { finished: boolean; regularNow: number | null },
): DerivedPlayerStat[] {
  type Acc = {
    teamId: number;
    name: string;
    goals: number;
    assists: number;
    yellow: number;
    red: number;
  };
  const byId = new Map<number, Acc>();

  const touch = (
    playerId: number | null | undefined,
    teamId: number | null | undefined,
    name: string | null | undefined,
  ): Acc | null => {
    if (playerId == null || !Number.isFinite(playerId) || playerId <= 0) {
      return null;
    }
    if (teamId == null || !Number.isFinite(teamId)) return null;
    let acc = byId.get(playerId);
    if (!acc) {
      acc = {
        teamId,
        name: String(name || "").trim(),
        goals: 0,
        assists: 0,
        yellow: 0,
        red: 0,
      };
      byId.set(playerId, acc);
    } else {
      acc.name = preferName(acc.name, name);
    }
    return acc;
  };

  for (const ev of events) {
    touch(ev.player_id, ev.team_id, ev.player_name);
    if (isSubst(ev) || isPlayerGoal(ev)) {
      touch(ev.assist_id, ev.team_id, ev.assist_name);
    }
    const scorer = ev.player_id != null ? byId.get(ev.player_id) : undefined;
    if (scorer && isPlayerGoal(ev)) scorer.goals += 1;
    const assister = ev.assist_id != null ? byId.get(ev.assist_id) : undefined;
    if (assister && isPlayerGoal(ev) && ev.assist_id !== ev.player_id) {
      assister.assists += 1;
    }
    if (scorer && normType(ev) === "card") {
      if (isRedOff(ev)) scorer.red += 1;
      else if (normDetail(ev).includes("yellow")) scorer.yellow += 1;
    }
  }

  const out: DerivedPlayerStat[] = [];
  for (const [playerId, acc] of byId) {
    const isSubstitute = events.some(
      (ev) => isSubst(ev) && ev.assist_id === playerId,
    );
    const window = playerPitchWindow(events, playerId, isSubstitute);
    const minutes = window
      ? (regularMinutesOnPitch(window, opts.finished, opts.regularNow) ?? 0)
      : 0;
    out.push({
      af_team_id: acc.teamId,
      af_player_id: playerId,
      player_name: acc.name,
      minutes,
      substitute: isSubstitute ? 1 : 0,
      goals: acc.goals,
      assists: acc.assists,
      yellow: acc.yellow,
      red: acc.red,
    });
  }
  return out;
}
