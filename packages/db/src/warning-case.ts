export type WarningCaseInput = {
  operationId?: string;
  guildId: string;
  actorId: string;
  targetId: string;
  reason: string;
};

export type WarningCaseData = WarningCaseInput & {
  action: 'WARN';
  status: 'completed';
};

export function persistWarningCase<T>(
  writer: { create(args: { data: WarningCaseData }): Promise<T> },
  input: WarningCaseInput,
): Promise<T> {
  return writer.create({ data: { ...input, action: 'WARN', status: 'completed' } });
}

export function isSameWarningReplay(existing: {
  operationId: string | null; guildId: string; actorId: string; targetId: string; action: string; reason: string;
}, input: WarningCaseInput & { operationId: string }): boolean {
  return existing.operationId === input.operationId && existing.action === 'WARN'
    && existing.guildId === input.guildId && existing.actorId === input.actorId
    && existing.targetId === input.targetId && existing.reason === input.reason.trim();
}

export function isReplayConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 'P2002' || code === 'P2034';
}
