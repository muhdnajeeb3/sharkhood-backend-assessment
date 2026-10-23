import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Response } from 'express';
import { MongoClient } from 'mongodb';
import { BATCH_QUEUE } from '../queue/batch-job';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(MongoClient) private readonly mongo: MongoClient,
    @InjectQueue(BATCH_QUEUE) private readonly queue: Queue,
  ) {}

  @Get()
  async health(@Res({ passthrough: true }) res: Response) {
    const [mongo, redis] = await Promise.all([this.pingMongo(), this.pingRedis()]);
    const ok = mongo && redis;
    if (!ok) res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: ok ? 'ok' : 'degraded',
      mongo: mongo ? 'up' : 'down',
      redis: redis ? 'up' : 'down',
    };
  }

  private async pingMongo(): Promise<boolean> {
    try {
      await this.mongo.db().command({ ping: 1 });
      return true;
    } catch {
      return false;
    }
  }

  private async pingRedis(): Promise<boolean> {
    try {
      const client = (await this.queue.client) as unknown as { ping: () => Promise<string> };
      return (await client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }
}
