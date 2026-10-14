'use client';

import { AlertCircle, CheckCircle2, ClipboardList, Clock3, Server, Shield, XCircle } from 'lucide-react';
import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import type { Guild, GuildConfig, ModerationCase } from './dashboard-types';
export const PreferencesContext = createContext<GuildConfig | null>(null);

const actionLabels: Record<string, string> = {
  WARN: 'Avertissement', TIMEOUT: 'Timeout', UNTIMEOUT: 'Fin du timeout', KICK: 'Expulsion',
  BAN: 'Bannissement', UNBAN: 'Débannissement', TEMPBAN: 'Ban temporaire',
  PURGE_MESSAGES: 'Suppression de messages', SLOWMODE: 'Slowmode', LOCK_CHANNEL: 'Verrouillage', UNLOCK_CHANNEL: 'Restauration',
};
export const statusLabels: Record<string, string> = {
  completed: 'Enregistré', requested: 'Demandé', running: 'En cours', succeeded: 'Réussi', failed: 'Échoué', uncertain: 'À vérifier',
};

function discordImage(id: string, hash: string | null) {
  return hash ? `https://cdn.discordapp.com/icons/${id}/${hash}.png?size=96` : null;
}

export function Brand() {
  return <span className="brand"><span className="brand-mark"><Shield size={20} strokeWidth={2.4} aria-hidden="true" /></span><span>VeyroBot</span></span>;
}

export function GuildIcon({ guild }: { guild: Guild }) {
  const image = discordImage(guild.id, guild.icon);
  return image ? <span className="guild-icon" role="img" aria-label={`Icône de ${guild.name}`} style={{ backgroundImage: `url("${image}")` }} /> : <span className="guild-icon guild-icon-fallback" aria-hidden="true"><Server size={18} /></span>;
}

export function PageHeader({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return <div className="page-header"><div><h1>{title}</h1>{description && <p>{description}</p>}</div>{children && <div className="page-header-actions">{children}</div>}</div>;
}

export function Notice({ tone, children }: { tone: 'error' | 'success' | 'info' | 'warning'; children: ReactNode }) {
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'error' ? XCircle : tone === 'warning' ? AlertCircle : Clock3;
  return <div className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}><Icon size={18} aria-hidden="true" /><span>{children}</span></div>;
}

export function EmptyState({ title, description }: { title: string; description: string }) {
  return <div className="empty-state"><span className="empty-icon"><ClipboardList size={21} /></span><strong>{title}</strong><p>{description}</p></div>;
}

export function CaseTable({ items, emptyText }: { items: ModerationCase[]; emptyText: string }) {
  const settings = useContext(PreferencesContext);
  const locale = settings?.language === 'en' ? 'en-US' : 'fr-FR';
  const timeZone = settings?.timeZone ?? 'UTC';
  if (!items.length) return <EmptyState title="Aucun dossier à afficher" description={emptyText} />;
  return <div className="table-scroll" role="region" aria-label="Dossiers de modération" tabIndex={0}><table className="case-table"><thead><tr><th scope="col">Action</th><th scope="col">Cible</th><th scope="col">Raison et résultat</th><th scope="col">État</th><th scope="col">Date</th></tr></thead><tbody>{items.map(item => <tr key={item.id}><td><strong>{actionLabels[item.action] ?? item.action}</strong><small className="case-id">{item.id.slice(0, 8)}</small></td><td><code>{item.targetId}</code></td><td className="reason-cell"><span>{item.reason}</span>{item.result && <small>{item.result}</small>}{item.deletedCount !== null && item.deletedCount !== undefined && <small>{item.deletedCount} message(s) supprimé(s)</small>}{item.expiresAt && <small>Échéance : {new Date(item.expiresAt).toLocaleString(locale, { timeZone })}</small>}{item.expiryResult && <small>{item.expiryResult}</small>}</td><td><span className={`status-badge status-${item.status}`}>{statusLabels[item.status] ?? item.status}</span></td><td><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short', timeZone })}</time><small className="case-actor">Par {item.actorId}</small></td></tr>)}</tbody></table></div>;
}

export function ConfirmDialog({ open, title, description, confirmLabel, onCancel, onConfirm }: { open: boolean; title: string; description: string; confirmLabel: string; onCancel: () => void; onConfirm: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return <dialog ref={ref} className="confirm-dialog" aria-labelledby="confirm-title" aria-describedby="confirm-description" onCancel={onCancel}><div className="dialog-icon"><AlertCircle size={22} /></div><h2 id="confirm-title">{title}</h2><p id="confirm-description">{description}</p><div className="dialog-actions"><button className="button button-secondary" type="button" onClick={onCancel}>Annuler</button><button className="button button-danger" type="button" onClick={onConfirm}>{confirmLabel}</button></div></dialog>;
}
