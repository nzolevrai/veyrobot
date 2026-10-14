'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { DashboardShell } from '../../navigation';
import { Notice } from '../../components';
import { failureMessage, failureReference, readApiFailure } from '../../api-failure';
import type { DiscordUser, Guild } from '../../dashboard-types';

const UserProfileContext = createContext<DiscordUser | null>(null);
export function useUserProfile() { return useContext(UserProfileContext); }

export function UserSpace({ initialUser, csrf, children }: { initialUser: DiscordUser; csrf: string; children: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<DiscordUser | null>(initialUser);
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [clientId, setClientId] = useState('');
  const [error, setError] = useState('');
  const [pendingInvite, setPendingInvite] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const loadGuilds = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch('/api/guilds', { credentials: 'same-origin', cache: 'no-store', signal: signal ?? null });
      if (response.status === 401) { router.replace('/?session=expired'); return; }
      if (!response.ok) { const failure = await readApiFailure(response); throw new Error(failureMessage(failure) + failureReference(failure)); }
      const items = await response.json() as Guild[];
      if (!signal?.aborted) { setGuilds(items); setError(''); }
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof TypeError ? 'L’API VeyroBot ne répond pas actuellement.' : cause instanceof Error ? cause.message : 'Serveurs indisponibles.');
    }
  }, [router]);
  useEffect(() => {
    const controller = new AbortController();
    void loadGuilds(controller.signal);
    void fetch('/api/public-config', { signal: controller.signal }).then(async response => {
      if (response.ok && !controller.signal.aborted) setClientId((await response.json() as { discordClientId: string }).discordClientId);
    }).catch(() => { /* L'invitation reste indisponible ; la navigation fonctionne. */ });
    return () => controller.abort();
  }, [loadGuilds]);
  const logout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      const response = await fetch('/api/logout', { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) { const failure = await readApiFailure(response); throw new Error(failureMessage(failure) + failureReference(failure)); }
      setUser(null); setGuilds([]); setClientId(''); setPendingInvite('');
      router.replace('/');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Déconnexion impossible.');
      setLoggingOut(false);
    }
  };
  const verifyInstallation = async () => {
    if (!pendingInvite) return;
    try {
      const response = await fetch(`/api/guilds/${pendingInvite}/installation-check`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ csrf }) });
      if (!response.ok) { const failure = await readApiFailure(response); throw new Error(failureMessage(failure) + failureReference(failure)); }
      const result = await response.json() as { botInstalled: boolean };
      await loadGuilds();
      if (result.botInstalled) { const id = pendingInvite; setPendingInvite(''); router.push(`/dashboard/${id}/overview`); }
      else setError('VeyroBot n’est pas encore installé sur ce serveur.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Vérification indisponible.'); }
  };
  return <UserProfileContext.Provider value={user}><DashboardShell user={user} guilds={guilds} selected={null} clientId={clientId} onNavigate={href => router.push(href)} onInvite={setPendingInvite} onLogout={() => void logout()} loggingOut={loggingOut}><main className="page-content">{error && <Notice tone="error">{error} <button className="text-button" type="button" onClick={() => void loadGuilds()}>Réessayer</button></Notice>}{pendingInvite && <Notice tone="info">Après l’invitation, vérifiez la présence réelle du bot. <button className="text-button" type="button" onClick={() => void verifyInstallation()}>Vérifier l’installation</button></Notice>}{children}</main></DashboardShell></UserProfileContext.Provider>;
}
