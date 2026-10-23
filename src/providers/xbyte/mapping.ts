import { canonicalNumericId, finiteNumber, normaliseLabel, normalisePhone } from './identity';

/**
 * Declarative field map for the xbyte/Talabat export.
 *
 * Names and types are not stable across the three collections, or even inside
 * one payload: `Minimum Order` has a space, `City` is capitalised, `deliveryFee`
 * is a numeric string, `rate` is sometimes an int and sometimes a float,
 * coordinates are strings. A second provider replaces this table.
 */
export type FieldCoercion = 'label' | 'number' | 'id' | 'phone' | 'optional-label';

export interface FieldMapping {
  to: string;
  from: string;
  coerce: FieldCoercion;
}

export const locationFieldMap: readonly FieldMapping[] = [
  { to: 'locationId', from: 'location_id', coerce: 'id' },
  { to: 'name', from: 'location_name', coerce: 'label' },
  { to: 'slug', from: 'location_slug', coerce: 'label' },
];

export const listingFieldMap: readonly FieldMapping[] = [
  { to: 'name', from: 'restaurant_name', coerce: 'label' },
  { to: 'url', from: 'restaurant_url', coerce: 'label' },
  { to: 'areaName', from: 'area_name', coerce: 'label' },
];

export const menuProfileFieldMap: readonly FieldMapping[] = [
  { to: 'vendorId', from: 'id', coerce: 'id' },
  { to: 'name', from: 'name', coerce: 'label' },
  { to: 'logoUrl', from: 'logo', coerce: 'optional-label' },
  { to: 'city', from: 'City', coerce: 'optional-label' },
  { to: 'address', from: 'Restaurant Address', coerce: 'optional-label' },
  { to: 'phone', from: 'Contact', coerce: 'phone' },
  { to: 'rating', from: 'rate', coerce: 'number' },
  { to: 'reviewCount', from: 'totalReviews', coerce: 'number' },
  { to: 'ratingCount', from: 'totalRatings', coerce: 'number' },
  { to: 'deliveryFee', from: 'deliveryFee', coerce: 'number' },
  { to: 'deliveryTimeLabel', from: 'DeliveryTime', coerce: 'label' },
  { to: 'minimumOrder', from: 'Minimum Order', coerce: 'number' },
];

export const menuItemFieldMap: readonly FieldMapping[] = [
  { to: 'itemId', from: 'item_id', coerce: 'id' },
  { to: 'name', from: 'item_name', coerce: 'label' },
  { to: 'description', from: 'description', coerce: 'optional-label' },
  { to: 'price', from: 'price', coerce: 'number' },
  { to: 'rating', from: 'rating', coerce: 'number' },
  { to: 'imageUrl', from: 'image', coerce: 'optional-label' },
];

export function applyFieldMap(
  source: Record<string, unknown>,
  mapping: readonly FieldMapping[],
): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  const value: Record<string, unknown> = {};
  for (const field of mapping) {
    const raw = source[field.from];
    const coerced = coerceField(field, raw);
    if (!coerced.ok) return coerced;
    value[field.to] = coerced.value;
  }
  return { ok: true, value };
}

function coerceField(
  field: FieldMapping,
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  switch (field.coerce) {
    case 'label': {
      if (typeof raw !== 'string' || !normaliseLabel(raw)) {
        return { ok: false, reason: `${field.from} is missing` };
      }
      return { ok: true, value: normaliseLabel(raw) };
    }
    case 'optional-label': {
      if (typeof raw !== 'string') return { ok: true, value: null };
      const label = normaliseLabel(raw);
      return { ok: true, value: label || null };
    }
    case 'phone':
      return { ok: true, value: normalisePhone(raw) };
    case 'id': {
      const id = canonicalNumericId(raw);
      if (!id) return { ok: false, reason: `${field.from} is not a numeric id` };
      return { ok: true, value: id };
    }
    case 'number': {
      const parsed = finiteNumber(raw);
      if (parsed === null) return { ok: false, reason: `${field.from} is not a number` };
      return { ok: true, value: parsed };
    }
    default:
      return { ok: false, reason: `unsupported coercion for ${field.from}` };
  }
}
