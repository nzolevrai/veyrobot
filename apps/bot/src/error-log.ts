import { safeDiagnosticText, sanitizedErrorDetails } from '@veyrobot/contracts';

type OperationPhase = 'queue_publish' | 'discord_execution' | 'expiry_execution' | 'lease_reconciliation';
type OperationKind = 'action' | 'expiry';
type OperationOutcome = 'published' | 'deferred' | 'succeeded' | 'failed' | 'uncertain' | 'superseded' | 'not_claimed' | 'lease_lost' | 'completion_conflict' | 'interrupted' | 'reconciled';
type OperationLogEvent = 'moderation_dispatch' | 'moderation_execution' | 'moderation_reconciliation';

export type OperationLogRecord = {
  event: OperationLogEvent;
  operationId?: string;
  caseId?: string;
  phase: OperationPhase;
  kind: OperationKind;
  outcome: OperationOutcome;
  from?: 'running';
  status?: 'requested' | 'running' | 'succeeded' | 'failed' | 'uncertain' | 'scheduled' | 'superseded';
  action?: string;
  durationMs?: number;
};

export type OperationErrorContext = {
  operationId?: string;
  caseId?: string;
  phase?: OperationPhase;
  kind?: OperationKind;
};

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[\w-]{1,128}$/.test(value) ? value : undefined;
}

/** Emit only bounded lifecycle fields; these IDs belong in logs, never metric labels. */
export function logBotOperation(record: OperationLogRecord): void {
  try {
    const fields = {
      event: record.event,
      ...(safeIdentifier(record.operationId) ? { operationId: safeIdentifier(record.operationId) } : {}),
      ...(safeIdentifier(record.caseId) ? { caseId: safeIdentifier(record.caseId) } : {}),
      phase: record.phase,
      kind: record.kind,
      outcome: record.outcome,
      ...(record.from ? { from: record.from } : {}),
      ...(record.status ? { status: record.status } : {}),
      ...(record.action && /^[A-Z_]{1,32}$/.test(record.action) ? { action: record.action } : {}),
      ...(typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) && record.durationMs >= 0 ? { durationMs: Math.round(record.durationMs * 100) / 100 } : {}),
    };
    console.info(JSON.stringify(fields));
  } catch {
    console.info('{"event":"moderation_lifecycle","outcome":"log_failed"}');
  }
}

export function logBotError(event: string, source: string, message: string, error: unknown, context?: OperationErrorContext): void {
  try {
    console.error(JSON.stringify({
      event: safeDiagnosticText(event, 48) ?? 'bot_error',
      source: safeDiagnosticText(source, 80) ?? 'unknown',
      message: safeDiagnosticText(message, 160) ?? 'Bot operation failed.',
      ...(safeIdentifier(context?.operationId) ? { operationId: safeIdentifier(context?.operationId) } : {}),
      ...(safeIdentifier(context?.caseId) ? { caseId: safeIdentifier(context?.caseId) } : {}),
      ...(context?.phase ? { phase: context.phase } : {}),
      ...(context?.kind ? { kind: context.kind } : {}),
      exception: sanitizedErrorDetails(error),
    }));
  } catch {
    console.error('{"event":"bot_error","message":"Bot operation failed."}');
  }
}
