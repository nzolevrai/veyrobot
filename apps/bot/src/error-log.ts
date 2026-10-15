import { safeDiagnosticText, sanitizedErrorDetails } from '@veyrobot/contracts';

export function logBotError(event: string, source: string, message: string, error: unknown): void {
  try {
    console.error(JSON.stringify({
      event: safeDiagnosticText(event, 48) ?? 'bot_error',
      source: safeDiagnosticText(source, 80) ?? 'unknown',
      message: safeDiagnosticText(message, 160) ?? 'Bot operation failed.',
      exception: sanitizedErrorDetails(error),
    }));
  } catch {
    console.error('{"event":"bot_error","message":"Bot operation failed."}');
  }
}
