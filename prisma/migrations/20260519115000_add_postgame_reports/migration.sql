-- CreateEnum
CREATE TYPE "PostGameReportStatus" AS ENUM ('PENDING', 'GENERATING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "PostGameReport" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "gameDate" TIMESTAMP(3),
    "status" "PostGameReportStatus" NOT NULL DEFAULT 'PENDING',
    "title" TEXT,
    "bodyLines" JSONB,
    "facts" JSONB,
    "error" TEXT,
    "generatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PostGameReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PostGameReport_externalId_teamId_key" ON "PostGameReport"("externalId", "teamId");

-- CreateIndex
CREATE INDEX "PostGameReport_teamId_gameDate_idx" ON "PostGameReport"("teamId", "gameDate");

-- CreateIndex
CREATE INDEX "PostGameReport_status_updatedAt_idx" ON "PostGameReport"("status", "updatedAt");
