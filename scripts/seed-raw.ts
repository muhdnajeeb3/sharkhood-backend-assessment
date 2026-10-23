import 'dotenv/config';
import { readFile } from 'fs/promises';
import path from 'path';
import { EJSON } from 'bson';
import { Document, MongoClient } from 'mongodb';

const FILES: Record<string, string> = {
  locations: 'locations.json',
  restaurants: 'restaurants.json',
  menus: 'menus.json',
};

// The factory pages with a cursor. This script is the load tool for the sample
// files, which are one JSON array each. We insert in batches and drop the
// array before opening the next file.
const BATCH = 200;

async function main(): Promise<void> {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error('MONGO_URI is not set. Copy .env.example to .env first.');
  }
  const dbName = process.env.RAW_DB || 'provider_raw';
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db(dbName);
    for (const [collection, fileName] of Object.entries(FILES)) {
      const file = path.resolve(process.cwd(), 'data/raw', fileName);
      const parsed = EJSON.parse(await readFile(file, 'utf8')) as Document[];
      if (!Array.isArray(parsed)) throw new Error(`${fileName} is not a JSON array`);
      try {
        await db.dropCollection(collection);
      } catch (err) {
        const code = (err as { codeName?: string }).codeName;
        if (code !== 'NamespaceNotFound') throw err;
      }
      const col = db.collection(collection);
      for (let offset = 0; offset < parsed.length; offset += BATCH) {
        const slice = parsed.slice(offset, offset + BATCH);
        if (slice.length > 0) await col.insertMany(slice, { ordered: false });
      }
      const count = await col.countDocuments();
      console.log(JSON.stringify({ message: 'seeded', collection, documents: count }));
    }
  } finally {
    await client.close();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify({ message: 'seed failed', error: message.replace(/mongodb(\+srv)?:\/\/\S+/gi, 'mongodb://redacted') }));
  process.exit(1);
});
