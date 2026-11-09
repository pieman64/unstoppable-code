import { isDeepStrictEqual } from 'node:util';
import { safeReadJson } from '../lib/fs-utils';
import { getCollectionConfigFilePath } from '../lib/paths';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type { CollectionConfigFile } from '@canopy/desktop-shared/types/collections';
import type {
  PipelinePluginCollection,
  PipelinePluginCollectionPreference,
  PipelinePluginDefaultPreviewItem,
  ResolvedPipelinePluginCollectionSnapshot,
} from '@canopy/execution-engine/types/pipeline';
import {
  buildPipelineDefaultDisplay,
  getPipelinePluginDefaultKey,
} from '@canopy/desktop-shared/pipelines/plugin-collections';
import type {
  ShareablePluginCatalog,
  ShareablePluginMatch,
} from '../plugins/shareable-plugin-resolution';
import {
  loadShareablePluginCatalog,
  matchShareablePluginRef,
} from '../plugins/shareable-plugin-resolution';

export interface PipelinePluginCollectionResolution {
  previewItems: PipelinePluginDefaultPreviewItem[];
  snapshots: Record<string, ResolvedPipelinePluginCollectionSnapshot>;
  messages: Array<{
    collectionId?: string;
    severity: 'error' | 'warning';
    text: string;
  }>;
}

const EMPTY_SELECTIONS: ChatTabPluginSelections = {
  collectionIds: [],
  skillRefs: [],
  pluginRefs: [],
  mcpServerRefs: [],
  mcpHttpAuthPreferences: [],
};

export function cloneSelections(
  selections: ChatTabPluginSelections | undefined,
): ChatTabPluginSelections {
  // Keep this explicit: new optional ChatTabPluginSelections fields must be
  // added here so pipeline collection snapshots do not silently drop them.
  const mergedCollectionIds: string[] = [];
  const seen = new Set<string>();
  for (const id of [
    ...(selections?.collectionIds ?? []),
    ...(selections?.bundleIds ?? []),
  ]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    mergedCollectionIds.push(id);
  }
  return {
    collectionIds: mergedCollectionIds,
    skillRefs: [...(selections?.skillRefs ?? [])],
    pluginRefs: [...(selections?.pluginRefs ?? [])],
    mcpServerRefs: [...(selections?.mcpServerRefs ?? [])],
    mcpHttpAuthPreferences: [...(selections?.mcpHttpAuthPreferences ?? [])],
  };
}

function addSkillSelection(
  selections: ChatTabPluginSelections,
  ref: { sourceId: string; skillName: string },
): void {
  if (
    selections.skillRefs.some(
      (entry) =>
        entry.sourceId === ref.sourceId && entry.skillName === ref.skillName,
    )
  ) {
    return;
  }
  selections.skillRefs.push(ref);
}

function addPluginSelection(
  selections: ChatTabPluginSelections,
  ref: { marketplaceId: string; pluginName: string },
): void {
  if (
    selections.pluginRefs.some(
      (entry) =>
        entry.marketplaceId === ref.marketplaceId &&
        entry.pluginName === ref.pluginName,
    )
  ) {
    return;
  }
  selections.pluginRefs.push(ref);
}

function addMcpSelection(
  selections: ChatTabPluginSelections,
  ref: { serverId: string; configId: string },
): void {
  selections.mcpServerRefs ??= [];
  if (
    selections.mcpServerRefs.some(
      (entry) =>
        entry.serverId === ref.serverId && entry.configId === ref.configId,
    )
  ) {
    return;
  }
  selections.mcpServerRefs.push(ref);
}

function addMatchSelection(
  selections: ChatTabPluginSelections,
  match: ShareablePluginMatch,
): void {
  if (match.matchState !== 'matched') {
    return;
  }
  if (match.selection.kind === 'skill') {
    addSkillSelection(selections, {
      sourceId: match.selection.sourceId,
      skillName: match.selection.skillName,
    });
    return;
  }
  addPluginSelection(selections, {
    marketplaceId: match.selection.marketplaceId,
    pluginName: match.selection.pluginName,
  });
}

/** `extras`' own MCP servers and their sign-in choices, for an agent or a chat. */
function addExtraMcpSelections(
  selections: ChatTabPluginSelections,
  extras: ChatTabPluginSelections,
): void {
  for (const ref of extras.mcpServerRefs ?? [])
    addMcpSelection(selections, ref);
  for (const preference of extras.mcpHttpAuthPreferences ?? []) {
    const preferences = (selections.mcpHttpAuthPreferences ??= []);
    if (
      !preferences.some((entry) =>
        isDeepStrictEqual(entry.target, preference.target),
      )
    )
      preferences.push(preference);
  }
}

/**
 * The matched defaults and `extras` as a chat takes them: collections stay,
 * and capabilities not yet installed stay for the chat to offer (CAN-5479).
 */
function withChatExtras(
  selections: ChatTabPluginSelections,
  extras: ChatTabPluginSelections,
): ChatTabPluginSelections {
  for (const collectionId of extras.collectionIds)
    if (!selections.collectionIds.includes(collectionId))
      selections.collectionIds.push(collectionId);
  for (const ref of extras.skillRefs) addSkillSelection(selections, ref);
  for (const ref of extras.pluginRefs) addPluginSelection(selections, ref);
  addExtraMcpSelections(selections, extras);
  return (extras.unresolvedCapabilities?.length ?? 0) > 0
    ? { ...selections, unresolvedCapabilities: extras.unresolvedCapabilities }
    : selections;
}

function mergeExtraSelections(
  selections: ChatTabPluginSelections,
  extras: ChatTabPluginSelections,
  missingOptionalDefaults: ResolvedPipelinePluginCollectionSnapshot['missingOptionalDefaults'],
  sourceCollectionIds: string[],
): void {
  for (const ref of extras.skillRefs) {
    addSkillSelection(selections, ref);
  }
  for (const ref of extras.pluginRefs) {
    addPluginSelection(selections, ref);
  }
  addExtraMcpSelections(selections, extras);

  for (const collectionId of extras.collectionIds) {
    const collectionFile = safeReadJson<CollectionConfigFile>(
      getCollectionConfigFilePath(collectionId),
    );
    if (!collectionFile?.collection) {
      missingOptionalDefaults.push({
        defaultKey: `collection:${collectionId}`,
        warning: `Collection "${collectionId}" was not found and was not enabled.`,
      });
      continue;
    }
    sourceCollectionIds.push(collectionId);

    for (const ref of collectionFile.collection.skills) {
      addSkillSelection(selections, ref);
    }
    for (const ref of collectionFile.collection.plugins) {
      addPluginSelection(selections, ref);
    }
    for (const ref of collectionFile.collection.mcpServers) {
      addMcpSelection(selections, ref);
    }
  }
}

function buildPreviewItem(args: {
  collectionId: string;
  defaultKey: string;
  required: boolean;
  enabled: boolean;
  match: ShareablePluginMatch;
}): PipelinePluginDefaultPreviewItem {
  const display = buildPipelineDefaultDisplay(args.match.ref);
  return {
    defaultKey: args.defaultKey,
    collectionId: args.collectionId,
    kind: args.match.ref.type === 'skill' ? 'skill' : 'plugin',
    required: args.required,
    enabledByDefault: args.enabled,
    matchState: args.match.matchState,
    ...(args.match.matchState === 'matched'
      ? { matchedCatalogKey: args.match.catalogKey }
      : {}),
    displayName: display.title,
    displayDescription: display.title,
    displaySource: display.subtitle,
    ...(args.match.matchState === 'unmatched'
      ? {
          warning: args.required
            ? `${display.title} is required but is not installed.`
            : `${display.title} is not installed and will be skipped.`,
        }
      : {}),
  };
}

export async function resolvePipelinePluginCollections(
  collections: readonly PipelinePluginCollection[] | undefined,
  preferences: Record<string, PipelinePluginCollectionPreference>,
  catalog?: ShareablePluginCatalog,
): Promise<PipelinePluginCollectionResolution> {
  const effectiveCatalog = catalog ?? (await loadShareablePluginCatalog());
  const previewItems: PipelinePluginDefaultPreviewItem[] = [];
  const snapshots: Record<string, ResolvedPipelinePluginCollectionSnapshot> =
    {};
  const messages: PipelinePluginCollectionResolution['messages'] = [];

  for (const collection of collections ?? []) {
    const preference = preferences[collection.id] ?? {
      disabledDefaultKeys: [],
      extraSelections: EMPTY_SELECTIONS,
    };
    const disabledKeys = new Set(preference.disabledDefaultKeys);
    const selections = cloneSelections(undefined);
    const sourceCollectionIds: string[] = [];
    const missingOptionalDefaults: ResolvedPipelinePluginCollectionSnapshot['missingOptionalDefaults'] =
      [];
    const unresolvedRequiredDefaults: ResolvedPipelinePluginCollectionSnapshot['unresolvedRequiredDefaults'] =
      [];

    for (const defaultRef of collection.defaults) {
      const defaultKey = getPipelinePluginDefaultKey(defaultRef);
      const required = defaultRef.required ?? false;
      const disabled = disabledKeys.has(defaultKey) && !required;
      const match = matchShareablePluginRef(defaultRef, effectiveCatalog);
      previewItems.push(
        buildPreviewItem({
          collectionId: collection.id,
          defaultKey,
          required,
          enabled: !disabled,
          match,
        }),
      );

      if (disabled) {
        continue;
      }

      if (match.matchState === 'matched') {
        addMatchSelection(selections, match);
        continue;
      }

      const display = buildPipelineDefaultDisplay(defaultRef);
      if (required) {
        const error = `${display.title} is required by "${collection.name}" but is not installed.`;
        unresolvedRequiredDefaults.push({ defaultKey, error });
        messages.push({
          collectionId: collection.id,
          severity: 'error',
          text: error,
        });
      } else {
        const warning = `${display.title} is optional for "${collection.name}" but is not installed.`;
        missingOptionalDefaults.push({ defaultKey, warning });
        messages.push({
          collectionId: collection.id,
          severity: 'warning',
          text: warning,
        });
      }
    }

    const chatSelections = withChatExtras(
      cloneSelections(selections),
      preference.extraSelections,
    );
    mergeExtraSelections(
      selections,
      preference.extraSelections,
      missingOptionalDefaults,
      sourceCollectionIds,
    );

    for (const warning of missingOptionalDefaults) {
      if (warning.defaultKey.startsWith('bundle:')) {
        messages.push({
          collectionId: collection.id,
          severity: 'warning',
          text: warning.warning,
        });
      }
    }

    snapshots[collection.id] = {
      selections,
      chatSelections,
      sourceCollectionIds,
      missingOptionalDefaults,
      unresolvedRequiredDefaults,
    };
  }

  return { previewItems, snapshots, messages };
}
