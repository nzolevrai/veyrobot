'use client';

import { ArrowRight, ChevronLeft, ChevronRight, Gavel, LoaderCircle, MessageSquareWarning, Search, SlidersHorizontal, Wifi, WifiOff } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { CaseTable, ConfirmDialog, GuildIcon, Notice, PageHeader, statusLabels } from './components';
import { createWarningThenRefresh } from './warning-submission';
import { failureReference, historyFailureMessage, readApiFailure, retryAfterDelayMs } from './api-failure';
import type { Guild, ModerationCase, View } from './dashboard-types';

export function OverviewView({ guild, cases, loading, onView }: { guild: Guild; cases: ModerationCase[]; loading: boolean; onView: (view: View) => void }) {
  const warnings = cases.filter(item => item.action === 'WARN').length;
  return <>
    <PageHeader title="Vue d’ensemble" description={`La modération de ${guild.name} en un coup d’œil.`}>
      <button className="button button-primary" type="button" onClick={() => onView('warnings')}><MessageSquareWarning size={17} /> Nouvel avertissement</button>
    </PageHeader>
    <div className="overview-summary">
      <section className="surface server-summary"><GuildIcon guild={guild} /><div><span className="overline">SERVEUR ACTIF</span><h2>{guild.name}</h2><span className={`availability-line${guild.botOnline ? ' is-ready' : ''}`}>{guild.botOnline ? <Wifi size={15} /> : <WifiOff size={15} />}{guild.botOnline ? 'Bot en ligne' : 'Bot installé, hors ligne'}</span></div></section>
      <section className="surface summary-tile"><span className="overline">DOSSIERS RÉCENTS CHARGÉS</span><strong>{loading ? '…' : cases.length}</strong><span>sur les 25 derniers au maximum</span></section>
      <section className="surface summary-tile"><span className="overline">AVERTISSEMENTS</span><strong>{loading ? '…' : warnings}</strong><span>parmi les dossiers chargés</span></section>
    </div>
    <div className="overview-columns">
      <section className="surface section-panel"><div className="section-heading"><div><h2>Activité récente</h2><p>Décisions et demandes enregistrées pour ce serveur.</p></div><button className="text-button" type="button" onClick={() => onView('cases')}>Voir les dossiers <ArrowRight size={16} /></button></div>{loading && !cases.length ? <div className="loading-row"><LoaderCircle className="spin" size={18} /> Chargement des dossiers…</div> : <CaseTable items={cases.slice(0, 5)} emptyText="Les avertissements et actions enregistrés apparaîtront ici." />}</section>
      <section className="surface section-panel quick-panel"><div className="section-heading"><div><h2>Accès rapides</h2><p>Les tâches de modération courantes.</p></div></div><button className="quick-link" type="button" onClick={() => onView('warnings')}><span className="quick-icon"><MessageSquareWarning size={18} /></span><span><strong>Avertir un membre</strong><small>Créer une note dans son dossier</small></span><ArrowRight size={17} /></button><button className="quick-link" type="button" onClick={() => onView('actions')}><span className="quick-icon"><Gavel size={18} /></span><span><strong>Demander une action</strong><small>Timeout, ban ou action sur salon</small></span><ArrowRight size={17} /></button><button className="quick-link" type="button" onClick={() => onView('settings')}><span className="quick-icon"><SlidersHorizontal size={18} /></span><span><strong>Param?tres du serveur</strong><small>Langue, fuseau et embeds</small></span><ArrowRight size={17} /></button></section>
    </div>
  </>;
}

export function CasesView({ guild, onUnauthorized }: { guild: Guild; onUnauthorized: () => void }) {
  const [items, setItems] = useState<ModerationCase[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<(string | null)[]>([]);
  const [targetInput, setTargetInput] = useState('');
  const [targetFilter, setTargetFilter] = useState('');
  const [localQuery, setLocalQuery] = useState('');
  const [actionFilter, setActionFilter] = useState('Toutes');
  const [statusFilter, setStatusFilter] = useState('Tous');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [retryUntil, setRetryUntil] = useState(0);
  const retryUntilRef = useRef(0);
  useEffect(() => {
    const delay = retryUntil - Date.now();
    if (delay <= 0) return;
    const timer = setTimeout(() => setRetryUntil(0), delay);
    return () => clearTimeout(timer);
  }, [retryUntil]);

  useEffect(() => {
    const controller = new AbortController();
    if (Date.now() < retryUntilRef.current) { setLoading(false); return () => controller.abort(); }
    const params = new URLSearchParams({ limit: '25' });
    if (cursor) params.set('cursor', cursor);
    if (targetFilter) params.set('targetId', targetFilter);
    void (async () => {
      try {
        const response = await fetch(`/api/guilds/${guild.id}/cases?${params}`, { signal: controller.signal });
        if (response.status === 401) { onUnauthorized(); return; }
        if (!response.ok) {
          const failure = await readApiFailure(response);
          const delay = retryAfterDelayMs(failure.retryAfter);
          if (delay !== undefined && delay > 0) { const until = Date.now() + delay; retryUntilRef.current = until; setRetryUntil(until); }
          setError(`${historyFailureMessage(failure)}${failureReference(failure)}`);
          return;
        }
        const data = await response.json() as { items: ModerationCase[]; nextCursor: string | null };
        if (controller.signal.aborted) return;
        setItems(data.items); setNextCursor(data.nextCursor); setError(''); retryUntilRef.current = 0; setRetryUntil(0);
      } catch (cause) { if (!controller.signal.aborted) setError(`Historique temporairement impossible à actualiser. Les dossiers affichés sont conservés. ${cause instanceof Error ? cause.message : 'Erreur de chargement.'}`); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [guild.id, cursor, targetFilter, revision, onUnauthorized]);

  const displayed = useMemo(() => items.filter(item => {
    if (actionFilter !== 'Toutes' && item.action !== actionFilter) return false;
    if (statusFilter !== 'Tous' && item.status !== statusFilter) return false;
    const query = localQuery.trim().toLocaleLowerCase('fr');
    return !query || [item.id, item.targetId, item.actorId, item.reason].some(value => value.toLocaleLowerCase('fr').includes(query));
  }), [items, actionFilter, statusFilter, localQuery]);
  const applyTarget = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (targetInput && !/^\d{17,20}$/.test(targetInput)) { setError('Entrez un identifiant Discord valide, ou laissez le champ vide.'); return; } setItems([]); setNextCursor(null); setCursor(null); setHistory([]); setTargetFilter(targetInput); setLoading(true); setRevision(value => value + 1); };
  return <>
    <PageHeader title="Dossiers et historique" description="Recherchez les décisions enregistrées pour ce serveur." />
    <section className="surface section-panel"><div className="section-heading"><div><h2>Rechercher un dossier</h2><p>Filtrez par membre sur toutes les pages, puis affinez la page affichée.</p></div></div><form className="case-search-form" onSubmit={applyTarget}><label className="field"><span>ID utilisateur Discord</span><input className="text-input" value={targetInput} onChange={event => setTargetInput(event.target.value)} inputMode="numeric" placeholder="Tous les membres" /></label><button className="button button-secondary" type="submit">Rechercher</button></form><div className="case-local-filters"><label className="search-field"><Search size={16} aria-hidden="true" /><span className="sr-only">Chercher dans la page affichée</span><input value={localQuery} onChange={event => setLocalQuery(event.target.value)} placeholder="Dans cette page : raison, ID…" /></label><label className="sr-label"><span className="sr-only">Action</span><select value={actionFilter} onChange={event => setActionFilter(event.target.value)}><option>Toutes</option><option value="WARN">Avertissement</option><option value="TIMEOUT">Timeout</option><option value="KICK">Expulsion</option><option value="BAN">Bannissement</option><option value="TEMPBAN">Ban temporaire</option><option value="UNBAN">Débannissement</option><option value="PURGE_MESSAGES">Suppression</option><option value="SLOWMODE">Slowmode</option><option value="LOCK_CHANNEL">Verrouillage</option><option value="UNLOCK_CHANNEL">Restauration</option></select></label><label className="sr-label"><span className="sr-only">État</span><select value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option>Tous</option><option value="requested">Demandé</option><option value="running">En cours</option><option value="completed">Enregistré</option><option value="succeeded">Réussi</option><option value="failed">Échoué</option><option value="uncertain">À vérifier</option></select></label></div></section>
    {error && <Notice tone="error">{error}</Notice>}
    <section className="surface section-panel history-panel"><div className="section-heading"><div><h2>Historique</h2><p>Page {history.length + 1} · {items.length} dossier(s) chargé(s)</p></div><button className="text-button" type="button" disabled={loading || retryUntil > Date.now()} onClick={() => { if (Date.now() < retryUntilRef.current) return; setLoading(true); setRevision(value => value + 1); }}>{retryUntil > Date.now() ? 'Attente de Retry-After…' : 'Actualiser'}</button></div>{error && <Notice tone="warning">{error}</Notice>}{loading ? <div className="loading-row"><LoaderCircle className="spin" size={18} /> Chargement des dossiers…</div> : <CaseTable items={displayed} emptyText="Aucun dossier ne correspond aux filtres de cette page." />}<div className="pagination"><button className="button button-secondary" type="button" disabled={!history.length || loading} onClick={() => { const previous = history.at(-1) ?? null; setHistory(old => old.slice(0, -1)); setCursor(previous); setLoading(true); }}><ChevronLeft size={16} /> Précédent</button><span>Page {history.length + 1}</span><button className="button button-secondary" type="button" disabled={!nextCursor || loading} onClick={() => { setHistory(old => [...old, cursor]); setCursor(nextCursor); setLoading(true); }}>Suivant <ChevronRight size={16} /></button></div></section>
  </>;
}

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

type ActionKind = 'TIMEOUT' | 'UNTIMEOUT' | 'KICK' | 'BAN' | 'TEMPBAN' | 'UNBAN' | 'PURGE_MESSAGES' | 'SLOWMODE' | 'LOCK_CHANNEL' | 'UNLOCK_CHANNEL';
const memberActions: { value: ActionKind; label: string }[] = [{ value: 'TIMEOUT', label: 'Timeout' }, { value: 'UNTIMEOUT', label: 'Retirer le timeout' }, { value: 'KICK', label: 'Expulser' }, { value: 'BAN', label: 'Bannir' }, { value: 'TEMPBAN', label: 'Bannir temporairement' }, { value: 'UNBAN', label: 'Débannir' }];
const channelActions: { value: ActionKind; label: string }[] = [{ value: 'PURGE_MESSAGES', label: 'Supprimer des messages' }, { value: 'SLOWMODE', label: 'Configurer le slowmode' }, { value: 'LOCK_CHANNEL', label: 'Verrouiller un salon' }, { value: 'UNLOCK_CHANNEL', label: 'Restaurer un salon' }];
const destructiveActions: ActionKind[] = ['KICK', 'BAN', 'TEMPBAN', 'UNBAN', 'PURGE_MESSAGES', 'LOCK_CHANNEL', 'UNLOCK_CHANNEL'];

export function ActionsView({ guild, enabledMembers, enabledChannels, csrf, initialGroup, recentCases, onCreated, onUnauthorized, onGroupChange, hideHeader = false }: { guild: Guild; enabledMembers: boolean; enabledChannels: boolean; csrf: string; initialGroup: 'members' | 'channels'; onGroupChange?: (group: 'members' | 'channels') => void; hideHeader?: boolean; recentCases: ModerationCase[]; onCreated: () => Promise<boolean>; onUnauthorized: () => void }) {
  const [group, setGroup] = useState(initialGroup);
  const [action, setAction] = useState<ActionKind>(initialGroup === 'members' ? 'TIMEOUT' : 'PURGE_MESSAGES');
  const [target, setTarget] = useState(''); const [reason, setReason] = useState(''); const [duration, setDuration] = useState('60'); const [count, setCount] = useState('50'); const [author, setAuthor] = useState(''); const [slowmode, setSlowmode] = useState('5');
  const [operationId, setOperationId] = useState(''); const [busy, setBusy] = useState(false); const [confirmOpen, setConfirmOpen] = useState(false); const [notice, setNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const switchGroup = (next: 'members' | 'channels') => { setGroup(next); setAction(next === 'members' ? 'TIMEOUT' : 'PURGE_MESSAGES'); setTarget(''); setOperationId(''); setNotice(null); };
  const changeAction = (next: ActionKind) => { setAction(next); setTarget(''); setOperationId(''); setNotice(null); };
  const channelAction = group === 'channels';
  const enabled = channelAction ? enabledChannels : enabledMembers;
  const execute = async () => {
    setConfirmOpen(false); setBusy(true); setNotice(null);
    const id = operationId || crypto.randomUUID(); setOperationId(id);
    try {
      const response = await fetch(`/api/guilds/${guild.id}/actions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, targetId: target, ...(channelAction ? { channelId: target } : {}), ...(action === 'PURGE_MESSAGES' ? { requestedCount: Number(count), ...(author ? { filterAuthorId: author } : {}) } : {}), ...(action === 'SLOWMODE' ? { rateLimitSeconds: Number(slowmode) } : {}), ...(action === 'TIMEOUT' || action === 'TEMPBAN' ? { durationMinutes: Number(duration) } : {}), reason, csrf, operationId: id }) });
      if (response.status === 401) { onUnauthorized(); return; }
      const data = await response.json() as { id?: string; status?: string; error?: string };
      if (!response.ok) { if (response.status < 500) setOperationId(''); throw new Error(data.error ?? 'La demande n’a pas pu être enregistrée.'); }
      setOperationId(''); setNotice({ tone: 'info', text: `Demande enregistrée dans le dossier ${data.id}. État : ${statusLabels[data.status ?? ''] ?? data.status}. Consultez le dossier pour le résultat confirmé.` }); await onCreated();
    } catch (cause) { setNotice({ tone: 'error', text: cause instanceof Error ? cause.message : 'Résultat de l’envoi inconnu. Vérifiez le dossier avant de réessayer.' }); }
    finally { setBusy(false); }
  };
  const confirmTitle = action === 'PURGE_MESSAGES' ? 'Supprimer des messages ?' : action === 'LOCK_CHANNEL' ? 'Verrouiller ce salon ?' : action === 'UNLOCK_CHANNEL' ? 'Restaurer ce salon ?' : action === 'UNBAN' ? 'Débannir cette personne ?' : action === 'KICK' ? 'Expulser cette personne ?' : 'Confirmer le bannissement ?';
  const confirmDescription = action === 'PURGE_MESSAGES' ? `Jusqu’à ${count} messages récents de ce salon seront examinés. Ceux de plus de 14 jours seront ignorés.` : action === 'LOCK_CHANNEL' || action === 'UNLOCK_CHANNEL' ? 'Cette demande modifiera les permissions du salon Discord. Le résultat sera consigné dans un dossier.' : `Cette demande concerne l’identifiant ${target}. Le bot vérifiera les permissions avant son exécution.`;
  return <>{!hideHeader && <PageHeader title="Actions de modération" description="Choisissez une action, indiquez une cible et suivez le résultat dans les dossiers." />}<div className="segmented" aria-label="Type d’action"><button type="button" className={group === 'members' ? 'is-active' : ''} aria-pressed={group === 'members'} onClick={() => { if (onGroupChange) onGroupChange('members'); else switchGroup('members'); }}>Membres</button><button type="button" className={group === 'channels' ? 'is-active' : ''} aria-pressed={group === 'channels'} onClick={() => { if (onGroupChange) onGroupChange('channels'); else switchGroup('channels'); }}>Salons</button></div><div className="action-layout"><section className="surface section-panel form-panel"><div className="section-heading"><div><h2>Nouvelle demande</h2><p>La raison sera conservée dans le dossier.</p></div></div>{guild.botOnline && enabled ? <form onSubmit={event => { event.preventDefault(); if (destructiveActions.includes(action)) setConfirmOpen(true); else void execute(); }}><div className="form-two"><label className="field"><span>Action</span><select className="text-input" value={action} onChange={event => changeAction(event.target.value as ActionKind)}>{(channelAction ? channelActions : memberActions).map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><label className="field"><span>{channelAction ? 'ID du salon' : action === 'UNBAN' ? 'ID de la personne bannie' : 'ID utilisateur Discord'}</span><input className="text-input" value={target} onChange={event => { setTarget(event.target.value); setOperationId(''); }} inputMode="numeric" pattern="[0-9]{17,20}" minLength={17} maxLength={20} required placeholder="123456789012345678" /></label></div><div className="form-two">{(action === 'TIMEOUT' || action === 'TEMPBAN') && <label className="field"><span>Durée en minutes</span><input className="text-input" type="number" min="1" max={action === 'TIMEOUT' ? '40320' : '525600'} value={duration} onChange={event => { setDuration(event.target.value); setOperationId(''); }} required /><small>{action === 'TIMEOUT' ? 'Maximum 28 jours.' : 'Maximum 365 jours.'}</small></label>}{action === 'PURGE_MESSAGES' && <><label className="field"><span>Messages récents à examiner</span><input className="text-input" type="number" min="1" max="100" value={count} onChange={event => { setCount(event.target.value); setOperationId(''); }} required /><small>Maximum 100 ; les messages de plus de 14 jours sont ignorés.</small></label><label className="field"><span>Filtrer par auteur <em>(facultatif)</em></span><input className="text-input" value={author} onChange={event => { setAuthor(event.target.value); setOperationId(''); }} inputMode="numeric" pattern="[0-9]{17,20}" minLength={17} maxLength={20} placeholder="Tous les auteurs" /></label></>}{action === 'SLOWMODE' && <label className="field"><span>Intervalle en secondes</span><input className="text-input" type="number" min="0" max="21600" value={slowmode} onChange={event => { setSlowmode(event.target.value); setOperationId(''); }} required /><small>0 désactive le slowmode.</small></label>}</div><label className="field"><span>Raison</span><textarea className="text-input textarea-input" value={reason} onChange={event => { setReason(event.target.value); setOperationId(''); }} required maxLength={500} placeholder="Décrivez la décision" /></label><Notice tone="info">Une demande enregistrée n’est pas encore une action réussie. Son résultat apparaîtra dans le dossier.</Notice>{notice && <Notice tone={notice.tone}>{notice.text}</Notice>}<div className="form-footer"><span>{reason.length}/500 caractères</span><button className="button button-primary" type="submit" disabled={busy}>{busy ? <><LoaderCircle className="spin" size={17} /> Envoi…</> : 'Envoyer la demande'}</button></div></form> : <Notice tone="warning">Activez ce module et attendez que le bot soit en ligne pour créer une action.</Notice>}</section><section className="surface section-panel action-help"><h2>À savoir</h2><p>Chaque action exige une raison. Vos droits et ceux du bot sont vérifiés avant son exécution.</p><p>Une action peut rester en attente ou demander une vérification si Discord ne confirme pas son résultat.</p><div className="help-divider" /><h3>Actions récentes</h3><CaseTable items={recentCases.filter(item => item.action !== 'WARN').slice(0, 4)} emptyText="Aucune action parmi les derniers dossiers chargés." /></section></div><ConfirmDialog open={confirmOpen} title={confirmTitle} description={confirmDescription} confirmLabel="Confirmer la demande" onCancel={() => setConfirmOpen(false)} onConfirm={() => void execute()} /></>;
}
