import type {
  ChatTabPluginSelections,
  PluginSelectionTombstones,
} from '@canopy/desktop-shared/types';
import type {
  McpServerRef,
  RewriteMcpServerRefsRequest,
} from '@canopy/desktop-shared/types/mcp-servers';

/** One server (any config) or one server config that moved. */
export type McpServerRefMatcher = RewriteMcpServerRefsRequest['from'][number];

function matchesRef(
  ref: { serverId: string; configId: string },
  from: readonly McpServerRefMatcher[],
): boolean {
  return from.some(
    (matcher): boolean =>
      matcher.serverId === ref.serverId &&
      (matcher.configId === undefined || matcher.configId === ref.configId),
  );
}

/** Replaces matching refs with `to`, keeping order and dropping duplicates. */
export function rewriteMcpServerRefList(
  refs: readonly McpServerRef[],
  from: readonly McpServerRefMatcher[],
  to: McpServerRef,
): McpServerRef[] | null {
  if (!refs.some((ref): boolean => matchesRef(ref, from))) return null;
  const seen = new Set<string>();
  const next: McpServerRef[] = [];
  for (const ref of refs) {
    const target = matchesRef(ref, from)
      ? { serverId: to.serverId, configId: to.configId }
      : ref;
    const key = JSON.stringify([target.serverId, target.configId]);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(target);
  }
  return next;
}

/**
 * Selections pointing at the moved server. A per-chat handler override for
 * the old server no longer applies once it changes scope, so it is dropped.
 */
export function rewriteMcpSelections<T extends ChatTabPluginSelections>(
  selections: T,
  from: readonly McpServerRefMatcher[],
  to: McpServerRef,
): T | null {
  const refs = rewriteMcpServerRefList(
    selections.mcpServerRefs ?? [],
    from,
    to,
  );
  const preferences = selections.mcpHttpAuthPreferences;
  const keptPreferences = preferences?.filter(
    (preference): boolean =>
      preference.target.kind !== 'standalone' ||
      !matchesRef(preference.target, from),
  );
  const preferencesChanged =
    preferences !== undefined &&
    keptPreferences !== undefined &&
    keptPreferences.length !== preferences.length;
  if (!refs && !preferencesChanged) return null;
  return {
    ...selections,
    ...(refs ? { mcpServerRefs: refs } : {}),
    ...(preferencesChanged ? { mcpHttpAuthPreferences: keptPreferences } : {}),
  };
}

export function rewriteMcpTombstones(
  tombstones: PluginSelectionTombstones,
  from: readonly McpServerRefMatcher[],
  to: McpServerRef,
): PluginSelectionTombstones | null {
  const refs = rewriteMcpServerRefList(
    tombstones.mcpServerRefs ?? [],
    from,
    to,
  );
  return refs ? { ...tombstones, mcpServerRefs: refs } : null;
}
