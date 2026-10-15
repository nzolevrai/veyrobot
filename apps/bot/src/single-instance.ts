import { Client as PgClient } from 'pg';

/** Holds a PostgreSQL session advisory lock for the entire bot lifetime. */
export async function acquireSingleBotLease(connectionString: string, onLost: () => void): Promise<() => Promise<void>> {
  const guard = new PgClient({ connectionString, application_name: 'veyrobot-bot-lease', connectionTimeoutMillis: 3_000 });
  let released = false;
  const lost = () => { if (!released) onLost(); };
  guard.on('error', lost);
  guard.on('end', lost);
  try {
    await guard.connect();
    const result = await guard.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS acquired', [86291, 1]);
    if (!result.rows[0]?.acquired) throw new Error('Un autre processus bot détient déjà le verrou de cette base.');
    return async () => { released = true; await guard.end(); };
  } catch (error) {
    released = true;
    await guard.end().catch(() => undefined);
    throw error;
  }
}
