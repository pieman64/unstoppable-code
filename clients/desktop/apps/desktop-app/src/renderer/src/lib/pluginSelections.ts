import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import { emptyChatTabPluginSelections } from '@canopy/desktop-shared/lib/app-advisor-chat-reads';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import type {
  McpHttpAuthHandler,
  McpHttpAuthPreference,
  McpHttpAuthTarget,
} from '@canopy/execution-engine/types/mcp-servers';
import { mcpHttpAuthTargetKey } from '@canopy/execution-engine/lib/mcp-http-auth';

export const EMPTY_SELECTIONS: ChatTabPluginSelections = {
  collectionIds: [],
  skillRefs: [],
  pluginRefs: [],
  mcpServerRefs: [],
  mcpHttpAuthPreferences: [],
};

const VALID_HANDLERS: ReadonlySet<McpHttpAuthHandler> =
  new Set<McpHttpAuthHandler>(['canopy', 'provider', 'account']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

function isSkillRefArray(
  value: unknown,
): value is ChatTabPluginSelections['skillRefs'] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.sourceId === 'string' &&
        typeof entry.skillName === 'string',
    )
  );
}

function isPluginRefArray(
  value: unknown,
): value is ChatTabPluginSelections['pluginRefs'] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.marketplaceId === 'string' &&
        typeof entry.pluginName === 'string',
    )
  );
}

function isMcpServerRefArray(
  value: unknown,
): value is NonNullable<ChatTabPluginSelections['mcpServerRefs']> {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.serverId === 'string' &&
        typeof entry.configId === 'string',
    )
  );
}

/**
 * Parse a single persisted {@link McpHttpAuthPreference} entry. Returns `null`
 * for any malformed shape (missing `target.kind`, missing required string
 * fields, or unknown handler) so corrupt entries are silently dropped rather
 * than breaking selection loading.
 */
function parseMcpHttpAuthPreference(
  value: unknown,
): McpHttpAuthPreference | null {
  if (!isRecord(value)) return null;
  const { target, handler } = value;
  if (typeof handler !== 'string') return null;
  if (!VALID_HANDLERS.has(handler as McpHttpAuthHandler)) return null;
  if (!isRecord(target)) return null;

  if (target.kind === 'standalone') {
    if (
      typeof target.serverId !== 'string' ||
      typeof target.configId !== 'string'
    ) {
      return null;
    }
    return {
      target: {
        kind: 'standalone',
        serverId: target.serverId,
        configId: target.configId,
      },
      handler: handler as McpHttpAuthHandler,
    };
  }
  if (target.kind === 'plugin') {
    if (
      typeof target.marketplaceId !== 'string' ||
      typeof target.pluginName !== 'string' ||
      typeof target.serverName !== 'string'
    ) {
      return null;
    }
    return {
      target: {
        kind: 'plugin',
        marketplaceId: target.marketplaceId,
        pluginName: target.pluginName,
        serverName: target.serverName,
      },
      handler: handler as McpHttpAuthHandler,
    };
  }
  return null;
}

function parseMcpHttpAuthPreferences(value: unknown): McpHttpAuthPreference[] {
  if (!Array.isArray(value)) return [];
  const result: McpHttpAuthPreference[] = [];
  for (const entry of value) {
    const parsed = parseMcpHttpAuthPreference(entry);
    if (parsed !== null) {
      result.push(parsed);
    }
  }
  return result;
}

export function parseSelectionsJson(
  json: string,
): ChatTabPluginSelections | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  const {
    collectionIds: rawCollectionIds,
    bundleIds: rawBundleIds,
    skillRefs,
    pluginRefs,
    mcpServerRefs,
    mcpHttpAuthPreferences,
  } = parsed;

  // Accept either the canonical `collectionIds` field or the deprecated
  // `bundleIds` alias on input. At least one must be present and an array of
  // strings; the helper merges them into `collectionIds` on output.
  const hasCollectionIds = rawCollectionIds !== undefined;
  const hasBundleIds = rawBundleIds !== undefined;
  if (!hasCollectionIds && !hasBundleIds) {
    return null;
  }
  if (hasCollectionIds && !isStringArray(rawCollectionIds)) {
    return null;
  }
  if (hasBundleIds && !isStringArray(rawBundleIds)) {
    return null;
  }
  if (!isSkillRefArray(skillRefs) || !isPluginRefArray(pluginRefs)) {
    return null;
  }

  if (mcpServerRefs !== undefined && !isMcpServerRefArray(mcpServerRefs)) {
    return null;
  }

  // Malformed individual auth preference entries are silently dropped so a
  // single corrupt persisted override cannot break selection loading.
  const parsedAuthPreferences =
    mcpHttpAuthPreferences === undefined
      ? undefined
      : parseMcpHttpAuthPreferences(mcpHttpAuthPreferences);

  const collectionIds: string[] = [];
  const seen = new Set<string>();
  for (const id of [...(rawCollectionIds ?? []), ...(rawBundleIds ?? [])]) {
    if (seen.has(id)) continue;
    seen.add(id);
    collectionIds.push(id);
  }

  return {
    collectionIds,
    skillRefs,
    pluginRefs,
    ...(mcpServerRefs ? { mcpServerRefs } : {}),
    ...(parsedAuthPreferences && parsedAuthPreferences.length > 0
      ? { mcpHttpAuthPreferences: parsedAuthPreferences }
      : {}),
  };
}

export function createEmptySelections(): ChatTabPluginSelections {
  return emptyChatTabPluginSelections();
}

function targetForSort(target: McpHttpAuthTarget): McpHttpAuthTarget {
  if (target.kind === 'standalone') {
    return {
      kind: 'standalone',
      serverId: target.serverId,
      configId: target.configId,
    };
  }
  return {
    kind: 'plugin',
    marketplaceId: target.marketplaceId,
    pluginName: target.pluginName,
    serverName: target.serverName,
  };
}

export function normalizeSelections(sel: unknown): string {
  const normalized = normalizePluginSelections(sel);
  return JSON.stringify({
    collectionIds: normalized.collectionIds.slice().sort(),
    skillRefs: normalized.skillRefs
      .slice()
      .sort((a, b) =>
        `${a.sourceId}/${a.skillName}`.localeCompare(
          `${b.sourceId}/${b.skillName}`,
        ),
      ),
    pluginRefs: normalized.pluginRefs
      .slice()
      .sort((a, b) =>
        `${a.marketplaceId}/${a.pluginName}`.localeCompare(
          `${b.marketplaceId}/${b.pluginName}`,
        ),
      ),
    mcpServerRefs: (normalized.mcpServerRefs ?? [])
      .slice()
      .sort((a, b) =>
        `${a.serverId}/${a.configId}`.localeCompare(
          `${b.serverId}/${b.configId}`,
        ),
      ),
    mcpHttpAuthPreferences: (normalized.mcpHttpAuthPreferences ?? [])
      .slice()
      .sort((a, b) =>
        mcpHttpAuthTargetKey(a.target).localeCompare(
          mcpHttpAuthTargetKey(b.target),
        ),
      )
      .map((preference) => ({
        target: targetForSort(preference.target),
        handler: preference.handler,
      })),
  });
}
