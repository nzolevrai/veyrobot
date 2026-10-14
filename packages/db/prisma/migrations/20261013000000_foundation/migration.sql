-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "ModerationCase" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModerationCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuildConfig" (
    "guildId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "logChannelId" TEXT,

    CONSTRAINT "GuildConfig_pkey" PRIMARY KEY ("guildId")
);

-- CreateTable
CREATE TABLE "ConfigAudit" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "changes" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConfigAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuildPresence" (
    "guildId" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shardId" INTEGER NOT NULL,

    CONSTRAINT "GuildPresence_pkey" PRIMARY KEY ("guildId")
);

-- CreateIndex
CREATE INDEX "ModerationCase_guildId_createdAt_idx" ON "ModerationCase"("guildId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ModerationCase_guildId_targetId_createdAt_idx" ON "ModerationCase"("guildId", "targetId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "GuildConfig_updatedAt_idx" ON "GuildConfig"("updatedAt");

-- CreateIndex
CREATE INDEX "ConfigAudit_guildId_createdAt_idx" ON "ConfigAudit"("guildId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "GuildPresence_lastSeenAt_idx" ON "GuildPresence"("lastSeenAt");
