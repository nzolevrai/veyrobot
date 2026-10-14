ALTER TABLE "ModerationCase"
  ADD COLUMN "operationId" TEXT,
  ADD COLUMN "startedAt" TIMESTAMP(3),
  ADD COLUMN "completedAt" TIMESTAMP(3),
  ADD COLUMN "result" TEXT,
  ADD COLUMN "durationMinutes" INTEGER;

CREATE UNIQUE INDEX "ModerationCase_operationId_key" ON "ModerationCase"("operationId");
