import type { InvocableInventoryKind } from '@canopy/desktop-shared/types';
import { BUILTIN_APP_PLUGIN_NAME } from './codex-plugin-compat';

export interface InvocationTokenInventoryEntry {
  invocationKey: string;
  kind: InvocableInventoryKind;
  name?: string;
  sourceName?: string;
}

interface AliasIndex {
  aliases: ReadonlyMap<string, string>;
  ambiguousAliases: ReadonlySet<string>;
}

interface InvocationAliasIndex {
  exact: AliasIndex;
  qualifiedStandaloneTails: AliasIndex;
  bareStandaloneAliases: AliasIndex;
}

function addAliasClaim(
  claims: Map<string, Set<string>>,
  alias: string,
  invocationKey: string,
): void {
  const invocationKeys = claims.get(alias) ?? new Set<string>();
  invocationKeys.add(invocationKey);
  claims.set(alias, invocationKeys);
}

function buildAliasIndex(claims: ReadonlyMap<string, Set<string>>): AliasIndex {
  const aliases = new Map<string, string>();
  const ambiguousAliases = new Set<string>();
  claims.forEach((invocationKeys, alias) => {
    if (invocationKeys.size === 1) {
      const invocationKey = invocationKeys.values().next().value;
      if (invocationKey) {
        aliases.set(alias, invocationKey);
      }
    } else {
      ambiguousAliases.add(alias);
    }
  });

  return { aliases, ambiguousAliases };
}

function buildInvocationAliasIndex(
  entries: readonly InvocationTokenInventoryEntry[],
): InvocationAliasIndex {
  const exactClaims = new Map<string, Set<string>>();
  const qualifiedStandaloneTailClaims = new Map<string, Set<string>>();
  const bareStandaloneClaims = new Map<string, Set<string>>();

  for (const entry of entries) {
    const keyMatch = /^[/$]([A-Za-z0-9][A-Za-z0-9._:-]*)$/.exec(
      entry.invocationKey,
    );
    const fullBody = keyMatch?.[1];
    if (!fullBody) {
      continue;
    }

    addAliasClaim(exactClaims, fullBody, entry.invocationKey);
    if (entry.kind !== 'skill') {
      continue;
    }

    const lastColonIndex = fullBody.lastIndexOf(':');
    if (lastColonIndex >= 0 && lastColonIndex < fullBody.length - 1) {
      addAliasClaim(
        qualifiedStandaloneTailClaims,
        fullBody.slice(lastColonIndex + 1),
        entry.invocationKey,
      );
    } else if (lastColonIndex < 0) {
      addAliasClaim(bareStandaloneClaims, fullBody, entry.invocationKey);
    }
  }

  return {
    exact: buildAliasIndex(exactClaims),
    qualifiedStandaloneTails: buildAliasIndex(qualifiedStandaloneTailClaims),
    bareStandaloneAliases: buildAliasIndex(bareStandaloneClaims),
  };
}

function resolveInvocationKey(
  body: string,
  index: InvocationAliasIndex,
): string | undefined {
  const fullBodyMatch = index.exact.aliases.get(body);
  if (fullBodyMatch || index.exact.ambiguousAliases.has(body)) {
    return fullBodyMatch;
  }

  const lastColonIndex = body.lastIndexOf(':');
  if (lastColonIndex < 0) {
    if (index.qualifiedStandaloneTails.ambiguousAliases.has(body)) {
      return undefined;
    }
    return index.qualifiedStandaloneTails.aliases.get(body);
  }
  if (lastColonIndex === body.length - 1) {
    return undefined;
  }

  // A qualified token may collapse to a bare standalone key only when its
  // namespace is the cross-provider aggregate plugin (the codex projection of
  // standalone skills). Any other explicit namespace is the user's choice and
  // must never be silently dropped.
  if (body.slice(0, lastColonIndex) !== BUILTIN_APP_PLUGIN_NAME) {
    return undefined;
  }
  const tail = body.slice(lastColonIndex + 1);
  if (index.bareStandaloneAliases.ambiguousAliases.has(tail)) {
    return undefined;
  }
  return index.bareStandaloneAliases.aliases.get(tail);
}

/** Resolve the leading token with exactly the normalization alias precedence. */
export function matchInvocationEntry<T extends InvocationTokenInventoryEntry>(
  text: string,
  entries: readonly T[],
): T | undefined {
  const match = /^\s*([/$])([A-Za-z0-9][A-Za-z0-9._:-]*)(?=\s|$)/.exec(text);
  const body = match?.[2];
  if (!body) return undefined;
  const key = resolveInvocationKey(body, buildInvocationAliasIndex(entries));
  return key ? entries.find((entry) => entry.invocationKey === key) : undefined;
}

export function normalizeInvocationToken(
  text: string,
  entries: readonly InvocationTokenInventoryEntry[],
): string {
  if (entries.length === 0) {
    return text;
  }

  const leadingWhitespace = /^\s*/.exec(text)?.[0] ?? '';
  const textAfterLeadingWhitespace = text.slice(leadingWhitespace.length);
  const tokenMatch = /^([/$])([A-Za-z0-9][A-Za-z0-9._:-]*)(?=\s|$)/.exec(
    textAfterLeadingWhitespace,
  );
  if (!tokenMatch) {
    return text;
  }

  const [typedToken, , body] = tokenMatch;
  if (!body) {
    return text;
  }

  const invocationKey = resolveInvocationKey(
    body,
    buildInvocationAliasIndex(entries),
  );
  if (!invocationKey || typedToken === invocationKey) {
    return text;
  }

  return `${leadingWhitespace}${invocationKey}${textAfterLeadingWhitespace.slice(typedToken.length)}`;
}
