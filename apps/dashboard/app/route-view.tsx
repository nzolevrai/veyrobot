'use client';

import { LoaderCircle } from 'lucide-react';
import { Notice, PageHeader } from './components';
import { SettingsPage } from './configuration';
import { ActionsView, CasesView, OverviewView, WarningsView } from './views';
import { useDashboard } from './dashboard-context';
import { moduleRegistry, type ModuleId } from './module-registry';
import type { GuildConfig, View } from './dashboard-types';

export type Section = 'overview' | 'settings' | 'premium' | 'warnings' | 'member-actions' | 'channel-actions' | 'records';
const destinations: Record<View, Section> = { overview: 'overview', settings: 'settings', warnings: 'warnings', actions: 'member-actions', cases: 'records' };
function ModuleSwitch({ id }: { id: ModuleId }) {
  const { draft, update, configLoading } = useDashboard();
  const module = moduleRegistry.find(item => item.id === id);
  const key = module?.enabledKey;
  if (!key) return null;
  const enabled = Boolean(draft?.[key]);
  return <label className="module-header-switch"><input type="checkbox" role="switch" checked={enabled} disabled={!draft || configLoading} onChange={event => update(key, event.target.checked)} /><span>{enabled ? 'Activé' : 'Désactivé'}</span></label>;
}
function ModuleHeader({ id }: { id: ModuleId }) {
  const module = moduleRegistry.find(item => item.id === id);
  return <PageHeader title={module?.title ?? ''} description={module?.description ?? ''}><ModuleSwitch id={id} /></PageHeader>;
}
export function RouteView({ section }: { section: Section }) {
  const { guild, guildId, csrf, saved, draft, configLoading, cases, casesLoading, refreshCases, expire, navigate, update } = useDashboard();
  if (!guild) return <div className="loading-row"><LoaderCircle size={18} className="spin" /> Chargement du serveur…</div>;
  const onView = (view: View) => navigate(`/dashboard/${guildId}/${destinations[view]}`);
  if (section === 'overview') return <OverviewView guild={guild} cases={cases} loading={casesLoading} onView={onView} />;
  if (section === 'settings') return <SettingsPage config={draft} loading={configLoading} onChange={<K extends 'language' | 'timeZone' | 'embedColor'>(key: K, value: GuildConfig[K]) => update(key, value)} />;
  if (section === 'premium') return <><PageHeader title="Premium" description="État des offres et de la facturation." /><section className="surface section-panel"><h2>Pas encore disponible</h2><p className="helper-copy">Aucune offre, aucun tarif et aucun paiement ne sont actifs dans VeyroBot actuellement. Les fonctions de modération disponibles restent accessibles selon la configuration du serveur.</p></section></>;
  if (section === 'warnings') return <div className="module-view"><ModuleHeader id="warnings" /><WarningsView hideHeader guild={guild} enabled={Boolean(saved?.warningsEnabled)} csrf={csrf} recentCases={cases} loading={casesLoading} onCreated={refreshCases} onUnauthorized={expire} /></div>;
  if (section === 'member-actions' || section === 'channel-actions') {
    const channel = section === 'channel-actions';
    return <div className="module-view"><ModuleHeader id={channel ? 'channel-actions' : 'member-actions'} /><ActionsView hideHeader key={section} guild={guild} enabledMembers={Boolean(saved?.memberActionsEnabled)} enabledChannels={Boolean(saved?.channelActionsEnabled)} csrf={csrf} initialGroup={channel ? 'channels' : 'members'} onGroupChange={group => navigate(`/dashboard/${guildId}/${group === 'channels' ? 'channel-actions' : 'member-actions'}`)} recentCases={cases} onCreated={refreshCases} onUnauthorized={expire} /></div>;
  }
  if (section === 'records') return <CasesView guild={guild} onUnauthorized={expire} />;
  return <Notice tone="error">Page indisponible.</Notice>;
}
