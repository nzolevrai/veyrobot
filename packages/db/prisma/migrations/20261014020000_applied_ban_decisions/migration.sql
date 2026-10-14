ALTER TABLE "GuildTargetDecision"
  ADD COLUMN "appliedGeneration" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "appliedOperationId" TEXT;

UPDATE "GuildTargetDecision" decision
SET "appliedGeneration" = COALESCE((
      SELECT MAX(c."banGeneration")
      FROM "ModerationCase" c
      WHERE c."guildId" = decision."guildId"
        AND c."targetId" = decision."targetId"
        AND c."action" IN ('BAN', 'TEMPBAN', 'UNBAN')
        AND c."status" = 'succeeded'
    ), 0),
    "appliedOperationId" = (
      SELECT c."operationId"
      FROM "ModerationCase" c
      WHERE c."guildId" = decision."guildId"
        AND c."targetId" = decision."targetId"
        AND c."action" IN ('BAN', 'TEMPBAN', 'UNBAN')
        AND c."status" = 'succeeded'
      ORDER BY c."banGeneration" DESC NULLS LAST
      LIMIT 1
    );
