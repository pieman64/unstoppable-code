import type { SlashCommandOption } from '../types';
import {
  deriveSearchIdentities,
  IDENTITY_STRENGTH,
  isOneEditApart,
  normalizeSearchText,
  subsequenceSpan,
  tokenizeDescription,
  tokenizeSearchQuery,
  type SearchIdentity,
} from './commandSearchIdentity';

/**
 * Five primary tiers: exact identity, prefix, substring/token prefixes,
 * one-edit typo, then whole description words. Single-word description
 * matches are fallback only; multi-term descriptions must cover every term.
 *
 * Within a tier: identity strength, exact tokens, then fewer unmatched tokens
 * for typos. Enabled status and input order break remaining ties.
 * Multi-token identity subsequences are a last resort when all five tiers miss
 * (the unchanged `ecom-debbuger` golden needs this); shorter spans win there.
 */
export interface SlashCommandMatch {
  tier: number;
  strength: number;
  exactTokens: number;
  /** Unmatched identity tokens in tier 4; character span in fallback tier 6. */
  span: number;
}

interface PreparedQuery {
  full: string;
  tokens: readonly string[];
}

function prepareQuery(query: string): PreparedQuery {
  const full = normalizeSearchText(query);
  return {
    full,
    tokens: tokenizeSearchQuery(full),
  };
}

function matchesPrefix(token: string, words: readonly string[]): boolean {
  return words.some((word) => word.startsWith(token));
}

function countExact(
  tokens: readonly string[],
  words: readonly string[],
): number {
  return tokens.filter((token) => words.includes(token)).length;
}

function compareMatches(a: SlashCommandMatch, b: SlashCommandMatch): number {
  return (
    a.tier - b.tier ||
    b.strength - a.strength ||
    b.exactTokens - a.exactTokens ||
    a.span - b.span
  );
}

function matchIdentity(
  identity: SearchIdentity,
  query: PreparedQuery,
): SlashCommandMatch | null {
  const { text, tokens, strength } = identity;
  const exactTokens = countExact(query.tokens, tokens);
  const match = (tier: number, span = 0): SlashCommandMatch => ({
    tier,
    strength,
    exactTokens,
    span,
  });
  if (text === query.full) return match(1);
  if (text.startsWith(query.full)) return match(2);
  if (query.full.length < 2) return null;
  const hasTokens = query.tokens.length > 0;
  if (
    text.includes(query.full) ||
    (hasTokens && query.tokens.every((token) => matchesPrefix(token, tokens)))
  ) {
    return match(3);
  }
  if (hasTokens) {
    let usedEdit = false;
    const typoMatch = query.tokens.every((token) => {
      if (matchesPrefix(token, tokens)) return true;
      if (token.length < 4) return false;
      const edited = tokens.some((word) => isOneEditApart(token, word));
      usedEdit ||= edited;
      return edited;
    });
    if (typoMatch && usedEdit)
      return match(4, tokens.length - query.tokens.length);
  }
  // Multi-token fallback only: preserve literal separators and full coverage.
  const span =
    query.tokens.length > 1 ? subsequenceSpan(text, query.full) : null;
  return span === null ? null : match(6, span);
}

/** Strongest match for one row, or null when it does not match. */
export function matchSlashCommand(
  command: SlashCommandOption,
  query: string,
): SlashCommandMatch | null {
  const prepared = prepareQuery(query);
  if (!prepared.full) return null;
  return matchPrepared(command, prepared);
}

function matchPrepared(
  command: SlashCommandOption,
  query: PreparedQuery,
): SlashCommandMatch | null {
  const identities = deriveSearchIdentities(command);
  const candidates = identities.map((identity) =>
    matchIdentity(identity, query),
  );
  if (query.full.length >= 2 && query.tokens.length > 0) {
    const description = tokenizeDescription(command.description);
    if (query.tokens.every((token) => description.includes(token))) {
      candidates.push({
        tier: 5,
        strength: IDENTITY_STRENGTH.label,
        exactTokens: countExact(query.tokens, description),
        span: 0,
      });
    }
  }
  let best: SlashCommandMatch | null = null;
  for (const candidate of candidates) {
    if (candidate && (!best || compareMatches(candidate, best) < 0)) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Identity-first ranking across the whole catalog. Enabled rows only break
 * ties with Available rows; no catalog IO and no change to row objects.
 */
export function searchSlashCommands<T extends SlashCommandOption>(
  commands: readonly T[],
  query: string,
): T[] {
  const prepared = prepareQuery(query);
  if (!prepared.full) return [...commands];
  const ranked: { command: T; index: number; match: SlashCommandMatch }[] = [];
  commands.forEach((command, index) => {
    const match = matchPrepared(command, prepared);
    if (match) ranked.push({ command, index, match });
  });
  // One word in a long description is too weak beside an identity match.
  // Multi-term intent probes still admit complete description coverage.
  // Subsequence recovery never expands a successful primary-tier search.
  const hasIdentity = ranked.some(({ match }) => match.tier <= 4);
  const hasDescription = ranked.some(({ match }) => match.tier === 5);
  return ranked
    .filter(({ match }) =>
      hasIdentity
        ? match.tier <= 4 || (match.tier === 5 && prepared.tokens.length > 1)
        : hasDescription
          ? match.tier === 5
          : true,
    )
    .sort(
      (a, b) =>
        compareMatches(a.match, b.match) ||
        Number(a.command.section === 'available') -
          Number(b.command.section === 'available') ||
        a.index - b.index,
    )
    .map((row) => row.command);
}
