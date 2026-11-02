import type { SlashCommandOption } from '../types';

/**
 * Identity derivation and text helpers for slash-command search. The mobile
 * app ports this file to Dart and checks both against shared JSON vectors, so
 * any rule change here updates the vectors and the Dart port together.
 */

const TOKEN_SEPARATOR = /[\s:/_\-.,()]+/;
const DESCRIPTION_SEPARATOR = /[^\p{L}\p{N}]+/u;

const STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'the',
  'my',
  'me',
  'our',
  'your',
  'to',
  'for',
  'of',
  'in',
  'on',
  'with',
  'and',
  'or',
  'this',
  'that',
  'it',
  'is',
  'be',
  'do',
  'please',
]);

/** Identity strength, strongest first within a tier. */
export const IDENTITY_STRENGTH = {
  member: 3,
  qualified: 2,
  plugin: 1,
  label: 0,
} as const;

export interface SearchIdentity {
  text: string;
  tokens: readonly string[];
  strength: number;
}

/** Trims, lowercases and strips at most one leading `/` or `$`. */
export function normalizeSearchText(value: string | undefined): string {
  if (!value) return '';
  const lowered = value.trim().toLowerCase();
  const stripped =
    lowered.startsWith('/') || lowered.startsWith('$')
      ? lowered.slice(1)
      : lowered;
  return stripped.trim();
}

export function tokenizeSearchText(value: string): string[] {
  return value.split(TOKEN_SEPARATOR).filter((token) => token.length > 0);
}

/** Query tokens without stopwords, unless only stopwords remain. */
export function tokenizeSearchQuery(normalizedQuery: string): string[] {
  const tokens = tokenizeSearchText(normalizedQuery);
  const meaningful = tokens.filter((token) => !STOPWORDS.has(token));
  return meaningful.length > 0 ? meaningful : tokens;
}

export function tokenizeDescription(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .toLowerCase()
    .split(DESCRIPTION_SEPARATOR)
    .filter((token) => token.length > 0);
}

function prefixBeforeColon(value: string): string {
  const index = value.indexOf(':');
  return index > 0 ? value.slice(0, index) : '';
}

function aliasStrength(alias: string): number {
  return alias.includes(':')
    ? IDENTITY_STRENGTH.qualified
    : IDENTITY_STRENGTH.member;
}

/**
 * Plugin, member, qualified and display identities for one row. Explicit
 * fields win over names inferred from `name` or `displayName`. The display
 * name is the additional alias; conflicting inferred names are not identities.
 */
export function deriveSearchIdentities(
  command: SlashCommandOption,
): SearchIdentity[] {
  const name = normalizeSearchText(command.name);
  const displayName = normalizeSearchText(command.displayName);
  const pluginName =
    normalizeSearchText(command.namespace) ||
    prefixBeforeColon(name) ||
    prefixBeforeColon(displayName);
  const memberName =
    normalizeSearchText(command.memberName) ||
    (name.includes(':') ? name.slice(name.indexOf(':') + 1) : name);
  const candidates: [string, number][] = [
    [memberName, IDENTITY_STRENGTH.member],
    [
      pluginName && memberName ? `${pluginName}:${memberName}` : '',
      IDENTITY_STRENGTH.qualified,
    ],
    [pluginName, IDENTITY_STRENGTH.plugin],
    [displayName, aliasStrength(displayName)],
  ];
  const seen = new Set<string>();
  const identities: SearchIdentity[] = [];
  for (const [text, strength] of candidates) {
    if (!text || seen.has(text)) continue;
    seen.add(text);
    identities.push({ text, tokens: tokenizeSearchText(text), strength });
  }
  return identities;
}

/**
 * True when `a` and `b` differ by exactly one insertion, deletion,
 * substitution or adjacent transposition (optimal string alignment).
 */
export function isOneEditApart(a: string, b: string): boolean {
  if (a === b) return false;
  const lengthDelta = a.length - b.length;
  if (lengthDelta > 1 || lengthDelta < -1) return false;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1;
  }
  if (lengthDelta === 0) {
    if (a.slice(start + 1) === b.slice(start + 1)) return true;
    return (
      a[start] === b[start + 1] &&
      a[start + 1] === b[start] &&
      a.slice(start + 2) === b.slice(start + 2)
    );
  }
  const longer = lengthDelta > 0 ? a : b;
  const shorter = lengthDelta > 0 ? b : a;
  return longer.slice(start + 1) === shorter.slice(start);
}

/** Shortest span containing `query` as an ordered subsequence, or null. */
export function subsequenceSpan(text: string, query: string): number | null {
  if (!query) return null;
  let best: number | null = null;
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== query[0]) continue;
    let offset = start + 1;
    let matched = 1;
    while (matched < query.length && offset < text.length) {
      if (text[offset] === query[matched]) matched += 1;
      offset += 1;
    }
    if (matched < query.length) break;
    const span = offset - start;
    if (best === null || span < best) best = span;
  }
  return best;
}
