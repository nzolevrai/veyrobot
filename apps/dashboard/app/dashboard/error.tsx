'use client';

import { Brand, Notice } from '../components';

export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="login-screen"><header className="login-header"><Brand /></header><section className="login-panel"><h1>Une erreur empêche l’ouverture du dashboard</h1><Notice tone="error">Réessayez. Si le problème persiste, communiquez la référence {error.digest ?? 'indisponible'} au support.</Notice><button className="button button-primary" type="button" onClick={reset}>Réessayer</button><a className="button button-secondary" href="/">Choisir un serveur</a></section></main>;
}
