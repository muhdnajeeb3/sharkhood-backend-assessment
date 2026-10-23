import {
  DomainWrite,
  PipelineOutcome,
  QuarantineDecision,
  RawDocument,
  SourceRank,
  rejectDocument,
} from '../../core/pipeline/types';
import {
  canonicalNumericId,
  categoryKey,
  documentRank,
  isRecord,
  normaliseLabel,
  parseCoordinate,
  parseRestaurantUrl,
  rawId,
} from './identity';
import {
  applyFieldMap,
  listingFieldMap,
  locationFieldMap,
  menuItemFieldMap,
  menuProfileFieldMap,
} from './mapping';

interface LocationRow {
  locationId: string;
  name: string;
  slug: string;
}

interface ListingRow {
  publicId: string;
  name: string;
  slug: string;
}

interface MenuItem {
  itemId: string;
  name: string;
  description: string | null;
  price: number;
  rating: number;
  imageUrl: string | null;
}

interface MenuCategory {
  providerCategoryId: string;
  name: string;
  position: number;
  items: Array<{ item: MenuItem; position: number }>;
}

interface MenuProfile {
  publicId: string;
  slug: string;
  locationId: string;
  vendorId: string;
  name: string;
  logoUrl: string | null;
  city: string | null;
  address: string | null;
  phone: string | null;
  rating: number;
  reviewCount: number;
  ratingCount: number;
  deliveryFee: number;
  deliveryTimeLabel: string;
  minimumOrder: number;
  /** GeoJSON axis order is longitude, latitude. The payload stores them the other way round. */
  coordinates: { type: 'Point'; coordinates: [number, number] };
}

/**
 * Fixed stage order for every collection. Provider-specific work is the body
 * of each stage; the runner does not know field names.
 */
export function transformDocument(collection: string, doc: RawDocument): PipelineOutcome {
  switch (collection) {
    case 'locations':
      return transformLocations(doc);
    case 'restaurants':
      return transformListings(doc);
    case 'menus':
      return transformMenu(doc);
    default:
      throw new Error(`No xbyte pipeline for collection "${collection}"`);
  }
}

function transformLocations(doc: RawDocument): PipelineOutcome {
  const validated = validateEnvelope(doc, 'locations');
  if (!validated.ok) return validated.outcome;

  const results = resultsArray(validated.payload);
  if (!results) {
    return rejectDocument(validated.rank.sourceId, 'locations', 'validate', 'location payload has no results array');
  }

  const quarantines: QuarantineDecision[] = [];
  const rows: LocationRow[] = [];
  results.forEach((row, index) => {
    if (!isRecord(row)) {
      quarantines.push(child(validated, 'locations', `row:${index}`, 'location row is not an object'));
      return;
    }
    const mapped = applyFieldMap(row, locationFieldMap);
    if (!mapped.ok) {
      quarantines.push(child(validated, 'locations', `row:${index}`, mapped.reason));
      return;
    }
    rows.push({
      locationId: mapped.value.locationId as string,
      name: mapped.value.name as string,
      slug: mapped.value.slug as string,
    });
  });

  if (rows.length === 0) {
    return rejectDocument(
      validated.rank.sourceId,
      'locations',
      'validate',
      quarantines[0]?.reason ?? 'location payload has no usable rows',
    );
  }

  const deduped = dedupeBy(rows, (row) => row.locationId);
  return accept(quarantines, projectLocations(validated, deduped.value), deduped.skipped);
}

function transformListings(doc: RawDocument): PipelineOutcome {
  const validated = validateEnvelope(doc, 'restaurants');
  if (!validated.ok) return validated.outcome;

  const failure = listingFailure(validated.payload);
  const results = resultsArray(validated.payload) ?? [];
  if (failure || results.length === 0) {
    return rejectDocument(
      validated.rank.sourceId,
      'restaurants',
      'validate',
      failure ? `provider: ${failure}` : 'listing page contained no restaurant rows',
    );
  }

  const areaId = isRecord(validated.params) ? canonicalNumericId(validated.params.areaId) : null;
  if (!areaId) {
    return rejectDocument(validated.rank.sourceId, 'restaurants', 'validate', 'listing page has no numeric areaId');
  }

  const quarantines: QuarantineDecision[] = [];
  const rows: ListingRow[] = [];
  results.forEach((row, index) => {
    if (!isRecord(row)) {
      quarantines.push(child(validated, 'restaurants', `row:${index}`, 'listing row is not an object'));
      return;
    }
    const mapped = applyFieldMap(row, listingFieldMap);
    if (!mapped.ok) {
      quarantines.push(child(validated, 'restaurants', `row:${index}`, mapped.reason));
      return;
    }
    const parsed = parseRestaurantUrl(mapped.value.url);
    if (!parsed) {
      quarantines.push(child(validated, 'restaurants', `row:${index}`, 'restaurant_url has no public id'));
      return;
    }
    // The row's ?aid= matched params.areaId on every sample row. A disagreement
    // means we would be guessing which location the listing was fetched for.
    if (parsed.locationId && parsed.locationId !== areaId) {
      quarantines.push(child(validated, 'restaurants', `row:${index}`, `url aid ${parsed.locationId} does not match areaId ${areaId}`));
      return;
    }
    rows.push({ publicId: parsed.publicId, name: mapped.value.name as string, slug: parsed.slug });
  });

  if (rows.length === 0) {
    return rejectDocument(
      validated.rank.sourceId,
      'restaurants',
      'normalise',
      quarantines[0]?.reason ?? 'listing page contained no usable restaurants',
    );
  }

  const deduped = dedupeBy(rows, (row) => row.publicId);
  return accept(quarantines, projectListings(validated, areaId, deduped.value), deduped.skipped);
}

function transformMenu(doc: RawDocument): PipelineOutcome {
  const validated = validateEnvelope(doc, 'menus');
  if (!validated.ok) return validated.outcome;

  const message = typeof validated.payload.Message === 'string' ? validated.payload.Message.trim() : '';
  if (message) {
    // statusCode on these documents is still 200. The message is the real signal.
    return rejectDocument(validated.rank.sourceId, 'menus', 'validate', `provider: ${message}`);
  }

  const results = resultsArray(validated.payload);
  const profileRow = results && results.length === 1 && isRecord(results[0]) ? results[0] : null;
  if (!profileRow) {
    return rejectDocument(validated.rank.sourceId, 'menus', 'validate', 'menu payload has no restaurant profile');
  }

  const url = isRecord(validated.params) ? parseRestaurantUrl(validated.params.restaurant_url) : null;
  if (!url || !url.locationId) {
    return rejectDocument(validated.rank.sourceId, 'menus', 'validate', 'menu restaurant_url is missing a public id or aid');
  }

  const mapped = applyFieldMap(profileRow, menuProfileFieldMap);
  if (!mapped.ok) {
    return rejectDocument(validated.rank.sourceId, 'menus', 'normalise', mapped.reason);
  }

  // `id` inside the body never matched the URL (0/345). `outletCode` matched it
  // every time. The URL id is what listings use, so that is the restaurant key.
  // If a future export breaks the match we quarantine instead of picking a side.
  const outletCode = canonicalNumericId(profileRow.outletCode);
  if (!outletCode || outletCode !== url.publicId) {
    return rejectDocument(
      validated.rank.sourceId,
      'menus',
      'validate',
      `outletCode ${String(profileRow.outletCode)} does not match url id ${url.publicId}`,
    );
  }

  const latitude = parseCoordinate(profileRow.latitude, -90, 90);
  const longitude = parseCoordinate(profileRow.longitude, -180, 180);
  if (latitude === null || longitude === null) {
    return rejectDocument(validated.rank.sourceId, 'menus', 'normalise', 'latitude/longitude are not usable coordinates');
  }

  const fee = mapped.value.deliveryFee as number;
  const minimumOrder = mapped.value.minimumOrder as number;
  if (fee < 0 || minimumOrder < 0) {
    return rejectDocument(validated.rank.sourceId, 'menus', 'normalise', 'delivery fee or minimum order is negative');
  }

  const profile: MenuProfile = {
    publicId: url.publicId,
    slug: url.slug,
    locationId: url.locationId,
    vendorId: mapped.value.vendorId as string,
    name: mapped.value.name as string,
    logoUrl: mapped.value.logoUrl as string | null,
    city: mapped.value.city as string | null,
    address: mapped.value.address as string | null,
    phone: mapped.value.phone as string | null,
    rating: mapped.value.rating as number,
    reviewCount: mapped.value.reviewCount as number,
    ratingCount: mapped.value.ratingCount as number,
    deliveryFee: fee,
    deliveryTimeLabel: mapped.value.deliveryTimeLabel as string,
    minimumOrder,
    coordinates: { type: 'Point', coordinates: [longitude, latitude] },
  };

  const quarantines: QuarantineDecision[] = [];
  const categories: MenuCategory[] = [];
  const rawCategories = Array.isArray(profileRow.category) ? profileRow.category : null;
  if (!rawCategories) {
    return rejectDocument(validated.rank.sourceId, 'menus', 'validate', 'menu profile has no category array');
  }

  rawCategories.forEach((rawCategory, categoryIndex) => {
    if (!isRecord(rawCategory)) {
      quarantines.push(child(validated, 'menus', `category:${categoryIndex}`, 'category is not an object'));
      return;
    }
    const providerCategoryId = canonicalNumericId(rawCategory.category_id);
    const name = typeof rawCategory.category_name === 'string' ? normaliseLabel(rawCategory.category_name) : '';
    if (!providerCategoryId || !name) {
      quarantines.push(child(validated, 'menus', `category:${categoryIndex}`, 'category is missing an id or a name'));
      return;
    }
    const items: MenuCategory['items'] = [];
    const rawItems = Array.isArray(rawCategory.items) ? rawCategory.items : [];
    rawItems.forEach((rawItem, itemIndex) => {
      if (!isRecord(rawItem)) {
        quarantines.push(child(validated, 'menus', `item:${categoryIndex}:${itemIndex}`, `item in category ${providerCategoryId} is not an object`));
        return;
      }
      const itemMapped = applyFieldMap(rawItem, menuItemFieldMap);
      if (!itemMapped.ok) {
        quarantines.push(child(validated, 'menus', `item:${categoryIndex}:${itemIndex}`, `${itemMapped.reason} (category ${providerCategoryId})`));
        return;
      }
      const price = itemMapped.value.price as number;
      const rating = itemMapped.value.rating as number;
      if (price < 0 || rating < 0) {
        quarantines.push(child(validated, 'menus', `item:${categoryIndex}:${itemIndex}`, `negative price or rating on item ${String(itemMapped.value.itemId)}`));
        return;
      }
      items.push({
        position: itemIndex,
        item: {
          itemId: itemMapped.value.itemId as string,
          name: itemMapped.value.name as string,
          description: itemMapped.value.description as string | null,
          price,
          rating,
          imageUrl: itemMapped.value.imageUrl as string | null,
        },
      });
    });
    categories.push({ providerCategoryId, name, position: categoryIndex, items });
  });

  const deduped = dedupeMenu(categories);
  return accept(quarantines, projectMenu(validated, profile, deduped.categories), deduped.skipped);
}

function projectLocations(validated: Validated, rows: LocationRow[]): DomainWrite[] {
  return rows.map((row) => ({
    kind: 'replace' as const,
    collection: 'locations',
    id: row.locationId,
    rank: validated.rank,
    fields: { locationId: row.locationId, name: row.name, slug: row.slug, channel: validated.channel },
  }));
}

function projectListings(validated: Validated, areaId: string, rows: ListingRow[]): DomainWrite[] {
  const writes: DomainWrite[] = [];
  for (const row of rows) {
    writes.push({
      kind: 'listing',
      collection: 'restaurants',
      id: row.publicId,
      rank: validated.rank,
      fields: { publicId: row.publicId, channel: validated.channel, name: row.name, slug: row.slug },
    });
    writes.push(serviceArea(validated, row.publicId, areaId));
  }
  return writes;
}

function projectMenu(validated: Validated, profile: MenuProfile, categories: MenuCategory[]): DomainWrite[] {
  const writes: DomainWrite[] = [
    {
      kind: 'menu-profile',
      collection: 'restaurants',
      id: profile.publicId,
      rank: validated.rank,
      fields: {
        publicId: profile.publicId,
        channel: validated.channel,
        slug: profile.slug,
        name: profile.name,
        vendorId: profile.vendorId,
        logoUrl: profile.logoUrl,
        city: profile.city,
        address: profile.address,
        phone: profile.phone,
        rating: profile.rating,
        reviewCount: profile.reviewCount,
        ratingCount: profile.ratingCount,
        deliveryFee: profile.deliveryFee,
        deliveryTimeLabel: profile.deliveryTimeLabel,
        minimumOrder: profile.minimumOrder,
        coordinates: profile.coordinates,
      },
    },
    serviceArea(validated, profile.publicId, profile.locationId),
  ];

  const emittedItems = new Set<string>();
  for (const category of categories) {
    const key = categoryKey(profile.publicId, category.providerCategoryId, category.name);
    writes.push({
      kind: 'replace',
      collection: 'menu_categories',
      id: key,
      rank: validated.rank,
      fields: {
        restaurantPublicId: profile.publicId,
        providerCategoryId: category.providerCategoryId,
        name: category.name,
        position: category.position,
        channel: validated.channel,
      },
    });
    for (const entry of category.items) {
      const itemKey = `${profile.publicId}:${entry.item.itemId}`;
      // One item row even when the item is filed under several sections.
      // The extra occurrences were already counted as skipped.
      if (!emittedItems.has(itemKey)) {
        emittedItems.add(itemKey);
        writes.push({
          kind: 'replace',
          collection: 'menu_items',
          id: itemKey,
          rank: validated.rank,
          fields: {
            restaurantPublicId: profile.publicId,
            itemId: entry.item.itemId,
            name: entry.item.name,
            description: entry.item.description,
            price: entry.item.price,
            rating: entry.item.rating,
            imageUrl: entry.item.imageUrl,
            channel: validated.channel,
          },
        });
      }
      writes.push({
        kind: 'replace',
        collection: 'menu_placements',
        id: `${key}:${entry.item.itemId}`,
        rank: validated.rank,
        fields: {
          restaurantPublicId: profile.publicId,
          categoryKey: key,
          itemId: entry.item.itemId,
          position: entry.position,
          channel: validated.channel,
        },
      });
    }
  }
  return writes;
}

/**
 * The same item is often filed under two sections (2,266 items in the sample)
 * with an identical payload. Keep one item and both placements.
 * A repeated category id with a different name stays two categories; the key
 * includes the name. A repeated item inside one category is dropped.
 */
function dedupeMenu(categories: MenuCategory[]): { categories: MenuCategory[]; skipped: number } {
  const seenItems = new Set<string>();
  let skipped = 0;
  const next = categories.map((category) => {
    const seenInCategory = new Set<string>();
    const items = [];
    for (const entry of category.items) {
      if (seenInCategory.has(entry.item.itemId)) {
        skipped += 1;
        continue;
      }
      seenInCategory.add(entry.item.itemId);
      if (seenItems.has(entry.item.itemId)) skipped += 1;
      seenItems.add(entry.item.itemId);
      items.push(entry);
    }
    return { ...category, items };
  });

  const seenCategories = new Set<string>();
  const uniqueCategories: MenuCategory[] = [];
  for (const category of next) {
    const key = `${category.providerCategoryId}:${category.name}`;
    if (seenCategories.has(key)) {
      skipped += 1;
      continue;
    }
    seenCategories.add(key);
    uniqueCategories.push(category);
  }
  return { categories: uniqueCategories, skipped };
}

function serviceArea(validated: Validated, publicId: string, locationId: string): DomainWrite {
  return {
    kind: 'replace',
    collection: 'restaurant_service_areas',
    id: `${publicId}:${locationId}`,
    rank: validated.rank,
    fields: { restaurantPublicId: publicId, locationId, channel: validated.channel },
  };
}

function dedupeBy<T>(rows: T[], keyOf: (row: T) => string): { value: T[]; skipped: number } {
  const seen = new Set<string>();
  const value: T[] = [];
  let skipped = 0;
  for (const row of rows) {
    const key = keyOf(row);
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    value.push(row);
  }
  return { value, skipped };
}

interface Validated {
  rank: SourceRank;
  channel: string;
  payload: Record<string, unknown>;
  params: unknown;
}

function validateEnvelope(
  doc: RawDocument,
  collection: string,
): { ok: true; rank: SourceRank; channel: string; payload: Record<string, unknown>; params: unknown } | { ok: false; outcome: PipelineOutcome } {
  const sourceId = rawId(doc) ?? 'unknown';
  const rank = documentRank(doc, collection);
  if (!rank) {
    return { ok: false, outcome: rejectDocument(sourceId, collection, 'validate', 'document has no id or timestamp') };
  }
  if (typeof doc.domain !== 'string' || !doc.domain.trim()) {
    return { ok: false, outcome: rejectDocument(rank.sourceId, collection, 'validate', 'domain is missing') };
  }
  if (!isRecord(doc.payload)) {
    return { ok: false, outcome: rejectDocument(rank.sourceId, collection, 'validate', 'payload is missing') };
  }
  return { ok: true, rank, channel: doc.domain.trim(), payload: doc.payload, params: doc.params };
}

function resultsArray(payload: Record<string, unknown>): unknown[] | null {
  return Array.isArray(payload.results) ? payload.results : null;
}

/**
 * A listing page can fail while statusCode stays 200.
 * `error: false` showed up next to a normal result set (a flag, not a failure).
 * `error: ""` and "Page limit exceeded." showed up with no rows.
 * Rows win when they are present; an empty page is quarantined with the provider text.
 */
function listingFailure(payload: Record<string, unknown>): string | null {
  const pageError = typeof payload['Page Error Message'] === 'string' ? payload['Page Error Message'].trim() : '';
  const error = payload.error;
  let errorText = '';
  if (typeof error === 'string') errorText = error.trim();
  else if (error === true) errorText = 'provider error flag';
  const results = resultsArray(payload);
  if (results && results.length > 0) return null;
  return pageError || errorText || null;
}

function child(validated: Validated, collection: string, suffix: string, reason: string): QuarantineDecision {
  return {
    sourceId: `${validated.rank.sourceId}#${suffix}`,
    collection,
    stage: 'normalise',
    reason: reason.slice(0, 500),
  };
}

function accept(quarantines: QuarantineDecision[], writes: DomainWrite[], skipped: number): PipelineOutcome {
  return { accepted: true, quarantines, writes, skipped };
}
