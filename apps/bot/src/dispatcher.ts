import type { Queue } from 'bullmq';

type Store = typeof import('@veyrobot/db').prisma;
export type DispatchPublication = { operationId: string; guildId: string; kind: 'action' | 'expiry'; enqueueStartedAt: number };

/** PostgreSQL is the outbox; Redis is only a wake-up and delivery mechanism. */
export function createDispatcher(prisma: Store, queue: Queue, isReady: () => boolean, logThrottled: (key: string, message: string, error: unknown) => void, onPublished?: (publication: DispatchPublication) => void): () => Promise<void> {
  let dispatching = false;
  let producer: { status: string } | undefined;
  // Queue.add may wait indefinitely for its initial Redis connection. Keep the
  // durable SQL request pending until the producer is actually connected.
  void queue.getBackend().client.then(client => { producer = client; }).catch(error => logThrottled('moderation-queue-connect', 'moderation queue connection unavailable', error));
  const dispatchRequested = async () => {
    if (dispatching || !isReady() || producer?.status !== 'ready') return;
    dispatching = true;
    try {
      const pending = await prisma.$queryRaw<Array<{ guildId: string; operationId: string; action: string }>>`
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
          ORDER BY chosen."createdAt"
          LIMIT 100
        ) ready ON ready."id" = c."id"
        ORDER BY ready."createdAt"
      `;
      for (const item of pending) {
        try {
          onPublished?.({ operationId: item.operationId, guildId: item.guildId, kind: 'action', enqueueStartedAt: Date.now() });
          await queue.add('moderation-action', { guildId: item.guildId, operationId: item.operationId }, { jobId: item.operationId, attempts: 1, priority: item.action === 'PURGE_MESSAGES' ? 20 : 1, removeOnComplete: true, removeOnFail: true });
        }
        catch (error) { logThrottled('moderation-queue-dispatch', 'moderation queue dispatch failed; PostgreSQL request remains durable', error); break; }
      }
      const expired = await prisma.moderationCase.findMany({ where: { action: 'TEMPBAN', status: 'succeeded', expiryStatus: 'scheduled', expiresAt: { lte: new Date() } }, orderBy: { expiresAt: 'asc' }, take: 100, select: { id: true, guildId: true } });
      for (const item of expired) {
        try {
          onPublished?.({ operationId: `expiry-${item.id}`, guildId: item.guildId, kind: 'expiry', enqueueStartedAt: Date.now() });
          await queue.add('temporary-ban-expiry', { caseId: item.id, guildId: item.guildId }, { jobId: `tempban-${item.id}`, attempts: 3, priority: 10, removeOnComplete: true, removeOnFail: true });
        }
        catch (error) { logThrottled('temporary-ban-dispatch', 'temporary ban expiry dispatch failed; PostgreSQL schedule remains durable', error); break; }
      }
    } catch (error) { logThrottled('moderation-request-reconcile', 'moderation request reconciliation failed', error); }
    finally { dispatching = false; }
  };
  return dispatchRequested;
}
