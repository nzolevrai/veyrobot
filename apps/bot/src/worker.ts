import { DiscordAPIError, type Client } from 'discord.js';
import { Worker, type ConnectionOptions } from 'bullmq';

type Store = typeof import('@veyrobot/db').prisma;
type Services = typeof import('@veyrobot/moderation');
export type WorkerAttempt = { operationId: string; guildId: string; kind: 'action' | 'expiry'; createdAt: Date; scheduledAt?: Date };
export type WorkerTelemetry = { onAttemptStarted?: (attempt: WorkerAttempt) => void; onAttemptFinished?: (guildId: string, operationId: string) => void; onGuildBusySkip?: (guildId: string, operationId: string) => void };

export function createModerationWorker(client: Client, connection: ConnectionOptions, prisma: Store, moderation: Services, rejectPendingAfterDisable: typeof import('@veyrobot/db').rejectPendingAfterDisable, onDrained: () => void, telemetry?: WorkerTelemetry, queueName = 'veyrobot-moderation'): Worker {
  const { executeModerationAction, expireTemporaryBan } = moderation;
const activeGuilds = new Set<string>();
  return new Worker(queueName, async job => {
  if (!client.isReady()) return; // PostgreSQL keeps the request pending for the next Ready/reconciliation.
  const guildId = String((job.data as { guildId: string }).guildId);
  // A busy guild cannot occupy every worker slot. Skipped jobs remain requested
  // in PostgreSQL and are republished by the reconciler after this guild drains.
  if (activeGuilds.has(guildId)) { telemetry?.onGuildBusySkip?.(guildId, String((job.data as { operationId?: string }).operationId ?? '')); return; }
  activeGuilds.add(guildId);
  try {
  if (job.name === 'temporary-ban-expiry') {
    const { caseId, guildId } = job.data as { caseId: string; guildId: string };
    const row = await prisma.moderationCase.findUnique({ where: { id: caseId } });
    if (!row || row.guildId !== guildId) return;
    telemetry?.onAttemptStarted?.({ operationId: `expiry-${row.id}`, guildId, kind: 'expiry', createdAt: row.createdAt, ...(row.expiresAt ? { scheduledAt: row.expiresAt } : {}) });
    let guild = client.guilds.cache.get(guildId);
    if (!guild) {
      try { guild = await client.guilds.fetch(guildId); } catch (error) {
        if (!(error instanceof DiscordAPIError) || (error.status !== 403 && error.status !== 404)) throw error;
        await prisma.moderationCase.updateMany({ where: { id: row.id, expiryStatus: 'scheduled' }, data: { expiryStatus: 'failed', expiryResult: 'Le bot ne peut pas accéder à ce serveur. Rétablissez son accès avant de créer une nouvelle demande.' } });
        return;
      }
    }
    if (!guild) {
      await prisma.moderationCase.update({ where: { id: row.id }, data: { expiryStatus: 'failed', expiryResult: 'Le bot ne peut plus accéder à ce serveur. Réactivez la planification après avoir restauré son accès.' } });
      return;
    }
    const began = performance.now();
    try { await expireTemporaryBan({ guild, caseRecord: row, store: prisma }); }
    finally { console.info(JSON.stringify({ event: 'moderation_expiry_attempt', operationId: row.operationId, caseId: row.id, durationMs: +(performance.now() - began).toFixed(2) })); telemetry?.onAttemptFinished?.(guildId, `expiry-${row.id}`); }
    return;
  }
  const { operationId } = job.data as { operationId: string; guildId: string };
  const row = await prisma.moderationCase.findUnique({ where: { operationId } });
  if (!row || row.guildId !== guildId || row.status !== 'requested') return;
  // A request accepted before a switch was disabled remains committed. A request
  // created after disable (for example from an old API process) is rejected here.
  const moduleConfig = await prisma.guildConfig.findUnique({ where: { guildId } });
  if (rejectPendingAfterDisable(moduleConfig, row.action, row.createdAt)) {
    await prisma.moderationCase.updateMany({ where: { id: row.id, status: 'requested' }, data: { status: 'failed', completedAt: new Date(), result: 'Module désactivé avant la demande : aucune action Discord envoyée.' } });
    return;
  }
  let guild = client.guilds.cache.get(guildId);
  if (!guild) {
    try { guild = await client.guilds.fetch(guildId); } catch (error) {
      if (!(error instanceof DiscordAPIError) || (error.status !== 403 && error.status !== 404)) throw error;
      await prisma.moderationCase.updateMany({ where: { id: row.id, status: 'requested' }, data: { status: 'failed', completedAt: new Date(), result: 'Le bot ne peut pas accéder au serveur; aucune action Discord n’a été envoyée.' } });
      return;
    }
  }
  if (!guild) {
    await prisma.moderationCase.update({ where: { id: row.id }, data: { status: 'failed', completedAt: new Date(), result: 'Le bot ne peut pas accéder au serveur; aucune action Discord n’a été envoyée.' } });
    return;
  }
  telemetry?.onAttemptStarted?.({ operationId, guildId, kind: 'action', createdAt: row.createdAt });
  const began = performance.now();
  try { await executeModerationAction({ operationId, guild, caseRecord: row, store: prisma }); }
  finally { console.info(JSON.stringify({ event: 'moderation_action_attempt', operationId, caseId: row.id, action: row.action, durationMs: +(performance.now() - began).toFixed(2) })); telemetry?.onAttemptFinished?.(guildId, operationId); }
  } finally {
    activeGuilds.delete(guildId);
    onDrained();
  }
}, { connection, concurrency: 4, autorun: true });

}
