'use client';

import { LoaderCircle, MessageSquareWarning } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { CaseTable, Notice, PageHeader } from './components';
import { createWarningThenRefresh } from './warning-submission';
import type { Guild, ModerationCase } from './dashboard-types';

export function WarningsView({ guild, enabled, csrf, recentCases, loading, onCreated, onUnauthorized, hideHeader = false }: { guild: Guild; enabled: boolean; csrf: string; recentCases: ModerationCase[]; loading: boolean; onCreated: () => Promise<boolean>; onUnauthorized: () => void; hideHeader?: boolean }) {
  const [target, setTarget] = useState(''); const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setBusy(true); setNotice(null); try {
    const result = await createWarningThenRefresh(async () => {
      const response = await fetch(`/api/guilds/${guild.id}/warnings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetId: target, reason, csrf }) });
      if (response.status === 401) { onUnauthorized(); return null; }
      const data = await response.json() as { id?: string; error?: string };
      if (!response.ok || !data.id) throw new Error(data.error ?? 'Impossible d’enregistrer cet avertissement.');
      return data;
    }, onCreated);
    if (!result.created) return;
    setTarget(''); setReason('');
    setNotice({ tone: 'success', text: `Avertissement enregistré dans le dossier ${result.created.id}.` });
  } catch (cause) { setNotice({ tone: 'error', text: cause instanceof Error ? cause.message : 'Erreur de connexion.' }); } finally { setBusy(false); } };
  return <>{!hideHeader && <PageHeader title="Avertissements" description="Ajoutez un avertissement et consultez les derniers dossiers concernés." />}<div className="form-layout"><section className="surface section-panel form-panel"><div className="section-heading"><div><h2>Nouvel avertissement</h2><p>Un avertissement crée une note dans le dossier du membre.</p></div></div>{guild.botOnline && enabled ? <form onSubmit={event => void submit(event)}><label className="field"><span>ID utilisateur Discord</span><input className="text-input" value={target} onChange={event => setTarget(event.target.value)} inputMode="numeric" pattern="[0-9]{17,20}" minLength={17} maxLength={20} required placeholder="123456789012345678" /></label><label className="field"><span>Raison</span><textarea className="text-input textarea-input" value={reason} onChange={event => setReason(event.target.value)} required maxLength={500} placeholder="Décrivez les faits observés" /></label><div className="form-footer"><span>{reason.length}/500 caractères</span><button className="button button-primary" disabled={busy} type="submit">{busy ? <><LoaderCircle className="spin" size={17} /> Enregistrement…</> : <><MessageSquareWarning size={17} /> Enregistrer</>}</button></div></form> : <Notice tone="warning">Activez le module Avertissements et attendez que le bot soit en ligne pour créer un avertissement.</Notice>}{notice && <Notice tone={notice.tone}>{notice.text}</Notice>}</section><section className="surface section-panel"><div className="section-heading"><div><h2>Avertissements récents</h2><p>Cette liste montre les avertissements parmi les 25 derniers dossiers.</p></div></div>{loading && !recentCases.length ? <div className="loading-row"><LoaderCircle className="spin" size={18} /> Chargement…</div> : <CaseTable items={recentCases.filter(item => item.action === 'WARN')} emptyText="Aucun avertissement parmi les dossiers récents." />}</section></div></>;
}
