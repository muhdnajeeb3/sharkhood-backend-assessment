import { collapseWrites, DomainWrite, SourceRank } from '../../src/core/pipeline/types';

function write(id: string, rank: SourceRank, name: string): DomainWrite {
  return {
    kind: 'replace',
    collection: 'locations',
    id,
    rank,
    fields: { name },
  };
}

const older: SourceRank = {
  updatedAt: new Date('2026-09-14T04:00:00.000Z'),
  sourceId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  sourceCollection: 'locations',
};
const newer: SourceRank = {
  updatedAt: new Date('2026-09-14T05:00:00.000Z'),
  sourceId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
  sourceCollection: 'locations',
};

describe('collapseWrites', () => {
  it('keeps the newer snapshot whichever order the batch saw them in', () => {
    const forward = collapseWrites([write('1560', older, 'Al Soor'), write('1560', newer, 'Al Soor East')]);
    const backward = collapseWrites([write('1560', newer, 'Al Soor East'), write('1560', older, 'Al Soor')]);
    expect(forward.writes).toHaveLength(1);
    expect(backward.writes).toHaveLength(1);
    expect(forward.writes[0]?.fields.name).toBe('Al Soor East');
    expect(backward.writes[0]?.fields.name).toBe('Al Soor East');
    expect(forward.skipped).toBe(1);
    expect(backward.skipped).toBe(1);
  });
});
