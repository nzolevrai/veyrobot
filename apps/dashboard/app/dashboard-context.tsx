'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { DashboardShell } from './navigation';
import { Notice, PreferencesContext } from './components';
import { changedConfig, hasConfigChanges, rebaseConfig, type EditableKey } from './config-draft';
import { shouldRefreshRecentCases } from './recent-cases';
import { failureMessage, failureReference, historyFailureMessage, readApiFailure, retryAfterDelayMs } from './api-failure';
import type { DiscordUser, Guild, GuildConfig, ModerationCase } from './dashboard-types';

type DashboardState = {
  guildId: string; guild: Guild | null; user: DiscordUser | null; csrf: string; saved: GuildConfig | null; draft: GuildConfig | null;
  configLoading: boolean; cases: ModerationCase[]; casesLoading: boolean; casesError: string; casesRetryBlocked: boolean; guildsError: string; guildsRetryBlocked: boolean; error: string; saving: boolean; saveMessage: string;
  update: <K extends EditableKey>(key: K, value: GuildConfig[K]) => void; reset: () => void; save: () => Promise<void>;
  refreshCases: () => Promise<boolean>; loadGuilds: () => Promise<boolean>; expire: () => void; navigate: (href: string) => void; verifyInstallation: () => Promise<void>;
  setPendingInvite: (id: string) => void; pendingInvite: string;
};
const Context = createContext<DashboardState | null>(null);
export function useDashboard(): DashboardState { const value = useContext(Context); if (!value) throw new Error('Dashboard context absent'); return value; }

export function DashboardProvider({ guildId, initialConfig, children }: { guildId: string; initialConfig: GuildConfig; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<DiscordUser | null>(null);
  const [csrf, setCsrf] = useState('');
  const [clientId, setClientId] = useState('');
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [saved, setSaved] = useState<GuildConfig | null>(initialConfig);
  const [draft, setDraft] = useState<GuildConfig | null>(initialConfig);
  const [configLoading] = useState(false);
  const [cases, setCases] = useState<ModerationCase[]>([]);
  const [casesLoading, setCasesLoading] = useState(false);
  const [casesError, setCasesError] = useState('');
  const [casesRetryUntil, setCasesRetryUntil] = useState(0);
  const casesRetryUntilRef = useRef(0);
  const [guildsError, setGuildsError] = useState('');
  const [guildsRetryUntil, setGuildsRetryUntil] = useState(0);
  const guildsRetryUntilRef = useRef(0);
  const [retryClock, setRetryClock] = useState(0);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [pendingInvite, setPendingInvite] = useState('');
  const lastCasesFetch = useRef(0);
  const casesRequest = useRef<AbortController | null>(null);
  const casesRefreshPromise = useRef<Promise<boolean> | null>(null);
  const dirtyRef = useRef(false);
  const pathRef = useRef(pathname);
  const busyRef = useRef(false);
  const dirty = hasConfigChanges(saved, draft);
  dirtyRef.current = dirty;
  pathRef.current = pathname;
  useEffect(() => {
    const deadlines = [casesRetryUntil, guildsRetryUntil].filter(deadline => deadline > Date.now());
    if (!deadlines.length) return;
    const timer = setTimeout(() => setRetryClock(value => value + 1), Math.max(0, Math.min(...deadlines) - Date.now()));
    return () => clearTimeout(timer);
  }, [casesRetryUntil, guildsRetryUntil, retryClock]);
  const expire = useCallback(() => { setError('Votre session a expiré. Reconnectez-vous.'); setUser(null); router.replace('/?session=expired'); }, [router]);
  const loadGuilds = useCallback(async () => {
    if (Date.now() < guildsRetryUntilRef.current) return false;
    try {
      const response = await fetch('/api/guilds', { credentials: 'same-origin', cache: 'no-store' });
      if (response.status === 401) { expire(); return false; }
      if (!response.ok) {
        const failure = await readApiFailure(response);
        const delay = retryAfterDelayMs(failure.retryAfter);
        if (delay !== undefined && delay > 0) { const until = Date.now() + delay; guildsRetryUntilRef.current = until; setGuildsRetryUntil(until); }
        setGuildsError(`Liste des serveurs indisponible. ${failureMessage(failure)}${failureReference(failure)}`);
        return false;
      }
      const items = await response.json() as Guild[];
      setGuilds(items); setGuildsError(''); guildsRetryUntilRef.current = 0; setGuildsRetryUntil(0);
      if (!items.some(item => item.id === guildId && item.botInstalled)) router.replace('/?access=denied');
      return true;
    } catch (cause) {
      setGuildsError(cause instanceof TypeError ? 'Liste des serveurs indisponible : l’API VeyroBot ne répond pas. Votre session est conservée.' : cause instanceof Error ? cause.message : 'Liste des serveurs indisponible.');
      return false;
    }
  }, [expire, guildId, router]);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const [me, publicConfig] = await Promise.all([
          fetch('/api/me', { signal: controller.signal, credentials: 'same-origin', cache: 'no-store' }),
          fetch('/api/public-config', { signal: controller.signal }),
        ]);
        if (me.status === 401) { expire(); return; }
        if (!me.ok) { const failure = await readApiFailure(me); throw new Error(failureMessage(failure) + failureReference(failure)); }
        const identity = await me.json() as { user: DiscordUser; csrf: string };
        if (controller.signal.aborted) return;
        setUser(identity.user); setCsrf(identity.csrf);
        if (publicConfig.ok) setClientId((await publicConfig.json() as { discordClientId: string }).discordClientId);
        await loadGuilds();
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof TypeError ? 'L’API VeyroBot ne répond pas actuellement. Votre session est conservée.' : cause instanceof Error ? cause.message : 'Connexion interrompue.'); }
    })();
    return () => controller.abort();
  }, [guildId, expire, loadGuilds]);
  const refreshCases = useCallback((): Promise<boolean> => {
    if (Date.now() < casesRetryUntilRef.current) return Promise.resolve(false);
    if (casesRefreshPromise.current) return casesRefreshPromise.current;
    const controller = new AbortController();
    casesRequest.current = controller;
    setCasesLoading(true);
    const request = (async (): Promise<boolean> => {
      try {
        const response = await fetch(`/api/guilds/${guildId}/cases?limit=25`, { signal: controller.signal, credentials: 'same-origin', cache: 'no-store' });
        if (controller.signal.aborted) return false;
        if (response.status === 401) { expire(); return false; }
        if (!response.ok) {
          const failure = await readApiFailure(response);
          const delay = retryAfterDelayMs(failure.retryAfter);
          if (delay !== undefined && delay > 0) { const until = Date.now() + delay; casesRetryUntilRef.current = until; setCasesRetryUntil(until); }
          setCasesError(`${historyFailureMessage(failure)}${failureReference(failure)}`);
          return false;
        }
        const data = await response.json() as { items: ModerationCase[] };
        if (controller.signal.aborted) return false;
        setCases(data.items);
        setCasesError(''); casesRetryUntilRef.current = 0; setCasesRetryUntil(0);
        lastCasesFetch.current = Date.now();
        return true;
      } catch (cause) { if (!controller.signal.aborted) setCasesError(`Historique temporairement impossible à actualiser. Les dossiers déjà affichés sont conservés. ${cause instanceof Error ? cause.message : 'Erreur de connexion.'}`); return false; }
      finally { if (casesRequest.current === controller) { casesRequest.current = null; setCasesLoading(false); } }
    })();
    casesRefreshPromise.current = request;
    void request.finally(() => { if (casesRefreshPromise.current === request) casesRefreshPromise.current = null; }).catch(() => undefined);
    return request;
  }, [guildId, expire]);
  // Actualise à l’ouverture d’une vue concernée et après les mutations; évite un polling OAuth régulier.
  useEffect(() => {
    if (!/\/(overview|warnings|member-actions|channel-actions)$/.test(pathname)) return;
    if (shouldRefreshRecentCases(pathname, lastCasesFetch.current, Date.now())) void refreshCases();
    return () => { casesRequest.current?.abort(); };
  }, [pathname, refreshCases]);
  const update = useCallback(<K extends EditableKey>(key: K, value: GuildConfig[K]) => { setDraft(current => current ? { ...current, [key]: value } : current); setSaveMessage(''); }, []);
  const reset = useCallback(() => { setDraft(saved); setSaveMessage(''); }, [saved]);
  const save = useCallback(async () => {
    if (!saved || !draft || busyRef.current) return;
    const changes = changedConfig(saved, draft);
    if (!Object.keys(changes).length) return;
    busyRef.current = true; setSaving(true); setSaveMessage('');
    try {
      const response = await fetch(`/api/guilds/${guildId}/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'patch', changes, version: saved.version, csrf }) });
      const result = await response.json() as GuildConfig & { error?: string };
      if (response.status === 401) { expire(); throw new Error('Session expirée.'); }
      if (response.status === 409) {
        const fresh = await fetch(`/api/guilds/${guildId}/config`);
        if (fresh.ok) { const current = await fresh.json() as GuildConfig; setSaved(current); setDraft(rebaseConfig(saved, draft, current)); }
        throw new Error('Une autre personne a modifié ces réglages. Vérifiez vos changements puis sauvegardez à nouveau.');
      }
      if (!response.ok) throw new Error(result.error ?? 'Enregistrement impossible.');
      setSaved(result); setDraft(current => current ? { ...result, ...changedConfig(draft, current) } : result); setSaveMessage('Modifications enregistrées.');
    } catch (cause) { setSaveMessage(cause instanceof Error ? cause.message : 'Enregistrement impossible.'); }
    finally { busyRef.current = false; setSaving(false); }
  }, [saved, draft, guildId, csrf, expire]);
  const navigate = useCallback((href: string) => {
    if (href === pathRef.current) return;
    if (dirtyRef.current && !window.confirm('Vous avez des modifications non enregistrées. Les abandonner ?')) return;
    if (dirtyRef.current) { setDraft(saved); dirtyRef.current = false; }
    router.push(href);
  }, [router, saved]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (!dirtyRef.current) return; event.preventDefault(); event.returnValue = ''; };
    const pop = () => {
      if (!dirtyRef.current) return;
      if (!window.confirm('Vous avez des modifications non enregistrées. Les abandonner ?')) { window.history.pushState(null, '', pathRef.current); router.replace(pathRef.current); }
      else { setDraft(saved); dirtyRef.current = false; }
    };
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('popstate', pop);
    return () => { window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('popstate', pop); };
  }, [router, saved]);
  const verifyInstallation = useCallback(async () => {
    if (!pendingInvite) return;
    try {
      const response = await fetch(`/api/guilds/${pendingInvite}/installation-check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ csrf }) });
      const result = await response.json() as { botInstalled?: boolean; error?: string };
      if (!response.ok) throw new Error(result.error ?? 'Vérification indisponible.');
      const guildsLoaded = await loadGuilds();
      if (result.botInstalled && guildsLoaded) { const id = pendingInvite; setPendingInvite(''); navigate(`/dashboard/${id}/overview`); }
      else setError('VeyroBot n’est pas encore installé sur ce serveur.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Vérification indisponible.'); }
  }, [pendingInvite, csrf, loadGuilds, navigate]);
  const logout = async () => { if (dirtyRef.current && !window.confirm('Vous avez des modifications non enregistrées. Les abandonner et vous déconnecter ?')) return; const response = await fetch('/api/logout', { method: 'POST' }); if (response.ok) router.replace('/'); else setError('Déconnexion impossible.'); };
  const guild = guilds.find(item => item.id === guildId) ?? null;
  const value = useMemo<DashboardState>(() => ({ guildId, guild, user, csrf, saved, draft, configLoading, cases, casesLoading, casesError, casesRetryBlocked: casesRetryUntil > Date.now(), guildsError, guildsRetryBlocked: guildsRetryUntil > Date.now(), error, saving, saveMessage, update, reset, save, refreshCases, loadGuilds, expire, navigate, verifyInstallation, pendingInvite, setPendingInvite }), [guildId, guild, user, csrf, saved, draft, configLoading, cases, casesLoading, casesError, casesRetryUntil, guildsError, guildsRetryUntil, retryClock, error, saving, saveMessage, update, reset, save, refreshCases, loadGuilds, expire, navigate, verifyInstallation, pendingInvite]);
  return <Context.Provider value={value}><PreferencesContext.Provider value={saved}><DashboardShell user={user} guilds={guilds} selected={guildId} clientId={clientId} onNavigate={navigate} onInvite={setPendingInvite} onLogout={() => void logout()}><main className={`page-content${dirty ? ' has-unsaved-bar' : ''}`}>{error && <Notice tone="error">{error} <button className="text-button" type="button" onClick={() => window.location.reload()}>Réessayer</button></Notice>}{guildsError && <Notice tone="warning">{guildsError} <button className="text-button" type="button" disabled={guildsRetryUntil > Date.now()} onClick={() => void loadGuilds()}>{guildsRetryUntil > Date.now() ? 'Attente de Retry-After…' : 'Réessayer la liste'}</button></Notice>}{casesError && <Notice tone="warning">{casesError} <button className="text-button" type="button" disabled={casesRetryUntil > Date.now()} onClick={() => void refreshCases()}>{casesRetryUntil > Date.now() ? 'Attente de Retry-After…' : 'Réessayer l’historique'}</button></Notice>}{pendingInvite && <Notice tone="info">Après l’invitation, vérifiez la présence réelle du bot. <button type="button" className="text-button" onClick={() => void verifyInstallation()}>Vérifier l’installation</button></Notice>}{children}</main></DashboardShell>{dirty && <div className="unsaved-bar" role="status"><span><strong>Attention, vous avez des modifications non enregistrées !</strong>{saveMessage && <small className="unsaved-feedback" role="alert">{saveMessage}</small>}</span><div><button className="button button-secondary" type="button" disabled={saving} onClick={reset}>Réinitialiser</button><button className="button button-primary" type="button" disabled={saving} onClick={() => void save()}>{saving ? 'Sauvegarde…' : 'Sauvegarder'}</button></div></div>}{saveMessage && !dirty && <div className="save-toast" role="status">{saveMessage}</div>}</PreferencesContext.Provider></Context.Provider>;
}
