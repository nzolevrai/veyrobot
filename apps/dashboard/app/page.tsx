'use client';

import { ArrowRight, LoaderCircle, Server } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Brand, Notice } from './components';
import { failureMessage, failureReference, readApiFailure } from './api-failure';
import type { Guild } from './dashboard-types';

export default function Home() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [signedIn, setSignedIn] = useState(false);
  const [guilds, setGuilds] = useState<Guild[] | null>(null);
  const [clientId, setClientId] = useState('');
  const [csrf, setCsrf] = useState('');
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const [denied, setDenied] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const me = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store', signal: signal ?? null });
      if (me.status === 401) { setSignedIn(false); setGuilds(null); return; }
      if (!me.ok) { const failure = await readApiFailure(me); throw new Error(failureMessage(failure) + failureReference(failure)); }
      const identity = await me.json() as { csrf: string };
      if (signal?.aborted) return;
      setSignedIn(true); setCsrf(identity.csrf);
      const response = await fetch('/api/guilds', { credentials: 'same-origin', cache: 'no-store', signal: signal ?? null });
      if (response.status === 401) { setSignedIn(false); setGuilds(null); setError('Votre session Discord a expiré. Reconnectez-vous.'); return; }
      if (!response.ok) { const failure = await readApiFailure(response); throw new Error(failureMessage(failure) + failureReference(failure)); }
      const items = await response.json() as Guild[];
      if (!signal?.aborted) setGuilds(items);
      const publicConfig = await fetch('/api/public-config', { cache: 'no-store', signal: signal ?? null });
      if (publicConfig.ok && !signal?.aborted) setClientId((await publicConfig.json() as { discordClientId: string }).discordClientId);
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof TypeError ? 'L’API VeyroBot ne répond pas actuellement. Votre session est conservée.' : cause instanceof Error ? cause.message : 'Chargement interrompu.');
    } finally { if (!signal?.aborted) setLoading(false); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams(window.location.search);
    setReason(query.get('session') ?? '');
    setDenied(query.get('access') === 'denied');
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const verify = async (id: string) => {
    try {
      const response = await fetch(`/api/guilds/${id}/installation-check`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ csrf }) });
      if (!response.ok) { const failure = await readApiFailure(response); throw new Error(failureMessage(failure) + failureReference(failure)); }
      const result = await response.json() as { botInstalled?: boolean };
      if (result.botInstalled) router.push(`/dashboard/${id}/overview`);
      else setError('VeyroBot n’est pas encore installé sur ce serveur.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Vérification indisponible.'); }
  };
  if (loading) return <main className="boot-screen"><Brand /><LoaderCircle className="spin" size={19} aria-label="Chargement" /><p>Ouverture de VeyroBot…</p></main>;
  if (signedIn) return <main className="login-screen"><header className="login-header"><Brand /></header><section className="login-panel"><Server size={25} /><h1>Choisissez un serveur</h1>{denied && <Notice tone="error">Accès refusé : serveur inaccessible ou VeyroBot absent.</Notice>}{error && <Notice tone="error">{error}</Notice>}{!guilds && <button className="button button-secondary" type="button" onClick={() => void load()}>Réessayer</button>}{guilds && <><div className="server-list">{guilds.filter(item => item.botInstalled).map(item => <a className="button button-secondary" key={item.id} href={`/dashboard/${item.id}/overview`}>{item.name}<ArrowRight size={16} /></a>)}</div>{guilds.some(item => !item.botInstalled) && <><h2>Inviter VeyroBot</h2><div className="server-list">{guilds.filter(item => !item.botInstalled).map(item => <div className="server-install-row" key={item.id}><strong>{item.name}</strong>{clientId && <a className="button button-secondary" target="_blank" rel="noopener noreferrer" href={`https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot%20applications.commands&permissions=0&guild_id=${item.id}&disable_guild_select=true`}>Inviter</a>}<button className="button button-secondary" type="button" onClick={() => void verify(item.id)}>Vérifier</button></div>)}</div></>}{guilds.length === 0 && <p>Aucun serveur administrable trouvé avec ce compte Discord.</p>}</>}</section></main>;
  return <main className="login-screen"><header className="login-header"><Brand /></header><section className="login-panel"><span className="eyebrow">DASHBOARD DISCORD</span><h1>La modération, au même endroit.</h1><p>Gérez les avertissements, les actions et les dossiers de vos serveurs autorisés.</p><a className="button button-primary" href="/api/oauth/discord/start">Continuer avec Discord <ArrowRight size={17} /></a>{reason && <Notice tone="error">Votre session Discord est absente ou expirée. Reconnectez-vous.</Notice>}{error && <Notice tone="error">{error}</Notice>}{error && <button className="button button-secondary" type="button" onClick={() => void load()}>Réessayer</button>}</section></main>;
}
