-- CreateTable
CREATE TABLE "documents" (
    "doc_id" TEXT NOT NULL PRIMARY KEY,
    "first_seen" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "content_sha256" TEXT,
    "original_name" TEXT
);

-- CreateTable
CREATE TABLE "stages" (
    "doc_id" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "prompt_version" TEXT,
    "done_at" DATETIME,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "result" TEXT,

    PRIMARY KEY ("doc_id", "stage")
);

-- CreateIndex
CREATE INDEX "stages_stage_status_idx" ON "stages"("stage", "status");
