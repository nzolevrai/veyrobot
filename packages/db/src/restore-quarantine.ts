import type { PrismaClient } from './generated/prisma/client.js';
import { recoveryEpochHash } from './recovery-gate.js';

/** Rotate to a fresh externally managed epoch while quarantining restored work in one transaction. */
export async function quarantineRestoredWork(client: PrismaClient, recoveryEpoch: string, now = new Date()) {
  const epochHash = recoveryEpochHash(recoveryEpoch);
  return client.$transaction(async tx => {
    const actions = await tx.moderationCase.updateMany({
      where: { status: { in: ['requested', 'running'] } },
      data: {
        status: 'uncertain', completedAt: now,
        result: 'Restauration ancienne : une exécution Discord après la sauvegarde ne peut pas être exclue. Réconciliation humaine requise; aucune répétition automatique.',
      },
    });
    const temporaryActionRows = await tx.moderationCase.updateMany({
      where: { status: 'uncertain', action: 'TEMPBAN', expiryStatus: { in: ['pending', 'scheduled', 'running'] } },
      data: { expiryStatus: 'uncertain', expiryResult: 'Restauration ancienne : vérifier le ban dans Discord avant toute reprise.' },
    });
    const scheduled = await tx.moderationCase.updateMany({
      where: { action: 'TEMPBAN', status: 'succeeded', expiryStatus: 'scheduled' },
      data: { expiryStatus: 'uncertain', expiryResult: 'Restauration ancienne : l’état Discord ou une décision ultérieure a pu changer après la sauvegarde. Vérifier l’opération et le ban dans Discord avant toute reprise.' },
    });
    const runningExpiries = await tx.moderationCase.updateMany({
      where: { action: 'TEMPBAN', expiryStatus: 'running' },
      data: { expiryStatus: 'uncertain', expiryResult: 'Restauration ancienne : un débannissement a pu être exécuté après le snapshot. Réconciliation humaine requise; aucun rejeu automatique.' },
    });
    const sessionsRevoked = await tx.sessionGrant.updateMany({ where: { revokedAt: null }, data: { revokedAt: now } });
    await tx.recoveryGate.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', epochHash },
      update: { epochHash },
    });
    return { actionsQuarantined: actions.count, temporaryActionsQuarantined: temporaryActionRows.count, scheduledExpiriesQuarantined: scheduled.count, runningExpiriesQuarantined: runningExpiries.count, sessionsRevoked: sessionsRevoked.count };
  });
}
