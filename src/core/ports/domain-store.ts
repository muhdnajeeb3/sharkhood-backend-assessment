import { DomainWrite } from '../pipeline/types';

export abstract class DomainStore {
  abstract ensureIndexes(): Promise<void>;
  abstract apply(writes: DomainWrite[]): Promise<void>;
}
