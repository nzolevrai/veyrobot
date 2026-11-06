CREATE TABLE "RecoveryGate" (
  "id" VARCHAR(16) NOT NULL DEFAULT 'singleton',
  "epochHash" VARCHAR(64) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RecoveryGate_pkey" PRIMARY KEY ("id")
);
