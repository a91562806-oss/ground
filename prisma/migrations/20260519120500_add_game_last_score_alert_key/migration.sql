-- AlterTable
ALTER TABLE "Game"
ADD COLUMN "lastScoreAlertKey" TEXT,
ADD COLUMN "lastScoreAlertAt" TIMESTAMP(3);
