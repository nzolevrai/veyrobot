-- Run only on a disposable PostgreSQL database. The transaction is rolled back.
BEGIN;
INSERT INTO "ModerationCase" ("id", "operationId", "guildId", "actorId", "targetId", "action", "reason", "status", "createdAt", "expiryStatus", "expiresAt")
SELECT 'plan-' || n, 'plan-op-' || n, 'guild-' || (n % 500), 'actor', 'target',
  CASE WHEN n % 50 = 0 THEN 'TEMPBAN' ELSE 'KICK' END, 'plan fixture',
  CASE WHEN n % 100 = 0 THEN 'running' WHEN n % 5 = 0 THEN 'requested' ELSE 'succeeded' END,
  now() - (n || ' seconds')::interval,
  CASE WHEN n % 50 = 0 THEN 'scheduled' ELSE NULL END,
  CASE WHEN n % 50 = 0 THEN now() - interval '1 minute' ELSE NULL END
FROM generate_series(1, 10000) n;
ANALYZE "ModerationCase";
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT c."guildId", c."operationId", c."action"
FROM "ModerationCase" c
JOIN (
  SELECT chosen."id", chosen."createdAt"
  FROM (
    SELECT DISTINCT ON (candidate."guildId") candidate."id", candidate."guildId", candidate."createdAt"
    FROM "ModerationCase" candidate
    WHERE candidate."status" = 'requested' AND candidate."operationId" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "ModerationCase" active WHERE active."guildId" = candidate."guildId" AND active."status" = 'running')
    ORDER BY candidate."guildId", candidate."createdAt", candidate."id"
  ) chosen
  ORDER BY chosen."createdAt" LIMIT 100
) ready ON ready."id" = c."id" ORDER BY ready."createdAt";
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT "id", "guildId" FROM "ModerationCase"
WHERE "action"='TEMPBAN' AND "status"='succeeded' AND "expiryStatus"='scheduled' AND "expiresAt" <= now()
ORDER BY "expiresAt" LIMIT 100;
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT "id" FROM "ConfigAudit" WHERE "createdAt" < now() - interval '730 days' ORDER BY "createdAt" LIMIT 100;
ROLLBACK;
