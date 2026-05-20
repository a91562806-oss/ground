-- CreateTable
CREATE TABLE "NotificationDispatchState" (
  "id" TEXT NOT NULL,
  "alertKind" TEXT NOT NULL,
  "teamScope" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "gameExternalId" TEXT,
  "payload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "NotificationDispatchState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDispatchState_alertKind_teamScope_eventKey_key"
ON "NotificationDispatchState"("alertKind", "teamScope", "eventKey");

-- CreateIndex
CREATE INDEX "NotificationDispatchState_gameExternalId_alertKind_createdAt_idx"
ON "NotificationDispatchState"("gameExternalId", "alertKind", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationDispatchState_alertKind_createdAt_idx"
ON "NotificationDispatchState"("alertKind", "createdAt");
