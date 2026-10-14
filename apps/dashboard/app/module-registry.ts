import { ClipboardList, Gavel, MessageSquareWarning, MessagesSquare, UserRoundPlus, UserRoundCog, type LucideIcon } from 'lucide-react';
import type { Guild, View } from './dashboard-types';
export type ModuleCategory = 'Accueil des membres' | 'Modération des membres' | 'Modération des salons' | 'Suivi';
export type ModuleId = 'welcome' | 'auto-roles' | 'warnings' | 'member-actions' | 'channel-actions' | 'records';
export type EnabledModuleId = 'warnings' | 'member-actions' | 'channel-actions';
export type ModuleDefinition = { id: ModuleId; title: string; category: ModuleCategory; description: string; keywords: readonly string[]; icon: LucideIcon; destination?: View; implemented: boolean; enabledKey?: 'warningsEnabled' | 'memberActionsEnabled' | 'channelActionsEnabled'; requiredUserPermission?: bigint; anyUserPermission?: bigint; permissionLabel?: string };
export const moduleCategories: readonly ModuleCategory[] = ['Accueil des membres', 'Modération des membres', 'Modération des salons', 'Suivi'];
export const moduleRegistry: readonly ModuleDefinition[] = [
  { id: 'welcome', title: 'Arrivées et départs', category: 'Accueil des membres', description: 'Messages et suivi des entrées et sorties.', keywords: ['bienvenue', 'départ', 'join'], icon: UserRoundPlus, implemented: false },
  { id: 'auto-roles', title: 'Rôles automatiques', category: 'Accueil des membres', description: 'Attribution de rôles à l’arrivée.', keywords: ['role', 'attribution'], icon: UserRoundCog, implemented: false },
  { id: 'warnings', title: 'Avertissements', category: 'Modération des membres', description: 'Ajouter un avertissement et consulter son dossier.', keywords: ['warn', 'sanction', 'membre'], icon: MessageSquareWarning, destination: 'warnings', implemented: true, enabledKey: 'warningsEnabled', requiredUserPermission: 1n << 40n, permissionLabel: 'Modérer les membres' },
  { id: 'member-actions', title: 'Actions sur membres', category: 'Modération des membres', description: 'Timeout, expulsion et bannissement suivis dans le dossier.', keywords: ['timeout', 'kick', 'ban', 'unban'], icon: Gavel, destination: 'actions', implemented: true, enabledKey: 'memberActionsEnabled', anyUserPermission: (1n << 40n) | (1n << 1n) | (1n << 2n), permissionLabel: 'Modérer, expulser ou bannir des membres' },
  { id: 'channel-actions', title: 'Actions sur salons', category: 'Modération des salons', description: 'Suppression bornée, slowmode et verrouillage.', keywords: ['purge', 'slowmode', 'verrouillage', 'salon'], icon: MessagesSquare, destination: 'actions', implemented: true, enabledKey: 'channelActionsEnabled', anyUserPermission: (1n << 13n) | (1n << 4n) | (1n << 28n), permissionLabel: 'Gérer les messages, les salons ou les rôles' },
  { id: 'records', title: 'Dossiers et historique', category: 'Suivi', description: 'Consulter les décisions et leurs résultats.', keywords: ['dossier', 'historique', 'journal'], icon: ClipboardList, destination: 'cases', implemented: true },
];
export function normalizeModuleSearch(value: string): string { return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr').trim(); }
export function searchModules(query: string): ModuleDefinition[] { const needle = normalizeModuleSearch(query); return moduleRegistry.filter(module => !needle || normalizeModuleSearch([module.title, module.description, ...module.keywords].join(' ')).includes(needle)); }
export function moduleAvailability(module: ModuleDefinition, guild: Guild): { label: string; tone: 'ready' | 'caution' | 'muted'; detail?: string } {
  if (!module.implemented) return { label: 'Indisponible', tone: 'muted', detail: 'Cette fonction n’est pas encore disponible.' };
  if (!guild.botInstalled) return { label: 'Bot absent', tone: 'caution', detail: 'Invitez Veyro pour utiliser cette fonction.' };
  if (!guild.botOnline && module.id !== 'records') return { label: 'Bot hors ligne', tone: 'caution', detail: 'Les nouvelles actions sont temporairement indisponibles.' };
  if (!guild.owner && module.requiredUserPermission && guild.permissions && /^\d+$/.test(guild.permissions) && (BigInt(guild.permissions) & module.requiredUserPermission) === 0n) return { label: 'Accès limité', tone: 'caution', detail: `Permission utilisateur manquante : ${module.permissionLabel}.` };
  if (!guild.owner && module.anyUserPermission && guild.permissions && /^\d+$/.test(guild.permissions) && (BigInt(guild.permissions) & module.anyUserPermission) === 0n) return { label: 'Accès limité', tone: 'caution', detail: `Aucune des permissions requises n’est disponible : ${module.permissionLabel}.` };
  return { label: 'Disponible', tone: 'ready' };
}
