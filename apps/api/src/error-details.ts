function safeMessage(message: string): string {
  return message
    .replace(/(Bot|Bearer)\s+[^\s,;]+/gi, '$1 [redacted]')
    .replace(/(set-cookie|cookie)\s*[:=]\s*[^\r\n;]+/gi, '$1=[redacted]')
    .replace(/(access_token|client_secret|password|token|code)=?[^\s&;,]*/gi, '$1=[redacted]')
    .replace(/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s]+@/gi, '$1[redacted]@')
    .replace(/\b[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{6,}\.[a-zA-Z0-9_-]{20,}\b/g, '[redacted-token]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 500);
}

export function sanitizedErrorDetails(error: unknown): { name: string; code?: string; message: string; cause?: { name: string; message: string } } {
  const value = error instanceof Error ? error : new Error('Non-Error thrown');
  const candidate = error as { code?: unknown } | null;
  const rawCause = (error as { cause?: unknown } | null)?.cause;
  const cause = rawCause instanceof Error ? { name: rawCause.name.slice(0, 80), message: safeMessage(rawCause.message) } : undefined;
  const code = typeof candidate?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(candidate.code) ? candidate.code : undefined;
  return { name: value.name.slice(0, 80), ...(code ? { code } : {}), message: safeMessage(value.message), ...(cause ? { cause } : {}) };
}
