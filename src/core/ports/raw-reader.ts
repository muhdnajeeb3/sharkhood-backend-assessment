import { RawDocument } from '../pipeline/types';

export abstract class RawReader {
  abstract readBatch(collection: string, afterId: string | null, limit: number, allowed: readonly string[]): Promise<RawDocument[]>;
}
