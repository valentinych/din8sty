/**
 * Lightweight Transfermarkt request queue (mirrors ../transfermarkt tmQueue).
 * Caps: ≤4/s, ≤100/min, jittered gaps + occasional pauses.
 */

const MAX_PER_SEC = 4;
const MAX_PER_MIN = 100;
const WINDOW_SEC_MS = 1000;
const WINDOW_MIN_MS = 60_000;
const GAP_MIN = 280;
const GAP_MAX = 950;
const PAUSE_EVERY_MIN = 7;
const PAUSE_EVERY_MAX = 14;
const PAUSE_MS_MIN = 1200;
const PAUSE_MS_MAX = 2800;

const recentSec: number[] = [];
const recentMin: number[] = [];
let lastIssued = 0;
let sincePause = 0;
let nextPauseAt = randInt(PAUSE_EVERY_MIN, PAUSE_EVERY_MAX);
let chain: Promise<void> = Promise.resolve();

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function prune(now: number): void {
  while (recentSec.length > 0 && now - recentSec[0]! >= WINDOW_SEC_MS) recentSec.shift();
  while (recentMin.length > 0 && now - recentMin[0]! >= WINDOW_MIN_MS) recentMin.shift();
}

async function reserveSlot(): Promise<void> {
  for (;;) {
    const now = Date.now();
    prune(now);

    const gapNeeded = randInt(GAP_MIN, GAP_MAX);
    const sinceLast = now - lastIssued;
    if (lastIssued > 0 && sinceLast < gapNeeded) {
      await sleep(gapNeeded - sinceLast);
      continue;
    }
    if (recentSec.length >= MAX_PER_SEC) {
      await sleep(WINDOW_SEC_MS - (now - recentSec[0]!) + randInt(20, 80));
      continue;
    }
    if (recentMin.length >= MAX_PER_MIN) {
      await sleep(WINDOW_MIN_MS - (now - recentMin[0]!) + randInt(50, 200));
      continue;
    }
    if (sincePause >= nextPauseAt) {
      sincePause = 0;
      nextPauseAt = randInt(PAUSE_EVERY_MIN, PAUSE_EVERY_MAX);
      await sleep(randInt(PAUSE_MS_MIN, PAUSE_MS_MAX));
      continue;
    }

    const t = Date.now();
    recentSec.push(t);
    recentMin.push(t);
    lastIssued = t;
    sincePause++;
    return;
  }
}

export async function tmEnqueue<T>(fn: () => Promise<T>): Promise<T> {
  const previous = chain;
  let release!: () => void;
  chain = new Promise<void>((r) => {
    release = r;
  });
  try {
    await previous;
    await reserveSlot();
    return await fn();
  } finally {
    release();
  }
}
