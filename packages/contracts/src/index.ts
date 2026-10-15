export type SessionUser = { id: string; username: string; avatar: string | null };
export type ManagedGuild = { id: string; name: string; icon: string | null; owner: boolean; botInstalled: boolean; botOnline: boolean; canManage: boolean; permissions: string };
export type ModerationCaseDto = { id: string; guildId: string; actorId: string; targetId: string; action: string; reason: string; status: string; createdAt: string };
export const MANAGE_GUILD = 0x20n;
export const MODERATE_MEMBERS = 1099511627776n;
export const ADMINISTRATOR = 0x8n;
export function hasPermissionBits(granted: bigint, required: bigint): boolean {
  return (granted & ADMINISTRATOR) !== 0n || (granted & required) === required;
}
export function canManageGuild(owner: boolean, permissions: string): boolean {
  return owner || hasPermissionBits(BigInt(permissions), MANAGE_GUILD);
}
export function canModerateMembers(owner: boolean, permissions: string): boolean {
  return owner || hasPermissionBits(BigInt(permissions), MODERATE_MEMBERS);
}
export { safeDiagnosticCode, safeDiagnosticText, sanitizedErrorDetails } from './error-details.js';
export type { SanitizedErrorDetails } from './error-details.js';
