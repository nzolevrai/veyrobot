import type { GuildConfig } from './dashboard-types';

export type EditableKey = 'warningsEnabled' | 'memberActionsEnabled' | 'channelActionsEnabled' | 'language' | 'timeZone' | 'embedColor';
export type ConfigChanges = Partial<Pick<GuildConfig, EditableKey>>;
export const editableKeys: readonly EditableKey[] = ['warningsEnabled', 'memberActionsEnabled', 'channelActionsEnabled', 'language', 'timeZone', 'embedColor'];
export function changedConfig(saved: GuildConfig | null, draft: GuildConfig | null): ConfigChanges {
  if (!saved || !draft) return {};
  const changes: ConfigChanges = {};
  for (const key of editableKeys) if (saved[key] !== draft[key]) Object.assign(changes, { [key]: draft[key] });
  return changes;
}
export function hasConfigChanges(saved: GuildConfig | null, draft: GuildConfig | null): boolean { return Object.keys(changedConfig(saved, draft)).length > 0; }
export function rebaseConfig(previous: GuildConfig, draft: GuildConfig, latest: GuildConfig): GuildConfig { return { ...latest, ...changedConfig(previous, draft) }; }
