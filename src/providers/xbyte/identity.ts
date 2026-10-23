import { createHash } from 'crypto';
import { RawDocument, SourceRank } from '../../core/pipeline/types';

export function rawId(doc: { _id?: unknown }): string | null {
  const id = doc._id;
  if (typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id)) return id.toLowerCase();
  if (
    id &&
    typeof id === 'object' &&
    'toHexString' in id &&
    typeof (id as { toHexString: unknown }).toHexString === 'function'
  ) {
    return (id as { toHexString: () => string }).toHexString();
  }
  return null;
}

export function documentRank(doc: RawDocument, sourceCollection: string): SourceRank | null {
  const sourceId = rawId(doc);
  const stamp = doc.updatedAt instanceof Date ? doc.updatedAt : doc.createdAt instanceof Date ? doc.createdAt : null;
  if (!sourceId || !stamp || Number.isNaN(stamp.getTime())) return null;
  return { sourceId, updatedAt: stamp, sourceCollection };
}

/** Collapse the export glitches ("Al  Muntazah", "SABUDANA VADA ") without changing case or emoji. */
export function normaliseLabel(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * Location ids arrive as ints in the catalogue and as decimal strings on listing
 * params (`"1468"`) and on `?aid=`. One canonical form so the two sides join.
 */
export function canonicalNumericId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) {
    return String(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed)) return String(parsed);
  }
  return null;
}

export function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Every menu in the sample has Contact "00000-00000". That is a placeholder,
 * not a phone we should serve. Real numbers (anything that isn't just zeros
 * and separators) are kept.
 */
export function normalisePhone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || /^[0\-\s]+$/.test(trimmed)) return null;
  return trimmed;
}

export interface ParsedRestaurantUrl {
  publicId: string;
  slug: string;
  /** Present when the URL carries `?aid=`. Listing pages also have a search area. */
  locationId: string | null;
}

/**
 * Public restaurant id is the number in `/restaurant/{id}/{slug}`.
 * `aid` is a location id (1280 is Dubai World Trade Center, and it is in the catalogue).
 */
export function parseRestaurantUrl(value: unknown): ParsedRestaurantUrl | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const match = url.pathname.match(/\/restaurant\/(\d+)\/([^/?#]+)\/?$/);
  if (!match) return null;
  const publicId = canonicalNumericId(match[1]);
  if (!publicId) return null;
  let slug = match[2];
  try {
    slug = decodeURIComponent(slug);
  } catch {
    return null;
  }
  slug = normaliseLabel(slug);
  if (!slug) return null;
  const aid = url.searchParams.get('aid');
  return { publicId, slug, locationId: aid ? canonicalNumericId(aid) : null };
}

export function parseCoordinate(value: unknown, min: number, max: number): number | null {
  const parsed = finiteNumber(value);
  if (parsed === null || parsed < min || parsed > max) return null;
  return parsed;
}

/**
 * `category_id` is reused inside a single menu for sections with different names
 * (60 menus). The id alone cannot be the key. The name is part of the identity,
 * hashed so emoji and punctuation don't have to be escaped into the _id.
 */
export function categoryKey(publicId: string, providerCategoryId: string, name: string): string {
  const hash = createHash('sha256').update(normaliseLabel(name)).digest('hex').slice(0, 16);
  return `${publicId}:${providerCategoryId}:${hash}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
