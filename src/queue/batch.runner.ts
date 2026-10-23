import { collapseWrites, PipelineOutcome, ProviderAdapter } from '../core/pipeline/types';
import { DomainStore } from '../core/ports/domain-store';
import { QuarantineStore } from '../core/ports/quarantine-store';
import { RawReader } from '../core/ports/raw-reader';
import { RunStore } from '../core/ports/run-store';
import { rawId } from '../providers/xbyte/identity';
import { RunCounters } from '../runs/run.types';
import { FactoryLogger, jsonLogger } from '../common/logger';
import { safeError } from '../common/safe-error';
import { BatchJobData, batchJobId, isDuplicateJobError, pageLimit } from './batch-job';

export interface Enqueue {
  (data: BatchJobData, jobId: string, attempts: number, backoffMs: number): Promise<void>;
}

export interface BatchRunnerDeps {
  adapter: ProviderAdapter;
  raw: RawReader;
  domain: DomainStore;
  runs: RunStore;
  quarantine: QuarantineStore;
  enqueue: Enqueue;
  attempts: number;
  backoffMs: number;
  logger?: FactoryLogger;
}

/**
 * One page of one raw collection.
 *
 * The job id is the run, the collection and the cursor. Writes are upserts, so
 * doing the page again is safe. Counters are incremented in the same update
 * that moves the checkpoint, and that update only matches if this job still
 * owns the cursor. A retry cannot double-count or pull the cursor backwards.
 */
export class BatchRunner {
  private readonly log: FactoryLogger;

  constructor(private readonly deps: BatchRunnerDeps) {
    this.log = deps.logger ?? jsonLogger;
  }

  async run(job: BatchJobData, jobId: string): Promise<void> {
    const run = await this.deps.runs.get(job.runId);
    if (!run) throw new Error(`Run ${job.runId} does not exist`);
    if (!this.deps.adapter.collections.includes(job.collection)) {
      throw new Error(`Provider ${this.deps.adapter.name} does not read "${job.collection}"`);
    }
    const progress = run.progress[job.collection];
    if (!progress) throw new Error(`Run ${run.id} is not tracking ${job.collection}`);

    if (job.limit <= 0) {
      await this.deps.runs.advance({
        runId: run.id,
        collection: job.collection,
        expectedAfterId: job.afterId,
        afterId: progress.afterId,
        readDelta: 0,
        done: true,
      });
      await this.deps.runs.complete(run.id);
      return;
    }

    const docs = await this.deps.raw.readBatch(job.collection, job.afterId, job.limit, this.deps.adapter.collections);
    const outcomes = docs.map((doc) => this.deps.adapter.transform(job.collection, doc));
    const collapsed = collapseWrites(outcomes.flatMap((outcome) => outcome.writes));
    const quarantines = outcomes.flatMap((outcome) => outcome.quarantines);

    await this.deps.domain.apply(collapsed.writes);
    await this.deps.quarantine.upsertMany(run.id, jobId, quarantines);

    const counters = tally(docs.length, outcomes, collapsed.skipped, collapsed.writes.length);
    const errors = quarantines.map((item) => ({
      sourceId: item.sourceId,
      collection: item.collection,
      stage: item.stage,
      reason: item.reason,
    }));

    const last = docs.length > 0 ? rawId(docs[docs.length - 1]!) : null;
    if (docs.length > 0 && !last) throw new Error(`Batch in ${job.collection} produced a document without an id`);
    const cursor = last ?? job.afterId;
    const alreadyCheckpointed = progress.afterId !== job.afterId;
    const consumed = alreadyCheckpointed ? progress.read : progress.read + docs.length;
    const reachedLimit = run.limitPerCollection != null && consumed >= run.limitPerCollection;
    const done = docs.length < job.limit || reachedLimit;

    await this.deps.runs.advance({
      runId: run.id,
      collection: job.collection,
      expectedAfterId: job.afterId,
      afterId: cursor,
      readDelta: docs.length,
      done,
      counters,
      errors,
    });

    if (!done && cursor) {
      const room = pageLimit(run.batchSize, run.limitPerCollection, consumed);
      if (room > 0) {
        await this.enqueueNext(
          { runId: run.id, collection: job.collection, afterId: cursor, limit: room },
          batchJobId(run.id, job.collection, cursor),
        );
      }
    }

    if (done) await this.deps.runs.complete(run.id);

    this.log.info({
      message: 'batch processed',
      runId: run.id,
      jobId,
      collection: job.collection,
      read: counters.read,
      written: counters.written,
      failed: counters.failed,
      done,
    });
  }

  private async enqueueNext(data: BatchJobData, jobId: string): Promise<void> {
    try {
      await this.deps.enqueue(data, jobId, this.deps.attempts, this.deps.backoffMs);
    } catch (err) {
      if (isDuplicateJobError(err)) return;
      this.log.error({ message: 'failed to enqueue next batch', runId: data.runId, jobId, error: safeError(err) });
      throw err;
    }
  }
}

function tally(
  read: number,
  outcomes: PipelineOutcome[],
  collapseSkipped: number,
  written: number,
): RunCounters {
  let transformed = 0;
  let failed = 0;
  let skipped = collapseSkipped;
  for (const outcome of outcomes) {
    skipped += outcome.skipped;
    if (outcome.accepted) {
      transformed += 1;
      failed += outcome.quarantines.length;
    } else {
      failed += 1;
    }
  }
  return { read, transformed, written, skipped, failed };
}
