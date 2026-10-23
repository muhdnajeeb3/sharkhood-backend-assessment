import { EJSON } from 'bson';
import { Db, MongoClient, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Enqueue } from '../../src/queue/batch.runner';
import { BatchRunner } from '../../src/queue/batch.runner';
import { batchJobId, BatchJobData } from '../../src/queue/batch-job';
import { MongoDomainStore } from '../../src/persistence/mongo-domain-store';
import { MongoQuarantineStore } from '../../src/persistence/mongo-quarantine-store';
import { MongoRawReader } from '../../src/persistence/mongo-raw-reader';
import { MongoRunStore } from '../../src/persistence/mongo-run-store';
import { xbyteAdapter } from '../../src/providers/xbyte/xbyte.adapter';

const silent = { info() {}, error() {} };

describe('factory pipeline', () => {
  let memory: MongoMemoryServer;
  let client: MongoClient;
  let rawDb: Db;
  let domainDb: Db;

  beforeAll(async () => {
    memory = await MongoMemoryServer.create();
    client = new MongoClient(memory.getUri());
    await client.connect();
    rawDb = client.db('provider_raw');
    domainDb = client.db('provider_domain');
  });

  afterAll(async () => {
    await client.close();
    await memory.stop();
  });

  beforeEach(async () => {
    await rawDb.dropDatabase();
    await domainDb.dropDatabase();
  });

  it('chains batches, quarantines bad documents, and stays put when the same input is applied again', async () => {
    const newerMenuId = new ObjectId();
    const olderMenuId = new ObjectId();
    const newerAt = new Date('2026-09-14T06:00:00.000Z');
    const olderAt = new Date('2026-09-14T04:00:00.000Z');

    await rawDb.collection('locations').insertMany([
      locationDoc(new ObjectId(), new Date('2026-09-14T04:00:00.000Z'), [
        { location_id: 1560, location_name: 'Al Soor', location_slug: 'al-soor' },
        { location_id: 6831, location_name: 'Al  Soor', location_slug: 'al-soor' },
      ]),
      locationDoc(new ObjectId(), new Date('2026-09-14T05:00:00.000Z'), [
        { location_id: 1560, location_name: 'Al Soor East', location_slug: 'al-soor' },
        { location_id: 1916, location_name: 'Industrial Area', location_slug: 'industrial-area' },
      ]),
      locationDoc(new ObjectId(), new Date('2026-09-14T05:30:00.000Z'), [
        { location_id: 5625, location_name: 'Industrial Area', location_slug: 'industrial-area' },
      ]),
    ]);

    await rawDb.collection('restaurants').insertMany([
      listingDoc(new ObjectId(), new Date('2026-09-14T05:00:00.000Z'), '1468', [
        row(200, 'sla', '1468', 'Sla'),
        row(200, 'sla', '1468', 'Sla'),
        row(201, 'other', '1468', 'Other'),
        { area_name: 'Al Zaab', restaurant_name: 'Broken', restaurant_url: 'https://example.com/nope' },
      ]),
      listingDoc(new ObjectId(), new Date('2026-09-14T05:10:00.000Z'), '1461', [row(200, 'sla', '1461', 'Sla')]),
    ]);

    await rawDb.collection('menus').insertMany([
      menuDoc(newerMenuId, newerAt, 100, 'Menu Name', [
        { category_id: 50, category_name: 'Mains', items: [menuItem(7, 'Soup')] },
      ]),
      menuDoc(olderMenuId, olderAt, 100, 'Old Name', [
        { category_id: 50, category_name: 'Mains', items: [menuItem(7, 'Soup old')] },
        { category_id: 51, category_name: 'Sides', items: [menuItem(8, 'Fries')] },
      ]),
      {
        _id: new ObjectId(),
        domain: 'talabat',
        createdAt: newerAt,
        updatedAt: newerAt,
        params: { restaurant_url: 'https://www.talabat.com/uae/restaurant/300/bad?aid=1280' },
        payload: { Message: 'This is not restaurant page (Talabat).' },
      },
      menuDoc(new ObjectId(), newerAt, 55, 'Mismatch', [], 'https://www.talabat.com/uae/restaurant/400/mismatch?aid=1280'),
    ]);

    const first = await drain(rawDb, domainDb, 2);
    expect(first.status).toBe('completed');
    expect(first.counters.read).toBe(9);
    expect(first.counters.transformed).toBe(7);
    expect(first.counters.failed).toBe(3);

    const locations = await domainDb.collection('locations').find().sort({ _id: 1 }).toArray();
    expect(locations.map((doc) => String(doc._id))).toEqual(['1560', '1916', '5625', '6831']);
    expect(locations.find((doc) => String(doc._id) === '1560')?.name).toBe('Al Soor East');
    expect(locations.find((doc) => String(doc._id) === '6831')?.name).toBe('Al Soor');

    const restaurant = await domainDb.collection('restaurants').findOne({ _id: '100' } as never);
    expect(restaurant?.name).toBe('Menu Name');
    expect(restaurant?.vendorId).toBe('999');
    expect(restaurant?.phone).toBeNull();
    expect(restaurant?.deliveryFee).toBe(6.5);
    expect(restaurant?.coordinates).toEqual({ type: 'Point', coordinates: [55.27, 25.2] });

    const areas = await domainDb.collection('restaurant_service_areas').find().sort({ _id: 1 }).toArray();
    expect(areas.map((doc) => String(doc._id))).toEqual(['100:1280', '200:1461', '200:1468', '201:1468']);

    const items = await domainDb.collection('menu_items').find().toArray();
    expect(items.map((doc) => doc.itemId)).toEqual(['7']);
    expect(await domainDb.collection('menu_categories').countDocuments()).toBe(1);
    expect(await domainDb.collection('menu_placements').countDocuments()).toBe(1);

    const quarantined = await domainDb.collection('quarantine').find().sort({ reason: 1 }).toArray();
    expect(quarantined.map((doc) => doc.reason)).toEqual([
      'outletCode 55 does not match url id 400',
      'provider: This is not restaurant page (Talabat).',
      'restaurant_url has no public id',
    ]);

    const before = await snapshot(domainDb);
    const counters = first.counters;
    await drain(rawDb, domainDb, 2);
    expect(await snapshot(domainDb)).toBe(before);

    // Replaying the opening page of the first run must not move its counters.
    const reader = new MongoRawReader(rawDb);
    const domain = new MongoDomainStore(domainDb);
    const runs = new MongoRunStore(domainDb);
    const quarantine = new MongoQuarantineStore(domainDb);
    const runner = new BatchRunner({
      adapter: xbyteAdapter,
      raw: reader,
      domain,
      runs,
      quarantine,
      attempts: 3,
      backoffMs: 100,
      logger: silent,
      enqueue: async () => {
        throw new Error('Job already exists');
      },
    });
    await runner.run({ runId: first.id, collection: 'locations', afterId: null, limit: 2 }, batchJobId(first.id, 'locations', null));
    const rerun = await runs.get(first.id);
    expect(rerun?.counters).toEqual(counters);
    expect(await snapshot(domainDb)).toBe(before);
  });
});

async function drain(rawDb: Db, domainDb: Db, batchSize: number) {
  const domain = new MongoDomainStore(domainDb);
  const runs = new MongoRunStore(domainDb);
  const quarantine = new MongoQuarantineStore(domainDb);
  await domain.ensureIndexes();
  await quarantine.ensureIndexes();
  await runs.ensureIndexes();

  const pending: BatchJobData[] = [];
  const seen = new Set<string>();
  const enqueue: Enqueue = async (data, jobId) => {
    if (seen.has(jobId)) throw new Error(`Job ${jobId} already exists`);
    seen.add(jobId);
    pending.push(data);
  };
  const runner = new BatchRunner({
    adapter: xbyteAdapter,
    raw: new MongoRawReader(rawDb),
    domain,
    runs,
    quarantine,
    enqueue,
    attempts: 5,
    backoffMs: 1000,
    logger: silent,
  });

  const run = await runs.create({
    provider: 'xbyte',
    collections: ['locations', 'restaurants', 'menus'],
    batchSize,
    limitPerCollection: null,
  });
  for (const collection of run.collections) {
    await enqueue({ runId: run.id, collection, afterId: null, limit: batchSize }, batchJobId(run.id, collection, null), 5, 1000);
  }
  while (pending.length > 0) {
    const job = pending.shift()!;
    await runner.run(job, batchJobId(job.runId, job.collection, job.afterId));
  }
  const finished = await runs.get(run.id);
  if (!finished) throw new Error('run disappeared');
  return finished;
}

async function snapshot(db: Db): Promise<string> {
  const names = ['locations', 'restaurants', 'restaurant_service_areas', 'menu_categories', 'menu_items', 'menu_placements'];
  const dumped: Record<string, unknown[]> = {};
  for (const name of names) {
    dumped[name] = await db.collection(name).find().sort({ _id: 1 }).toArray();
  }
  return EJSON.stringify(dumped);
}

function locationDoc(id: ObjectId, updatedAt: Date, results: unknown[]) {
  return { _id: id, domain: 'talabat', createdAt: updatedAt, updatedAt, payload: { results } };
}

function listingDoc(id: ObjectId, updatedAt: Date, areaId: string, results: unknown[]) {
  return {
    _id: id,
    domain: 'talabat',
    createdAt: updatedAt,
    updatedAt,
    params: { areaId, areaSlug: 'area', domain: 'talabat', page_no: 0 },
    payload: { 'Total Page': 1, results },
  };
}

function row(id: number, slug: string, aid: string, name: string) {
  return {
    area_name: 'Area',
    restaurant_name: name,
    restaurant_url: `https://www.talabat.com/uae/restaurant/${id}/${slug}?aid=${aid}`,
  };
}

function menuItem(id: number, name: string) {
  return { item_id: id, item_name: name, description: 'Hot', price: 0, rating: 0, image: null };
}

function menuDoc(
  id: ObjectId,
  updatedAt: Date,
  outletCode: number,
  name: string,
  category: unknown[],
  url = 'https://www.talabat.com/uae/restaurant/100/menu-name?aid=1280',
) {
  return {
    _id: id,
    domain: 'talabat',
    createdAt: updatedAt,
    updatedAt,
    params: { restaurant_url: url },
    payload: {
      results: [
        {
          id: 999,
          outletCode,
          name,
          logo: '',
          latitude: '25.20',
          longitude: '55.27',
          rate: 4.5,
          totalReviews: 10,
          totalRatings: 12,
          deliveryFee: '6.5',
          DeliveryTime: '25-40 mins',
          'Minimum Order': 15,
          'Restaurant Address': '1 Test Street',
          City: 'Dubai',
          Contact: '00000-00000',
          category,
        },
      ],
    },
  };
}
