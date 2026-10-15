import { safeDiagnosticCode, safeDiagnosticText, sanitizedErrorDetails } from '@veyrobot/contracts';

export { safeDiagnosticCode, safeDiagnosticText, sanitizedErrorDetails };

const publicCodes = new Set([
  'ACCESS_DENIED', 'API_RATE_LIMIT', 'DISCORD_RATE_LIMIT', 'DISCORD_UNAVAILABLE', 'INVALID_GUILD_ID',
  'OAUTH_CACHE_CAPACITY', 'OAUTH_RECONNECT_REQUIRED', 'SESSION_ABSENT', 'SESSION_CHECK_UNAVAILABLE',
  'SESSION_REVOKE_UNAVAILABLE', 'MODULE_DISABLED', 'MODERATION_BACKLOG_LIMIT', 'MODERATION_RULE_ERROR',
  'INTERNAL_ERROR', 'VALIDATION_ERROR', 'REQUEST_FAILED', 'SERVICE_UNAVAILABLE', 'UNKNOWN_ERROR',
]);

function read(value: unknown, key: string): unknown {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined;
  try { return Reflect.get(value, key); } catch { return undefined; }
}

export function safeRequestId(value: unknown): string {
  return typeof value === 'string' && /^[\w-]{1,128}$/.test(value) ? value : 'unknown';
}

export function safeRetryAfter(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 64) return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 86_400 ? String(numeric) : undefined;
}

export interface ClassifiedApiError {
  status: number;
  code: string;
  message: string;
  retryAfter?: string;
}

export function classifyApiError(error: unknown): ClassifiedApiError {
  const rawStatus = read(error, 'statusCode');
  const rawCode = read(error, 'code');
  const name = read(error, 'name');
  const statusCode = typeof rawStatus === 'number' && Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : undefined;
  const code = safeDiagnosticCode(rawCode);
  const isValidation = name === 'ZodError' || name === 'ModerationRuleError' || code === 'MODERATION_RULE_ERROR';
  const dependencyUnavailable = ['P1000', 'P1001', 'P1002', 'P1017', 'P2024'].includes(typeof rawCode === 'string' ? rawCode : '') || name === 'PrismaClientInitializationError';
  const status = isValidation ? 400 : statusCode ?? (rawCode === 'P2002' || rawCode === 'P2034' ? 409 : code === 'MODERATION_BACKLOG_LIMIT' ? 429 : dependencyUnavailable ? 503 : 500);
  const safeCode = code && publicCodes.has(code) ? code : isValidation ? 'VALIDATION_ERROR' : status === 401 ? 'SESSION_ABSENT' : status === 403 ? 'ACCESS_DENIED' : status === 409 ? 'REQUEST_FAILED' : status === 429 ? 'API_RATE_LIMIT' : status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED';
  const message = status === 400 ? 'Requête invalide.' : status === 401 ? 'Reconnectez votre compte.' : status === 403 ? 'Accès refusé.' : status === 409 ? 'Conflit avec une opération existante.' : status === 429 ? 'Trop de requêtes ou capacité atteinte.' : status === 503 || status === 502 ? 'Service temporairement indisponible.' : 'Erreur interne.';
  const retryAfter = safeRetryAfter(read(error, 'retryAfter'));
  return { status, code: safeCode, message, ...(retryAfter ? { retryAfter } : {}) };
}

export function apiExceptionLogRecord(requestId: unknown, status: unknown, code: unknown, error: unknown, phase = 'request'): Record<string, unknown> {
  return {
    requestId: safeRequestId(requestId),
    status: typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : 500,
    code: safeDiagnosticCode(code) ?? 'INTERNAL_ERROR',
    phase: safeDiagnosticText(phase, 48) ?? 'request',
    exception: sanitizedErrorDetails(error),
  };
}
