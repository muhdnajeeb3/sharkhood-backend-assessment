import { Global, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Db, MongoClient } from 'mongodb';
import { DomainStore } from '../core/ports/domain-store';
import { QuarantineStore } from '../core/ports/quarantine-store';
import { RawReader } from '../core/ports/raw-reader';
import { RunStore } from '../core/ports/run-store';
import { safeError } from '../common/safe-error';
import { jsonLogger } from '../common/logger';
import { MongoDomainStore } from './mongo-domain-store';
import { MongoQuarantineStore } from './mongo-quarantine-store';
import { MongoRawReader } from './mongo-raw-reader';
import { MongoRunStore } from './mongo-run-store';

@Global()
@Module({
  providers: [
    {
      provide: MongoClient,
      inject: [ConfigService],
      useFactory: async (config: ConfigService) => {
        const uri = config.getOrThrow<string>('MONGO_URI');
        let lastError: unknown;
        for (let attempt = 1; attempt <= 8; attempt += 1) {
          const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
          try {
            await client.connect();
            await client.db().command({ ping: 1 });
            jsonLogger.info({ message: 'mongo connected', attempt });
            return client;
          } catch (err) {
            lastError = err;
            await client.close().catch(() => undefined);
            jsonLogger.error({ message: 'mongo connection failed', attempt, error: safeError(err) });
            await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
          }
        }
        throw new Error(`MongoDB did not become reachable: ${safeError(lastError)}`);
      },
    },
    {
      provide: 'RAW_DB',
      inject: [MongoClient, ConfigService],
      useFactory: (client: MongoClient, config: ConfigService): Db => client.db(config.getOrThrow<string>('RAW_DB')),
    },
    {
      provide: 'DOMAIN_DB',
      inject: [MongoClient, ConfigService],
      useFactory: (client: MongoClient, config: ConfigService): Db => client.db(config.getOrThrow<string>('DOMAIN_DB')),
    },
    {
      provide: RawReader,
      inject: ['RAW_DB'],
      useFactory: (db: Db) => new MongoRawReader(db),
    },
    {
      provide: DomainStore,
      inject: ['DOMAIN_DB'],
      useFactory: (db: Db) => new MongoDomainStore(db),
    },
    {
      provide: RunStore,
      inject: ['DOMAIN_DB'],
      useFactory: (db: Db) => new MongoRunStore(db),
    },
    {
      provide: QuarantineStore,
      inject: ['DOMAIN_DB'],
      useFactory: (db: Db) => new MongoQuarantineStore(db),
    },
  ],
  exports: [MongoClient, RawReader, DomainStore, RunStore, QuarantineStore],
})
export class PersistenceModule implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly client: MongoClient,
    private readonly domain: DomainStore,
    private readonly runs: RunStore,
    private readonly quarantine: QuarantineStore,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.domain.ensureIndexes();
    await this.quarantine.ensureIndexes();
    if (this.runs instanceof MongoRunStore) await this.runs.ensureIndexes();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.close();
  }
}
