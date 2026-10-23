import { randomUUID } from 'crypto';
import { Db } from 'mongodb';
import { RunStore, AdvanceInput, CreateRunInput } from '../core/ports/run-store';
import { RunRecord } from '../runs/run.types';

interface RunDocument extends Omit<RunRecord, 'id'> {
  _id: string;
}

export class MongoRunStore extends RunStore {
  constructor(private readonly db: Db) {
    super();
  }

  private collection() {
    return this.db.collection<RunDocument>('runs');
  }

  async ensureIndexes(): Promise<void> {
    await this.collection().createIndex({ status: 1 });
  }

  async create(input: CreateRunInput): Promise<RunRecord> {
    const progress: RunRecord['progress'] = {};
    for (const name of input.collections) {
      progress[name] = { afterId: null, read: 0, done: false };
    }
    const doc: RunDocument = {
      _id: randomUUID(),
      provider: input.provider,
      status: 'running',
      collections: input.collections,
      batchSize: input.batchSize,
      limitPerCollection: input.limitPerCollection,
      progress,
      counters: { read: 0, transformed: 0, written: 0, skipped: 0, failed: 0 },
      errorSample: [],
      startedAt: new Date(),
      finishedAt: null,
      failure: null,
    };
    await this.collection().insertOne(doc);
    return toRecord(doc);
  }

  async get(id: string): Promise<RunRecord | null> {
    const doc = await this.collection().findOne({ _id: id });
    return doc ? toRecord(doc) : null;
  }

  async findRunning(): Promise<RunRecord[]> {
    const docs = await this.collection().find({ status: 'running' }).toArray();
    return docs.map(toRecord);
  }

  async advance(input: AdvanceInput): Promise<void> {
    // Only the job that still owns this cursor may move it. Counters ride the
    // same update, so a retry whose cursor has already moved cannot double-count.
    const inc: Record<string, number> = {
      [`progress.${input.collection}.read`]: input.readDelta,
    };
    if (input.counters) {
      inc['counters.read'] = input.counters.read;
      inc['counters.transformed'] = input.counters.transformed;
      inc['counters.written'] = input.counters.written;
      inc['counters.skipped'] = input.counters.skipped;
      inc['counters.failed'] = input.counters.failed;
    }
    const update: Record<string, unknown> = {
      $set: {
        [`progress.${input.collection}.afterId`]: input.afterId,
        [`progress.${input.collection}.done`]: input.done,
      },
      $inc: inc,
    };
    if (input.errors && input.errors.length > 0) {
      update.$push = { errorSample: { $each: input.errors.slice(0, 5), $slice: -25 } };
    }
    await this.collection().updateOne(
      { _id: input.runId, [`progress.${input.collection}.afterId`]: input.expectedAfterId },
      update,
    );
  }

  async markFailed(runId: string, reason: string, jobId: string | null): Promise<void> {
    await this.collection().updateOne(
      { _id: runId, status: 'running' },
      {
        $set: {
          status: 'failed',
          finishedAt: new Date(),
          failure: { reason: reason.slice(0, 500), jobId, at: new Date() },
        },
      },
    );
  }

  async complete(runId: string): Promise<void> {
    const run = await this.get(runId);
    if (!run || run.status !== 'running') return;
    const finished = run.collections.every((name) => run.progress[name]?.done);
    if (!finished) return;
    await this.collection().updateOne(
      { _id: runId, status: 'running' },
      { $set: { status: 'completed', finishedAt: new Date() } },
    );
  }
}

function toRecord(doc: RunDocument): RunRecord {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}
