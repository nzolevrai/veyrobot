import type { Metadata } from 'next';
import './style.css';
import { connection } from 'next/server';

export const metadata: Metadata = {
  title: 'VeyroBot — Modération Discord',
  description: 'Console de modération et de sécurité Discord.',
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  await connection();
  return <html lang="fr"><body>{children}</body></html>;
}
