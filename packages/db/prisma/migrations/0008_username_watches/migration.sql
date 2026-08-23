-- Migration: 0008_username_watches — Sherlock username watchlist (13_SHERLOCK.md §6.6).
-- Lock impact: none. Creates one new table with its indexes; no existing table is altered.
-- Estimated duration: < 20 ms.
-- Expand/contract: expand only.

CREATE TABLE "username_watches" (
    "id"          TEXT         NOT NULL,
    "org_id"      TEXT         NOT NULL,
    "project_id"  TEXT         NOT NULL,
    "node_id"     TEXT         NOT NULL,
    "handle"      VARCHAR(120) NOT NULL,
    "created_by"  TEXT         NOT NULL,
    "cadence"     VARCHAR(16)  NOT NULL,
    "sites"       JSONB,
    "notify_on"   JSONB        NOT NULL,
    "consent_id"  TEXT         NOT NULL,
    "paused_at"   TIMESTAMP(3),
    "last_run_id" TEXT,
    "next_run_at" TIMESTAMP(3) NOT NULL,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "username_watches_pkey" PRIMARY KEY ("id")
);

-- safe: the table is created empty in this migration, so the index build takes no meaningful lock
CREATE UNIQUE INDEX "username_watches_project_id_node_id_key" ON "username_watches"("project_id", "node_id");
-- safe: same, the worker's due-list query scans this index
CREATE INDEX "username_watches_next_run_at_idx" ON "username_watches"("next_run_at");
