import { jobsToResume, pageLimit } from '../../src/queue/batch-job';
import { RunRecord } from '../../src/runs/run.types';

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    provider: 'xbyte',
    status: 'running',
    collections: ['locations', 'menus'],
    batchSize: 25,
    limitPerCollection: null,
    progress: {
      locations: { afterId: 'abc', read: 50, done: false },
      menus: { afterId: null, read: 0, done: true },
    },
    counters: { read: 0, transformed: 0, written: 0, skipped: 0, failed: 0 },
    errorSample: [],
    startedAt: new Date('2026-09-14T00:00:00.000Z'),
    finishedAt: null,
    failure: null,
    ...overrides,
  };
}

describe('resume planning', () => {
  it('requeues only the unfinished collection, from the checkpoint', () => {
    const planned = jobsToResume(run(), new Set());
    expect(planned).toHaveLength(1);
    expect(planned[0]?.data).toEqual({
      runId: '11111111-1111-4111-8111-111111111111',
      collection: 'locations',
      afterId: 'abc',
      limit: 25,
    });
    expect(planned[0]?.jobId).toBe('11111111-1111-4111-8111-111111111111__locations__abc');
  });

  it('does not duplicate a job that is still in Redis, and ignores finished runs', () => {
    const open = run();
    const jobId = '11111111-1111-4111-8111-111111111111__locations__abc';
    expect(jobsToResume(open, new Set([jobId]))).toEqual([]);
    expect(jobsToResume(run({ status: 'completed' }), new Set())).toEqual([]);
    expect(jobsToResume(run({ status: 'failed' }), new Set())).toEqual([]);
  });

  it('stops a collection that has already read its limit', () => {
    expect(pageLimit(25, 40, 40)).toBe(0);
    expect(pageLimit(25, 40, 30)).toBe(10);
    const limited = run({
      limitPerCollection: 50,
      progress: {
        locations: { afterId: 'abc', read: 50, done: false },
        menus: { afterId: null, read: 0, done: true },
      },
    });
    expect(jobsToResume(limited, new Set())).toEqual([]);
  });
});
