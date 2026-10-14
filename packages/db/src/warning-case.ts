export type WarningCaseInput = {
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
