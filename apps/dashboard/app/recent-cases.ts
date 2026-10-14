export function shouldRefreshRecentCases(pathname: string, lastFetchedAt: number, now: number): boolean {
  return /\/(overview|warnings|member-actions|channel-actions)$/.test(pathname) && now - lastFetchedAt > 30_000;
}
