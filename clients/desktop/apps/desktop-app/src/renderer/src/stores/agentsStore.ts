import {
  artifactInventoryScope,
  clearArtifactAgentRemovals,
  recordArtifactAgentRemoval,
} from './agentArtifactInventoryStore';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from './featureFlagsStore';
import { useWorkspaceContextStore } from './workspaceContextStore';
import { create } from 'zustand';
import type {
  AgentModelDefinition,
  ImportSharedAgentRequest,
  ImportSharedAgentResponse,
  SaveAgentModelRequest,
} from '@canopy/desktop-shared/types/agent-models';
import { extractIpcErrorMessage } from '@/lib/errors';

/**
 * Renderer store for the LOCAL custom Agent models surfaced in the Marketplace
 * Agents tab (CAN-4266).
 *
 * It sits over the `window.agents` preload bridge (`AgentModelsAPI`) and owns
 * the local list, loading/error state, the local CRUD mutations, shared-Agent
 * import, and the `agents:changed` re-hydration subscription.
 *
 * Agents shared with the viewer are listed separately by
 * `useSharedMarketplaceShares`, mirroring the Skills split between
 * `useSkillList` and `useSharedSkillList`.
 *
 * IMPORTANT: this store never exposes anything beyond the persisted
 * {@link AgentModelDefinition} shape. Current-UI-state reporting reports agent
 * ids and dialog modes through `plugins.page` only and never serializes Agent
 * instructions or the full plugin configuration.
 */
interface AgentsState {
  /** The local Agent models, most-recently loaded first-party ordering. */
  agents: AgentModelDefinition[];
  /** True while a list refresh is in flight. */
  loading: boolean;
  /** True once the first list response has settled (success or failure). */
  loaded: boolean;
  /** Scope of the last completed inventory; a filtered list cannot prove deletion. */
  inventoryComplete: boolean;
  inventoryGeneration: number | null;
  /** Last load/mutation error message, or null when the last op succeeded. */
  error: string | null;
  /** Refresh the local Agent list from the main process. */
  load: () => Promise<void>;
  /** Create (omit `id`) or update (include `id`) a local Agent. */
  save: (request: SaveAgentModelRequest) => Promise<AgentModelDefinition>;
  /** Delete a local Agent by its stable `agent_model_*` id. */
  remove: (id: string) => Promise<void>;
  /** Import a shared Agent (by server-side UUID) into the local store. */
  importShared: (
    request: ImportSharedAgentRequest,
  ) => Promise<ImportSharedAgentResponse>;
  /**
   * Subscribe to the main → renderer `agents:changed` broadcast so the local
   * list re-hydrates after any main-process Agent store mutation. Returns an
   * unsubscribe handle.
   */
  subscribe: () => () => void;
}

// Lists can overlap after a mutation and its broadcast. Only the latest read
// may replace the inventory, even within the same context.
let loadSequence = 0;

export const useAgentsStore = create<AgentsState>((set, get) => ({
  agents: [],
  loading: false,
  loaded: false,
  inventoryComplete: false,
  inventoryGeneration: null,
  error: null,

  load: async (): Promise<void> => {
    const sequence = ++loadSequence;
    const contextEnabled = useFeatureFlagsStore
      .getState()
      .isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key);
    const generation = useWorkspaceContextStore.getState().appliedGeneration;
    const artifactScope = artifactInventoryScope();
    const contextChanged =
      contextEnabled && get().inventoryGeneration !== generation;
    set({
      loading: true,
      ...(contextChanged
        ? {
            agents: [],
            loaded: false,
            error: null,
            inventoryGeneration: generation,
            inventoryComplete: false,
          }
        : {}),
    });
    try {
      const response = await window.agents.list();
      if (
        sequence !== loadSequence ||
        (contextEnabled &&
          generation !== useWorkspaceContextStore.getState().appliedGeneration)
      )
        return;
      clearArtifactAgentRemovals(response.agents.map((agent) => agent.id));
      set({
        inventoryComplete: artifactScope.complete,
        inventoryGeneration: artifactScope.generation,
        agents: response.agents,
        loading: false,
        loaded: true,
        error: null,
      });
    } catch (err: unknown) {
      if (
        sequence !== loadSequence ||
        (contextEnabled &&
          generation !== useWorkspaceContextStore.getState().appliedGeneration)
      )
        return;
      set({
        loading: false,
        loaded: true,
        error: extractIpcErrorMessage(err),
      });
    }
  },

  save: async (
    request: SaveAgentModelRequest,
  ): Promise<AgentModelDefinition> => {
    const scope = artifactInventoryScope();
    const saved = await window.agents.save(request);
    if (
      !scope.complete &&
      scope.generation !== artifactInventoryScope().generation
    )
      return saved;
    clearArtifactAgentRemovals([saved.id]);
    set((state) => {
      const sameScope =
        scope.complete || state.inventoryGeneration === scope.generation;
      const agents = sameScope ? state.agents : [];
      return {
        agents: [...agents.filter((agent) => agent.id !== saved.id), saved],
        inventoryGeneration: scope.generation,
        inventoryComplete: sameScope && state.inventoryComplete,
        loaded: sameScope && state.loaded,
      };
    });
    // Refresh immediately for a snappy UI; the `agents:changed` broadcast is a
    // secondary safety net that also re-hydrates.
    await get().load();
    return saved;
  },

  remove: async (id: string): Promise<void> => {
    const scope = artifactInventoryScope();
    await window.agents.delete({ id });
    if (
      !scope.complete &&
      scope.generation !== artifactInventoryScope().generation
    )
      return;
    recordArtifactAgentRemoval(id);
    set((state) => ({
      agents: state.agents.filter((agent) => agent.id !== id),
    }));
    await get().load();
  },

  importShared: async (
    request: ImportSharedAgentRequest,
  ): Promise<ImportSharedAgentResponse> => {
    const imported = await window.agents.importShared(request);
    await get().load();
    return imported;
  },

  subscribe: (): (() => void) => {
    const changed = window.agents.onChanged(() => {
      void get().load();
    });
    const context = useWorkspaceContextStore.subscribe((state, previous) => {
      if (
        state.appliedGeneration !== previous.appliedGeneration &&
        useFeatureFlagsStore
          .getState()
          .isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key)
      )
        void get().load();
    });
    return (): void => {
      changed();
      context();
    };
  },
}));
