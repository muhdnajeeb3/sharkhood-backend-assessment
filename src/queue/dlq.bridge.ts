import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, QueueEvents } from 'bullmq';
import { jsonLogger } from '../common/logger';
import { safeError } from '../common/safe-error';
import { RunStore } from '../core/ports/run-store';
import { BATCH_QUEUE, DLQ_QUEUE } from './batch-job';

/**
 * Bad documents are quarantined and the batch continues. This path is only for
 * a job that threw (Mongo or Redis down, a bug) and used up its attempts.
 */
@Injectable()
export class DlqBridge implements OnModuleInit, OnModuleDestroy {
  private events?: QueueEvents;

  constructor(
    @InjectQueue(BATCH_QUEUE) private readonly batches: Queue,
    @InjectQueue(DLQ_QUEUE) private readonly dead: Queue,
    private readonly runs: RunStore,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.events = new QueueEvents(BATCH_QUEUE, {
      connection: {
        host: this.config.getOrThrow<string>('REDIS_HOST'),
        port: this.config.getOrThrow<number>('REDIS_PORT'),
        maxRetriesPerRequest: null,
      },
    });
    this.events.on('failed', ({ jobId, failedReason }) => {
      void this.deadLetter(jobId, failedReason);
    });
    await this.events.waitUntilReady();
  }

  async onModuleDestroy(): Promise<void> {
    await this.events?.close();
  }

  private async deadLetter(jobId: string, failedReason: string): Promise<void> {
    try {
      const job = await this.batches.getJob(jobId);
      if (!job) return;
      const attempts = job.opts.attempts ?? 1;
      // `failed` also fires when BullMQ is about to retry. Only the last attempt is dead.
      if (job.attemptsMade < attempts) return;
      const reason = safeError(new Error(failedReason));
      await this.dead.add(
        'dead',
        {
          jobId,
          runId: job.data.runId,
          collection: job.data.collection,
          afterId: job.data.afterId,
          reason,
        },
        { jobId: `dlq__${jobId}`, removeOnComplete: false, removeOnFail: false },
      );
      await this.runs.markFailed(String(job.data.runId), reason, jobId);
      jsonLogger.error({ message: 'batch moved to dead letter', runId: job.data.runId, jobId, collection: job.data.collection });
    } catch (err) {
      jsonLogger.error({ message: 'dead letter handling failed', jobId, error: safeError(err) });
    }
  }
}
