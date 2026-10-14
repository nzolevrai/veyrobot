'use client';

import { Bot, BotOff, ChevronDown, Gem, LayoutDashboard, LogOut, Menu, Plus, Search, Settings2, Shield, ShieldCheck, UserRound, X } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type FocusEvent, type MouseEvent, type ReactNode } from 'react';
import type { DiscordUser, Guild } from './dashboard-types';
import { moduleCategories, moduleRegistry, searchModules, type ModuleCategory } from './module-registry';

function GuildIcon({ guild }: { guild: Guild }) {
  return guild.icon ? <span className="guild-icon" aria-hidden="true" style={{ backgroundImage: `url(https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=96)` }} /> : <span className="guild-icon guild-icon-fallback" aria-hidden="true">{guild.name.trim().split(/\s+/).slice(0, 2).map(word => word[0]?.toUpperCase()).join('') || '?'}</span>;
}
function UserIcon({ user }: { user: DiscordUser | null }) {
  return user?.avatar ? <span className="user-avatar" aria-hidden="true" style={{ backgroundImage: `url(https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=96)` }} /> : <span className="user-avatar user-avatar-fallback" aria-hidden="true"><UserRound size={17} /></span>;
}
type Tip = { name: string; subtitle: string | undefined; top: number };
export function DashboardShell({ children, user, guilds, selected, clientId, onNavigate, onInvite, onLogout, loggingOut = false }: {
  children: ReactNode; user: DiscordUser | null; guilds: Guild[]; selected: string | null; clientId: string;
  onNavigate: (href: string) => void; onInvite: (id: string) => void; onLogout: () => void; loggingOut?: boolean;
}) {
  const pathname = usePathname();
  const userSpace = selected === null;
  const active = pathname.split('/').at(-1) ?? 'overview';
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [tooltip, setTooltip] = useState<Tip | null>(null);
  const [expanded, setExpanded] = useState<Partial<Record<ModuleCategory, boolean>>>({});
  const guild = guilds.find(item => item.id === selected);
  const matches = searchModules(query);
  const activeCategory = userSpace ? undefined : moduleRegistry.find(item => item.id === active)?.category;
  const href = (section: string, id = selected) => `/dashboard/${id}/${section}`;
  const navigate = (event: MouseEvent<HTMLAnchorElement>, destination: string) => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); onNavigate(destination); setMenuOpen(false); setTooltip(null);
  };
  const showTip = (event: FocusEvent<HTMLElement> | MouseEvent<HTMLElement>, name: string, subtitle?: string) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setTooltip({ name, subtitle, top: Math.max(86, Math.min(window.innerHeight - 52, rect.top + rect.height / 2)) });
  };
  useEffect(() => { try { setExpanded(JSON.parse(localStorage.getItem('veyro-nav-categories') ?? '{}') as Partial<Record<ModuleCategory, boolean>>); } catch { /* empty */ } }, []);
  useEffect(() => { if (!activeCategory) return; setExpanded(current => { const next = { ...current, [activeCategory]: true }; localStorage.setItem('veyro-nav-categories', JSON.stringify(next)); return next; }); }, [activeCategory]);
  useEffect(() => { if (!menuOpen) return; const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, [menuOpen]);
  const toggleCategory = (category: ModuleCategory) => setExpanded(current => { const next = { ...current, [category]: !(current[category] ?? activeCategory === category) }; localStorage.setItem('veyro-nav-categories', JSON.stringify(next)); return next; });
  const fixed = [{ slug: 'overview', label: 'Vue d’ensemble', icon: LayoutDashboard }, { slug: 'settings', label: 'Paramètres', icon: Settings2 }, { slug: 'premium', label: 'Premium', icon: Gem }] as const;
  const userLinks = [{ path: '/dashboard/user/profil', label: 'Profil', icon: UserRound }, { path: '/dashboard/user/security', label: 'Sécurité', icon: ShieldCheck }, { path: '/dashboard/user/premium', label: 'Premium', icon: Gem }] as const;
  return <div className="app-shell">
    <header className="app-header"><button className="icon-button menu-toggle" type="button" aria-label={menuOpen ? 'Fermer la navigation' : 'Ouvrir la navigation'} aria-expanded={menuOpen} aria-controls="dashboard-sidebar" onClick={() => setMenuOpen(open => !open)}>{menuOpen ? <X size={20} /> : <Menu size={20} />}</button><span className="brand"><span className="brand-mark"><Shield size={20} /></span><span>VeyroBot</span></span></header>
    {menuOpen && <button className="mobile-scrim" type="button" aria-label="Fermer la navigation" onClick={() => setMenuOpen(false)} />}
    <aside className={`server-rail${menuOpen ? ' is-open' : ''}`} aria-label="Comptes et serveurs Discord">
      <a href="/dashboard/user" className={`rail-account${userSpace ? ' is-selected' : ''}`} aria-label={`Espace utilisateur : ${user?.username ?? 'compte Discord'}`} aria-current={userSpace ? 'page' : undefined} onMouseEnter={event => showTip(event, user?.username ?? 'Compte Discord')} onFocus={event => showTip(event, user?.username ?? 'Compte Discord')} onMouseLeave={() => setTooltip(null)} onBlur={() => setTooltip(null)} onClick={event => navigate(event, '/dashboard/user')}><UserIcon user={user} /></a>
      <div className="rail-scroll"><div className="rail-group" role="group" aria-label="VeyroBot installé"><span className="rail-section-marker" aria-hidden="true"><Bot size={14} /></span>{guilds.filter(item => item.botInstalled).map(item => <a key={item.id} href={href('overview', item.id)} className={`rail-server${selected === item.id ? ' is-selected' : ''}`} aria-label={`${item.name}, ${item.botOnline ? 'bot en ligne' : 'bot hors ligne'}`} aria-current={selected === item.id ? 'page' : undefined} onMouseEnter={event => showTip(event, item.name)} onFocus={event => showTip(event, item.name)} onMouseLeave={() => setTooltip(null)} onBlur={() => setTooltip(null)} onClick={event => navigate(event, href('overview', item.id))}><GuildIcon guild={item} /></a>)}</div>
      <div className="rail-group" role="group" aria-label="Inviter VeyroBot"><span className="rail-section-marker" aria-hidden="true"><BotOff size={14} /></span>{guilds.filter(item => !item.botInstalled).map(item => <a key={item.id} className="rail-server rail-invite" aria-label={`Ajouter VeyroBot sur ${item.name}`} href={clientId ? `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot%20applications.commands&permissions=0&guild_id=${item.id}&disable_guild_select=true` : undefined} aria-disabled={!clientId} target="_blank" rel="noopener noreferrer" onMouseEnter={event => showTip(event, item.name, 'Ajouter VeyroBot')} onFocus={event => showTip(event, item.name, 'Ajouter VeyroBot')} onMouseLeave={() => setTooltip(null)} onBlur={() => setTooltip(null)} onClick={() => { if (clientId) onInvite(item.id); }}><GuildIcon guild={item} /><span className="rail-add" aria-hidden="true"><Plus size={14} strokeWidth={3} /></span></a>)}</div></div>
    </aside>
    {tooltip && <span className="rail-floating-tooltip" style={{ top: tooltip.top }} role="tooltip"><strong>{tooltip.name}</strong>{tooltip.subtitle && <small>{tooltip.subtitle}</small>}</span>}
    <aside id="dashboard-sidebar" className={`app-sidebar${menuOpen ? ' is-open' : ''}`}>
      <div className="sidebar-server-head"><span className="sidebar-avatar">{userSpace ? <UserIcon user={user} /> : guild && <GuildIcon guild={guild} />}</span><span className="sidebar-server-copy"><strong>{userSpace ? user?.username ?? 'Compte Discord' : guild?.name ?? 'Chargement…'}</strong><small>{userSpace ? 'Espace utilisateur' : !guild ? 'État inconnu' : guild.botOnline ? 'Bot en ligne' : 'Bot hors ligne'}</small></span></div>
      <div className="sidebar-scroll" tabIndex={0}>
        {userSpace ? <nav aria-label="Espace utilisateur" className="side-nav user-nav">{userLinks.map(item => { const Icon = item.icon; return <a key={item.path} href={item.path} className={`nav-item${pathname === item.path ? ' is-active' : ''}`} aria-current={pathname === item.path ? 'page' : undefined} onClick={event => navigate(event, item.path)}><Icon size={17} /><span>{item.label}</span></a>; })}<button className="nav-item" type="button" disabled={loggingOut} onClick={onLogout}><LogOut size={17} /><span>{loggingOut ? 'Déconnexion…' : 'Se déconnecter'}</span></button></nav> : <>
          <div className="sidebar-fixed"><label className="search-field nav-search"><Search size={16} aria-hidden="true" /><span className="sr-only">Rechercher un module</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Rechercher un module…" /></label><nav aria-label="Pages principales" className="side-nav">{fixed.map(item => { const Icon = item.icon; return <a key={item.slug} href={href(item.slug)} className={`nav-item${active === item.slug ? ' is-active' : ''}`} aria-current={active === item.slug ? 'page' : undefined} onClick={event => navigate(event, href(item.slug))}><Icon size={17} /><span>{item.label}</span></a>; })}</nav></div>
          <nav className="sidebar-categories" aria-label="Modules du serveur">{moduleCategories.map(category => { const entries = matches.filter(item => item.category === category); if (query && !entries.length) return null; const open = query ? true : (expanded[category] ?? activeCategory === category); return <div className="nav-category" key={category}><button type="button" className="category-trigger" aria-expanded={open} onClick={() => toggleCategory(category)}><span>{category}</span><ChevronDown size={15} className={open ? 'chevron-open' : ''} /></button>{open && <div className="category-items">{entries.map(item => { const Icon = item.icon; const isActive = active === item.id; return item.implemented ? <a key={item.id} href={href(item.id)} className={`nav-item module-nav${isActive ? ' is-active' : ''}`} aria-current={isActive ? 'page' : undefined} onClick={event => navigate(event, href(item.id))}><Icon size={16} /><span>{item.title}</span></a> : <span key={item.id} className="nav-item module-nav is-unavailable" aria-label={`${item.title}, bientôt disponible`} aria-disabled="true"><Icon size={16} /><span>{item.title}</span></span>; })}</div>}</div>; })}{query && !matches.length && <p className="nav-no-results">Aucun module trouvé.</p>}</nav>
        </>}
      </div>
    </aside>
    <div className="app-content">{children}</div>
  </div>;
}
