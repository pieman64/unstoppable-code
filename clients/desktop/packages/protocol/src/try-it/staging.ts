import { buildTryItCapabilityKey, type TryItCapability } from './index';

interface Selections {
  collectionIds: string[];
  skillRefs: { sourceId: string; skillName: string }[];
  pluginRefs: { marketplaceId: string; pluginName: string }[];
  mcpServerRefs?: { serverId: string; configId: string }[];
  unresolvedCapabilities?: TryItCapability[];
}

function mergeByKey<T>(
  existing: T[],
  incoming: T[],
  key: (entry: T) => string,
): T[] {
  const byKey = new Map(existing.map((entry) => [key(entry), entry]));
  for (const entry of incoming) byKey.set(key(entry), entry);
  return Array.from(byKey.values());
}

/** Explicit selection adds this capability while retaining unrelated host fields. */
export function mergeTryItCapabilitySelections<T extends Selections>(
  existing: T,
  incoming: Selections,
  resolvedCapability?: TryItCapability,
): T {
  const capabilityKey = (entry: TryItCapability): string =>
    buildTryItCapabilityKey('', entry);
  return {
    ...existing,
    collectionIds: Array.from(
      new Set([...existing.collectionIds, ...incoming.collectionIds]),
    ),
    skillRefs: mergeByKey(existing.skillRefs, incoming.skillRefs, (entry) =>
      JSON.stringify([entry.sourceId, entry.skillName]),
    ),
    pluginRefs: mergeByKey(existing.pluginRefs, incoming.pluginRefs, (entry) =>
      JSON.stringify([entry.marketplaceId, entry.pluginName]),
    ),
    mcpServerRefs: mergeByKey(
      existing.mcpServerRefs ?? [],
      incoming.mcpServerRefs ?? [],
      (entry) => entry.serverId,
    ),
    unresolvedCapabilities: mergeByKey(
      existing.unresolvedCapabilities ?? [],
      incoming.unresolvedCapabilities ?? [],
      capabilityKey,
    ).filter(
      (entry) =>
        !resolvedCapability ||
        capabilityKey(entry) !== capabilityKey(resolvedCapability),
    ),
  };
}

export function tryItStagedMessage(capabilityName: string): string {
  return `${capabilityName} is ready to try. Edit the prompt, then send it.`;
}
