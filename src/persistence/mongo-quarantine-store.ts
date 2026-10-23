import { Db } from 'mongodb';
import { QuarantineStore, QuarantinePage, QuarantineRecord } from '../core/ports/quarantine-store';
import { QuarantineDecision } from '../core/pipeline/types';

interface QuarantineDocument extends QuarantineRecord {
  _id: string;
}

export class MongoQuarantineStore extends QuarantineStore {
  constructor(private readonly db: Db) {
    super();
  }

  private collection() {
    return this.db.collection<QuarantineDocument>('quarantine');
  }

  async ensureIndexes(): Promise<void> {
    await this.collection().createIndex({ runId: 1, sourceId: 1, stage: 1 }, { unique: true });
    await this.collection().createIndex({ runId: 1, createdAt: 1 });
  }

  async upsertMany(runId: string, jobId: string, decisions: QuarantineDecision[]): Promise<void> {
    if (decisions.length === 0) return;
    const now = new Date();
    await this.collection().bulkWrite(
      decisions.map((decision) => ({
        updateOne: {
          filter: { runId, sourceId: decision.sourceId, stage: decision.stage },
          update: {
            $setOnInsert: {
              runId,
              jobId,
              sourceId: decision.sourceId,
              collection: decision.collection,
              stage: decision.stage,
              reason: decision.reason,
              createdAt: now,
            },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  async list(runId: string, skip: number, limit: number): Promise<QuarantinePage> {
    const filter = { runId };
    const [total, docs] = await Promise.all([
      this.collection().countDocuments(filter),
      this.collection().find(filter).sort({ createdAt: 1, sourceId: 1 }).skip(skip).limit(limit).toArray(),
    ]);
    return {
      total,
      errors: docs.map((doc) => ({
        runId: doc.runId,
        jobId: doc.jobId,
        sourceId: doc.sourceId,
        collection: doc.collection,
        stage: doc.stage,
        reason: doc.reason,
        createdAt: doc.createdAt,
      })),
    };
  }
}
