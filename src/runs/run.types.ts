export interface CollectionProgress {
  afterId: string | null;
  read: number;
  done: boolean;
}

export interface RunCounters {
  read: number;
  transformed: number;
  written: number;
  skipped: number;
  failed: number;
}

export interface RunErrorSample {
  sourceId: string;
  collection: string;
  stage: string;
  reason: string;
}

export type RunStatus = 'running' | 'completed' | 'failed';

export interface RunRecord {
  id: string;
  provider: string;
  status: RunStatus;
  collections: string[];
  batchSize: number;
  limitPerCollection: number | null;
  progress: Record<string, CollectionProgress>;
  counters: RunCounters;
  errorSample: RunErrorSample[];
  startedAt: Date;
  finishedAt: Date | null;
  failure: { reason: string; jobId: string | null; at: Date } | null;
}

export interface RunView extends RunRecord {
  durationMs: number | null;
}
