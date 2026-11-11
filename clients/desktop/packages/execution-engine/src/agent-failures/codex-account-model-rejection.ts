import type { CodexAccountModelAccessFailureKind } from '@canopy/protocol/auth-recovery';

/** What {@link classifyCodexAccountModelRejection} recognizes. */
export interface CodexAccountModelRejection {
  kind: CodexAccountModelAccessFailureKind;
  /** The model the account was refused, as the provider named it. */
  model: string;
}

/**
 * OpenAI's refusal of a model a ChatGPT account cannot use with Codex
 * (`docs/codex-app-server.md`). Matched on the provider's own sentence only.
 */
const MODEL_UNSUPPORTED_PATTERN =
  /The '([^']+)' model is not supported when using Codex with a ChatGPT account/;

/**
 * `codexErrorInfo` variants that can carry this rejection. Any other definitive
 * variant (`unauthorized`, `usageLimitExceeded`, ...) is a different failure,
 * whatever its text says.
 */
// Codex 0.165+ reports the refusal's `model_not_found` code as `modelNotFound`.
const TOLERATED_ERROR_INFO = new Set(['badRequest', 'other', 'modelNotFound']);

/**
 * Connection variants Codex uses to forward an upstream HTTP status. The
 * refusal is an HTTP 400, so they count only with status 400 (or none).
 */
const HTTP_STATUS_ERROR_INFO = new Set([
  'httpConnectionFailed',
  'responseStreamConnectionFailed',
]);

function isToleratedErrorInfo(info: unknown, variant: string): boolean {
  if (TOLERATED_ERROR_INFO.has(variant)) return true;
  if (!HTTP_STATUS_ERROR_INFO.has(variant) || !isRecord(info)) return false;
  const detail = info[variant];
  const status = isRecord(detail) ? detail.httpStatusCode : undefined;
  return status === 400 || status === null || status === undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorInfoVariant(info: unknown): string | undefined {
  if (info === undefined || info === null) return undefined;
  if (typeof info === 'string') return info;
  if (isRecord(info)) return Object.keys(info)[0];
  return '';
}

/**
 * The provider's message from a Codex turn error. The runtime reports an HTTP
 * error body as JSON text, sometimes after a status prefix.
 */
function providerMessage(raw: string): string {
  const trimmed = raw.trim();
  const start = trimmed.indexOf('{');
  if (start < 0) return trimmed;
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(start));
    const body = isRecord(parsed) ? parsed : undefined;
    const nested = isRecord(body?.error) ? body.error.message : undefined;
    const message = [nested, body?.error, body?.detail, body?.message].find(
      (value): value is string =>
        typeof value === 'string' && value.trim().length > 0,
    );
    return message?.trim() ?? trimmed;
  } catch {
    return trimmed;
  }
}

/**
 * Classify a failed Codex turn as the signed-in ChatGPT account being refused
 * its model (CAN-4716), or `null`.
 *
 * Deliberately separate from `classifyAgentFailure`, which also drives retry,
 * pipeline and usage-limit handling: this kind is never retried
 * automatically. It is also not a speed denial.
 */
export function classifyCodexAccountModelRejection(
  error: string | undefined,
  codexErrorInfo?: unknown,
): CodexAccountModelRejection | null {
  if (!error) return null;
  const variant = errorInfoVariant(codexErrorInfo);
  if (variant !== undefined && !isToleratedErrorInfo(codexErrorInfo, variant)) {
    return null;
  }
  const model = MODEL_UNSUPPORTED_PATTERN.exec(providerMessage(error))?.[1];
  return model ? { kind: 'model_unsupported', model } : null;
}
