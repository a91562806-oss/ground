-- AlterTable
ALTER TABLE "Game"
ADD COLUMN "highlightNotifiedAt" TIMESTAMP(3),
ADD COLUMN "highlightVideoUrl" TEXT,
ADD COLUMN "lastHighlightCheckedAt" TIMESTAMP(3);
