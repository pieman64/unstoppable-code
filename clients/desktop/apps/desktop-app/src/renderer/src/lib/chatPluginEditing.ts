import {
  getAgentModelSelectionId,
  type ChatTabPluginSelections,
  type PluginSelectionTombstones,
} from '@canopy/desktop-shared/types';
import {
  effectiveChatPluginSelections,
  effectiveGlobalPluginSelections,
  inheritedPluginSelections,
  projectDefaultsForChat,
  splitChosenChatPluginSelections,
  subtractPluginSelections,
  chatSurfaceUsesGlobalPluginDefaults,
  type InheritedPluginLayers,
} from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { normalizePluginSelections } from '@canopy/desktop-shared/lib/plugin-selections-normalization';
import {
  mergeAgentChatPluginSelections,
  stripAgentOnlyChatPluginSelections,
} from './chatPluginSelections';
import { useGlobalPluginDefaultsStore } from '@/stores/globalPluginDefaultsStore';
import { useModelCatalogStore } from '@/stores/modelCatalogStore';
import type { useChatStore } from '@/stores/chatStore';
import {
  getProjectPluginDefaults,
  getProjectPluginTombstones,
} from '@/stores/chat/tab-utils';
import { shouldMaterializeCodexThread } from '@/components/chat/codex-thread-materialization';

type ChatState = ReturnType<typeof useChatStore.getState>;
export interface PluginChatTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

/**
 * The inherited layers a plugin list labels as defaults. A global the project
 * turned off is not inherited, so it is never labelled a global default.
 */
export function inheritedDefaultLayers(layers: InheritedPluginLayers): {
  project?: ChatTabPluginSelections;
  global?: ChatTabPluginSelections;
} {
  return {
    ...(layers.projectDefaults ? { project: layers.projectDefaults } : {}),
    ...(layers.global
      ? {
          global: effectiveGlobalPluginSelections(layers.global, [
            layers.projectTombstones,
          ]),
        }
      : {}),
  };
}

/**
 * Read the captured chat, never whichever tab happens to be active after IPC.
 * `projectDefaults` is the project layer the chat inherits: none for a chat
 * written before it was live (`chatInheritsProjectDefaults`), which owns every
 * ref it has until main normalizes it. `projectTombstones` are the globals the
 * project turned off, which the chat does not inherit either.
 */
export function chatPluginEditingState(
  state: ChatState,
  target: PluginChatTarget,
): {
  tab: ChatState['worktreeChats'][string]['tabs'][number];
  global: ChatTabPluginSelections | undefined;
  projectDefaults: ChatTabPluginSelections | undefined;
  projectTombstones: PluginSelectionTombstones | undefined;
  agent: ChatTabPluginSelections | undefined;
  effective: ChatTabPluginSelections;
} {
  const tab = state.worktreeChats[
    `${target.projectId}/${target.worktreeId}`
  ]?.tabs.find((t) => t.id === target.chatId);
  if (!tab) throw new Error('Chat is no longer available.');
  const defaults = useGlobalPluginDefaultsStore.getState();
  const global =
    chatSurfaceUsesGlobalPluginDefaults(target.projectId) && defaults.hydrated
      ? defaults.selections
      : undefined;
  const rawProjectDefaults = projectDefaultsForChat(
    tab,
    getProjectPluginDefaults(
      target.projectId,
      target.worktreeId,
      state.worktreeDefaultPlugins,
    ),
  );
  const projectDefaults = rawProjectDefaults
    ? normalizePluginSelections(rawProjectDefaults)
    : undefined;
  const projectTombstones = getProjectPluginTombstones(target.projectId);
  // A chat pinned to an Agent route takes that Agent's plugins.
  const agentId = tab.model ? getAgentModelSelectionId(tab.model) : undefined;
  const agent = useModelCatalogStore
    .getState()
    .snapshot?.agents?.find((entry) => entry.id === agentId)?.pluginSelections;
  const displayed = effectiveChatPluginSelections({
    local: tab.pluginSelections,
    projectDefaults,
    global,
    projectTombstones,
    chatTombstones: tab.disabledGlobalPluginSelections,
  });
  return {
    tab,
    global,
    projectDefaults,
    projectTombstones,
    agent,
    effective: normalizePluginSelections(
      mergeAgentChatPluginSelections(displayed, agent),
    ),
  };
}

export async function editChatPlugins(
  getState: () => ChatState,
  target: PluginChatTarget,
  edit: (current: ChatTabPluginSelections) => ChatTabPluginSelections,
): Promise<void> {
  const { tab, global, projectDefaults, projectTombstones, agent, effective } =
    chatPluginEditingState(getState(), target);
  if (tab.readOnly || tab.status === 'streaming')
    throw new Error('Wait for this chat to finish before changing plugins.');
  const chosen = edit(effective);
  const stripped = stripAgentOnlyChatPluginSelections(
    chosen,
    agent,
    tab.pluginSelections,
  );
  // Tombstones derive from the pre-strip chosen set so agent-locked stripping
  // cannot turn off a default the user left on.
  const { localSelections } = splitChosenChatPluginSelections({
    chosen: stripped,
    projectDefaults,
    global,
    projectTombstones,
    previousLocal: tab.pluginSelections,
    previousTombstones: tab.disabledGlobalPluginSelections,
  });
  const { tombstones } = splitChosenChatPluginSelections({
    chosen,
    projectDefaults,
    global,
    projectTombstones,
    previousTombstones: tab.disabledGlobalPluginSelections,
  });
  const inherits = global !== undefined || projectDefaults !== undefined;
  const response = await window.api.chat.updatePlugins({
    ...target,
    pluginSelections: localSelections,
    ...(inherits ? { disabledGlobalPluginSelections: tombstones } : {}),
    deferredToolsAllowed: tab.deferredToolsAllowed,
    materializeCodexThread: shouldMaterializeCodexThread({
      providerType: tab.providerType,
      executionHarness: tab.executionHarness,
      sdkSessionId: tab.sdkSessionId,
    }),
    expectedCurrentThreadId: tab.sdkSessionId,
  });
  getState().setPluginSelections(
    response.pluginSelections,
    target,
    response.deferredToolsAllowed,
    {
      runtimeAlreadyUpdated: true,
      ...(inherits
        ? {
            disabledGlobalPluginSelections:
              response.disabledGlobalPluginSelections ?? tombstones,
          }
        : {}),
      ...(response.sdkSessionId ? { sdkSessionId: response.sdkSessionId } : {}),
    },
  );
}

/**
 * Applies auth handler choices made on a chat's effective selections (for
 * example the Activity MCP proxy toggle) to the selections the chat owns.
 * Choices that match an inherited default are left to that default, so the
 * chat's own selection never picks up copies of inherited plugins.
 */
export function setChatAuthPreferencesFromEffective(
  getState: () => ChatState,
  target: PluginChatTarget,
  next: ChatTabPluginSelections,
): void {
  const { tab, global, projectDefaults, projectTombstones } =
    chatPluginEditingState(getState(), target);
  const inherited = inheritedPluginSelections({
    projectDefaults,
    global,
    projectTombstones,
  });
  if (!inherited) {
    getState().setPluginSelections(next, target);
    return;
  }
  const own = normalizePluginSelections(tab.pluginSelections);
  const { mcpHttpAuthPreferences } = subtractPluginSelections(next, inherited);
  getState().setPluginSelections(
    {
      collectionIds: own.collectionIds,
      skillRefs: own.skillRefs,
      pluginRefs: own.pluginRefs,
      mcpServerRefs: own.mcpServerRefs ?? [],
      ...(mcpHttpAuthPreferences ? { mcpHttpAuthPreferences } : {}),
    },
    target,
  );
}

/**
 * Persists a just-created chat's own selections and the inherited defaults it
 * turns off, resolving only after main has them so the chat's first turn
 * already sees them.
 */
export async function applyNewChatPluginSelections(
  getState: () => ChatState,
  target: PluginChatTarget,
  plugins: {
    pluginSelections: ChatTabPluginSelections;
    disabledGlobalPluginSelections?: PluginSelectionTombstones;
  },
): Promise<void> {
  const tombstones = plugins.disabledGlobalPluginSelections ?? {};
  const response = await window.api.chat.updatePlugins({
    ...target,
    pluginSelections: plugins.pluginSelections,
    disabledGlobalPluginSelections: tombstones,
  });
  getState().setPluginSelections(
    response.pluginSelections,
    target,
    response.deferredToolsAllowed,
    {
      runtimeAlreadyUpdated: true,
      disabledGlobalPluginSelections:
        response.disabledGlobalPluginSelections ?? tombstones,
      ...(response.sdkSessionId ? { sdkSessionId: response.sdkSessionId } : {}),
    },
  );
}
