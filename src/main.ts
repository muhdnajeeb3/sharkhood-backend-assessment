import 'dotenv/config';
import 'reflect-metadata';
import helmet from 'helmet';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { jsonLogger } from './common/logger';
import { safeError } from './common/safe-error';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.enableShutdownHooks();
  app.use(helmet());
  const config = app.get(ConfigService);
  const port = config.getOrThrow<number>('PORT');
  await app.listen(port);
  jsonLogger.info({ message: 'factory listening', port, provider: config.getOrThrow<string>('PROVIDER') });
}

bootstrap().catch((err: unknown) => {
  jsonLogger.error({ message: 'factory failed to start', error: safeError(err) });
  process.exit(1);
});
