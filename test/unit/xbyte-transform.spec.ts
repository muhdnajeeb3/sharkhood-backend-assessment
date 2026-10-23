import { PipelineOutcome, RawDocument } from '../../src/core/pipeline/types';
import { transformDocument } from '../../src/providers/xbyte/transform';

const WHEN = new Date('2026-09-14T05:00:00.000Z');

function raw(overrides: Partial<RawDocument> & Pick<RawDocument, 'payload'>): RawDocument {
  return {
    _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    domain: 'talabat',
    createdAt: WHEN,
    updatedAt: WHEN,
    ...overrides,
  };
}

function writes(outcome: PipelineOutcome, collection: string) {
  return outcome.writes.filter((write) => write.collection === collection);
}

describe('xbyte transform', () => {
  it('keeps two locations that share a slug, and collapses the double space in the name', () => {
    const outcome = transformDocument(
      'locations',
      raw({
        payload: {
          results: [
            { location_id: 1594, location_name: 'Al  Muntazah', location_slug: 'al-muntazah' },
            { location_id: 5599, location_name: 'Al Muntazah', location_slug: 'al-muntazah' },
          ],
        },
      }),
    );
    expect(outcome.accepted).toBe(true);
    expect(outcome.quarantines).toHaveLength(0);
    const locations = writes(outcome, 'locations');
    expect(locations.map((row) => row.id).sort()).toEqual(['1594', '5599']);
    expect(locations.map((row) => row.fields.name).sort()).toEqual(['Al Muntazah', 'Al Muntazah']);
  });

  it('treats a repeated listing url as one restaurant and quarantines a url with no id', () => {
    const outcome = transformDocument(
      'restaurants',
      raw({
        params: { areaId: '1468', areaSlug: 'al-zaab' },
        payload: {
          results: [
            {
              area_name: 'Al Zaab',
              restaurant_name: 'Sla',
              restaurant_url: 'https://www.talabat.com/uae/restaurant/200/sla?aid=1468',
            },
            {
              area_name: 'Al Zaab',
              restaurant_name: 'Sla',
              restaurant_url: 'https://www.talabat.com/uae/restaurant/200/sla?aid=1468',
            },
            {
              area_name: 'Al Zaab',
              restaurant_name: 'Broken',
              restaurant_url: 'https://example.com/not-a-restaurant',
            },
          ],
        },
      }),
    );
    expect(outcome.accepted).toBe(true);
    expect(outcome.skipped).toBe(1);
    expect(outcome.quarantines).toHaveLength(1);
    expect(outcome.quarantines[0]?.reason).toMatch(/public id/);
    expect(writes(outcome, 'restaurants')).toHaveLength(1);
    expect(writes(outcome, 'restaurant_service_areas').map((row) => row.id)).toEqual(['200:1468']);
  });

  it('quarantines an empty listing page and ignores error:false when rows are present', () => {
    const empty = transformDocument(
      'restaurants',
      raw({
        params: { areaId: '1468' },
        payload: { 'Total Page': 1, 'Page Error Message': 'Page limit exceeded.', results: [] },
      }),
    );
    expect(empty.accepted).toBe(false);
    expect(empty.quarantines[0]?.reason).toBe('provider: Page limit exceeded.');

    const blankError = transformDocument(
      'restaurants',
      raw({ params: { areaId: '1468' }, payload: { error: '' } }),
    );
    expect(blankError.accepted).toBe(false);

    const flag = transformDocument(
      'restaurants',
      raw({
        params: { areaId: '1468' },
        payload: {
          error: false,
          results: [
            {
              area_name: 'Al Zaab',
              restaurant_name: 'Sla',
              restaurant_url: 'https://www.talabat.com/uae/restaurant/200/sla?aid=1468',
            },
          ],
        },
      }),
    );
    expect(flag.accepted).toBe(true);
    expect(flag.quarantines).toHaveLength(0);
  });

  it('keys the menu on outletCode, nulls the placeholder phone, and splits a shared item into placements', () => {
    const outcome = transformDocument(
      'menus',
      raw({
        params: {
          restaurant_url: 'https://www.talabat.com/uae/restaurant/100/bombay-box?aid=1280',
        },
        payload: {
          results: [
            {
              id: 999,
              outletCode: 100,
              name: 'Bombay Box',
              logo: '',
              latitude: '25.20',
              longitude: '55.27',
              rate: 4,
              totalReviews: 3,
              totalRatings: 8,
              deliveryFee: '6.5',
              DeliveryTime: '25-40 mins',
              'Minimum Order': 15,
              'Restaurant Address': 'Business Bay',
              City: 'Dubai',
              Contact: '00000-00000',
              category: [
                {
                  category_id: 50,
                  category_name: 'Picks',
                  items: [item(1, 'Soup'), item(2, 'Bread')],
                },
                {
                  category_id: 50,
                  category_name: 'Mains',
                  items: [item(1, 'Soup'), item(3, 'Rice')],
                },
              ],
            },
          ],
        },
      }),
    );

    expect(outcome.accepted).toBe(true);
    expect(outcome.skipped).toBe(1);
    const profile = writes(outcome, 'restaurants')[0];
    expect(profile?.id).toBe('100');
    expect(profile?.fields.vendorId).toBe('999');
    expect(profile?.fields.phone).toBeNull();
    expect(profile?.fields.deliveryFee).toBe(6.5);
    expect(profile?.fields.coordinates).toEqual({ type: 'Point', coordinates: [55.27, 25.2] });
    expect(writes(outcome, 'menu_categories')).toHaveLength(2);
    expect(writes(outcome, 'menu_items')).toHaveLength(3);
    expect(writes(outcome, 'menu_placements')).toHaveLength(4);
    const soup = writes(outcome, 'menu_items').find((row) => row.fields.itemId === '1');
    expect(soup?.fields.price).toBe(0);
    expect(soup?.fields.imageUrl).toBeNull();
    expect(writes(outcome, 'restaurant_service_areas')[0]?.id).toBe('100:1280');
  });

  it('quarantines a provider message and a menu whose outletCode does not match the url', () => {
    const message = transformDocument(
      'menus',
      raw({
        params: { restaurant_url: 'https://www.talabat.com/uae/restaurant/100/x?aid=1280' },
        payload: { Message: 'This is not restaurant page (Talabat).' },
      }),
    );
    expect(message.accepted).toBe(false);
    expect(message.writes).toHaveLength(0);
    expect(message.quarantines[0]?.reason).toMatch(/not restaurant page/);

    const mismatch = transformDocument(
      'menus',
      raw({
        params: { restaurant_url: 'https://www.talabat.com/uae/restaurant/100/x?aid=1280' },
        payload: { results: [{ ...profileShell(), outletCode: 55, id: 1 }] },
      }),
    );
    expect(mismatch.accepted).toBe(false);
    expect(mismatch.quarantines[0]?.reason).toMatch(/outletCode/);
  });
});

function item(id: number, name: string) {
  return {
    item_id: id,
    item_name: name,
    description: '  ',
    price: 0,
    rating: 0,
    image: null,
  };
}

function profileShell() {
  return {
    name: 'X',
    logo: '',
    latitude: '25.2',
    longitude: '55.2',
    rate: 1,
    totalReviews: 0,
    totalRatings: 0,
    deliveryFee: '1',
    DeliveryTime: '30 mins',
    'Minimum Order': 0,
    'Restaurant Address': 'A',
    City: 'Dubai',
    Contact: '00000-00000',
    category: [],
  };
}
