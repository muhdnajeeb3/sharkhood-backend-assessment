import { ProviderAdapter } from '../core/pipeline/types';
import { xbyteAdapter } from './xbyte/xbyte.adapter';

const registry: Record<string, ProviderAdapter> = {
  [xbyteAdapter.name]: xbyteAdapter,
};

export function adapterFor(name: string): ProviderAdapter {
  const adapter = registry[name];
  if (!adapter) {
    const known = Object.keys(registry).join(', ');
    throw new Error(`Unknown provider "${name}". Registered providers: ${known}`);
  }
  return adapter;
}
