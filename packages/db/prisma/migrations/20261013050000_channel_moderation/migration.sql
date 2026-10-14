ALTER TABLE "ModerationCase"
  ADD COLUMN "channelId" TEXT,
  ADD COLUMN "filterAuthorId" TEXT,
  ADD COLUMN "requestedCount" INTEGER,
  ADD COLUMN "rateLimitSeconds" INTEGER,
  ADD COLUMN "deletedCount" INTEGER;

CREATE TABLE "ChannelLockState" (
  "guildId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "originalSendMessages" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "lockOperationId" TEXT NOT NULL,
  "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "unlockedAt" TIMESTAMP(3),
  CONSTRAINT "ChannelLockState_pkey" PRIMARY KEY ("guildId", "channelId")
);
CREATE INDEX "ChannelLockState_guildId_active_lockedAt_idx" ON "ChannelLockState"("guildId", "active", "lockedAt");
