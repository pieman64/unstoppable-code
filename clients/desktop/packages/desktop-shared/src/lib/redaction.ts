export { containsSecretMaterial } from '@canopy/protocol/capability-files';

// ---------------------------------------------------------------------------
// Pure secret/PII scrubber (CAN-374 / CAN-402).
//
// This module is the single source of truth for masking secrets and PII out of
// free-text before it leaves the machine (telemetry sync) or is sent to
// instrumentation. It is intentionally dependency-free and browser-safe: only
// regular expressions, no Node APIs, no Electron, no filesystem. That keeps it
// importable from `packages/desktop-instrumentation` (which delegates to it),
// from the desktop main process, and from renderer-safe code, and lets it pass
// `npm run check:electron-boundary`.
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

/**
 * Extends `match` to cover every occurrence — of any configured value,
 * including a further occurrence of the SAME value — whose start falls
 * anywhere within the current span and whose end reaches further, repeating
 * until stable.
 *
 * Finalizing only the leftmost-starting match and moving past its end is
 * unsafe whenever two DIFFERENT configured values can match at different,
 * overlapping start positions (e.g. one value is a suffix-sharing infix of
 * another, or one value is internally periodic and matches itself twice
 * with overlapping spans): the other occurrence's non-overlapping tail
 * would be left as untouched raw text — a real partial-secret leak, not a
 * cosmetic difference.
 *
 * Tracks each value's next not-yet-considered occurrence in `nextOccurrence`
 * and only ever advances a value's pointer forward, past an occurrence once
 * it's been fully accounted for (whether or not it extended the span) — an
 * EARLIER version of this function instead re-sliced and re-scanned the
 * whole `[match.start, match.end)` window from scratch on every pass, which
 * is quadratic in the merged span's size: a long run of a self-overlapping
 * (periodic) configured value can produce a long chain of extensions, and
 * re-scanning the growing window on every one of them made a single
 * `redactValues`/`SecretValueRedactor` call over such a run take seconds on
 * a merely tens-of-KB input, with the streaming class additionally
 * accumulating the ENTIRE run in its internal buffer while the span kept
 * reaching the unsafe tail on every chunk — directly contradicting that
 * class's own bounded-memory guarantee. Advancing each value's pointer
 * monotonically instead means every occurrence is examined exactly once
 * over the life of one `extendMatchToFurthestOverlap` call, so total cost
 * is proportional to the number of configured values times the number of
 * occurrences actually found — linear in the merged span's size, not
 * quadratic.
 *
 * `nextIndexAtOrAfter` is the caller's own cached lookup (identical in shape
 * to `redactValues`'s below — see it for the exact cache; `SecretValueRedactor`,
 * `node/pipelines/executor/spawned-process.ts`, builds a fresh instance of the
 * same shape once per `drain` call) rather than a plain `text.indexOf`,
 * so that a configured value that never occurs anywhere in `text` still
 * costs only one remaining-text scan for the whole call, not one per match
 * found by the caller's own outer loop. Callers must only ever query with a
 * non-decreasing `from` per value within one call — the cache's own guard
 * (`from >= cached.searchedFrom`) falls through to a fresh scan otherwise,
 * but relying on that fallback instead of preserving monotonicity defeats
 * the point of caching. `SecretValueRedactor` learned this the hard way: an
 * earlier revision of its own cap decision queried this exact cache
 * backward (checking which values occur inside an already-extended span,
 * after `extendMatchToFurthestOverlap`'s own retiring loop had already
 * advanced past that point), and the cache's then-unguarded "found" branch
 * returned a stale answer — a real, shipped leak, fixed by adding the guard
 * and then, once both reviewers had independently proven the guard itself
 * sound, by removing that backward query entirely (track the value that
 * seeded the match instead of re-querying).
 *
 * This is the ONE place this extension algorithm is implemented — shared by
 * `redactValues` below (whole-string, no streaming) and the streaming
 * `SecretValueRedactor` (`node/pipelines/executor/spawned-process.ts`, which
 * additionally defers finalizing a match whose extended span reaches its
 * buffer's not-yet-fully-arrived tail until more text, or the end of the
 * stream, decides it — see its own docstring). An earlier
 * version of this PR hardened only
 * the streaming class against this exact overlap class, leaving
 * `redactValues` — which is what actually redacts the durable
 * `rawText`/`structured`/`proposedPlan`/`agent-failure.json` outputs, not
 * just the live transcript stream — with the original, unsafe
 * `split`/`join` implementation. Two independent copies of the same
 * matching logic is how that gap survived; there must be only one.
 */
export function extendMatchToFurthestOverlap(
  values: readonly string[],
  match: { start: number; end: number },
  nextIndexAtOrAfter: (value: string, from: number) => number,
): { start: number; end: number } {
  const nextOccurrence = new Map<string, number>();
  for (const value of values) {
    nextOccurrence.set(value, nextIndexAtOrAfter(value, match.start));
  }
  for (;;) {
    let extended = false;
    for (const value of values) {
      let start = nextOccurrence.get(value) ?? -1;
      // Permanently retire every occurrence of `value` that is already
      // fully covered by the current span — it starts before `match.end`
      // but doesn't reach past it — since `match.end` only ever grows, so
      // such an occurrence can never become relevant again.
      while (
        start !== -1 &&
        start < match.end &&
        start + value.length <= match.end
      ) {
        start = nextIndexAtOrAfter(value, start + 1);
      }
      nextOccurrence.set(value, start);
      if (start === -1 || start >= match.end) continue;
      const end = start + value.length;
      if (end > match.end) {
        match = { start: match.start, end };
        extended = true;
      }
    }
    if (!extended) break;
  }
  return match;
}

/**
 * Expands a secret value list with each value's own JSON-string-escaped
 * form — the exact character sequence `JSON.stringify` would produce for
 * that value inside a string (backslashes, quotes, and control characters
 * including `\n` become two-character escape sequences). A caller matching
 * against text that is ITSELF the output of JSON-serializing structured
 * data it cannot redact before serialization happens (e.g. an NDJSON
 * transcript line built by an upstream host-runner process this one only
 * observes one already-serialized line at a time, never the pre-serialized
 * event) needs this: a multi-line secret's real newlines never survive
 * serialization, so only the escaped form can still exact-match. JSON
 * escaping never shrinks a string, so an eligible (>= 6 character) raw
 * value's escaped form is always itself eligible — unlike
 * `redactNormalizedText`'s whitespace-normalized variant
 * (`builtin-actions/agent-prompt/logic.ts`), no special-case length handling
 * is needed here.
 *
 * Two levels are produced: the value escaped once, and that escaped once
 * more. Decoded text can hold either — an echo of a JSON list of values holds
 * the first; that echo printed inside another JSON document holds the
 * second. Every value-based masker matches these forms inside DECODED text
 * (string and key content), never against serialized JSON syntax, so the
 * structural path still cannot corrupt a record. Callers pass values that
 * already passed the eligibility floor: escaping only lengthens, so it never
 * promotes a value that was too short to qualify.
 */
export function withJsonEscapedVariants(values: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const value of values) {
    forms.add(value);
    const once = JSON.stringify(value).slice(1, -1);
    forms.add(once);
    forms.add(JSON.stringify(once).slice(1, -1));
  }
  return Array.from(forms);
}

/**
 * How a partial document's opening characters classify. The third state is
 * the load-bearing one: a chunk that is only whitespace so far is NOT
 * "definitely not JSON", it is simply not decided yet, and a caller that
 * collapses those two cases commits the rest of the line to the raw matcher
 * on the strength of a single leading space. That is reproducible against
 * the real parent writer — a child that wrote `' '` in
 * one `write` and an ordinary record in the next had the record corrupted,
 * because the whitespace was read as proof the line was not a document.
 */
export type JsonDocumentStart = 'json' | 'other' | 'undecided';

/** Classifies `text`'s first non-whitespace character. See
 * `JsonDocumentStart` for why "all whitespace so far" is its own answer. */
export function classifyJsonDocumentStart(text: string): JsonDocumentStart {
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (character === ' ' || character === '\t') continue;
    if (character === '\r' || character === '\n') continue;
    return character === '{' || character === '[' ? 'json' : 'other';
  }
  return 'undecided';
}

/** True when `text`'s first non-whitespace character can begin a JSON object
 * or array — the cheap pre-check every caller uses before paying for a real
 * `JSON.parse`, and the only shape the NDJSON/JSONL records this module
 * guards are ever emitted in. Whitespace-only input is NOT a document; a
 * caller that must distinguish "not yet decided" from "decided no" wants
 * `classifyJsonDocumentStart` instead. */
export function looksLikeJsonDocument(text: string): boolean {
  return classifyJsonDocumentStart(text) === 'json';
}

/**
 * Largest number of committed key names one object scope remembers. Past this
 * the scope switches to appending a fresh ordinal, which keeps produced names
 * distinct without remembering them, so bookkeeping never grows with the
 * document.
 */
/**
 * Character budget for masked-key bookkeeping in the STREAMING path, shared
 * across every open scope so the bound does not multiply by nesting depth.
 * Reported by `trackedCharacterLength`.
 */
/**
 * Deterministic work counters for regression tests.
 *
 * A wall-clock ratio is a diagnostic, not a bound: it varies with machine load
 * and invites threshold-raising when it flakes. These count the operations that
 * actually made the structural pass expensive, so a regression is provable
 * rather than timed.
 */
export const redactionWorkCounters = {
  /** Offset maps built (one array entry per decoded code unit). */
  offsetMapsBuilt: 0,
  /** Whole-record character walks performed to assign object scopes. */
  scopeScans: 0,
  /** Whole-record copy passes performed to apply mask splices. */
  recordPasses: 0,
  /**
   * `__N` candidates examined while naming masked keys.
   *
   * Restarting the probe at 1 for every colliding sibling made k siblings cost
   * O(k^2) candidates. Counted rather than timed so the bound is machine
   * independent.
   */
  maskedKeyCandidatesProbed: 0,
  reset(): void {
    redactionWorkCounters.offsetMapsBuilt = 0;
    redactionWorkCounters.scopeScans = 0;
    redactionWorkCounters.recordPasses = 0;
    redactionWorkCounters.maskedKeyCandidatesProbed = 0;
  },
};

/**
 * Chooses names for masked object keys.
 *
 * What this guarantees, and the one thing it cannot:
 *
 * 1. **A key it did not mask is never renamed.** An ordinary duplicate key
 *  therefore survives exactly as it arrived; masking does not get to change
 *  duplicate semantics it had no part in creating.
 * 2. **Identity is the DECODED key, not its serialized spelling.**
 *  `"\u002a\u002a\u002a"` and `"***"` are the same JSON key, and comparing
 *  spellings missed that collision entirely.
 * 3. **A masked key never lands on a name held by another key in the same
 *  object.** Scope is per object: duplicates are only possible inside one, so
 *  a sibling object's key is never renamed to avoid a collision that cannot
 *  happen.
 *
 * 3 holds exactly, not approximately, because the only caller holds the whole
 * record and reserves every key in it before allocating anything. This class
 * used to also serve a bounded STREAMING caller — hence a char budget, a
 * scope-depth cap, `enterObject`/`leaveObject` scope tracking, and a `verified`
 * flag letting a caller decline an unverifiable suffix. That path is gone, and
 * none of that machinery is kept "just in case": unreachable safety code cannot
 * be shown to work, and its presence made the remaining guarantee read as
 * conditional when it is not.
 */
export class MaskedKeyAllocator {
  private readonly scopes = new Map<number, Set<string>>();
  /**
   * Where the `__N` search may resume, per scope and base name.
   *
   * Restarting at 1 for every colliding sibling made k colliding keys cost
   * O(k^2) — 500/1,000/2,000/4,000 siblings measured 51.9/171.1/738.9/3,320.5 ms,
   * quadrupling per doubling. A reserved name is never released, so a candidate
   * rejected once can never become free; resuming past it is safe. The hint only
   * moves where the search STARTS — every candidate is still verified against
   * the scope, so unmasked names and pre-existing duplicates are unaffected.
   */
  private readonly nextSuffix = new Map<string, number>();

  /** Records a decoded key identity present in `scopeId`. */
  reserveIn(scopeId: number, decodedName: string): void {
    const scope = this.scopes.get(scopeId) ?? new Set<string>();
    if (!this.scopes.has(scopeId)) this.scopes.set(scopeId, scope);
    scope.add(decodedName);
  }

  /**
   * Returns the name to emit for a masked key. `serialized` is the
   * already-mask-spliced text; `decoded` is what that text means as a JSON key.
   */
  allocateIn(scopeId: number, serialized: string, decoded: string): string {
    const scope = this.scopes.get(scopeId);
    if (!scope?.has(decoded)) {
      this.reserveIn(scopeId, decoded);
      return serialized;
    }
    const hintKey = `${scopeId}\u0000${decoded}`;
    for (let counter = this.nextSuffix.get(hintKey) ?? 1; ; counter += 1) {
      redactionWorkCounters.maskedKeyCandidatesProbed += 1;
      const candidateDecoded = `${decoded}__${counter}`;
      if (scope.has(candidateDecoded)) continue;
      this.reserveIn(scopeId, candidateDecoded);
      this.nextSuffix.set(hintKey, counter + 1);
      return `${serialized}__${counter}`;
    }
  }
}

/** Decodes the text between a JSON string token's quotes to its key identity. */
export function decodeJsonKeyIdentity(content: string): string {
  return decodeJsonStringToken(`"${content}"`, 1, content.length + 1).decoded;
}

/**
 * Masks configured secret values inside ONE already-serialized JSON document
 * (an NDJSON/JSONL record) by rewriting the ORIGINAL serialized text in
 * place, never by re-serializing a parsed copy. Returns `null` — and only
 * `null` — when `text` is not valid JSON, so a caller can fall back to
 * whatever protection it uses for arbitrary bytes.
 *
 * Two properties make this the correct boundary for serialized output, and
 * both are the reason a raw substring matcher must not be pointed at JSON:
 *
 * 1. **It cannot corrupt the document.** Matching happens only inside a
 *  string token's DECODED value (and over a whole numeric token), so a
 *  configured value that coincidentally equals a structural fragment
 *  (`","subtype":`) or part of the document's own escape syntax (the
 *  `n` of a `\n` followed by real text, which is how a configured
 *  `nABCDE` corrupts `"\nABCDE"`) is never matched: neither sequence
 *  exists in any decoded value. Both are reproducible against the real
 *  parent writer; they are the reason this function exists.
 * 2. **It preserves byte-for-byte fidelity wherever nothing matched.** The
 *  output is the input with only the matched spans spliced, so a record
 *  with no secret in it is returned IDENTICALLY — no re-serialization.
 *  Round-tripping through `JSON.parse`/`JSON.stringify` (which is what
 *  this replaced) silently rewrote every record whenever any secret was
 *  configured: an integer beyond 2^53 lost precision
 *  (`1740000000123456789` → `...800`), `1.0` became `1`, `1e5` became
 *  `100000`, `\uXXXX` escapes re-emitted as raw characters, and
 *  duplicate keys collapsed. Transcript records are provider-owned data
 *  this process only forwards; rewriting them is not ours to do.
 *
 * Decoding is what makes escaped forms matchable without
 * `withJsonEscapedVariants`' guesswork: a multi-line secret whose real
 * newlines were serialized to two-character `\n` sequences decodes back to
 * the raw configured value and matches exactly. That also restores the
 * documented eligibility rule — the >= 6 floor is applied to each value's
 * ORIGINAL form, never to a longer escaped variant of a value that was
 * itself too short to qualify.
 *
 * A numeric token whose text contains a value is replaced WHOLE by the string
 * `"***"`: masking a digit run inside a longer number has no valid numeric
 * form, and the document must stay parseable. This is deliberately MORE
 * conservative than `redactStructuredValue`, which partial-splices a numeric
 * leaf (`{count: 12345678}` against `'234567'` gives `{"count":"1***8"}`).
 *
 */
export function redactJsonPreservingFormat(
  text: string,
  secretValues: readonly string[],
): string | null {
  if (!looksLikeJsonDocument(text)) return null;
  try {
    JSON.parse(text);
  } catch {
    return null;
  }
  // Escaped forms are matched inside each DECODED token, never against the
  // serialized syntax around it.
  const values = Array.from(
    new Set(
      withJsonEscapedVariants(
        secretValues.filter((value) => value.length >= 6),
      ),
    ),
  ).sort((left, right) => right.length - left.length);
  if (values.length === 0) return text;

  const splices: Array<{ start: number; end: number; replacement: string }> =
    [];
  // Masked OBJECT KEYS have to stay distinct from one another. Two sibling
  // keys that both contain a configured value would otherwise both become the
  // literal `***`, and a reparse of the record keeps only the last of them —
  // silently dropping a field, which is exactly the corruption this function
  // promises not to cause. `redactStructuredValue` disambiguates for the same
  // reason; this mirrors its `__N` suffix.
  // Disambiguation is per OBJECT and accounts for keys this function did not
  // mask. Registering only its own masked keys let a document that already
  // contained a literal `***` key collide with one — in either order — and a
  // reparse then dropped a field. A first pass reserves every key name in its
  // own scope; the second pass only ever renames a key it actually masked.
  const tokens = scanJsonTokens(text);
  // Pass 1 decides whether anything matches at all, using decoded text but NO
  // offset maps and NO scope scan. Those are the expensive parts and the common
  // case needs neither. Decoding is still done, so an escaped or numeric
  // occurrence is found exactly as before — a raw substring prefilter would
  // miss `\u0061bcdef` and numeric leaves, which is why one is not used.
  const stringRanges = new Map<
    number,
    ReturnType<typeof findMergedMatchRanges>
  >();
  const numericTokens = new Set<number>();
  /** Tokens whose decoded offsets are arithmetic, so no offset map is needed. */
  const identityOffsetTokens = new Set<number>();
  let anyKeyMatched = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.kind === 'string') {
      const raw = text.slice(token.start + 1, token.end);
      // A token with no backslash decodes to itself, so matching its raw text
      // is EXACT — no decode, no per-code-unit string building. That is the
      // overwhelmingly common token, and building its decoded copy was the
      // dominant cost of the structural pass. Tokens that do carry escapes
      // still decode, so `\u0061bcdef` is matched exactly as before; this is a
      // fast path, not a weaker one.
      const escaped = raw.includes('\\');
      const searchable = escaped
        ? decodeJsonStringToken(text, token.start + 1, token.end, false).decoded
        : raw;
      const ranges = findMergedMatchRanges(searchable, values);
      if (ranges.length === 0) continue;
      stringRanges.set(index, ranges);
      if (!escaped) identityOffsetTokens.add(index);
      if (isJsonObjectKey(text, token.end)) anyKeyMatched = true;
      continue;
    }
    if (
      findMergedMatchRanges(text.slice(token.start, token.end), values).length >
      0
    )
      numericTokens.add(index);
  }
  if (stringRanges.size === 0 && numericTokens.size === 0) return text;
  // Scope bookkeeping only matters when a KEY is being renamed.
  const scopeIds = anyKeyMatched
    ? scopeIdsForTokens(text, tokens)
    : ([] as number[]);
  // This path already holds the whole record, so reserving every key costs it
  // nothing asymptotically and buys the exact guarantee: a masked key is
  // checked against EVERY other key in its object, not just the ones seen so
  // far. Identity is the decoded key — `"\u002a\u002a\u002a"` is `***`.
  const allocator = new MaskedKeyAllocator();
  if (anyKeyMatched) {
    tokens.forEach((token, index) => {
      if (token.kind !== 'string') return;
      if (!isJsonObjectKey(text, token.end)) return;
      const identity = decodeJsonStringToken(
        text,
        token.start + 1,
        token.end,
        false,
      ).decoded;
      allocator.reserveIn(scopeIds[index] ?? 0, identity);
    });
  }
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    const token = tokens[tokenIndex];
    if (!token) continue;
    if (token.kind === 'string') {
      const ranges = stringRanges.get(tokenIndex);
      if (!ranges) continue;
      const contentStart = token.start + 1;
      // For an escape-free token every decoded index maps to itself, so the
      // offset map is arithmetic rather than an allocated array.
      const offsets: number[] | undefined = identityOffsetTokens.has(tokenIndex)
        ? undefined
        : decodeJsonStringToken(text, contentStart, token.end).offsets;
      const offsetAt = (decodedIndex: number): number =>
        offsets === undefined
          ? contentStart + decodedIndex
          : (offsets[decodedIndex] ?? token.end);
      if (isJsonObjectKey(text, token.end)) {
        let content = '';
        let cursor = token.start + 1;
        for (const range of ranges) {
          content += text.slice(cursor, offsetAt(range.start)) + '***';
          cursor = offsetAt(range.end);
        }
        content += text.slice(cursor, token.end);
        const scopeId = scopeIds[tokenIndex] ?? 0;
        splices.push({
          start: token.start + 1,
          end: token.end,
          replacement: allocator.allocateIn(
            scopeId,
            content,
            decodeJsonKeyIdentity(content),
          ),
        });
        continue;
      }
      for (const range of ranges) {
        splices.push({
          start: offsetAt(range.start),
          end: offsetAt(range.end),
          replacement: '***',
        });
      }
      continue;
    }
    if (numericTokens.has(tokenIndex)) {
      splices.push({
        start: token.start,
        end: token.end,
        replacement: '"***"',
      });
    }
  }
  if (splices.length === 0) return text;

  // One pass over the record, whatever the splice count. The mechanism this
  // replaced split and rejoined the WHOLE record once per masked key, so the
  // cost grew with keys x length. Counted rather than timed: a wall-clock
  // ratio varies with load and invites threshold-raising when it flakes.
  redactionWorkCounters.recordPasses += 1;
  let output = '';
  let cursor = 0;
  for (const splice of splices) {
    output += text.slice(cursor, splice.start) + splice.replacement;
    cursor = splice.end;
  }
  return output + text.slice(cursor);
}

/**
 * True when the string token whose closing quote sits at `closingQuote` is an
 * object KEY rather than a value — i.e. the next non-whitespace character is
 * the `:` that separates it from its value. Cheap because the caller has
 * already proven the text is valid JSON.
 */
/**
 * Object-scope id for each token, so masked-key disambiguation stays inside
 * the object that could actually produce a duplicate. Walking the raw text is
 * safe here because the caller has already proven it parses; string spans are
 * skipped using the tokens themselves, so braces inside a string value can
 * never be mistaken for structure.
 */
function scopeIdsForTokens(
  text: string,
  tokens: readonly JsonToken[],
): number[] {
  redactionWorkCounters.scopeScans += 1;
  const stringSpans = tokens
    .filter((token) => token.kind === 'string')
    .map((token) => ({ start: token.start, end: token.end + 1 }));
  const scopeIds: number[] = [];
  const stack: number[] = [];
  let nextScopeId = 0;
  let tokenIndex = 0;
  let spanIndex = 0;
  let index = 0;
  while (index < text.length) {
    while (
      tokenIndex < tokens.length &&
      (tokens[tokenIndex]?.start ?? Infinity) === index
    ) {
      scopeIds.push(stack[stack.length - 1] ?? 0);
      tokenIndex += 1;
    }
    const span = stringSpans[spanIndex];
    if (span && span.start === index) {
      index = span.end;
      spanIndex += 1;
      continue;
    }
    const character = text[index] ?? '';
    if (character === '{') {
      nextScopeId += 1;
      stack.push(nextScopeId);
    } else if (character === '}') {
      stack.pop();
    }
    index += 1;
  }
  while (tokenIndex < tokens.length) {
    scopeIds.push(stack[stack.length - 1] ?? 0);
    tokenIndex += 1;
  }
  return scopeIds;
}

function isJsonObjectKey(text: string, closingQuote: number): boolean {
  for (let index = closingQuote + 1; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (
      character === ' ' ||
      character === '\t' ||
      character === '\r' ||
      character === '\n'
    )
      continue;
    return character === ':';
  }
  return false;
}

interface JsonToken {
  readonly kind: 'string' | 'number';
  /** For a string, the index of its OPENING quote; for a number, its first
   * character. */
  readonly start: number;
  /** For a string, the index of its CLOSING quote (exclusive of content);
   * for a number, one past its last character. */
  readonly end: number;
}

/**
 * Locates every string and numeric token in text already proven to be valid
 * JSON by the caller's own `JSON.parse`. Validity is what lets this stay a
 * small two-state scanner: inside a string, a backslash always consumes the
 * next character (for `\uXXXX` the four hex digits that follow are ordinary
 * non-quote characters, so skipping two is enough to find the real closing
 * quote), and outside a string the only tokens that can carry a configured
 * value are numbers — `true`/`false`/`null` are all shorter than the
 * six-character eligibility floor.
 */
function scanJsonTokens(text: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index] ?? '';
    if (character === '"') {
      const start = index;
      index += 1;
      while (index < text.length) {
        const inner = text[index] ?? '';
        if (inner === '\\') {
          index += 2;
          continue;
        }
        if (inner === '"') break;
        index += 1;
      }
      tokens.push({ kind: 'string', start, end: index });
      index += 1;
      continue;
    }
    if (character === '-' || (character >= '0' && character <= '9')) {
      const start = index;
      index += 1;
      while (index < text.length) {
        const inner = text[index] ?? '';
        const isNumeric =
          (inner >= '0' && inner <= '9') ||
          inner === '.' ||
          inner === 'e' ||
          inner === 'E' ||
          inner === '+' ||
          inner === '-';
        if (!isNumeric) break;
        index += 1;
      }
      tokens.push({ kind: 'number', start, end: index });
      continue;
    }
    index += 1;
  }
  return tokens;
}

/**
 * Decodes one JSON string token's content and records, for every decoded
 * UTF-16 code unit, the source index it came from. `offsets[k]` is where
 * decoded unit `k` starts and `offsets[decoded.length]` is `contentEnd`, so
 * a decoded match span maps back to an exact serialized span. Each loop
 * iteration produces exactly one decoded code unit — including `\uXXXX`,
 * which yields one — so the mapping stays one-to-one and a splice can never
 * land inside an escape sequence.
 *
 * It CAN, however, land between the halves of a surrogate pair the source
 * wrote literally: those are two source code units, so they get two offset
 * entries. Reaching
 * it needs a configured value that ends (or begins) on a lone half of a pair,
 * which is not a well-formed string a caller can configure through any
 * supported path — so this is a precision correction to the claim, not a
 * live defect. The splice still replaces a whole matched span; only a value
 * that itself splits a pair could split one here.
 */
function decodeJsonStringToken(
  text: string,
  contentStart: number,
  contentEnd: number,
  withOffsets = true,
): { decoded: string; offsets: number[] } {
  // The offset map is one array entry per decoded code unit, and it was being
  // built for EVERY token before anything checked whether a value could match —
  // tens of megabytes of transient arrays for a large record with no secret in
  // it. Callers that only need the decoded text ask for `withOffsets: false`.
  if (withOffsets) redactionWorkCounters.offsetMapsBuilt += 1;
  let decoded = '';
  const offsets: number[] = [];
  let index = contentStart;
  while (index < contentEnd) {
    if (withOffsets) offsets.push(index);
    const character = text[index] ?? '';
    if (character !== '\\') {
      decoded += character;
      index += 1;
      continue;
    }
    const escape = text[index + 1] ?? '';
    if (escape === 'u') {
      decoded += String.fromCharCode(
        Number.parseInt(text.slice(index + 2, index + 6), 16),
      );
      index += 6;
      continue;
    }
    const simple: Record<string, string> = {
      n: '\n',
      t: '\t',
      r: '\r',
      b: '\b',
      f: '\f',
      '"': '"',
      '\\': '\\',
      '/': '/',
    };
    decoded += simple[escape] ?? escape;
    index += 2;
  }
  offsets.push(contentEnd);
  return { decoded, offsets };
}

/**
 * Redacts a single already-JSON-serialized line (exactly one
 * `JSON.stringify` result — an NDJSON/JSONL record). Delegates to
 * `redactJsonPreservingFormat`, which masks inside decoded string/number
 * tokens of the ORIGINAL text so JSON syntax can never be corrupted and a
 * record containing no secret is forwarded byte-for-byte. Falls back to raw
 * substring matching (with `withJsonEscapedVariants`, as defense in depth)
 * only when the line is not valid JSON, since then there is no JSON
 * structure left to corrupt.
 */
export function redactSerializedJsonLine(
  line: string,
  secretValues: readonly string[],
): string {
  if (secretValues.length === 0) return line;
  return (
    redactJsonPreservingFormat(line, secretValues) ??
    // Eligibility from the ORIGINAL form, before expansion — escaping must
    // never promote a deliberately-ineligible short value into a match.
    redactValuesUnfiltered(
      line,
      withJsonEscapedVariants(
        secretValues.filter((value) => value.length >= 6),
      ),
    )
  );
}

/**
 * Mask every occurrence of a set of known secret values (pipeline
 * `secrets:`-block values, AI-Credits routing credentials) out of arbitrary
 * text by exact string match. Unlike `redactSecrets` above (shape-based:
 * JWTs, `sk-` keys, `key: value` pairs), this catches a pipeline-authored
 * secret regardless of its shape, because the caller already knows the exact
 * value to look for. Values under 6 characters are skipped as too likely to
 * cause false-positive collisions with ordinary text; overlapping matches
 * from different (or the same, self-overlapping) values are merged via
 * `extendMatchToFurthestOverlap` so a value is never left partially
 * unmasked.
 *
 * This is the single source of truth for value-based redaction shared by the
 * pipeline executor's host-runner interceptors (Codex, Cursor) and the
 * Claude/Ollama builtin-action subprocess, all of which persist agent-authored
 * `rawText`/`structured`/`proposedPlan` output that can echo a secret the
 * agent read out of its environment or a file.
 */
export function redactValues(
  text: string,
  secretValues: readonly string[],
): string {
  const values = Array.from(
    new Set(
      withJsonEscapedVariants(
        secretValues.filter((value) => value.length >= 6),
      ),
    ),
  ).sort((left, right) => right.length - left.length);
  return redactValuesUnfiltered(text, values);
}

/**
 * Lower-level matching primitive behind `redactValues`: masks every
 * occurrence of each value in `values`, WITHOUT re-applying the
 * minimum-length eligibility filter `redactValues` applies to each value
 * independently. Callers must pre-filter/dedupe `values` themselves — this
 * exists so a caller like `redactNormalizedText`
 * (`builtin-actions/agent-prompt/logic.ts`) can decide eligibility ONCE from
 * a value's ORIGINAL form, then also search for a TRANSFORMED variant of
 * that same value (its whitespace-normalized form) that can itself be
 * shorter than the length-6 minimum — e.g. the eligible 10-character secret
 * `'ab cd'` normalizes to the 5-character `'ab cd'`. Passing both
 * variants through `redactValues` would silently drop the normalized one
 * (independently too short) even though the value it derives from already
 * cleared the bar; the minimum-length policy exists to avoid colliding with
 * ordinary short text, not to un-protect a value that already qualified.
 */
export function redactValuesUnfiltered(
  text: string,
  values: readonly string[],
): string {
  const ranges = findMergedMatchRanges(text, values);
  if (ranges.length === 0) return text;
  let cursor = 0;
  let output = '';
  for (const range of ranges) {
    output += text.slice(cursor, range.start) + '***';
    cursor = range.end;
  }
  return output + text.slice(cursor);
}

/**
 * The shared match-finding half of `redactValuesUnfiltered`: returns the
 * ordered, non-overlapping spans of `text` that must be masked, instead of
 * the masked string itself. Callers that cannot simply splice `***` into
 * `text` — `redactJsonPreservingFormat` below masks inside a JSON string
 * token's DECODED value and has to map each span back to the original
 * serialized offsets — need the spans, and must not reimplement the
 * leftmost-match + `extendMatchToFurthestOverlap` merge that
 * `redactValuesUnfiltered` performs. Values are used exactly as given (no
 * eligibility filtering, no dedupe, no sorting) — see
 * `redactValuesUnfiltered`'s own contract.
 */
export function findMergedMatchRanges(
  text: string,
  values: readonly string[],
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  if (values.length === 0) return ranges;
  let cursor = 0;
  // Per-value "next occurrence at/after N" cache, identical in shape to
  // `SecretValueRedactor`'s (`node/pipelines/executor/spawned-process.ts`):
  // a configured value that never occurs in `text` at all would otherwise
  // cost a full remaining-text `indexOf` scan on every match found, making
  // this quadratic in the number of matches for a large `text` with several
  // absent configured values. Every call site here only ever queries with a
  // non-decreasing `from` per value, so the `from >= cached.searchedFrom`
  // guard below is a no-op today — kept anyway because `SecretValueRedactor`
  // shipped this exact cache shape WITHOUT that guard and it leaked (a
  // later-added caller queried backward); guarding both branches here too
  // means a future caller that queries backward gets a correct, if slower,
  // fresh scan instead of a silently wrong cached answer.
  const nextIndexCache = new Map<
    string,
    { index: number; searchedFrom: number }
  >();
  const nextIndexAtOrAfter = (value: string, from: number): number => {
    const cached = nextIndexCache.get(value);
    if (cached && from >= cached.searchedFrom) {
      if (cached.index === -1) return -1;
      if (cached.index >= from) return cached.index;
    }
    const found = text.indexOf(value, from);
    nextIndexCache.set(value, { index: found, searchedFrom: from });
    return found;
  };
  for (;;) {
    let match: { start: number; end: number } | null = null;
    for (const value of values) {
      const start = nextIndexAtOrAfter(value, cursor);
      if (start === -1) continue;
      if (match === null || start < match.start) {
        match = { start, end: start + value.length };
      }
    }
    if (match === null) break;
    match = extendMatchToFurthestOverlap(values, match, nextIndexAtOrAfter);
    ranges.push(match);
    cursor = match.end;
  }
  return ranges;
}

/**
 * `redactValues` applied (substring match) to every string leaf, every
 * numeric leaf, and every object key of an arbitrary JSON-serializable value.
 *
 * **Input contract: JSON-derived data only** — plain objects, arrays, strings,
 * numbers, booleans and null. No `Date`, `Buffer`, class instance, or anything
 * else carrying a custom `toJSON`. The walker rebuilds objects with
 * `Object.entries`/`Object.fromEntries`, so such a value would serialize
 * differently after a pass than before it (a `Date` becomes `{}`, a `Buffer`
 * becomes `{"0":…}`), and no guard would report it.
 *
 * Two kinds of caller rely on that contract, and both satisfy it:
 * - structured agent output — the parsed result of a pipeline
 *   `structured_output_schema`, i.e. `JSON.parse` output;
 * - provider transcript records (`createTranscriptCapture`,
 *   `serializeTranscript`) — every provider event reaching them is itself
 *   JSON-derived: Codex arrives as JSON-RPC over the app-server, Cursor as ACP
 *   JSON, and the Claude SDK's events are the JSON the CLI emits.
 *
 * Kept as a documented boundary rather than handled: adding `Date`/`Buffer`
 * branches would be speculative feature growth for a shape no current caller
 * can produce, and it would make the contract harder to reason about rather
 * than easier.
 *
 * This walks the value directly rather than round-tripping through
 * `JSON.stringify`/`JSON.parse`: an earlier implementation ran `redactValues`
 * over the *serialized* string as a second pass, which is unsafe for two
 * reasons a caller must not reintroduce. First, splicing `***` over a secret
 * that happens to span a JSON structural character (e.g. starting inside one
 * property's value and ending inside the next, swallowing the `","key":"`
 * between them) can corrupt JSON syntax. Second — the actual security bug —
 * catching that corruption and falling back to only the per-leaf-redacted
 * result left a configured secret unmasked whenever it appeared as a
 * *non-string* leaf (a bare JSON number) or as an object *key*, since
 * `JSON.stringify`'s string-only replacer never visits either. A number leaf
 * is redacted the same substring-based way as a string leaf (stringified,
 * passed through `redactValues`, and only converted to that masked string if
 * anything actually matched) so a secret embedded inside a longer number is
 * caught exactly like one embedded inside a longer string — changing its type
 * on match is the only way to mask a partial digit run without reintroducing
 * invalid JSON.
 *
 * Keys are redacted with the same substring-based `redactValues` as string
 * values (not just exact match), so a secret embedded in a longer key name is
 * also caught. Two different resulting keys could then collide on the same
 * name — either two originals that each redact to the same value, or a masked
 * key landing on a name an ordinary key already holds — so a masked key is
 * disambiguated with a numeric suffix and no entry is ever silently dropped.
 *
 * The same guarantee `MaskedKeyAllocator` gives the serialized path applies
 * here, and for the same reason: a key this pass did NOT mask is never
 * renamed. Every unmasked key is reserved before any name is allocated, so a
 * masked key routes around it instead of pushing it aside. The result is built via `Object.fromEntries`, which
 * creates plain data properties (`CreateDataPropertyOrThrow`) rather than
 * assigning through `[[Set]]`, so a secret shaped like `__proto__` becomes an
 * ordinary own property instead of polluting the prototype.
 */
export function redactStructuredValue(
  value: unknown,
  secretValues: readonly string[],
): unknown {
  if (value === undefined) return undefined;
  const values = Array.from(
    new Set(secretValues.filter((candidate) => candidate.length >= 6)),
  );
  if (values.length === 0) return value;
  return redactStructuredNode(value, values);
}

function redactStructuredNode(
  node: unknown,
  values: readonly string[],
): unknown {
  if (typeof node === 'string') {
    return redactValues(node, values);
  }
  if (typeof node === 'number') {
    const text = String(node);
    const masked = redactValues(text, values);
    return masked === text ? node : masked;
  }
  if (Array.isArray(node)) {
    return node.map((item) => redactStructuredNode(item, values));
  }
  if (node !== null && typeof node === 'object') {
    const original = Object.entries(node);
    // Reserve every key this pass does NOT mask BEFORE allocating any name.
    // Accumulating `usedKeys` as the loop went meant a masked key could take a
    // name a LATER ordinary key already held, pushing that ordinary key to a
    // suffixed name — renaming a key masking had no part in. `{"***":1,
    // "SECRET":2,"***__1":3}` produced `***__1__1` for the untouched third
    // key. `redactSerializedJsonLine` has always reserved the whole record
    // first; a parsed object is equally whole, so it gets the same guarantee.
    const reserved = new Set<string>(
      original
        .map(([key]) => key)
        .filter((key) => redactValues(key, values) === key),
    );
    const nextSuffix = new Map<string, number>();
    const entries: [string, unknown][] = [];
    for (const [key, entryValue] of original) {
      const candidateKey = redactValues(key, values);
      let redactedKey = candidateKey;
      if (candidateKey !== key) {
        // Resume from where this base name's search last stopped: a reserved
        // name is never released, so a rejected candidate cannot become free.
        let suffix = nextSuffix.get(candidateKey) ?? 1;
        while (reserved.has(redactedKey)) {
          redactionWorkCounters.maskedKeyCandidatesProbed += 1;
          redactedKey = `${candidateKey}__${suffix}`;
          suffix += 1;
        }
        nextSuffix.set(candidateKey, suffix);
        reserved.add(redactedKey);
      }
      entries.push([redactedKey, redactStructuredNode(entryValue, values)]);
    }
    return Object.fromEntries(entries);
  }
  return node;
}

/**
 * A stable, input-independent description of a `JSON.parse` failure.
 *
 * V8's own message embeds a SHORTENED excerpt of the input — e.g.
 * `Unexpected token 'x', ..."live-secret-fra"... is not valid JSON` — and that
 * fragment is not an exact match for any configured value, so it survives every
 * later value-based masking pass and reaches durable result files, failure
 * metadata, and (on the structured-output retry path) the next prompt sent to
 * the vendor. Masking the raw payload separately does not help: the excerpt is
 * already a different, shorter string by the time the matcher runs.
 *
 * Only the parser's location facts are kept. Those describe the input's SHAPE
 * (how far in the parse got), never its content, so they are safe to carry into
 * a durable diagnostic while still telling a maintainer where to look.
 */
export function describeJsonParseFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const lineColumn = /line (\d+) column (\d+)/.exec(raw);
  if (lineColumn?.[1] !== undefined && lineColumn[2] !== undefined)
    return `invalid JSON at line ${lineColumn[1]} column ${lineColumn[2]}`;
  const position = /at position (\d+)/.exec(raw);
  if (position?.[1] !== undefined)
    return `invalid JSON at position ${position[1]}`;
  if (raw.startsWith('Unexpected end of JSON input'))
    return 'invalid JSON: unexpected end of input';
  // V8's `Unexpected token 'x', ..."<excerpt>"... is not valid JSON` variant is
  // the one that carries NO position — only the excerpt. Report the category.
  if (/^Unexpected (token|non-whitespace character)/.test(raw))
    return 'invalid JSON: unexpected token';
  return 'invalid JSON';
}

/** `text` with every whitespace run collapsed to one space, trimmed. */
export function normalizeSingleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Masks configured values in `text` using `redactNormalizedText`'s
 * (`builtin-actions/agent-prompt/logic.ts`) whitespace-insensitive matching, but leaves every character it did not
 * match exactly as it was — including newlines and indentation.
 *
 * This is the matcher a durable FILE copy needs. `redactNormalizedText`
 * returns the collapsed single-line projection, which is right for a
 * single-line output field (`text_response`) and wrong for a multi-line
 * artifact (`text-response.txt`, `proposed-plan.md`, a plan or summary file)
 * whose formatting is the point. Until now those files used plain
 * `redactValues`, so they got strictly weaker protection than the field they
 * are a copy of: an agent that echoed a configured value with its internal
 * whitespace reflowed — a newline where the value has a space — had the value
 * masked in `text_response` and left in cleartext in `text-response.txt`.
 *
 * The mechanism mirrors `redactJsonPreservingFormat`: match against a
 * projection, then splice back at the ORIGINAL offsets rather than returning
 * the projection. Text with no match is returned byte-for-byte.
 */
export function normalizedSecretRanges(
  text: string,
  secretValues: readonly string[],
): ReadonlyArray<{ start: number; end: number }> {
  const eligible = withJsonEscapedVariants(
    Array.from(new Set(secretValues.filter((value) => value.length >= 6))),
  );
  if (eligible.length === 0) return [];
  const expanded = Array.from(
    new Set([
      ...eligible,
      ...eligible
        .map((value) => normalizeSingleLine(value))
        .filter((value) => value.length > 0),
    ]),
  ).sort((left, right) => right.length - left.length);
  const projection = projectNormalizedOffsets(text);
  const projected = findMergedMatchRanges(projection.normalized, expanded);
  // A configured value made only of WHITESPACE cannot be found through the
  // projection at all: its normalized form is empty, and an empty form is
  // never searched for (it would match everywhere), while every whitespace run
  // in `text` has collapsed to a single space there. Its exact characters are
  // therefore matched against the original text, the one place they still
  // exist. Without this, a durable copy is strictly WEAKER than the inline
  // field it mirrors — the inline field is emitted normalized, so the value's
  // own run is destroyed on the way out, while the file keeps it verbatim.
  // This masks the value's exact characters only; it is never an
  // any-whitespace wildcard.
  const whitespaceOnly = eligible.filter(
    (value) => normalizeSingleLine(value).length === 0,
  );
  const spans = [
    ...projected.map((range) => ({
      start: projection.starts[range.start] ?? text.length,
      end: projection.ends[range.end - 1] ?? text.length,
    })),
    ...findMergedMatchRanges(text, whitespaceOnly),
  ].sort((left, right) => left.start - right.start);
  if (spans.length === 0) return [];
  // Merge only spans that genuinely OVERLAP. Two merely touching spans stay
  // two masks, exactly as the projection-only path has always emitted them.
  const merged: Array<{ start: number; end: number }> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start < last.end) {
      if (span.end > last.end) last.end = span.end;
      continue;
    }
    merged.push({ start: span.start, end: span.end });
  }
  return merged;
}

/** Mask normalized matches while preserving every unrelated character. */
export function redactNormalizedPreservingFormat(
  text: string,
  secretValues: readonly string[],
): string {
  const merged = normalizedSecretRanges(text, secretValues);
  let output = '';
  let cursor = 0;
  for (const span of merged) {
    output += text.slice(cursor, span.start) + '***';
    cursor = span.end;
  }
  return output + text.slice(cursor);
}

/**
 * Builds `normalizeSingleLine`'s exact output alongside, for each normalized
 * character, the original span it came from. A collapsed whitespace run maps
 * to the whole run, so masking a match that begins or ends on one covers the
 * original whitespace rather than leaving half of it behind.
 */
function projectNormalizedOffsets(text: string): {
  normalized: string;
  starts: number[];
  ends: number[];
} {
  const isWhitespace = (character: string): boolean => /\s/.test(character);
  let normalized = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let index = 0;
  while (index < text.length && isWhitespace(text[index] ?? '')) index += 1;
  while (index < text.length) {
    if (isWhitespace(text[index] ?? '')) {
      const runStart = index;
      while (index < text.length && isWhitespace(text[index] ?? '')) index += 1;
      // A trailing run is trimmed away by `normalizeSingleLine`, so it
      // contributes no normalized character at all.
      if (index >= text.length) break;
      normalized += ' ';
      starts.push(runStart);
      ends.push(index);
      continue;
    }
    normalized += text[index];
    starts.push(index);
    ends.push(index + 1);
    index += 1;
  }
  return { normalized, starts, ends };
}
