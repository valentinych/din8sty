/**
 * Top-4 fantasy team logos: store under data/uploads, path on registration row.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { ensureTop4Tables, getRegistration } from "./top4League.js";

export const TOP4_LOGO_MAX_BYTES = 1_500_000;
export const TOP4_LOGO_PUBLIC_PREFIX = "/uploads/top4-logos";

const ALLOWED_EXT = new Set(["png", "jpg", "webp"]);

export type Top4LogoKind = "png" | "jpg" | "webp";

function normEmail(email: string): string {
  return String(email || "").trim().toLowerCase();
}

export function top4LogoUploadDir(dataDir: string): string {
  return path.join(dataDir, "uploads", "top4-logos");
}

export function ensureTop4LogoSchema(db: Database.Database): void {
  ensureTop4Tables(db);
  const cols = db.prepare(`PRAGMA table_info(top4_registrations)`).all() as Array<{
    name: string;
  }>;
  if (!cols.some((c) => c.name === "logo_url")) {
    db.exec(`ALTER TABLE top4_registrations ADD COLUMN logo_url TEXT`);
  }
}

export function ensureTop4LogoDir(dataDir: string): void {
  fs.mkdirSync(top4LogoUploadDir(dataDir), { recursive: true });
}

/** Stable, filesystem-safe stem from manager email (no path chars). */
export function emailLogoStem(email: string): string {
  return crypto
    .createHash("sha256")
    .update(normEmail(email))
    .digest("hex")
    .slice(0, 24);
}

export function detectImageKind(buf: Buffer): Top4LogoKind | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "png";
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "jpg";
  }
  if (
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

/** Strip query/hash; allow only `{stem}.{png|jpg|webp}` under the logos dir. */
export function safeLogoFilename(raw: string): string | null {
  const base = path.basename(String(raw || "").split("?")[0].split("#")[0]);
  const m = /^([a-f0-9]{24})\.(png|jpg|webp)$/i.exec(base);
  if (!m) return null;
  const ext = m[2].toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return null;
  return `${m[1].toLowerCase()}.${ext}`;
}

/**
 * Resolve a public logo path to an absolute file under dataDir.
 * Returns null on path traversal / invalid name.
 */
export function resolveTop4LogoFile(
  dataDir: string,
  publicPathOrName: string,
): string | null {
  const raw = String(publicPathOrName || "").trim();
  const nameOnly = raw.startsWith(TOP4_LOGO_PUBLIC_PREFIX + "/")
    ? raw.slice(TOP4_LOGO_PUBLIC_PREFIX.length + 1)
    : raw.startsWith("/")
      ? path.basename(raw)
      : raw;
  const safe = safeLogoFilename(nameOnly);
  if (!safe) return null;
  const dir = path.resolve(top4LogoUploadDir(dataDir));
  const full = path.resolve(dir, safe);
  if (full !== path.join(dir, safe)) return null;
  if (!full.startsWith(dir + path.sep)) return null;
  return full;
}

export function publicLogoUrl(filename: string, version?: number | string): string {
  const safe = safeLogoFilename(filename);
  if (!safe) throw new Error("logo_invalid");
  const base = `${TOP4_LOGO_PUBLIC_PREFIX}/${safe}`;
  return version != null && String(version) !== ""
    ? `${base}?v=${encodeURIComponent(String(version))}`
    : base;
}

function unlinkQuiet(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* missing is fine */
  }
}

function removeExistingLogoFiles(dataDir: string, stem: string): void {
  const dir = top4LogoUploadDir(dataDir);
  for (const ext of ALLOWED_EXT) {
    unlinkQuiet(path.join(dir, `${stem}.${ext}`));
  }
}

export function getTop4LogoUrl(
  db: Database.Database,
  email: string,
): string | null {
  ensureTop4LogoSchema(db);
  const row = db
    .prepare(
      `SELECT logo_url FROM top4_registrations WHERE email = ? COLLATE NOCASE`,
    )
    .get(normEmail(email)) as { logo_url: string | null } | undefined;
  const url = row?.logo_url?.trim();
  return url || null;
}

export function logoUrlByEmails(
  db: Database.Database,
  emails: string[],
): Map<string, string | null> {
  ensureTop4LogoSchema(db);
  const map = new Map<string, string | null>();
  const uniq = [
    ...new Set(emails.map(normEmail).filter(Boolean)),
  ];
  if (!uniq.length) return map;
  const rows = db
    .prepare(
      `SELECT email, logo_url FROM top4_registrations
       WHERE email IN (${uniq.map(() => "?").join(",")})`,
    )
    .all(...uniq) as Array<{ email: string; logo_url: string | null }>;
  for (const r of rows) {
    map.set(normEmail(r.email), r.logo_url?.trim() || null);
  }
  return map;
}

export function saveTop4Logo(
  db: Database.Database,
  dataDir: string,
  email: string,
  buf: Buffer,
): { logo_url: string } {
  ensureTop4LogoSchema(db);
  ensureTop4LogoDir(dataDir);
  const em = normEmail(email);
  if (!getRegistration(db, em)) throw new Error("not_registered");
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new Error("logo_empty");
  if (buf.length > TOP4_LOGO_MAX_BYTES) throw new Error("logo_too_large");
  const kind = detectImageKind(buf);
  if (!kind) throw new Error("logo_invalid_type");

  const stem = emailLogoStem(em);
  removeExistingLogoFiles(dataDir, stem);
  const filename = `${stem}.${kind}`;
  const dest = path.join(top4LogoUploadDir(dataDir), filename);
  fs.writeFileSync(dest, buf);
  const logoUrl = publicLogoUrl(filename, Date.now());
  db.prepare(
    `UPDATE top4_registrations SET logo_url = ? WHERE email = ? COLLATE NOCASE`,
  ).run(logoUrl, em);
  return { logo_url: logoUrl };
}

export function clearTop4Logo(
  db: Database.Database,
  dataDir: string,
  email: string,
): void {
  ensureTop4LogoSchema(db);
  const em = normEmail(email);
  const mine = getRegistration(db, em);
  if (!mine) throw new Error("not_registered");
  removeExistingLogoFiles(dataDir, emailLogoStem(em));
  db.prepare(
    `UPDATE top4_registrations SET logo_url = NULL WHERE email = ? COLLATE NOCASE`,
  ).run(em);
}

/** Best-effort cleanup when a manager unregisters. */
export function deleteTop4LogoFilesForEmail(
  db: Database.Database,
  dataDir: string,
  email: string,
): void {
  ensureTop4LogoSchema(db);
  const em = normEmail(email);
  const url = getTop4LogoUrl(db, em);
  if (url) {
    const file = resolveTop4LogoFile(dataDir, url);
    if (file) unlinkQuiet(file);
  }
  removeExistingLogoFiles(dataDir, emailLogoStem(em));
}
