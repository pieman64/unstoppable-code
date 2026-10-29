import type {
  ChatTabPluginSelections,
  InvocableInventoryEntry,
  InvocableInventoryProvider,
  ResolveInvocableSelectionRequest,
  ResolveInvocableSelectionResponse,
  PluginSelectionTombstones,
} from '@canopy/desktop-shared/types';
import type { IPCResult } from '@canopy/desktop-shared/types/pipeline';
import type { PluginInfo } from '@canopy/desktop-shared/types/plugins';
import { appendEnableRef } from '@canopy/desktop-shared/lib/slash-invocable-inventory';

export {
  appendEnableRef,
  buildSlashInventoryCommands,
  flattenCollectionRefs,
  inventoryRowNeedsResolution,
  type BuildSlashInventoryCommandsParams,
  type CollectionEnabledRefs,
  type SlashInventoryCommand,
  type SlashInventoryCommandLists,
} from '@canopy/desktop-shared/lib/slash-invocable-inventory';

/**
 * User-facing copy shown when an "available to enable" row cannot be enabled
 * (prepare failed, or the resolve check found the row no longer installed).
 */
export const INVENTORY_ENABLE_ERROR_COPY =
  'Could not enable that item. Try again or use the Plugins picker.';

export interface RunInventorySelectionDeps {
  prepareCodexCompatibilityPlugin: (
    marketplaceId: string,
    pluginName: string,
  ) => Promise<IPCResult<PluginInfo>>;
  resolveSelection: (
    request: ResolveInvocableSelectionRequest,
  ) => Promise<IPCResult<ResolveInvocableSelectionResponse>>;
  /** Enable the merged selections (the plugin-picker write + discovery retrigger). */
  applySelections: (next: ChatTabPluginSelections) => void;
  /** Insert the RESOLVED invocation text into the active trigger range. */
  insertResolvedText: (insertText: string) => void;
  /** Show the enable-failure toast. */
  onError: () => void;
  /** Trigger an inventory refresh (stale/removed row). */
  refreshInventory: () => void;
}

export interface RunInventorySelectionParams {
  entry: InvocableInventoryEntry;
  providerType: InvocableInventoryProvider;
  currentSelections: ChatTabPluginSelections;
  /**
   * The chat's plugin opt-outs, when it has any. The resolver numbers a
   * Cursor row's id over the plugin set the chat actually runs, so a plugin
   * the chat turned off must not take an id there either.
   */
  chatTombstones?: PluginSelectionTombstones;
  /** The chat's working directory, when known; see the request field. */
  projectPath?: string;
  deps: RunInventorySelectionDeps;
}

export type InventorySelectionStatus =
  | 'inserted'
  | 'prepare-failed'
  | 'resolve-failed';

/**
 * Enable-and-insert flow for an "available to enable" row, and for an
 * inherited row, which enables nothing but still needs the resolved id. Runs
 * in order and,
 * on any failure, aborts to the error path BEFORE mutating selections or
 * inserting any text:
 *
 *   1. Codex-compat prepare (when required).
 *   2. Validate-and-resolve against the post-merge selection (mandatory because
 *      `setPluginSelections` is fire-and-forget and never reports validity).
 *   3. Enable like the plugin picker, then insert the RESOLVED invocation text.
 */
export async function runInventorySelection(
  params: RunInventorySelectionParams,
): Promise<InventorySelectionStatus> {
  const {
    entry,
    providerType,
    currentSelections,
    chatTombstones,
    projectPath,
    deps,
  } = params;
  const nextSelections = appendEnableRef(currentSelections, entry.enableRef);

  if (entry.requiresCodexCompatPrepare && entry.enableRef.kind === 'plugin') {
    try {
      const prepared = await deps.prepareCodexCompatibilityPlugin(
        entry.enableRef.marketplaceId,
        entry.enableRef.pluginName,
      );
      if (!prepared.success) {
        deps.onError();
        return 'prepare-failed';
      }
    } catch {
      deps.onError();
      return 'prepare-failed';
    }
  }

  let resolved: IPCResult<ResolveInvocableSelectionResponse>;
  try {
    resolved = await deps.resolveSelection({
      providerType,
      entry,
      selections: nextSelections,
      ...(chatTombstones ? { chatTombstones } : {}),
      ...(projectPath ? { projectPath } : {}),
    });
  } catch {
    deps.onError();
    deps.refreshInventory();
    return 'resolve-failed';
  }

  if (!resolved.success || !resolved.data) {
    deps.onError();
    deps.refreshInventory();
    return 'resolve-failed';
  }

  // An inherited row enables nothing, so nothing is written: a selection
  // write restarts the provider session (and would abort a running turn) and
  // pins the chat's default selections as local picks.
  if (entry.enableRef.kind !== 'none') deps.applySelections(nextSelections);
  deps.insertResolvedText(resolved.data.insertText);
  return 'inserted';
}
