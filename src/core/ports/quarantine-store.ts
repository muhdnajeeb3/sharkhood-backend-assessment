import { QuarantineDecision } from '../pipeline/types';

export interface QuarantineRecord extends QuarantineDecision {
  runId: string;
  jobId: string;
  createdAt: Date;
}

export interface QuarantinePage {
  total: number;
  errors: QuarantineRecord[];
}

export abstract class QuarantineStore {
  abstract ensureIndexes(): Promise<void>;
  abstract upsertMany(runId: string, jobId: string, decisions: QuarantineDecision[]): Promise<void>;
  abstract list(runId: string, skip: number, limit: number): Promise<QuarantinePage>;
}
