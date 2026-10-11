/**
 * Top-4 consigliere: trusted deputy for empty wishlist / empty pre-deadline lineup.
 * Never overrides the primary manager's choices.
 */
import type Database from "better-sqlite3";
import {
  ensureTop4Tables,
  getRegistration,
  getTop4State,
  isRegistered,
  listTop4Wishlist,
  type Top4Registration,
} from "./top4League.js";
import { lineupDeadlinePassed } from "./gameweeks.js";

export type LineupSetBy = "manager" | "consigliere";

export type Top4RegistrationWithConsigliere = Top4Registration & {
  consigliere_email: string | null;
};

export type Top4ConsigliereClient = {
  email: string;
  team_name: string;
  name: string | null;
  logo_url?: string | null;
};

export type Top4LineupRow = {
  team_id: number;
  gw: number;
  formation: string;
  slots_json: string;
  set_by: LineupSetBy;
  updated_at: string;
  updated_by: string;
};

function normEmail(email: string): string {
  return String(email || "").trim().toLowerCase();
}

export function ensureTop4ConsigliereSchema(db: Database.Database): void {
  ensureTop4Tables(db);
  const regCols = db.prepare(`PRAGMA table_info(top4_registrations)`).all() as Array<{
    name: string;
  }>;
  if (!regCols.some((c) => c.name === "consigliere_email")) {
    db.exec(`ALTER TABLE top4_registrations ADD COLUMN consigliere_email TEXT`);
  }
  const wlCols = db.prepare(`PRAGMA table_info(top4_wishlist)`).all() as Array<{
    name: string;
  }>;
  if (!wlCols.some((c) => c.name === "set_by")) {
    db.exec(
      `ALTER TABLE top4_wishlist ADD COLUMN set_by TEXT NOT NULL DEFAULT 'manager'`,
    );
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS top4_lineups (
      team_id INTEGER NOT NULL,
      gw INTEGER NOT NULL,
      formation TEXT NOT NULL,
      slots_json TEXT NOT NULL,
      set_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      PRIMARY KEY (team_id, gw)
    );
  `);
}

export function getRegistrationFull(
  db: Database.Database,
  email: string,
): Top4RegistrationWithConsigliere | null {
  ensureTop4ConsigliereSchema(db);
  const row = db
    .prepare(
      `SELECT email, name, team_name, registered_at, consigliere_email, logo_url, team_code
       FROM top4_registrations WHERE email = ? COLLATE NOCASE`,
    )
    .get(normEmail(email)) as
    | {
        email: string;
        name: string | null;
        team_name: string | null;
        registered_at: string;
        consigliere_email: string | null;
        logo_url: string | null;
        team_code: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    email: row.email,
    name: row.name,
    team_name: row.team_name?.trim() || row.name || row.email,
    registered_at: row.registered_at,
    consigliere_email: row.consigliere_email
      ? normEmail(row.consigliere_email)
      : null,
    logo_url: row.logo_url?.trim() || null,
    team_code: row.team_code?.trim()?.toUpperCase() || null,
  };
}

export function listTop4RegistrationsFull(
  db: Database.Database,
): Top4RegistrationWithConsigliere[] {
  ensureTop4ConsigliereSchema(db);
  return (
    db
      .prepare(
        `SELECT email, name, team_name, registered_at, consigliere_email, logo_url, team_code
         FROM top4_registrations ORDER BY registered_at ASC`,
      )
      .all() as Array<{
      email: string;
      name: string | null;
      team_name: string | null;
      registered_at: string;
      consigliere_email: string | null;
      logo_url: string | null;
      team_code: string | null;
    }>
  ).map((r) => ({
    email: r.email,
    name: r.name,
    team_name: r.team_name?.trim() || r.name || r.email,
    registered_at: r.registered_at,
    consigliere_email: r.consigliere_email
      ? normEmail(r.consigliere_email)
      : null,
    logo_url: r.logo_url?.trim() || null,
    team_code: r.team_code?.trim()?.toUpperCase() || null,
  }));
}

/** Managers for whom `email` is the consigliere. */
export function listConsigliereClients(
  db: Database.Database,
  email: string,
): Top4ConsigliereClient[] {
  ensureTop4ConsigliereSchema(db);
  return (
    db
      .prepare(
        `SELECT email, name, team_name, logo_url FROM top4_registrations
         WHERE consigliere_email = ? COLLATE NOCASE
         ORDER BY registered_at ASC`,
      )
      .all(normEmail(email)) as Array<{
      email: string;
      name: string | null;
      team_name: string | null;
      logo_url: string | null;
    }>
  ).map((r) => ({
    email: r.email,
    name: r.name,
    team_name: r.team_name?.trim() || r.name || r.email,
    logo_url: r.logo_url?.trim() || null,
  }));
}

export function setTop4Consigliere(
  db: Database.Database,
  managerEmail: string,
  consigliereEmailRaw: string | null,
): Top4RegistrationWithConsigliere {
  ensureTop4ConsigliereSchema(db);
  const mine = getRegistrationFull(db, managerEmail);
  if (!mine) throw new Error("not_registered");
  let consigliere: string | null = null;
  if (consigliereEmailRaw != null && String(consigliereEmailRaw).trim()) {
    consigliere = normEmail(consigliereEmailRaw);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(consigliere)) {
      throw new Error("consigliere_email_invalid");
    }
    if (consigliere === normEmail(managerEmail)) {
      throw new Error("consigliere_self");
    }
    if (!isRegistered(db, consigliere)) {
      throw new Error("consigliere_not_participant");
    }
  }
  db.prepare(
    `UPDATE top4_registrations SET consigliere_email = ? WHERE email = ? COLLATE NOCASE`,
  ).run(consigliere, normEmail(managerEmail));
  return getRegistrationFull(db, managerEmail)!;
}

export function isConsigliereOf(
  db: Database.Database,
  actorEmail: string,
  managerEmail: string,
): boolean {
  const reg = getRegistrationFull(db, managerEmail);
  return Boolean(
    reg?.consigliere_email &&
      reg.consigliere_email === normEmail(actorEmail),
  );
}

/** Wishlist has any row set by the primary manager. */
export function wishlistHasManagerPicks(
  db: Database.Database,
  ownerEmail: string,
): boolean {
  ensureTop4ConsigliereSchema(db);
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM top4_wishlist
       WHERE email = ? COLLATE NOCASE AND set_by = 'manager' LIMIT 1`,
    )
    .get(normEmail(ownerEmail));
  return Boolean(row);
}

/**
 * Resolve which manager's wishlist/lineup the actor may touch.
 * `ownerEmail` optional — defaults to actor (self) or single consigliere client.
 */
export function resolveTop4Owner(
  db: Database.Database,
  actorEmail: string,
  ownerEmailRaw?: string | null,
): { ownerEmail: string; asConsigliere: boolean } {
  ensureTop4ConsigliereSchema(db);
  const actor = normEmail(actorEmail);
  const requested = ownerEmailRaw ? normEmail(ownerEmailRaw) : null;

  if (!requested || requested === actor) {
    if (isRegistered(db, actor)) {
      return { ownerEmail: actor, asConsigliere: false };
    }
    const clients = listConsigliereClients(db, actor);
    if (clients.length === 1) {
      return { ownerEmail: normEmail(clients[0].email), asConsigliere: true };
    }
    if (clients.length > 1) throw new Error("owner_required");
    throw new Error("not_registered");
  }

  if (requested === actor) {
    if (!isRegistered(db, actor)) throw new Error("not_registered");
    return { ownerEmail: actor, asConsigliere: false };
  }

  if (!isConsigliereOf(db, actor, requested)) {
    throw new Error("not_consigliere");
  }
  return { ownerEmail: requested, asConsigliere: true };
}

/** Consigliere may edit wishlist only when manager has made no picks. */
export function assertWishlistActor(
  db: Database.Database,
  actorEmail: string,
  ownerEmail: string,
  asConsigliere: boolean,
): void {
  const state = getTop4State(db);
  if (state.status === "complete") throw new Error("wishlist_locked");
  if (!isRegistered(db, ownerEmail)) throw new Error("not_registered");
  if (!asConsigliere) return;
  if (!isConsigliereOf(db, actorEmail, ownerEmail)) {
    throw new Error("not_consigliere");
  }
  if (wishlistHasManagerPicks(db, ownerEmail)) {
    throw new Error("cannot_override_manager");
  }
}

export function addToTop4WishlistAs(
  db: Database.Database,
  ownerEmail: string,
  playerId: string,
  setBy: LineupSetBy,
): void {
  ensureTop4ConsigliereSchema(db);
  const em = normEmail(ownerEmail);
  const exists = db
    .prepare(
      `SELECT 1 AS ok FROM top4_wishlist WHERE email = ? COLLATE NOCASE AND player_id = ?`,
    )
    .get(em, playerId);
  if (exists) return;
  const last = db
    .prepare(
      `SELECT MAX(priority) AS m FROM top4_wishlist WHERE email = ? COLLATE NOCASE`,
    )
    .get(em) as { m: number | null };
  const next = (last.m ?? 0) + 1;
  db.prepare(
    `INSERT INTO top4_wishlist (email, player_id, priority, set_by) VALUES (?, ?, ?, ?)`,
  ).run(em, playerId, next, setBy);
}

export function removeFromTop4WishlistAs(
  db: Database.Database,
  ownerEmail: string,
  playerId: string,
  asConsigliere: boolean,
): void {
  ensureTop4ConsigliereSchema(db);
  const em = normEmail(ownerEmail);
  if (asConsigliere) {
    const row = db
      .prepare(
        `SELECT set_by FROM top4_wishlist WHERE email = ? COLLATE NOCASE AND player_id = ?`,
      )
      .get(em, playerId) as { set_by: string } | undefined;
    if (row?.set_by === "manager") throw new Error("cannot_override_manager");
  }
  db.prepare(
    `DELETE FROM top4_wishlist WHERE email = ? COLLATE NOCASE AND player_id = ?`,
  ).run(em, playerId);
  const rows = listTop4Wishlist(db, em);
  const tx = db.transaction(() => {
    rows.forEach((r, idx) => {
      db.prepare(
        `UPDATE top4_wishlist SET priority = ? WHERE email = ? COLLATE NOCASE AND player_id = ?`,
      ).run(idx + 1, em, r.player_id);
    });
  });
  tx();
}

export function getTop4Lineup(
  db: Database.Database,
  teamId: number,
  gw: number,
): Top4LineupRow | null {
  ensureTop4ConsigliereSchema(db);
  return (
    (db
      .prepare(
        `SELECT team_id, gw, formation, slots_json, set_by, updated_at, updated_by
         FROM top4_lineups WHERE team_id = ? AND gw = ?`,
      )
      .get(teamId, gw) as Top4LineupRow | undefined) ?? null
  );
}

export function upsertTop4Lineup(
  db: Database.Database,
  teamId: number,
  gw: number,
  formation: string,
  slotsJson: string,
  setBy: LineupSetBy,
  updatedBy: string,
): Top4LineupRow {
  ensureTop4ConsigliereSchema(db);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO top4_lineups (team_id, gw, formation, slots_json, set_by, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(team_id, gw) DO UPDATE SET
       formation = excluded.formation,
       slots_json = excluded.slots_json,
       set_by = excluded.set_by,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
  ).run(teamId, gw, formation, slotsJson, setBy, now, updatedBy);
  return getTop4Lineup(db, teamId, gw)!;
}

/**
 * Manager always may save.
 * Consigliere may save only before deadline, and only if no manager lineup exists
 * (may update their own consigliere lineup).
 */
export function assertTop4LineupActor(
  db: Database.Database,
  actorEmail: string,
  managerEmail: string,
  teamId: number,
  gw: number,
  asConsigliere: boolean,
): LineupSetBy {
  if (!asConsigliere) {
    if (normEmail(actorEmail) !== normEmail(managerEmail)) {
      throw new Error("forbidden");
    }
    return "manager";
  }
  if (!isConsigliereOf(db, actorEmail, managerEmail)) {
    throw new Error("not_consigliere");
  }
  if (lineupDeadlinePassed(gw)) {
    throw new Error("deadline_passed");
  }
  const existing = getTop4Lineup(db, teamId, gw);
  if (existing?.set_by === "manager") {
    throw new Error("cannot_override_manager");
  }
  return "consigliere";
}

/** Map draft team_id → manager email from lottery JSON. */
export function managerEmailForTop4Team(
  db: Database.Database,
  teamId: number,
): string | null {
  const state = getTop4State(db);
  if (!state.lottery_order_json) return null;
  try {
    const lottery = JSON.parse(state.lottery_order_json) as Array<{
      email: string;
      team_id: number;
    }>;
    const hit = lottery.find((e) => Number(e.team_id) === teamId);
    return hit ? normEmail(hit.email) : null;
  } catch {
    return null;
  }
}

export function canEditTop4TeamAs(
  db: Database.Database,
  actorEmail: string,
  teamId: number,
  gw: number,
): { ok: boolean; asConsigliere: boolean; managerEmail: string | null; reason?: string } {
  const managerEmail = managerEmailForTop4Team(db, teamId);
  if (!managerEmail) return { ok: false, asConsigliere: false, managerEmail: null, reason: "no_manager" };
  const actor = normEmail(actorEmail);
  if (actor === managerEmail) {
    return { ok: true, asConsigliere: false, managerEmail };
  }
  if (!isConsigliereOf(db, actor, managerEmail)) {
    return { ok: false, asConsigliere: false, managerEmail, reason: "forbidden" };
  }
  if (lineupDeadlinePassed(gw)) {
    return { ok: false, asConsigliere: true, managerEmail, reason: "deadline_passed" };
  }
  const existing = getTop4Lineup(db, teamId, gw);
  if (existing?.set_by === "manager") {
    return { ok: false, asConsigliere: true, managerEmail, reason: "cannot_override_manager" };
  }
  return { ok: true, asConsigliere: true, managerEmail };
}
