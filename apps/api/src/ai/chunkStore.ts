/**
 * The pgvector side of hybrid retrieval (14_AI_AGENT.md §6.4–§6.5). This is the only file that
 * knows chunks live in Postgres: `@nexus/ai` owns the math, this owns the SQL. Both searches are
 * tenant-scoped by `project_id` in the WHERE clause — never trust the fused list to filter.
 */

import { Prisma, prisma } from '@nexus/db';
import type { ChunkSearch, RetrievalScope, ScoredChunk } from '@nexus/ai';

/** Raise HNSW recall for retrieval queries (§6.4); SET LOCAL keeps it to the transaction. */
const EF_SEARCH = 80;

interface Row {
  readonly id: string;
  readonly node_id: string;
  readonly text: string;
  readonly score: number;
}

const toChunks = (rows: readonly Row[]): ScoredChunk[] =>
  rows.map((row) => ({ id: row.id, nodeId: row.node_id, text: row.text, score: row.score }));

const boardFilter = (scope: RetrievalScope): Prisma.Sql =>
  scope.boardId === undefined ? Prisma.empty : Prisma.sql`AND "board_id" = ${scope.boardId}`;

/** pgvector rejects a bare float8[] parameter, so the vector is passed as its text literal. */
const vectorLiteral = (embedding: readonly number[]): string => `[${embedding.join(',')}]`;

export function createChunkStore(embedModel: string): ChunkSearch {
  return {
    async vector(embedding, scope, limit) {
      const literal = vectorLiteral(embedding);
      const rows = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL hnsw.ef_search = ${Prisma.raw(String(EF_SEARCH))}`;
        return tx.$queryRaw<Row[]>`
          SELECT "id", "node_id", "text", 1 - ("embedding" <=> ${literal}::vector) AS score
          FROM "ai_chunks"
          WHERE "project_id" = ${scope.projectId} ${boardFilter(scope)}
            AND "model" = ${embedModel} AND "embedding" IS NOT NULL
          ORDER BY "embedding" <=> ${literal}::vector
          LIMIT ${limit}`;
      });
      return toChunks(rows);
    },

    async lexical(query, scope, limit) {
      const rows = await prisma.$queryRaw<Row[]>`
        SELECT "id", "node_id", "text",
               ts_rank_cd(to_tsvector('simple', "text"), websearch_to_tsquery('simple', ${query})) AS score
        FROM "ai_chunks"
        WHERE "project_id" = ${scope.projectId} ${boardFilter(scope)}
          AND to_tsvector('simple', "text") @@ websearch_to_tsquery('simple', ${query})
        ORDER BY score DESC
        LIMIT ${limit}`;
      return toChunks(rows);
    },
  };
}
