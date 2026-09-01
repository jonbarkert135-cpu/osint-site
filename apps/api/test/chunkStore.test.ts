/** The pgvector chunk store: tenant scoping, vector literals and honest scores (14 §6.4–§6.5). */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prismaMock, recordAuditMock } from './prisma-mock.ts';

// The store only uses Prisma.sql / Prisma.empty / Prisma.raw; a structural fake keeps the test
// off the generated client. Raw calls arrive as (strings, ...values) tagged-template arguments.
const sql = (strings: TemplateStringsArray, ...values: unknown[]) => ({
  strings: [...strings],
  values,
});
vi.mock('@nexus/db', () => ({
  prisma: prismaMock,
  recordAudit: recordAuditMock,
  Prisma: { sql, empty: { strings: [''], values: [] }, raw: (s: string) => s },
}));

const { createChunkStore } = await import('../src/ai/chunkStore.ts');

const row = { id: 'c1', node_id: 'n1', text: 'hello', score: 0.9 };

const flatten = (call: unknown[]): { text: string; values: unknown[] } => {
  const [strings, ...values] = call as [readonly string[], ...unknown[]];
  return { text: strings.join('?'), values };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createChunkStore', () => {
  it('vector search runs in a transaction with raised ef_search and maps rows', async () => {
    const tx = { $executeRaw: vi.fn(), $queryRaw: vi.fn().mockResolvedValue([row]) };
    prismaMock.$transaction.mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx));

    const chunks = await createChunkStore('embed-x').vector([0.25, -1], { projectId: 'p1' }, 40);

    expect(chunks).toEqual([{ id: 'c1', nodeId: 'n1', text: 'hello', score: 0.9 }]);
    const setLocal = flatten(tx.$executeRaw.mock.calls[0] ?? []);
    expect(setLocal.text).toContain('SET LOCAL hnsw.ef_search = ');
    expect(setLocal.values).toContain('80');
    const query = flatten(tx.$queryRaw.mock.calls[0] ?? []);
    expect(query.text).toContain('"project_id" = ');
    expect(query.values).toContain('p1');
    expect(query.values).toContain('embed-x');
    expect(query.values).toContain('[0.25,-1]'); // the pgvector text literal
    expect(query.values).toContain(40);
  });

  it('lexical search stays tenant- and board-scoped', async () => {
    prismaMock.$queryRaw.mockResolvedValue([row]);

    const chunks = await createChunkStore('m').lexical(
      'query words',
      { projectId: 'p1', boardId: 'b1' },
      40,
    );

    expect(chunks).toHaveLength(1);
    const query = flatten(prismaMock.$queryRaw.mock.calls[0] ?? []);
    expect(query.text).toContain('websearch_to_tsquery');
    expect(query.values).toEqual(expect.arrayContaining(['query words', 'p1', 40]));
    // The board filter travels as a nested sql fragment carrying the board id.
    expect(JSON.stringify(query.values)).toContain('b1');
  });

  it('omits the board filter when no board is given', async () => {
    prismaMock.$queryRaw.mockResolvedValue([]);
    await createChunkStore('m').lexical('q', { projectId: 'p1' }, 10);
    const query = flatten(prismaMock.$queryRaw.mock.calls[0] ?? []);
    expect(JSON.stringify(query.values)).not.toContain('b1');
  });
});
