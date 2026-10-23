import { Db, ObjectId } from 'mongodb';
import { RawReader } from '../core/ports/raw-reader';
import { RawDocument } from '../core/pipeline/types';

/**
 * One batch, one cursor. The raw database is never written.
 * `allowed` comes from the provider adapter so a bad job cannot point this at
 * some other collection in the same database.
 */
export class MongoRawReader extends RawReader {
  constructor(private readonly db: Db) {
    super();
  }

  async readBatch(
    collection: string,
    afterId: string | null,
    limit: number,
    allowed: readonly string[],
  ): Promise<RawDocument[]> {
    if (!allowed.includes(collection)) {
      throw new Error(`Refusing to read unknown collection "${collection}"`);
    }
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`Batch limit must be a positive integer, got ${limit}`);
    }
    const filter = afterId ? { _id: { $gt: new ObjectId(afterId) } } : {};
    const cursor = this.db.collection(collection).find(filter).sort({ _id: 1 }).limit(limit);
    const docs: RawDocument[] = [];
    try {
      for await (const doc of cursor) docs.push(doc as RawDocument);
    } finally {
      await cursor.close();
    }
    return docs;
  }
}
