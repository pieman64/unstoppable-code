import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChatTabPluginSelections,
  InvocableInventoryEntry,
  InvocableInventoryProvider,
  SlashCommandData,
} from '@canopy/desktop-shared/types';
import {
  buildSlashInventoryCommands,
  appendEnableRef,
  flattenCollectionRefs,
  runInventorySelection,
  type CollectionEnabledRefs,
  type InventorySelectionStatus,
} from '@/lib/slashInvocableInventory';
import { createEmptySelections } from '@/lib/pluginSelections';
import { useInvocableInventory } from './useInvocableInventory';

export interface ComposerInventoryCommandOptions {
  providerType: InvocableInventoryProvider | undefined;
  discoveredCommands: SlashCommandData[];
  discoveryLoading: boolean;
  effectiveSelections?: ChatTabPluginSelections;
  /** Explicit additions to persist; omitted when the host owns the complete set. */
  persistedSelections?: ChatTabPluginSelections;
  /** Home pipeline keeps only discovered rows. Configuration always uses chat mode. */
  includeInventory: boolean;
  /** Must cover editor, target, mode, provider, selections and mount identity. */
  isCurrent: () => boolean;
  /**
   * Insert the resolved text and, when `selections` is not `null`, persist
   * them. `null` means the row enabled nothing (an inherited Cursor row):
   * insert the text, clear any pending state, and write no selection, since
   * a selection write restarts the provider session.
   */
  commit: (
    selections: ChatTabPluginSelections | null,
    insertText: string,
    onInserted?: (text: string) => void,
  ) => void;
  onError: () => void;
}

/** Shared Home/configuration catalog and provider-correct enablement flow. */
export function useComposerInventoryCommands({
  providerType,
  discoveredCommands,
  discoveryLoading,
  effectiveSelections,
  persistedSelections,
  includeInventory,
  isCurrent,
  commit,
  onError,
}: ComposerInventoryCommandOptions): {
  commands: SlashCommandData[];
  isRefreshing: boolean;
  isCodex: boolean;
  runInventoryCommand: (
    entry: InvocableInventoryEntry,
    onInserted?: (text: string) => void,
  ) => Promise<InventorySelectionStatus>;
  /** List the cache again (a menu opening); see `useInvocableInventory`. */
  reloadInventory: () => Promise<void>;
} {
  const inventory = useInvocableInventory(providerType);
  const operation = useRef(false);
  const collectionIdsKey = (
    providerType === undefined ? [] : (effectiveSelections?.collectionIds ?? [])
  ).join('\n');
  const [collectionRefs, setCollectionRefs] = useState<CollectionEnabledRefs>({
    skillRefs: [],
    pluginRefs: [],
  });
  useEffect(() => {
    const ids = collectionIdsKey ? collectionIdsKey.split('\n') : [];
    if (ids.length === 0) {
      setCollectionRefs({ skillRefs: [], pluginRefs: [] });
      return;
    }
    let cancelled = false;
    void Promise.all(
      ids.map((id) => window.collections.loadCollection(id).catch(() => null)),
    ).then(
      (configs) => {
        if (!cancelled) setCollectionRefs(flattenCollectionRefs(configs));
      },
      () => {
        if (!cancelled) setCollectionRefs({ skillRefs: [], pluginRefs: [] });
      },
    );
    return (): void => {
      cancelled = true;
    };
  }, [collectionIdsKey]);

  const sortedDiscovered = useMemo(
    () => [...discoveredCommands].sort((a, b) => a.name.localeCompare(b.name)),
    [discoveredCommands],
  );
  const commands = useMemo(() => {
    if (providerType === undefined) return [];
    const {
      discoveredCommands: discovered,
      promotedInventoryCommands,
      availableInventoryCommands,
    } = buildSlashInventoryCommands({
      entries: inventory.entries,
      discoveredCommands: sortedDiscovered,
      selections: effectiveSelections,
      collectionRefs,
      isDiscovering: false,
    });
    return includeInventory
      ? [
          ...discovered,
          ...promotedInventoryCommands.map(
            (command): SlashCommandData => ({
              ...command,
              section: 'available',
            }),
          ),
          ...availableInventoryCommands,
        ]
      : discovered;
  }, [
    providerType,
    inventory.entries,
    sortedDiscovered,
    effectiveSelections,
    collectionRefs,
    includeInventory,
  ]);

  async function runInventoryCommand(
    entry: InvocableInventoryEntry,
    onInserted?: (text: string) => void,
  ): Promise<InventorySelectionStatus> {
    if (providerType === undefined || !isCurrent()) return 'resolve-failed';
    if (operation.current) return 'resolve-failed';
    operation.current = true;
    let nextSelections: ChatTabPluginSelections | null = null;
    try {
      return await runInventorySelection({
        entry,
        providerType,
        currentSelections: effectiveSelections ?? createEmptySelections(),
        deps: {
          prepareCodexCompatibilityPlugin: (marketplaceId, pluginName) =>
            window.plugins.prepareCodexCompatibilityPlugin(
              marketplaceId,
              pluginName,
            ),
          resolveSelection: async (request) => {
            if (!isCurrent())
              return { success: false, error: 'Destination changed.' };
            const response =
              await window.invocableInventory.resolveSelection(request);
            return isCurrent()
              ? response
              : { success: false, error: 'Destination changed.' };
          },
          applySelections: (selections) => {
            nextSelections = selections;
          },
          insertResolvedText: (text) => {
            if (!isCurrent()) return;
            // An inherited row enabled nothing (no `applySelections` call):
            // the consumer still commits, with `null` for the selections, so
            // it inserts the text and clears its own state without writing.
            commit(
              nextSelections
                ? persistedSelections
                  ? appendEnableRef(persistedSelections, entry.enableRef)
                  : nextSelections
                : null,
              text,
              onInserted,
            );
          },
          onError: () => {
            if (isCurrent()) onError();
          },
          refreshInventory: () => {
            if (isCurrent()) void inventory.refresh();
          },
        },
      });
    } finally {
      operation.current = false;
    }
  }

  return {
    commands,
    isRefreshing: providerType !== undefined && discoveryLoading,
    isCodex: providerType === 'codex',
    runInventoryCommand,
    reloadInventory: inventory.reload,
  };
}
