export type SanitizedErrorDetails = {
  name: string;
  code?: string;
  message: string;
  cause?: SanitizedErrorDetails;
};

const safeNames = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError', 'AggregateError',
  'AbortError', 'TimeoutError', 'FastifyError', 'ZodError', 'ModerationRuleError', 'DiscordAPIError',
  'PrismaClientKnownRequestError', 'PrismaClientUnknownRequestError', 'PrismaClientRustPanicError',
  'PrismaClientInitializationError', 'PrismaClientValidationError',
]);

const safeCodes = new Set([
  'ACCESS_DENIED', 'API_RATE_LIMIT', 'DISCORD_RATE_LIMIT', 'DISCORD_UNAVAILABLE', 'INVALID_GUILD_ID',
  'OAUTH_CACHE_CAPACITY', 'OAUTH_RECONNECT_REQUIRED', 'SESSION_ABSENT', 'SESSION_CHECK_UNAVAILABLE',
  'SESSION_REVOKE_UNAVAILABLE', 'MODULE_DISABLED', 'MODERATION_BACKLOG_LIMIT', 'MODERATION_RULE_ERROR',
  'INTERNAL_ERROR', 'VALIDATION_ERROR', 'REQUEST_FAILED', 'SERVICE_UNAVAILABLE', 'UNKNOWN_ERROR',
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ABORT_ERR',
  'ERR_INVALID_ARG_TYPE', 'ERR_SOCKET_CLOSED', 'ERR_HTTP_HEADERS_SENT',
]);

const diagnosticTextBudget = 4096;
const omittedLongText = '[diagnostic text omitted: input limit exceeded]';
const omittedExceptionText = 'Exception text omitted.';
const sensitiveAssignment = /("?(?:client[_-]?secret|session[_-]?key|access[_-]?token|refresh[_-]?token|password|api[_-]?key|token|secret)"?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n]*)/gi;
const rawJwt = /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g;

function read(value: unknown, property: string): unknown {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined;
  try { return Reflect.get(value, property); } catch { return undefined; }
}

export function safeDiagnosticCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (safeCodes.has(value) || /^P\d{4}$/.test(value)) return value;
  return undefined;
}

export function safeDiagnosticText(value: unknown, maxLength = 160): string | undefined {
  if (typeof value !== 'string' || maxLength < 1) return undefined;
  if (value.length > diagnosticTextBudget) return omittedLongText.slice(0, maxLength);
  let text = value;
  text = text
    .replace(/\b(postgres(?:ql)?|redis|mysql|mongodb(?:\+srv)?):\/\/[^\s/@]+@/gi, '$1://[redacted]@')
    .replace(/\b([a-z][a-z\d+.-]*:\/\/)[^\s/@]+:[^\s/@]*@/gi, '$1[redacted]@')
    .replace(/\b(authorization\s*[:=]\s*)(?:(?:Bearer|Basic)\s+)?[^\s,;]+/gi, '$1[redacted]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, '[redacted-authorization]')
    .replace(/\b(set-cookie|cookie)\s*[:=]\s*[^\r\n]*/gi, '$1=[redacted]')
    .replace(sensitiveAssignment, '$1[redacted]')
    .replace(rawJwt, '[redacted-token]')
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, maxLength);
}

function errorName(value: unknown): string {
  const name = read(value, 'name');
  return typeof name === 'string' && safeNames.has(name) ? name : 'Error';
}

function summarize(value: unknown, depth: number, seen: Set<object>): SanitizedErrorDetails | undefined {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined;
  if (seen.has(value)) return { name: 'Error', message: '[circular cause]' };
  seen.add(value);

  const rawCode = read(value, 'code');
  const rawCause = read(value, 'cause');
  const code = safeDiagnosticCode(rawCode);
  const result: SanitizedErrorDetails = {
    name: errorName(value),
    ...(code ? { code } : {}),
    message: omittedExceptionText,
  };

  if (rawCause !== undefined) {
    if (depth >= 3) result.cause = { name: 'Error', message: '[cause depth limit]' };
    else result.cause = summarize(rawCause, depth + 1, seen) ?? {
      name: 'Error',
      message: 'Cause text omitted.',
    };
  }
  return result;
}

export function sanitizedErrorDetails(error: unknown): SanitizedErrorDetails {
  try {
    return summarize(error, 0, new Set()) ?? { name: 'Error', message: 'Non-Error thrown.' };
  } catch {
    return { name: 'Error', message: 'Error details unavailable.' };
  }
}
