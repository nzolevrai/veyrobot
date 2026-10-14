ALTER TABLE "ModerationCase"
ADD COLUMN "expiresAt" TIMESTAMP(3),
ADD COLUMN "banMarker" TEXT,
ADD COLUMN "expiryStatus" TEXT,
ADD COLUMN "expiryStartedAt" TIMESTAMP(3),
ADD COLUMN "unbannedAt" TIMESTAMP(3),
ADD COLUMN "expiryResult" TEXT;

CREATE INDEX "ModerationCase_expiryStatus_expiresAt_idx"
ON "ModerationCase"("expiryStatus", "expiresAt");
