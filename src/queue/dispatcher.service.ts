import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { ProviderAdapter } from '../core/pipeline/types';
import { RunStore } from '../core/ports/run-store';
import { safeError } from '../common/safe-error';
import { jsonLogger } from '../common/logger';
import { RunRecord } from '../runs/run.types';
import { BATCH_QUEUE, BatchJobData, batchJobId, jobsToResume, pageLimit } from './batch-job';

const LIVE_STATES = new Set(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children']);

@Injectable()
export class RunDispatcher implements OnModuleInit {
  constructor(
    private readonly runs: RunStore,
    private readonly adapter: ProviderAdapter,
    private readonly config: ConfigService,
    @InjectQueue(BATCH_QUEUE) private readonly queue: Queue,
  ) {}

  async start(input: { collections?: string[]; limitPerCollection?: number | null }): Promise<RunRecord> {
    const requested = input.collections?.length ? input.collections : [...this.adapter.collections];
    const unknown = requested.filter((name) => !this.adapter.collections.includes(name));
    if (unknown.length > 0) {
      throw new BadRequestException(`Unknown collections: ${unknown.join(', ')}`);
    }
    const collections = [...new Set(requested)];
    const batchSize = this.config.getOrThrow<number>('BATCH_SIZE');
    const run = await this.runs.create({
      provider: this.adapter.name,
      collections,
      batchSize,
      limitPerCollection: input.limitPerCollection ?? null,
    });

    try {
      for (const collection of collections) {
        const limit = pageLimit(batchSize, run.limitPerCollection, 0);
        await this.enqueue({ runId: run.id, collection, afterId: null, limit });
      }
    } catch (err) {
      await this.runs.markFailed(run.id, safeError(err), null);
      throw err;
    }
    return run;
  }

  /**
   * A restarted process picks up runs that are still `running`. Live jobs are
   * left to BullMQ. A job that exhausted its attempts is removed and queued
   * again from the checkpoint, so a kill mid-batch does not replay earlier pages.
   */
  async onModuleInit(): Promise<void> {
    const client = (await this.queue.client) as unknown as { ping: () => Promise<string> };
    const pong = await client.ping();
    if (pong !== 'PONG') throw new Error('Redis did not respond to PING');

    const open = await this.runs.findRunning();
    for (const run of open) {
      const planned = jobsToResume(run, new Set());
      for (const job of planned) {
        const existing = await this.queue.getJob(job.jobId);
        if (existing) {
          const state = await existing.getState();
          if (LIVE_STATES.has(state)) continue;
          await existing.remove().catch(() => undefined);
        }
        await this.enqueue(job.data);
        jsonLogger.info({ message: 'resumed batch', runId: run.id, jobId: job.jobId, collection: job.data.collection });
      }
    }
  }

  private async enqueue(data: BatchJobData): Promise<void> {
    await this.queue.add('batch', data, {
      jobId: batchJobId(data.runId, data.collection, data.afterId),
      attempts: this.config.getOrThrow<number>('JOB_ATTEMPTS'),
      backoff: { type: 'exponential', delay: this.config.getOrThrow<number>('JOB_BACKOFF_MS') },
      removeOnComplete: 5000,
      removeOnFail: 1000,
    });
  }
}
