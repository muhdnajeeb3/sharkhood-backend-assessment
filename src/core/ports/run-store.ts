import { RunCounters, RunErrorSample, RunRecord } from '../../runs/run.types';

export interface CreateRunInput {
  provider: string;
  collections: string[];
  batchSize: number;
  limitPerCollection: number | null;
}

export interface AdvanceInput {
  runId: string;
  collection: string;
  expectedAfterId: string | null;
  afterId: string | null;
  readDelta: number;
  done: boolean;
  /** Applied only when this job still owns the cursor, so a retry cannot double-count. */
  counters?: RunCounters;
  errors?: RunErrorSample[];
}

export abstract class RunStore {
  abstract create(input: CreateRunInput): Promise<RunRecord>;
  abstract get(id: string): Promise<RunRecord | null>;
  abstract findRunning(): Promise<RunRecord[]>;
  abstract advance(input: AdvanceInput): Promise<void>;
  abstract markFailed(runId: string, reason: string, jobId: string | null): Promise<void>;
  abstract complete(runId: string): Promise<void>;
}
