import { MEMORY_SYNC_LIMITS } from '@canopy/protocol/memory-sync';
import {
  redactSecrets as redactSharedSecrets,
  SECRET_ASSIGNMENT_KEYS_SOURCE,
} from '@canopy/protocol/secret-redaction';

// Built from the shared redactor's complete assignment-key vocabulary so the
// two passes can never drift apart again: any key the shared `key: value` /
// `key=value` rules treat as secret-bearing is also rest-of-line-redacted
// here, with optional `[a-z0-9]+[_-]` prefixes on top.
//
// The match starts at the key itself, never at its first prefix, so each run
// of word characters and dashes is tried once instead of once per prefix. The
// key must end its run (the lookahead) and must follow a word boundary, or
// `_`-joined prefixes that start at one (the lookbehind; a dash is a word
// boundary). The prefixes are left in the text as they were.
const MEMORY_SECRET_ASSIGNMENT_RULE = new RegExp(
  `(?=(?:${SECRET_ASSIGNMENT_KEYS_SOURCE})["']?[^\\S\\n]*[=:])(?<=(?:^|\\W)(?:[a-z0-9]+_)*)(${SECRET_ASSIGNMENT_KEYS_SOURCE})(["']?[^\\S\\n]*[=:]+[^\\S\\n]*)([^\\n]+)`,
  'gi',
);

// A URL carrying user:password@ credentials, or (second branch) the rest of a
// run of scheme characters: every start in one run reaches the same `://`, so
// a run that starts no such URL is skipped whole rather than retried at each
// word boundary inside it. Runs shorter than 16 are not skipped: retrying
// them costs little, and ordinary words then never call the replacer.
// The user and password never hold `<SECRET>`: the blob pass after this one
// writes it in place of a secret whose `/` made this rule refuse the URL, so
// accepting it would redact on a second run what the first run kept.
const CREDENTIAL_URL_RULE =
  /(\b[a-z][a-z0-9+.-]*:\/\/(?:(?!<SECRET>)[^\s:/@"'])+:(?:(?!<SECRET>)[^\s:/@"'])+@[^\s"']+)|\b[a-z][a-z0-9+.-]{15,}/gi;

/**
 * The memory passes in order: the shared telemetry scrubber as a base pass
 * plus the store's additional credential patterns (connection strings, token
 * prefixes, high-entropy blobs, assignment rest-of-line). Every pass runs in
 * time linear in its input.
 */
const MEMORY_REDACTION_PASSES: readonly ((text: string) => string)[] = [
  // Base pass: the shared scrubber (`@canopy/protocol/secret-redaction`)
  // owns the common secret/PII vocabulary — PEM private-key blocks, JWTs,
  // GitHub classic and fine-grained tokens, AWS access keys, `sk-` keys,
  // Authorization/Cookie/API-key headers, Bearer tokens, `key: value` /
  // `key=value` secret pairs, email addresses, IPv4 addresses, and user
  // home-directory paths.
  redactSharedSecrets,
  // Memory-specific additions the shared corpus does not cover follow.
  // Credential-bearing connection strings: known database/broker schemes, and
  // any scheme carrying user:password@ credentials.
  (text) =>
    text.replace(
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s"']+/gi,
      '<CONNECTION_STRING>',
    ),
  (text) =>
    text.replace(CREDENTIAL_URL_RULE, (match, url: string | undefined) =>
      url === undefined ? match : '<CONNECTION_STRING>',
    ),
  // Token prefixes the shared module lacks, anchored to their real key
  // shapes (separator or distinctive prefix) so ordinary words that merely
  // start with `sk`/`pk` can never match.
  (text) =>
    text.replace(
      /\b(?:(?:sk|pk|rk|csk)[-_][A-Za-z0-9_-]{10,}|xox[bapr]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{30,}|ya29\.[A-Za-z0-9_.-]{20,}|AKIA[A-Z0-9]{16}|gh[po]_[A-Za-z0-9]{20,})\b/g,
      '<API_KEY>',
    ),
  // High-entropy 40-char base64ish blobs (classic AWS secret-key shape).
  (text) =>
    text.replace(
      /(?<![A-Za-z0-9/+])(?=[A-Za-z0-9/+]*[A-Z])(?=[A-Za-z0-9/+]*[a-z])(?=[A-Za-z0-9/+]*[0-9])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/g,
      '<SECRET>',
    ),
  // Prefixed assignment keys (e.g. OPENAI_CUSTOM_TOKEN=...) that the shared
  // module's word-boundary key list cannot reach. The key vocabulary is the
  // shared redactor's own SECRET_ASSIGNMENT_KEYS_SOURCE (never a
  // hand-maintained subset), extended with optional prefixes. A real
  // assignment separator (= or :) is required so ordinary prose like
  // "password reminder123" is never rewritten; whitespace is tolerated on
  // both sides of the separator. Once a secret-key assignment is present, the
  // REST OF THE LINE is redacted: no value parsing (quotes, spaces, length) is
  // attempted, so no shape of credential can partially survive. Deliberately
  // conservative — trailing same-line prose after an explicit secret
  // assignment is sacrificed rather than risking a leaked fragment.
  (text) =>
    text.replace(
      MEMORY_SECRET_ASSIGNMENT_RULE,
      (match, key: string, separator: string, value: string): string => {
        // Leave values the shared pass already fully replaced untouched.
        if (/^["']?<[A-Za-z_-]+>["']?$/.test(value.trim())) return match;
        return `${key}${separator}<TOKEN>`;
      },
    ),
];

/**
 * Memory-specific redaction: the shared telemetry scrubber as a base pass
 * plus the store's additional credential patterns. Exported so consolidation
 * output is scrubbed with the SAME rules as note content before it is
 * persisted at rest.
 */
export function redactMemoryContent(text: string): string {
  return MEMORY_REDACTION_PASSES.reduce((current, pass) => pass(current), text);
}

/**
 * The longest text the bounded scan reads: the largest note or document the
 * memory sync API accepts. A string never has more UTF-16 units than UTF-8
 * bytes, so every text within that byte limit fits.
 */
export const MEMORY_SECRET_SCAN_MAX_CHARS = MEMORY_SYNC_LIMITS.documentMaxBytes;

/** Scan time one request may spend, shared by every text it scans. */
export interface MemorySecretScanBudget {
  remainingMs: number;
  readonly now: () => number;
}

/**
 * The default allows several times what the largest commit the sync API
 * accepts (16 MiB) takes to scan, so only a pathological request runs out.
 */
export function createMemorySecretScanBudget(
  ms = 5_000,
  now: () => number = () => performance.now(),
): MemorySecretScanBudget {
  return { remainingMs: ms, now };
}

/**
 * `clean` when the redaction leaves the text as it is, `secret` when it
 * would change it, and `incomplete` when the text is longer than the scan
 * reads or the budget ran out before every pass ran. Callers refuse an
 * incomplete text: it was not shown to be free of secrets.
 */
export type MemorySecretScanResult = 'clean' | 'secret' | 'incomplete';

/**
 * Whether `text` holds anything `redactMemoryContent` would redact, at a cost
 * bounded by the text's length and the budget. Only time spent in the passes
 * counts against the budget, which is checked before each pass.
 */
export function scanMemoryContentForSecrets(
  text: string,
  budget: MemorySecretScanBudget,
): MemorySecretScanResult {
  if (text.length > MEMORY_SECRET_SCAN_MAX_CHARS) return 'incomplete';
  let redacted = text;
  for (const pass of MEMORY_REDACTION_PASSES) {
    if (budget.remainingMs <= 0) return 'incomplete';
    const started = budget.now();
    redacted = pass(redacted);
    budget.remainingMs -= budget.now() - started;
  }
  return redacted === text ? 'clean' : 'secret';
}
