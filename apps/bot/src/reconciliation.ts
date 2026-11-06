import { markInterruptedOperationsUncertain } from '@veyrobot/moderation';
import { logBotOperation } from './error-log.js';

type Store = typeof import('@veyrobot/db').prisma;

/** Reconcile stale durable claims and emit one structured record per won transition. */
export async function reconcileInterruptedModeration(store: Store, now = new Date()): Promise<void> {
  const transitions = await markInterruptedOperationsUncertain(store, now);
  for (const transition of transitions) {
    logBotOperation({
      event: 'moderation_reconciliation',
      ...(transition.operationId ? { operationId: transition.operationId } : {}),
      caseId: transition.caseId,
      phase: 'lease_reconciliation',
      kind: transition.kind,
      outcome: 'reconciled',
      from: transition.from,
      status: transition.to,
      ...(transition.kind === 'expiry' ? { action: 'TEMPBAN' } : {}),
    });
  }
}
