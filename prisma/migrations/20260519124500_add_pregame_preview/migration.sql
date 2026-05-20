-- CreateEnum
CREATE TYPE "PregamePreviewStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "PregamePreview" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "opponentTeamId" TEXT NOT NULL,
    "gameTime" TEXT NOT NULL,
    "stadium" TEXT,
    "status" "PregamePreviewStatus" NOT NULL DEFAULT 'PENDING',
    "title" TEXT,
    "bodyLines" JSONB,
    "context" JSONB,
    "error" TEXT,
    "generatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PregamePreview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PregamePreview_date_teamId_key" ON "PregamePreview"("date", "teamId");

-- CreateIndex
CREATE INDEX "PregamePreview_date_status_idx" ON "PregamePreview"("date", "status");

-- CreateIndex
CREATE INDEX "PregamePreview_teamId_date_idx" ON "PregamePreview"("teamId", "date");
