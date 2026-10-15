CREATE TABLE "SessionGrant" (
  "idHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "SessionGrant_pkey" PRIMARY KEY ("idHash")
);
CREATE INDEX "SessionGrant_expiresAt_idx" ON "SessionGrant"("expiresAt");
