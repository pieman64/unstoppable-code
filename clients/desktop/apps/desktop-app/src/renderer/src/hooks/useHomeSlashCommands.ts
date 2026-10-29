import { useShallow } from 'zustand/shallow';
import type {
  InvocableInventoryEntry,
  SlashCommandData,
} from '@canopy/desktop-shared/types';
import { useComposerInventoryCommands } from './useComposerInventoryCommands';
import {
  INVENTORY_ENABLE_ERROR_COPY,
  type InventorySelectionStatus,
} from '@/lib/slashInvocableInventory';
import {
  resolveHomeEffectiveProviderType,
  useHomeComposerStore,
} from '@/stores/homeComposerStore';

export interface UseHomeSlashCommandsResult {
  commands: SlashCommandData[];
  isRefreshing: boolean;
  isCodex: boolean;
  runInventoryCommand: (
    entry: InvocableInventoryEntry,
    insertResolvedText: (text: string) => void,
  ) => Promise<InventorySelectionStatus>;
  /**
   * List the inventory cache again, for the composer menu opening: the
   * backend re-checks the inherited Cursor folders, which no Canopy mutation
   * marks stale.
   */
  reloadInventory: () => Promise<void>;
}

/** Home's store adapter over the shared, context-driven inventory flow. */
export function useHomeSlashCommands(): UseHomeSlashCommandsResult {
  const {
    workspaceId,
    branchTarget,
    selectedRepoId,
    draftGeneration,
    mode,
    model,
    executionHarness,
    pluginSelections,
    discovery,
    discoveryLoading,
    setPluginSelections,
    setSendError,
  } = useHomeComposerStore(
    useShallow((state) => ({
      workspaceId: state.workspaceId,
      branchTarget: state.branchTarget,
      selectedRepoId: state.selectedRepoId,
      draftGeneration: state.draftGeneration,
      mode: state.mode,
      model: state.model,
      executionHarness: state.executionHarness,
      pluginSelections: state.pluginSelections,
      discovery: state.discovery,
      discoveryLoading: state.discoveryLoading,
      setPluginSelections: state.setPluginSelections,
      setSendError: state.setSendError,
    })),
  );
  const providerType = resolveHomeEffectiveProviderType(
    workspaceId,
    model,
    executionHarness,
  );
  const shared = useComposerInventoryCommands({
    providerType,
    // Cursor has no provider discovery; a cached result from another
    // provider's draft must not be listed as a Cursor command.
    discoveredCommands:
      providerType === 'cursor' ||
      providerType === 'copilot' ||
      providerType === 'opencode'
        ? []
        : (discovery?.slashCommands ?? []),
    discoveryLoading,
    effectiveSelections: pluginSelections ?? undefined,
    includeInventory: mode !== 'pipeline',
    isCurrent: () => {
      const current = useHomeComposerStore.getState();
      return (
        providerType !== undefined &&
        current.workspaceId === workspaceId &&
        current.branchTarget === branchTarget &&
        current.selectedRepoId === selectedRepoId &&
        current.draftGeneration === draftGeneration &&
        current.mode === mode &&
        current.model === model &&
        current.executionHarness === executionHarness &&
        current.pluginSelections === pluginSelections &&
        resolveHomeEffectiveProviderType(
          current.workspaceId,
          current.model,
          current.executionHarness,
        ) === providerType
      );
    },
    commit: (selections, text, onInserted) => {
      // `null`: an inherited row enabled nothing, so the draft keeps its
      // selections and only the text lands.
      if (selections) setPluginSelections(selections);
      onInserted?.(text);
    },
    onError: () => setSendError(INVENTORY_ENABLE_ERROR_COPY),
  });

  return {
    ...shared,
    runInventoryCommand: (
      entry,
      insertResolvedText,
    ): Promise<InventorySelectionStatus> =>
      shared.runInventoryCommand(entry, insertResolvedText),
  };
}
