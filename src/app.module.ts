import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { envSchema, formatEnvError } from './config/env.schema';
import { HealthModule } from './health/health.module';
import { PersistenceModule } from './persistence/persistence.module';
import { RunsModule } from './runs/runs.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (env) => {
        const parsed = envSchema.safeParse(env);
        if (!parsed.success) {
          throw new Error(`Invalid environment\n${formatEnvError(parsed.error)}`);
        }
        return parsed.data;
      },
    }),
    PersistenceModule,
    RunsModule,
    HealthModule,
  ],
})
export class AppModule {}
