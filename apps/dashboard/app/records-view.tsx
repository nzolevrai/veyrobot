'use client';

import { ChevronLeft, ChevronRight, LoaderCircle, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { CaseTable, Notice, PageHeader } from './components';
import { failureReference, historyFailureMessage, readApiFailure, retryAfterDelayMs } from './api-failure';
import type { Guild, ModerationCase } from './dashboard-types';

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
