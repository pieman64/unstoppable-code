import {
  redactSecrets as redactSharedSecrets,
  SECRET_ASSIGNMENT_KEYS_SOURCE,
} from '@canopy/protocol/secret-redaction';

// Built from the shared redactor's complete assignment-key vocabulary so the
// two passes can never drift apart again: any key the shared `key: value` /
// `key=value` rules treat as secret-bearing is also rest-of-line-redacted
// here, with optional `[a-z0-9]+[_-]` prefixes and the bare `apikey` spelling
// on top.
const MEMORY_SECRET_ASSIGNMENT_RULE = new RegExp(
  `\\b((?:[a-z0-9]+[_-])*(?:${SECRET_ASSIGNMENT_KEYS_SOURCE})|apikey)(["']?[^\\S\\n]*[=:]+[^\\S\\n]*)([^\\n]+)`,
  'gi',
);

/**
 * Memory-specific redaction: the shared telemetry scrubber as a base pass
 * plus the store's additional credential patterns (connection strings, token
 * prefixes, high-entropy blobs, assignment rest-of-line). Exported so
 * consolidation output is scrubbed with the SAME rules as note content
 * before it is persisted at rest.
 */
export function redactMemoryContent(text: string): string {
  // Base pass: the shared scrubber (`@canopy/protocol/secret-redaction`)
  // owns the common secret/PII vocabulary — PEM private-key blocks, JWTs,
  // GitHub classic and fine-grained tokens, AWS access keys, `sk-` keys,
  // Authorization/Cookie/API-key headers, Bearer tokens, `key: value` /
  // `key=value` secret pairs, email addresses, IPv4 addresses, and user
  // home-directory paths.
  let result = redactSharedSecrets(text);
  // Memory-specific additions the shared corpus does not cover follow.
  // Credential-bearing connection strings: known database/broker schemes, and
  // any scheme carrying user:password@ credentials.
  result = result.replace(
    /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s"']+/gi,
    '<CONNECTION_STRING>',
  );
  result = result.replace(
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"']+:[^\s:/@"']+@[^\s"']+/gi,
    '<CONNECTION_STRING>',
  );
  // Token prefixes the shared module lacks, anchored to their real key
  // shapes (separator or distinctive prefix) so ordinary words that merely
  // start with `sk`/`pk` can never match.
  result = result.replace(
    /\b(?:(?:sk|pk|rk|csk)[-_][A-Za-z0-9_-]{10,}|xox[bapr]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{30,}|ya29\.[A-Za-z0-9_.-]{20,}|AKIA[A-Z0-9]{16}|gh[po]_[A-Za-z0-9]{20,})\b/g,
    '<API_KEY>',
  );
  // High-entropy 40-char base64ish blobs (classic AWS secret-key shape).
  result = result.replace(
    /(?<![A-Za-z0-9/+])(?=[A-Za-z0-9/+]*[A-Z])(?=[A-Za-z0-9/+]*[a-z])(?=[A-Za-z0-9/+]*[0-9])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/g,
    '<SECRET>',
  );
  // Prefixed assignment keys (e.g. OPENAI_CUSTOM_TOKEN=...) that the shared
  // module's word-boundary key list cannot reach. The key vocabulary is the
  // shared redactor's own SECRET_ASSIGNMENT_KEYS_SOURCE (never a
  // hand-maintained subset), extended with optional prefixes and the bare
  // `apikey` spelling. A real assignment separator (= or :) is required so
  // ordinary prose like "password reminder123" is never rewritten; whitespace
  // is tolerated on both sides of the separator. Once a secret-key assignment
  // is present, the REST OF THE LINE is redacted: no value parsing (quotes,
  // spaces, length) is attempted, so no shape of credential can partially
  // survive. Deliberately conservative — trailing same-line prose after an
  // explicit secret assignment is sacrificed rather than risking a leaked
  // fragment.
  result = result.replace(
    MEMORY_SECRET_ASSIGNMENT_RULE,
    (match, key: string, separator: string, value: string): string => {
      // Leave values the shared pass already fully replaced untouched.
      if (/^["']?<[A-Za-z_-]+>["']?$/.test(value.trim())) return match;
      return `${key}${separator}<TOKEN>`;
    },
  );
  return result;
}
