const INVOCATION_PATTERN =
  /(?:^|[^A-Za-z0-9_-])(\/[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)*|\$[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)*)(?=$|[^A-Za-z0-9._-])/g;

export interface InvocationToken {
  value: string;
  before: string;
  after: string;
  /** UTF-16 code-unit offset of `value` in the scanned text. */
  start: number;
}

/**
 * The context the path heuristics read. A token synthesized from structured
 * data (a frontmatter declaration) has no position in any text.
 */
export type InvocationTokenContext = Pick<
  InvocationToken,
  'value' | 'before' | 'after'
>;

export function extractInvocationTokens(value: string): InvocationToken[] {
  return Array.from(value.matchAll(INVOCATION_PATTERN)).flatMap((match) => {
    const rawInvocation = match[1];
    if (typeof rawInvocation !== 'string') return [];
    const invocationOffset = match[0].indexOf(rawInvocation);
    const invocationStart = (match.index ?? 0) + invocationOffset;
    if (
      rawInvocation.startsWith('/') &&
      value.slice(Math.max(0, invocationStart - 2), invocationStart) === ':/'
    ) {
      return [];
    }
    const invocation = rawInvocation.replace(/[.,;:!?]+$/, '');
    return [
      {
        value: invocation,
        start: invocationStart,
        before: value.slice(Math.max(0, invocationStart - 1), invocationStart),
        after: value.slice(
          invocationStart + rawInvocation.length,
          invocationStart + rawInvocation.length + 1,
        ),
      },
    ];
  });
}

export function isPathShapedInvocationToken(
  token: InvocationTokenContext,
): boolean {
  if (isExplicitPathInvocationToken(token)) return true;
  if (!token.value.startsWith('/')) return false;
  return /\.[A-Za-z0-9]{1,10}$/.test(token.value);
}

export function isExplicitPathInvocationToken(
  token: InvocationTokenContext,
): boolean {
  if (token.after === '/') return true;
  if (!token.value.startsWith('/')) return false;
  return ['/', '=', '.', '~'].includes(token.before);
}

/**
 * A possible pipeline reference in free text. Pipelines can't use the `/name`
 * syntax: an agent reads the prompt, and a slash token reads as a skill.
 */
export interface PipelineReferenceToken {
  /** `uuid`: shaped like a pipeline id. `name`: an exact pipeline name. */
  kind: 'uuid' | 'name';
  /** The exact slice of the text, so a span can be checked and rewritten. */
  text: string;
  /** UTF-16 code-unit offset of `text` in the scanned text. */
  start: number;
}

// Word-bounded on both sides: a hex run glued to letters, digits, `_` or `-`
// is part of a longer identifier, not a pipeline id.
const UUID_REFERENCE_PATTERN =
  /(?<![A-Za-z0-9_-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![A-Za-z0-9_-])/gi;

// Only syntax characters: a `u`-flag pattern rejects identity escapes such
// as `\-`.
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * Pipeline references in `text`: every UUID-shaped token (case-insensitive)
 * and every exact, case-sensitive, whole-word occurrence of one of `names`.
 * A name only matches where it is not glued to a letter, digit or `_`, so
 * "Deploy" does not match inside "Deployment". With no names, only UUIDs are
 * returned. Results are ordered by offset, UUIDs before names at one offset.
 */
export function extractPipelineReferenceTokens(
  text: string,
  names: readonly string[],
): PipelineReferenceToken[] {
  const tokens: PipelineReferenceToken[] = [];
  for (const match of Array.from(text.matchAll(UUID_REFERENCE_PATTERN))) {
    tokens.push({ kind: 'uuid', text: match[0], start: match.index ?? 0 });
  }
  const uniqueNames = Array.from(new Set(names)).filter(
    (name) => name.trim().length > 0,
  );
  for (const name of uniqueNames) {
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_])${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`,
      'gu',
    );
    for (const match of Array.from(text.matchAll(pattern))) {
      tokens.push({ kind: 'name', text: match[0], start: match.index ?? 0 });
    }
  }
  return tokens.sort(
    (left, right) =>
      left.start - right.start ||
      Number(left.kind === 'name') - Number(right.kind === 'name'),
  );
}
