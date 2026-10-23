import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { ProviderAdapter } from '../core/pipeline/types';
import { DomainStore } from '../core/ports/domain-store';
import { QuarantineStore } from '../core/ports/quarantine-store';
import { RawReader } from '../core/ports/raw-reader';
import { RunStore } from '../core/ports/run-store';
import { XbyteModule } from '../providers/xbyte/xbyte.module';
import { BATCH_QUEUE, BatchJobData, DLQ_QUEUE } from './batch-job';
import { BatchProcessor } from './batch.processor';
import { BatchRunner } from './batch.runner';
import { RunDispatcher } from './dispatcher.service';
import { DlqBridge } from './dlq.bridge';

const queues = BullModule.registerQueue({ name: BATCH_QUEUE }, { name: DLQ_QUEUE });

@Module({
  imports: [
    XbyteModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.getOrThrow<string>('REDIS_HOST'),
          port: config.getOrThrow<number>('REDIS_PORT'),
        },
      }),
    }),
    queues,
  ],
  providers: [
    {
      provide: BatchRunner,
      inject: [ProviderAdapter, RawReader, DomainStore, RunStore, QuarantineStore, getQueueToken(BATCH_QUEUE), ConfigService],
      useFactory: (
        adapter: ProviderAdapter,
        raw: RawReader,
        domain: DomainStore,
        runs: RunStore,
        quarantine: QuarantineStore,
        queue: Queue,
        config: ConfigService,
      ) =>
        new BatchRunner({
          adapter,
          raw,
          domain,
          runs,
          quarantine,
          attempts: config.getOrThrow<number>('JOB_ATTEMPTS'),
          backoffMs: config.getOrThrow<number>('JOB_BACKOFF_MS'),
          enqueue: async (data: BatchJobData, jobId: string, attempts: number, backoffMs: number) => {
            await queue.add('batch', data, {
              jobId,
              attempts,
              backoff: { type: 'exponential', delay: backoffMs },
              removeOnComplete: 5000,
              removeOnFail: 1000,
            });
          },
        }),
    },
    BatchProcessor,
    RunDispatcher,
    DlqBridge,
  ],
  exports: [RunDispatcher, queues],
})
export class QueueModule {}
