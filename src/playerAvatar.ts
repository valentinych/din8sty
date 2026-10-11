/**
 * TM squad pages often embed the club crest (`/wappen/...`) when a player
 * has no portrait. After a transfer that URL stays pointed at the *former*
 * club. Treat those as "no photo" and fall back to the current club crest.
 */

export function isRealPortraitUrl(url: string | null | undefined): boolean {
  if (url == null) return false;
  const s = String(url).trim();
  if (!s) return false;
  return !/\/wappen\//i.test(s);
}

/** Drop TM crest URLs that were wrongly stored as portraits. */
export function sanitizePortraitUrl(
  url: string | null | undefined,
): string | null {
  return isRealPortraitUrl(url) ? String(url).trim() : null;
}

/** Photo if real, else current club crest. */
export function resolvePlayerAvatarUrl(
  portraitUrl: string | null | undefined,
  clubCrestUrl: string | null | undefined,
): string | null {
  const photo = sanitizePortraitUrl(portraitUrl);
  if (photo) return photo;
  if (clubCrestUrl == null) return null;
  const crest = String(clubCrestUrl).trim();
  return crest || null;
}
