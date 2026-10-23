import { PipelineOutcome, ProviderAdapter, RawDocument } from '../../core/pipeline/types';
import { transformDocument } from './transform';

/**
 * xbyte is the export, Talabat is the marketplace inside it (`domain`).
 * Another marketplace with this same envelope can ride this adapter.
 * A provider with a different envelope implements ProviderAdapter and is
 * registered in provider-registry.ts. Nothing in the queue or the store changes.
 */
export class XbyteAdapter extends ProviderAdapter {
  readonly name = 'xbyte';
  readonly collections = ['locations', 'restaurants', 'menus'] as const;

  transform(collection: string, doc: RawDocument): PipelineOutcome {
    return transformDocument(collection, doc);
  }
}

export const xbyteAdapter = new XbyteAdapter();
