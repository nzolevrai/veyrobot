import type { PrismaClient } from './generated/prisma/client.js';

/** Call once against an isolated restored database before any API or bot starts. */
export async function quarantineRestoredWork(client: PrismaClient, now = new Date()) {
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
    const expired = await tx.moderationCase.updateMany({
      where: { action: 'TEMPBAN', status: 'succeeded', expiryStatus: 'scheduled', expiresAt: { lte: now } },
      data: { expiryStatus: 'uncertain', expiryResult: 'Restauration ancienne : l’échéance a pu être exécutée après la sauvegarde. Vérifier Discord avant toute reprise.' },
    });
    return { actionsQuarantined: actions.count, temporaryActionsQuarantined: temporaryActionRows.count, expiredSchedulesQuarantined: expired.count };
  });
}
