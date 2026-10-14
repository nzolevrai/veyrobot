import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readApiFailure } from './api-failure';
import type { DiscordUser } from './dashboard-types';
import { DashboardLoadFailure } from './dashboard/load-failure';
import { UserSpace } from './dashboard/user/user-space';

export default async function UserLayout({ children }: { children: React.ReactNode }) {
  const session = (await cookies()).get('veyrobot_session');
  if (!session) redirect('/?session=missing');
  let response: Response;
  try {
    response = await fetch(`${process.env.API_INTERNAL_URL ?? 'http://localhost:4000'}/me`, {
      headers: { cookie: `veyrobot_session=${encodeURIComponent(session.value)}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return <DashboardLoadFailure failure={{ status: 0, code: 'API_UNREACHABLE' }} />;
  }
  if (response.status === 401) redirect('/?session=expired');
  if (!response.ok) return <DashboardLoadFailure failure={await readApiFailure(response)} />;
  const identity = await response.json() as { user: DiscordUser; csrf: string };
  return <UserSpace initialUser={identity.user} csrf={identity.csrf}>{children}</UserSpace>;
}
