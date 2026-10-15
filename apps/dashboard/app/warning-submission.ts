export async function createWarningThenRefresh<T>(create: () => Promise<T | null>, refresh: () => Promise<boolean>): Promise<{ created: T | null; refreshed: boolean }> {
  const created = await create();
  if (created === null) return { created, refreshed: false };
  try { return { created, refreshed: await refresh() }; }
  catch { return { created, refreshed: false }; }
}
