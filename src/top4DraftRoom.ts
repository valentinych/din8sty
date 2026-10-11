/**
 * Top-4 «Комната драфта»: up to 10 formation sets per manager
 * with starter + 2 replacement options per slot.
 */
import type Database from "better-sqlite3";
import { FORMATIONS } from "./primerDraft.js";
import {
  ensureTop4Tables,
  getTop4State,
  isRegistered,
  listTop4Wishlist,
  parseLotteryOrder,
} from "./top4League.js";
import { listFormerPlayersByTeam } from "./top4Transfers.js";
import { formationById, pitchFormations } from "./userLineups.js";

export const DRAFT_ROOM_MAX_SETS = 10;
export const DRAFT_ROOM_NAME_MAX = 40;

export type DraftRoomSlot = {
  starter: string | null;
  replace1: string | null;
  replace2: string | null;
};

export type DraftRoomSetRow = {
  id: number;
  email: string;
  name: string;
  formation: string;
  slots_json: string;
  updated_at: string;
};

export type DraftRoomSet = {
  id: number;
  name: string;
  formation: string;
  slots: DraftRoomSlot[];
  updated_at: string;
};

export type DraftRoomPoolPlayer = {
  player_id: string;
  name: string;
  club_id: string;
  club_name: string;
  league_id: string;
  position: string | null;
  detail_role: string | null;
  detail_label: string | null;
  side_role: string | null;
  position_display: string;
  fm_rating: number | null;
  market_value_eur: number;
  wage_pw: number;
  portrait_url: string | null;
  club_crest: string | null;
  source: "wishlist" | "squad" | "both";
};

export function ensureTop4DraftRoomTables(db: Database.Database): void {
  ensureTop4Tables(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS top4_draft_room_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL COLLATE NOCASE,
      name TEXT NOT NULL DEFAULT '',
      formation TEXT NOT NULL,
      slots_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_top4_draft_room_sets_email
      ON top4_draft_room_sets (email);
  `);
}

function emptySlots(count: number): DraftRoomSlot[] {
  return Array.from({ length: count }, () => ({
    starter: null,
    replace1: null,
    replace2: null,
  }));
}

function normalizeName(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, DRAFT_ROOM_NAME_MAX);
}

function parseSlotsJson(raw: string, slotCount: number): DraftRoomSlot[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptySlots(slotCount);
  }
  if (!Array.isArray(parsed)) return emptySlots(slotCount);
  const out: DraftRoomSlot[] = [];
  for (let i = 0; i < slotCount; i++) {
    const row = parsed[i] as Record<string, unknown> | undefined;
    const pick = (key: string): string | null => {
      const v = row?.[key];
      if (v == null || v === "") return null;
      return String(v);
    };
    out.push({
      starter: pick("starter"),
      replace1: pick("replace1"),
      replace2: pick("replace2"),
    });
  }
  return out;
}

function assertValidSlots(
  slots: DraftRoomSlot[],
  slotCount: number,
  allowedIds: Set<string>,
): DraftRoomSlot[] {
  if (!Array.isArray(slots) || slots.length !== slotCount) {
    throw new Error("slots_invalid");
  }
  const out: DraftRoomSlot[] = [];
  for (const row of slots) {
    const norm = (v: unknown): string | null => {
      if (v == null || v === "") return null;
      const id = String(v).trim();
      if (!id) return null;
      if (allowedIds.size > 0 && !allowedIds.has(id)) {
        return null;
      }
      if (allowedIds.size === 0 && id) {
        return null;
      }
      return id;
    };
    out.push({
      starter: norm(row?.starter),
      replace1: norm(row?.replace1),
      replace2: norm(row?.replace2),
    });
  }
  return out;
}

function rowToSet(row: DraftRoomSetRow): DraftRoomSet {
  const formation = formationById(row.formation, FORMATIONS);
  const slotCount = formation?.slots.length ?? 11;
  return {
    id: row.id,
    name: row.name,
    formation: formation?.id ?? row.formation,
    slots: parseSlotsJson(row.slots_json, slotCount),
    updated_at: row.updated_at,
  };
}

function formerIdsForEmail(db: Database.Database, email: string): Set<string> {
  const em = email.toLowerCase();
  const lottery = parseLotteryOrder(getTop4State(db)) ?? [];
  const teamId = lottery.find((e) => e.email.toLowerCase() === em)?.team_id;
  if (teamId == null) return new Set();
  return new Set(
    (listFormerPlayersByTeam(db).get(teamId) || []).map((p) => String(p.id)),
  );
}

/** Wishlist ∪ current fantasy roster. Dumped / former players are excluded. */
export function draftRoomAllowedPlayerIds(
  db: Database.Database,
  email: string,
): { wishlistIds: string[]; squadIds: string[]; allowedIds: Set<string> } {
  ensureTop4DraftRoomTables(db);
  const em = email.toLowerCase();
  const formerIds = formerIdsForEmail(db, em);
  const wishlistIds = listTop4Wishlist(db, em)
    .map((w) => w.player_id)
    .filter((id) => !formerIds.has(String(id)));
  const squadIdSet = new Set<string>();

  // Current roster lives in top4_draft_picks (dumps already deleted there).
  const livePicks = db
    .prepare(
      `SELECT DISTINCT player_id FROM top4_draft_picks
       WHERE email = ? COLLATE NOCASE`,
    )
    .all(em) as Array<{ player_id: string }>;
  for (const row of livePicks) {
    if (row?.player_id) squadIdSet.add(String(row.player_id));
  }

  // Legacy fallback only when this manager has no pick rows at all.
  const state = getTop4State(db);
  if (!squadIdSet.size && state.draft_json) {
    try {
      const draft = JSON.parse(state.draft_json) as {
        managers?: Array<{ email: string; team_id: number }>;
        teams?: Array<{ id: number; players?: Array<{ id: string }> }>;
      };
      const manager = (draft.managers || []).find(
        (m) => m.email.toLowerCase() === em,
      );
      if (manager) {
        const team = (draft.teams || []).find((t) => t.id === manager.team_id);
        for (const p of team?.players || []) {
          if (p?.id && !formerIds.has(String(p.id))) squadIdSet.add(String(p.id));
        }
      }
    } catch {
      /* ignore bad draft_json */
    }
  }

  for (const id of formerIds) squadIdSet.delete(id);
  const squadIds = [...squadIdSet];
  const allowedIds = new Set<string>([...wishlistIds, ...squadIds]);
  return { wishlistIds, squadIds, allowedIds };
}

export function listDraftRoomSets(
  db: Database.Database,
  email: string,
): DraftRoomSet[] {
  ensureTop4DraftRoomTables(db);
  const rows = db
    .prepare(
      `SELECT id, email, name, formation, slots_json, updated_at
       FROM top4_draft_room_sets
       WHERE email = ? COLLATE NOCASE
       ORDER BY id ASC`,
    )
    .all(email.toLowerCase()) as DraftRoomSetRow[];
  return rows.map(rowToSet);
}

export function getDraftRoomSet(
  db: Database.Database,
  email: string,
  id: number,
): DraftRoomSet | null {
  ensureTop4DraftRoomTables(db);
  const row = db
    .prepare(
      `SELECT id, email, name, formation, slots_json, updated_at
       FROM top4_draft_room_sets
       WHERE id = ? AND email = ? COLLATE NOCASE`,
    )
    .get(id, email.toLowerCase()) as DraftRoomSetRow | undefined;
  return row ? rowToSet(row) : null;
}

export function createDraftRoomSet(
  db: Database.Database,
  email: string,
  input: { name?: string; formation?: string; slots?: DraftRoomSlot[] },
): DraftRoomSet {
  ensureTop4DraftRoomTables(db);
  const em = email.toLowerCase();
  if (!isRegistered(db, em)) throw new Error("not_registered");
  const count = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM top4_draft_room_sets WHERE email = ? COLLATE NOCASE`,
      )
      .get(em) as { n: number }
  ).n;
  if (count >= DRAFT_ROOM_MAX_SETS) throw new Error("draft_room_limit");

  const formationId = String(input.formation || "4-4-2");
  const formation = formationById(formationId, FORMATIONS);
  if (!formation) throw new Error("formation_invalid");

  const { allowedIds } = draftRoomAllowedPlayerIds(db, em);
  const slots = input.slots
    ? assertValidSlots(input.slots, formation.slots.length, allowedIds)
    : emptySlots(formation.slots.length);

  const now = new Date().toISOString();
  const name = normalizeName(input.name);
  const result = db
    .prepare(
      `INSERT INTO top4_draft_room_sets (email, name, formation, slots_json, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(em, name, formation.id, JSON.stringify(slots), now);

  return getDraftRoomSet(db, em, Number(result.lastInsertRowid))!;
}

export function updateDraftRoomSet(
  db: Database.Database,
  email: string,
  id: number,
  input: { name?: string; formation?: string; slots?: DraftRoomSlot[] },
): DraftRoomSet {
  ensureTop4DraftRoomTables(db);
  const em = email.toLowerCase();
  if (!isRegistered(db, em)) throw new Error("not_registered");
  const existing = getDraftRoomSet(db, em, id);
  if (!existing) throw new Error("set_not_found");

  const formationId = String(input.formation ?? existing.formation);
  const formation = formationById(formationId, FORMATIONS);
  if (!formation) throw new Error("formation_invalid");

  const { allowedIds } = draftRoomAllowedPlayerIds(db, em);
  let slots: DraftRoomSlot[];
  if (input.slots) {
    slots = assertValidSlots(input.slots, formation.slots.length, allowedIds);
  } else if (formation.id !== existing.formation) {
    // Formation change without slots: keep overlapping prefix, pad/truncate.
    const prev = existing.slots;
    slots = emptySlots(formation.slots.length).map((empty, i) =>
      i < prev.length ? prev[i] : empty,
    );
    slots = assertValidSlots(slots, formation.slots.length, allowedIds);
  } else {
    slots = existing.slots;
  }

  const name = input.name !== undefined ? normalizeName(input.name) : existing.name;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE top4_draft_room_sets
     SET name = ?, formation = ?, slots_json = ?, updated_at = ?
     WHERE id = ? AND email = ? COLLATE NOCASE`,
  ).run(name, formation.id, JSON.stringify(slots), now, id, em);

  return getDraftRoomSet(db, em, id)!;
}

export function deleteDraftRoomSet(
  db: Database.Database,
  email: string,
  id: number,
): void {
  ensureTop4DraftRoomTables(db);
  const em = email.toLowerCase();
  if (!isRegistered(db, em)) throw new Error("not_registered");
  const result = db
    .prepare(
      `DELETE FROM top4_draft_room_sets WHERE id = ? AND email = ? COLLATE NOCASE`,
    )
    .run(id, em);
  if (result.changes === 0) throw new Error("set_not_found");
}

export function clearDraftRoomSets(db: Database.Database): void {
  ensureTop4DraftRoomTables(db);
  db.prepare(`DELETE FROM top4_draft_room_sets`).run();
}

export function draftRoomFormationsPublic(): Array<{
  id: string;
  label: string;
  slots: Array<{ roles: string[]; label: string; x: number; y: number }>;
}> {
  return pitchFormations(FORMATIONS).map((f) => ({
    id: f.id,
    label: f.label,
    slots: f.slots.map((s) => ({
      roles: [...s.roles],
      label: s.label,
      x: s.x,
      y: s.y,
    })),
  }));
}
