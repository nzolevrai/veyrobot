import type { Metadata } from 'next';
import './style.css';

export const metadata: Metadata = {
  title: 'VeyroBot — Modération Discord',
  description: 'Console de modération et de sécurité Discord.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="fr"><body>{children}</body></html>;
}
