import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import type {
  ChatStateChangedEvent,
  ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';

interface DiscoveryRequest {
  projectId: string;
  worktreeId: string;
  chatId: string;
  pluginSelections?: ChatTabPluginSelections;
}

function samePluginSelections(
  before: ChatTabPluginSelections | undefined,
  after: ChatTabPluginSelections | undefined,
): boolean {
  return (
    JSON.stringify(normalizePluginSelections(before)) ===
    JSON.stringify(normalizePluginSelections(after))
  );
}

/**
 * Re-runs slash-command discovery for each chat tab whose plugin selections a
 * committed event changed, whoever committed it: main, the Portal or this
 * window (CAN-5999). The window's own change arrives already applied, so it
 * compares equal and is not discovered twice. Call it with the tabs as they
 * were before the event was applied; it requests once per changed tab.
 */
export function requestDiscoveryForCommittedPluginChanges(
  event: Pick<ChatStateChangedEvent, 'projectId' | 'worktreeId' | 'changes'>,
  tabsBefore: ReadonlyArray<{
    id: string;
    kind?: string;
    pluginSelections?: ChatTabPluginSelections;
  }>,
  requestDiscovery: (request: DiscoveryRequest) => void,
): void {
  const changed = new Map<string, ChatTabPluginSelections | undefined>();
  for (const change of event.changes) {
    if (
      change.type !== 'tab.metadata_patched' ||
      change.patch.pluginSelections === undefined
    )
      continue;
    const before = tabsBefore.find((tab) => tab.id === change.tabId);
    if (!before || before.kind === 'file') continue;
    const after = change.patch.pluginSelections ?? undefined;
    if (samePluginSelections(before.pluginSelections, after))
      changed.delete(change.tabId);
    else changed.set(change.tabId, after);
  }
  changed.forEach((pluginSelections, chatId) => {
    requestDiscovery({
      projectId: event.projectId,
      worktreeId: event.worktreeId,
      chatId,
      ...(pluginSelections ? { pluginSelections } : {}),
    });
  });
}
