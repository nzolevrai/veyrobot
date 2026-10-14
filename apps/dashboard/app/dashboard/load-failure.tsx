'use client';

import { useRouter } from 'next/navigation';
import { Brand, Notice } from '../components';
import { failureMessage, failureReference, type ApiFailure } from '../api-failure';

export function DashboardLoadFailure({ failure }: { failure: ApiFailure }) {
  const router = useRouter();
  return <main className="login-screen"><header className="login-header"><Brand /></header><section className="login-panel"><h1>Chargement interrompu</h1><Notice tone="error">{failureMessage(failure)}{failureReference(failure)}</Notice><button className="button button-primary" type="button" onClick={() => router.refresh()}>Réessayer</button><a className="button button-secondary" href="/">Choisir un serveur</a></section></main>;
}
