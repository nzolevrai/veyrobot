'use client';

import { ArrowRight, Gavel, LoaderCircle, MessageSquareWarning, SlidersHorizontal, Wifi, WifiOff } from 'lucide-react';
import { CaseTable, GuildIcon, PageHeader } from './components';
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
