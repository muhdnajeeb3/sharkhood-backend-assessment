export interface SourceRank {
  updatedAt: Date;
  sourceId: string;
  sourceCollection: string;
}

export type WriteKind = 'replace' | 'menu-profile' | 'listing';

export interface DomainWrite {
  kind: WriteKind;
  collection: string;
  id: string;
  rank: SourceRank;
  /** Fields owned by this write. Rank metadata is added by the store. */
  fields: Record<string, unknown>;
}

export interface QuarantineDecision {
  sourceId: string;
  collection: string;
  stage: 'validate' | 'normalise' | 'map' | 'dedupe' | 'project';
  reason: string;
}

export interface PipelineOutcome {
  /** The raw document was usable. Child rows may still have been quarantined. */
  accepted: boolean;
  quarantines: QuarantineDecision[];
  writes: DomainWrite[];
  /** Duplicate entities collapsed before they were written. */
  skipped: number;
}

export interface RawDocument {
  _id?: unknown;
  domain?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  payload?: unknown;
  params?: unknown;
  statusCode?: unknown;
  endpoint?: unknown;
}

/**
 * One provider. A second provider is another implementation plus a mapping,
 * registered by name. The batch runner only calls `transform`.
 */
export abstract class ProviderAdapter {
  abstract readonly name: string;
  abstract readonly collections: readonly string[];
  abstract transform(collection: string, doc: RawDocument): PipelineOutcome;
}

export function compareRank(a: SourceRank, b: SourceRank): number {
  const delta = a.updatedAt.getTime() - b.updatedAt.getTime();
  if (delta !== 0) return delta;
  if (a.sourceId === b.sourceId) return 0;
  return a.sourceId > b.sourceId ? 1 : -1;
}

export function collapseWrites(writes: DomainWrite[]): { writes: DomainWrite[]; skipped: number } {
  const best = new Map<string, DomainWrite>();
  let skipped = 0;
  for (const write of writes) {
    const key = `${write.kind}:${write.collection}:${write.id}`;
    const existing = best.get(key);
    if (!existing) {
      best.set(key, write);
      continue;
    }
    skipped += 1;
    if (compareRank(write.rank, existing.rank) > 0) {
      best.set(key, write);
    }
  }
  const collapsed = [...best.values()].sort((a, b) => {
    const left = `${a.collection}:${a.id}:${a.kind}`;
    const right = `${b.collection}:${b.id}:${b.kind}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return { writes: collapsed, skipped };
}

export function rejectDocument(
  sourceId: string,
  collection: string,
  stage: QuarantineDecision['stage'],
  reason: string,
): PipelineOutcome {
  return {
    accepted: false,
    quarantines: [{ sourceId, collection, stage, reason: reason.slice(0, 500) }],
    writes: [],
    skipped: 0,
  };
}
