// ---------------------------------------------------------------------------
// Pure secret/PII scrubber (CAN-374 / CAN-402).
//
// The single source of truth for masking secrets and PII out of free text:
// telemetry and instrumentation through `@canopy/desktop-shared/lib/redaction`
// (which re-exports it), and local memory through `@canopy/memory-consolidation`,
// which the desktop and Canopy Cloud share. Only regular expressions: no Node
// APIs, no Electron, no filesystem.
//
// `redactText()` in `packages/desktop-instrumentation/src/privacy.ts` layers
// URL/home-path normalization on top of this and then delegates here, so the
// secret/PII vocabulary lives in exactly one place.
// ---------------------------------------------------------------------------

const REDACTED = '<redacted>';

/**
 * The complete secret-bearing assignment-key vocabulary, as a regex
 * alternation source string. This is the single source of truth for which
 * key names mark an assignment value as a secret; the `key: value` and
 * `key=value` passes below and downstream consumers (e.g. the local-memory
 * pre-persistence redactor) must all derive their key matching from this
 * constant rather than hand-maintaining subsets.
 */
export const SECRET_ASSIGNMENT_KEYS_SOURCE =
  'api[_-]?key|access[_-]?key|secret[_-]?access[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd';

/**
 * Ordered list of redaction passes. Order matters: multi-line/structured
 * blocks (PEM) run before token-shaped patterns, and the generic
 * `key: value` / `key=value` masks run after the specific token shapes so a
 * specific replacement is not clobbered by a broader one.
 */
interface RedactionPass {
  readonly pattern: RegExp;
  readonly replacement: string;
}

const SECRET_REDACTION_PASSES: ReadonlyArray<RedactionPass> = [
  // PEM-encoded private key blocks (RSA/EC/OPENSSH/generic).
  {
    pattern:
      /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
    replacement: '<redacted-private-key>',
  },
  // JSON Web Tokens (header.payload.signature, header starts with `eyJ`).
  {
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replacement: '<redacted-jwt>',
  },
  // GitHub fine-grained personal access tokens.
  {
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    replacement: '<redacted-token>',
  },
  // GitHub classic tokens: ghp_, gho_, ghu_, ghs_, ghr_.
  {
    pattern: /\bgh[opusr]_[A-Za-z0-9]{20,}/g,
    replacement: '<redacted-token>',
  },
  // Slack bot/app/user/configuration tokens.
  {
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
    replacement: '<redacted-token>',
  },
  // AWS access key IDs.
  {
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: '<redacted-aws-key>',
  },
  // OpenAI / Anthropic style secret keys (`sk-`, `sk-ant-...`).
  {
    pattern: /\bsk-[A-Za-z0-9_-]{16,}/g,
    replacement: '<redacted-token>',
  },
  // Authorization / Cookie / common API-key headers (mask the whole value).
  {
    pattern:
      /\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie|X-Api-Key|X-Auth-Token|X-Amz-Security-Token)\s*:\s*([^\r\n]+)/gi,
    replacement: `$1: ${REDACTED}`,
  },
  // Bearer tokens anywhere in the text.
  {
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]+=*/g,
    replacement: `Bearer ${REDACTED}`,
  },
  // key: value (quoted or unquoted) for secret-bearing keys.
  {
    pattern: new RegExp(
      `(["']?(?:${SECRET_ASSIGNMENT_KEYS_SOURCE})["']?\\s*:\\s*["']?)([^"',}\\]\\s]+)`,
      'gi',
    ),
    replacement: `$1${REDACTED}`,
  },
  // key=value for secret-bearing keys (query strings, env-style, CLI flags).
  {
    pattern: new RegExp(
      `\\b(${SECRET_ASSIGNMENT_KEYS_SOURCE})=([^\\s&"']+)`,
      'gi',
    ),
    replacement: `$1=${REDACTED}`,
  },
];

const PII_REDACTION_PASSES: ReadonlyArray<RedactionPass> = [
  // Email addresses (PII).
  {
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: '<redacted-email>',
  },
  // IPv4 addresses (PII).
  {
    pattern:
      /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
    replacement: '<redacted-ip>',
  },
  // User home directories (PII): mask the OS username component while keeping
  // the rest of the path for context. Mirrors the home-path normalization in
  // `packages/desktop-instrumentation/src/privacy.ts` so direct `redactSecrets`
  // callers (telemetry transcript bodies, branch/workspace names, plan/PR
  // titles) do not leak the username. macOS `/Users/<name>`, Linux
  // `/home/<name>`, and Windows `<drive>:\Users\<name>`.
  {
    pattern: /\/Users\/[^/\s)]+/g,
    replacement: '<user-home>',
  },
  {
    pattern: /\/home\/[^/\s)]+/g,
    replacement: '<user-home>',
  },
  {
    pattern: /[A-Za-z]:\\Users\\[^\\\s)]+/g,
    replacement: '<user-home>',
  },
];

const REDACTION_PASSES = [
  ...SECRET_REDACTION_PASSES,
  ...PII_REDACTION_PASSES,
] as const;

/**
 * Mask secrets and PII out of an arbitrary string. Pure and idempotent enough
 * for repeated application (already-redacted markers contain no secret shapes).
 *
 * Coverage: API keys / tokens / secrets / passwords expressed as `key: value`
 * or `key=value`, `Authorization`/`Cookie`/`Bearer` headers, JWTs, GitHub
 * tokens, AWS access keys, OpenAI/Anthropic `sk-` keys, PEM private-key blocks,
 * email addresses, IPv4 addresses, and user home-directory paths (the OS
 * username component is masked).
 */
export function redactSecrets(text: string): string {
  if (text.length === 0) {
    return text;
  }
  return REDACTION_PASSES.reduce(
    (current, { pattern, replacement }) =>
      current.replace(pattern, replacement),
    text,
  );
}
