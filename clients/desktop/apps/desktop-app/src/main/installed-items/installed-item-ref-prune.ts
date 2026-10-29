import {
  InstalledItemRefSchema,
  installedItemKey,
  type InstalledItemRef,
} from '@canopy/protocol/installed-items';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Selection metadata only; historical messages and transcript bodies are immutable. */
export function pruneInstalledItemRefs(
  value: unknown,
  ref: InstalledItemRef,
): boolean {
  if (!isRecord(value)) return false;
  let changed = false;
  const key = installedItemKey(ref);
  for (const [field, child] of Object.entries(value)) {
    if (
      ['messages', 'transcript', 'parts', 'content', 'history'].includes(field)
    )
      continue;
    if (Array.isArray(child)) {
      const kind =
        field === 'pluginRefs' || field === 'plugins'
          ? 'plugin'
          : field === 'skillRefs' || field === 'skills'
            ? 'skill'
            : field === 'mcpServerRefs' || field === 'mcpServers'
              ? 'mcp-config'
              : null;
      let filtered = child;
      if (kind)
        filtered = child.filter((entry: unknown) => {
          if (!isRecord(entry)) return true;
          if (
            kind === 'mcp-config' &&
            ref.kind === 'account-mcp' &&
            entry.serverId === `account:${ref.connectionId}`
          )
            return false;
          const parsed = InstalledItemRefSchema.safeParse({ kind, ...entry });
          return !parsed.success || installedItemKey(parsed.data) !== key;
        });
      if (
        (field === 'collectionIds' || field === 'bundleIds') &&
        ref.kind === 'collection'
      )
        filtered = child.filter((id) => id !== ref.collectionId);
      if (field === 'disabledInstalledItems')
        filtered = child.filter((entry) => entry !== key);
      if (field === 'parkedCodexPlugins')
        filtered = child.filter(
          (entry) => !isRecord(entry) || entry.key !== key,
        );
      if (field === 'codexCompatDisabledPlugins' && ref.kind === 'plugin')
        filtered = child.filter(
          (entry) =>
            entry !== `${ref.marketplaceId}/${ref.pluginName.toLowerCase()}`,
        );
      if (field === 'mcpHttpAuthPreferences')
        filtered = child.filter((entry: unknown) => {
          if (!isRecord(entry) || !isRecord(entry.target)) return true;
          const target = entry.target;
          if (ref.kind === 'plugin' && target.kind === 'plugin')
            return (
              target.marketplaceId !== ref.marketplaceId ||
              typeof target.pluginName !== 'string' ||
              target.pluginName.toLowerCase() !== ref.pluginName.toLowerCase()
            );
          if (ref.kind === 'mcp-config' && target.kind === 'standalone')
            return (
              target.serverId !== ref.serverId ||
              target.configId !== ref.configId
            );
          if (ref.kind === 'account-mcp' && target.kind === 'standalone')
            return target.serverId !== `account:${ref.connectionId}`;
          return true;
        });
      if (filtered.length !== child.length) {
        value[field] = filtered;
        changed = true;
      }
      if (['tabs', 'chatTabs', 'chats'].includes(field))
        for (const entry of child)
          changed = pruneInstalledItemRefs(entry, ref) || changed;
    } else if (isRecord(child))
      changed = pruneInstalledItemRefs(child, ref) || changed;
  }
  return changed;
}
