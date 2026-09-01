-- Migration: 0009_ai_retrieval — retrieval chunks for hybrid search (14_AI_AGENT.md §6.4).
-- Lock impact: none. One extension + one new table with its indexes; no existing table is altered.
-- Estimated duration: < 50 ms.
-- Expand/contract: expand only.

-- safe: pgvector ships in the deployment image (pgvector/pgvector:pg16); IF NOT EXISTS is a no-op re-run
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "ai_chunks" (
    "id"           TEXT         NOT NULL,
    "project_id"   TEXT         NOT NULL,
    "board_id"     TEXT,
    "node_id"      TEXT         NOT NULL,
    "kind"         VARCHAR(16)  NOT NULL,
    "ord"          INTEGER      NOT NULL,
    "text"         TEXT         NOT NULL,
    "token_count"  INTEGER      NOT NULL,
    "content_hash" VARCHAR(64)  NOT NULL,
    "model"        VARCHAR(120) NOT NULL,
    "embedding"    vector(1536),
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_chunks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_chunks_kind_check" CHECK ("kind" IN ('title', 'body', 'finding'))
);

-- safe: the table is created empty in this migration, so index builds take no meaningful lock
CREATE UNIQUE INDEX "ai_chunks_node_id_kind_ord_model_key" ON "ai_chunks"("node_id", "kind", "ord", "model");
-- safe: same — this is the retriever's tenant-scoped scan
CREATE INDEX "ai_chunks_project_id_node_id_idx" ON "ai_chunks"("project_id", "node_id");
-- safe: same — semantic index Prisma cannot express (14_AI_AGENT.md §6.4). Indexed as a halfvec
-- expression: an expression index is invisible to `prisma migrate diff` (a plain column index on
-- an Unsupported field trips the drift check), and halfvec halves the index size at ~no recall
-- cost per pgvector's own guidance. Queries must use the same expression to hit the index.
CREATE INDEX "ai_chunks_vec_idx" ON "ai_chunks" USING hnsw ((("embedding")::halfvec(1536)) halfvec_cosine_ops) WITH (m = 16, ef_construction = 64);
-- safe: same — lexical expression index; the retriever queries to_tsvector('simple', "text") directly
CREATE INDEX "ai_chunks_tsv_idx" ON "ai_chunks" USING gin (to_tsvector('simple', "text"));

-- safe: the table is empty; matches Prisma's relation (ON DELETE CASCADE, ON UPDATE CASCADE)
ALTER TABLE "ai_chunks" ADD CONSTRAINT "ai_chunks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
