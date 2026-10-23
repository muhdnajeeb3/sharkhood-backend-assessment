import 'dotenv/config';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { BatchRunner } from './batch.runner';
import { BATCH_QUEUE, BatchJobData } from './batch-job';

function workerConcurrency(): number {
  const parsed = Number(process.env.WORKER_CONCURRENCY ?? 4);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 32 ? parsed : 4;
}

@Processor(BATCH_QUEUE, {
  concurrency: workerConcurrency(),
  lockDuration: 120_000,
  maxStalledCount: 2,
})
export class BatchProcessor extends WorkerHost {
  constructor(private readonly runner: BatchRunner) {
    super();
  }

  async process(job: Job<BatchJobData>): Promise<void> {
    if (!job.id) throw new Error('batch job has no id');
    await this.runner.run(job.data, job.id);
  }
}
