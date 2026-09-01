-- Migration: 0010_integration_credentials — envelope-encrypted org credentials (15_SECURITY.md §8.2).
-- Lock impact: none. Creates one new table with its indexes; no existing table is altered.
-- Estimated duration: < 20 ms.
-- Expand/contract: expand only.

CREATE TABLE "integration_credentials" (
    "id"             TEXT         NOT NULL,
    "org_id"         TEXT         NOT NULL,
    "project_id"     TEXT,
    "integration_id" TEXT         NOT NULL,
    "label"          VARCHAR(120) NOT NULL,
    "enc_dek"        BYTEA        NOT NULL,
    "nonce"          BYTEA        NOT NULL,
    "ciphertext"     BYTEA        NOT NULL,
    "key_version"    INTEGER      NOT NULL,
    "fingerprint"    VARCHAR(32)  NOT NULL,
    "last_four"      VARCHAR(8),
    "created_by"     TEXT         NOT NULL,
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at"   TIMESTAMP(3),
    "rotated_at"     TIMESTAMP(3),
    "expires_at"     TIMESTAMP(3),

    CONSTRAINT "integration_credentials_pkey" PRIMARY KEY ("id")
);

-- safe: the table is created empty in this migration, so the index build takes no meaningful lock
CREATE UNIQUE INDEX "integration_credentials_org_id_integration_id_label_key" ON "integration_credentials"("org_id", "integration_id", "label");
-- safe: same, this index serves the "credentials of one integration" listing
CREATE INDEX "integration_credentials_org_id_integration_id_idx" ON "integration_credentials"("org_id", "integration_id");
