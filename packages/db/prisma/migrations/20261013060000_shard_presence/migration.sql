CREATE TABLE "ShardPresence" (
  "shardId" INTEGER NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShardPresence_pkey" PRIMARY KEY ("shardId")
);
