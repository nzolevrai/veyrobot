ALTER TABLE "ModerationCase"
  ADD COLUMN "claimToken" TEXT,
  ADD COLUMN "claimLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "executionPhase" TEXT,
  ADD COLUMN "expiryClaimToken" TEXT,
  ADD COLUMN "expiryLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "banGeneration" INTEGER;

CREATE INDEX "ModerationCase_status_createdAt_idx" ON "ModerationCase"("status", "createdAt");
CREATE INDEX "ModerationCase_action_status_expiryStatus_expiresAt_idx" ON "ModerationCase"("action", "status", "expiryStatus", "expiresAt");
CREATE INDEX "ModerationCase_expiryStatus_expiryLeaseUntil_idx" ON "ModerationCase"("expiryStatus", "expiryLeaseUntil");

CREATE TABLE "GuildTargetDecision" (
  "guildId" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "generation" INTEGER NOT NULL DEFAULT 0,
  "latestOperationId" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GuildTargetDecision_pkey" PRIMARY KEY ("guildId", "targetId")
);
CREATE INDEX "GuildTargetDecision_guildId_updatedAt_idx" ON "GuildTargetDecision"("guildId", "updatedAt");
