import { RunRecord } from '../runs/run.types';

export const BATCH_QUEUE = 'factory-batches';
export const DLQ_QUEUE = 'factory-dlq';

export interface BatchJobData {
  runId: string;
  collection: string;
  afterId: string | null;
  /** Frozen page size. Retries must read the same window the first attempt did. */
  limit: number;
}

export function batchJobId(runId: string, collection: string, afterId: string | null): string {
  // BullMQ rejects custom ids that contain ":".
  return `${runId}__${collection}__${afterId ?? 'start'}`;
}

export function isDuplicateJobError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /already exists|duplicat/i.test(message);
}

export function pageLimit(batchSize: number, limitPerCollection: number | null, alreadyRead: number): number {
  const room = limitPerCollection == null ? batchSize : limitPerCollection - alreadyRead;
  if (room <= 0) return 0;
  return Math.min(batchSize, room);
}

export interface PlannedJob {
  jobId: string;
  data: BatchJobData;
}

/**
 * Jobs to put back on the queue when a worker starts and a run is still open.
 * Collections that already finished are left alone. A job id that is still in
 * Redis (the caller passes those) is not duplicated.
 */
export function jobsToResume(run: RunRecord, existingJobIds: ReadonlySet<string>): PlannedJob[] {
  if (run.status !== 'running') return [];
  const planned: PlannedJob[] = [];
  for (const collection of run.collections) {
    const progress = run.progress[collection];
    if (!progress || progress.done) continue;
    const limit = pageLimit(run.batchSize, run.limitPerCollection, progress.read);
    if (limit <= 0) continue;
    const jobId = batchJobId(run.id, collection, progress.afterId);
    if (existingJobIds.has(jobId)) continue;
    planned.push({
      jobId,
      data: { runId: run.id, collection, afterId: progress.afterId, limit },
    });
  }
  return planned;
}
