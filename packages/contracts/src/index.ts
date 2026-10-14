export type SessionUser = { id: string; username: string; avatar: string | null };
export type ManagedGuild = { id: string; name: string; icon: string | null; owner: boolean; botInstalled: boolean; botOnline: boolean; canManage: boolean; permissions: string };
export type ModerationCaseDto = { id: string; guildId: string; actorId: string; targetId: string; action: string; reason: string; status: string; createdAt: string };
export const MANAGE_GUILD = 0x20n;
export const MODERATE_MEMBERS = 1099511627776n;
export function canManageGuild(owner: boolean, permissions: string): boolean {
  return owner || (BigInt(permissions) & MANAGE_GUILD) !== 0n;
}
export function canModerateMembers(owner: boolean, permissions: string): boolean {
  return owner || (BigInt(permissions) & MODERATE_MEMBERS) !== 0n;
}
