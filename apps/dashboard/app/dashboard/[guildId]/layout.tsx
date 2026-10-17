import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { DashboardProvider } from '../../dashboard-context';
import { readApiFailure, type ApiFailure } from '../../api-failure';
import { DashboardLoadFailure } from '../load-failure';
import type { GuildConfig } from '../../dashboard-types';
import { safeDiagnosticCode, safeDiagnosticText } from '@veyrobot/contracts';

export default async function GuildLayout({ children, params }: { children: React.ReactNode; params: Promise<{ guildId: string }> }) {
  const { guildId } = await params;
  if (!/^\d{17,20}$/.test(guildId)) redirect('/?access=denied');
  const session = (await cookies()).get('veyrobot_session');
  if (!session) redirect('/?session=missing');
  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(`${process.env.API_INTERNAL_URL ?? 'http://localhost:4000'}/guilds/${guildId}/config`, {
      headers: { cookie: `veyrobot_session=${encodeURIComponent(session.value)}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    console.warn(JSON.stringify({ endpoint: '/guilds/:guildId/config', status: 0, durationMs: Math.round(performance.now() - started), code: 'API_UNREACHABLE' }));
    return <DashboardLoadFailure failure={{ status: 0, code: 'API_UNREACHABLE' }} />;
  }
  if (response.status === 401) redirect('/?session=expired');
  if (response.status === 403 || response.status === 404) redirect('/?access=denied');
  if (!response.ok) {
    const failure: ApiFailure = await readApiFailure(response);
    console.warn(JSON.stringify({ endpoint: '/guilds/:guildId/config', status: failure.status, durationMs: Math.round(performance.now() - started), code: safeDiagnosticCode(failure.code) ?? 'UNKNOWN_ERROR', requestId: safeDiagnosticText(failure.requestId, 128) ?? 'unknown' }));
    return <DashboardLoadFailure failure={failure} />;
  }
  const initialConfig = await response.json() as GuildConfig;
  return <DashboardProvider key={guildId} guildId={guildId} initialConfig={initialConfig}>{children}</DashboardProvider>;
}
