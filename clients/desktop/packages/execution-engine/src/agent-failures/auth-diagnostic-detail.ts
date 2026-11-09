import { redactSecrets } from '../lib/redaction';

/**
 * Upper bound on the `AuthDependencyFailure.detail` string carried onto a
 * transcript block.
 *
 * Tighter than the 2000-character cap `classifier.ts` applies to
 * `diagnostic_message`: `detail` is persisted per block and replays into the
 * web Portal, where a long upstream error body is noise rather than context.
 */
const MAX_AUTH_DIAGNOSTIC_DETAIL_LENGTH = 512;

/**
 * Prepare a raw upstream diagnostic for `AuthDependencyFailure.detail`.
 *
 * Redaction delegates to `redactSecrets`, which
 * `packages/execution-engine/src/lib/redaction.ts` declares as the single source
 * of truth for masking secrets and PII out of free text before it leaves the
 * machine. A parallel regex list here would inevitably lag it — the one this
 * replaced leaked JWTs, `github_pat_*`, `ghu_`/`ghs_`/`ghr_`, `xoxb-*`, AWS
 * access key ids, `sk-proj-*`, `X-Api-Key:` headers, `auth_token:`
 * assignments, and PEM blocks — and `detail` is a real egress path
 * (CAN-1814 review).
 */
export function toAuthDiagnosticDetail(raw: string): string {
  const redacted = redactSecrets(raw);
  return redacted.length > MAX_AUTH_DIAGNOSTIC_DETAIL_LENGTH
    ? `${redacted.slice(0, MAX_AUTH_DIAGNOSTIC_DETAIL_LENGTH - 1)}…`
    : redacted;
}
