import type { PrismaClient } from './generated/prisma/client.js';

export type RetentionPolicy = { sessionDays: number; auditDays: number; warningDays: number; batchSize: number; maxBatches: number };

function integer(name: string, fallback: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${name} must be between 1 and ${max}.`);
  return value;
}

export function retentionPolicy(): RetentionPolicy {
  return {
    sessionDays: integer('RETENTION_SESSION_DAYS', 30, 3650),
    auditDays: integer('RETENTION_AUDIT_DAYS', 730, 3650),
    warningDays: integer('RETENTION_WARNING_DAYS', 1095, 3650),
    batchSize: integer('RETENTION_BATCH_SIZE', 100, 1000),
    maxBatches: integer('RETENTION_MAX_BATCHES', 10, 100),
  };
}

/** One bounded maintenance invocation. Schedule externally; never run on request paths. */
export async function pruneRetainedData(client: PrismaClient, now = new Date(), policy = retentionPolicy()) {
  const cutoff = (days: number) => new Date(now.getTime() - days * 86_400_000);
  const deleted = { sessions: 0, configAudits: 0, warnings: 0 };
  for (let batch = 0; batch < policy.maxBatches; batch++) {
    const rows = await client.sessionGrant.findMany({ where: { expiresAt: { lt: cutoff(policy.sessionDays) } }, orderBy: { expiresAt: 'asc' }, take: policy.batchSize, select: { idHash: true } });
    if (!rows.length) break;
    deleted.sessions += (await client.sessionGrant.deleteMany({ where: { idHash: { in: rows.map(row => row.idHash) }, expiresAt: { lt: cutoff(policy.sessionDays) } } })).count;
  }
  for (let batch = 0; batch < policy.maxBatches; batch++) {
    const rows = await client.configAudit.findMany({ where: { createdAt: { lt: cutoff(policy.auditDays) } }, orderBy: { createdAt: 'asc' }, take: policy.batchSize, select: { id: true } });
    if (!rows.length) break;
    deleted.configAudits += (await client.configAudit.deleteMany({ where: { id: { in: rows.map(row => row.id) }, createdAt: { lt: cutoff(policy.auditDays) } } })).count;
  }
  // Action cases retain operationId for replay protection and all expiry/uncertain state.
  // Only completed, non-operational warning history is eligible.
  const warningFilter = { action: 'WARN', status: 'completed', operationId: null, createdAt: { lt: cutoff(policy.warningDays) } } as const;
  for (let batch = 0; batch < policy.maxBatches; batch++) {
    const rows = await client.moderationCase.findMany({ where: warningFilter, orderBy: { createdAt: 'asc' }, take: policy.batchSize, select: { id: true } });
    if (!rows.length) break;
    deleted.warnings += (await client.moderationCase.deleteMany({ where: { ...warningFilter, id: { in: rows.map(row => row.id) } } })).count;
  }
  return deleted;
}
