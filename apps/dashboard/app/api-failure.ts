export type ApiFailure = { status: number; code: string; requestId?: string; retryAfter?: string };
export function failureMessage(failure: ApiFailure): string {
  switch (failure.code) {
    case 'SESSION_ABSENT': return 'Votre session Discord est absente ou expirée. Reconnectez-vous.';
    case 'OAUTH_RECONNECT_REQUIRED': return 'L’autorisation Discord a expiré ou été retirée. Reconnectez votre compte.';
    case 'ACCESS_DENIED': return 'Vous n’avez plus accès à ce serveur.';
    case 'API_RATE_LIMIT': return 'Trop de requêtes vers VeyroBot. Patientez avant de réessayer.';
    case 'DISCORD_RATE_LIMIT': return 'Discord limite temporairement la lecture des serveurs. Réessayez plus tard.';
    case 'DISCORD_UNAVAILABLE': return 'Discord ne répond pas actuellement. Votre session est conservée.';
    case 'API_UNREACHABLE': return 'L’API VeyroBot ne répond pas actuellement. Votre session est conservée.';
    default: return failure.status >= 500 ? 'Le service est temporairement indisponible. Votre session est conservée.' : 'La requête a été refusée.';
  }
}
export async function readApiFailure(response: Response): Promise<ApiFailure> {
  let body: { code?: unknown; requestId?: unknown } = {};
  try { body = await response.json() as typeof body; } catch { /* réponse non JSON */ }
  const code = typeof body.code === 'string' ? body.code : response.status === 429 ? 'API_RATE_LIMIT' : response.status === 401 ? 'SESSION_ABSENT' : 'INTERNAL_ERROR';
  const requestId = typeof body.requestId === 'string' ? body.requestId : response.headers.get('x-request-id') ?? undefined;
  const retryAfter = response.headers.get('retry-after') ?? undefined;
  return { status: response.status, code, ...(requestId ? { requestId } : {}), ...(retryAfter ? { retryAfter } : {}) };
}
export function failureReference(failure: ApiFailure): string { return failure.requestId ? ` Référence : ${failure.requestId}.` : ''; }
