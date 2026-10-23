import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProviderAdapter } from '../../core/pipeline/types';
import { adapterFor } from '../provider-registry';

@Module({
  providers: [
    {
      provide: ProviderAdapter,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => adapterFor(config.getOrThrow<string>('PROVIDER')),
    },
  ],
  exports: [ProviderAdapter],
})
export class XbyteModule {}
