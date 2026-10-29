/**
 * IPC handlers for per-worktree panel-layout persistence (Phase 5).
 * Thin validation + dispatch onto the existing grid/default stores and the
 * injected mode-persistence contract. Persistence implementations own all
 * file shapes and write semantics.
 */
import {
  IPC_CHANNELS,
  isPanelLayoutSurface,
  isWorkspaceLayoutMode,
  type DeleteWorktreePanelLayoutRequest,
  type InitializeWorktreeModeRequest,
  type InitializeWorktreeModeResponse,
  type LoadDefaultPanelLayoutRequest,
  type LoadDefaultPanelLayoutResponse,
  type LoadWorktreeModeRequest,
  type LoadWorktreeModeResponse,
  type LoadWorktreePanelLayoutRequest,
  type LoadWorktreePanelLayoutResponse,
  type PanelLayoutSurface,
  type SaveDefaultPanelLayoutRequest,
  type SaveWorktreeModeRequest,
  type SaveWorktreeModeResponse,
  type SaveWorktreePanelLayoutRequest,
  type WorkspaceLayoutMode,
} from '@canopy/desktop-shared/types';
import { isWorkEntryWorkspace } from '../lib/workspace-registry';
import { validateId } from '../lib/validation';
import { defaultPanelLayoutStore } from '../panels/default-layout-persistence';
import { panelLayoutPersistenceStore } from '../panels/persistence';
import { registerIpcHandler } from './register';

export interface PanelLayoutModePersistence {
  load(
    projectId: string,
    worktreeId: string,
  ): Promise<WorkspaceLayoutMode | null>;
  initialize(
    projectId: string,
    worktreeId: string,
    mode: WorkspaceLayoutMode,
  ): Promise<WorkspaceLayoutMode>;
  save(
    projectId: string,
    worktreeId: string,
    mode: WorkspaceLayoutMode,
  ): Promise<void>;
}

const unconfiguredPanelLayoutModePersistence: PanelLayoutModePersistence = {
  load: () => Promise.reject(panelLayoutModePersistenceUnavailable()),
  initialize: () => Promise.reject(panelLayoutModePersistenceUnavailable()),
  save: () => Promise.reject(panelLayoutModePersistenceUnavailable()),
};

function panelLayoutModePersistenceUnavailable(): Error {
  return new Error('Panel layout mode persistence is not configured');
}

export function registerPanelLayoutHandlers(
  modePersistence: PanelLayoutModePersistence = unconfiguredPanelLayoutModePersistence,
): void {
  registerIpcHandler<
    [LoadWorktreePanelLayoutRequest],
    LoadWorktreePanelLayoutResponse
  >(
    IPC_CHANNELS.panelLayoutLoad,
    (_event, request): LoadWorktreePanelLayoutResponse => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      return {
        layout: panelLayoutPersistenceStore.loadWorktreeLayout(
          request.projectId,
          request.worktreeId,
        ),
      };
    },
  );

  registerIpcHandler<[SaveWorktreePanelLayoutRequest], void>(
    IPC_CHANNELS.panelLayoutSave,
    (_event, request): Promise<void> => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      panelLayoutPersistenceStore.saveWorktreeLayout(
        request.projectId,
        request.worktreeId,
        request.layout,
        request.hasUserChanges !== false,
      );
      if (request.hasUserChanges !== false) {
        return markWorkEntryCustomized(request.projectId, request.worktreeId);
      }
      return Promise.resolve();
    },
  );

  registerIpcHandler<[DeleteWorktreePanelLayoutRequest], void>(
    IPC_CHANNELS.panelLayoutDelete,
    (_event, request): void => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      panelLayoutPersistenceStore.deleteWorktreeLayout(
        request.projectId,
        request.worktreeId,
      );
    },
  );

  registerIpcHandler<[LoadWorktreeModeRequest], LoadWorktreeModeResponse>(
    IPC_CHANNELS.panelLayoutLoadMode,
    async (_event, request): Promise<LoadWorktreeModeResponse> => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      const mode = await modePersistence.load(
        request.projectId,
        request.worktreeId,
      );
      return { mode };
    },
  );

  registerIpcHandler<
    [InitializeWorktreeModeRequest],
    InitializeWorktreeModeResponse
  >(
    IPC_CHANNELS.panelLayoutInitializeMode,
    async (_event, request): Promise<InitializeWorktreeModeResponse> => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      const mode = await modePersistence.initialize(
        request.projectId,
        request.worktreeId,
        validateWorkspaceLayoutMode(request.mode),
      );
      return { mode };
    },
  );

  registerIpcHandler<[SaveWorktreeModeRequest], SaveWorktreeModeResponse>(
    IPC_CHANNELS.panelLayoutSaveMode,
    async (_event, request): Promise<SaveWorktreeModeResponse> => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      await modePersistence.save(
        request.projectId,
        request.worktreeId,
        validateWorkspaceLayoutMode(request.mode),
      );
      await markWorkEntryCustomized(request.projectId, request.worktreeId);
    },
  );

  registerIpcHandler<[SaveDefaultPanelLayoutRequest], void>(
    IPC_CHANNELS.panelLayoutSaveDefault,
    (_event, request): void => {
      defaultPanelLayoutStore.saveDefaultLayout(
        validatePanelLayoutSurface(request.surface),
        request.layout,
      );
    },
  );

  registerIpcHandler<
    [LoadDefaultPanelLayoutRequest],
    LoadDefaultPanelLayoutResponse
  >(
    IPC_CHANNELS.panelLayoutLoadDefault,
    (_event, request): LoadDefaultPanelLayoutResponse => ({
      layout: defaultPanelLayoutStore.loadDefaultLayout(
        validatePanelLayoutSurface(request.surface),
      ),
    }),
  );
}

function validatePanelLayoutSurface(value: unknown): PanelLayoutSurface {
  if (!isPanelLayoutSurface(value)) {
    throw new Error(`Invalid panel layout surface: ${String(value)}`);
  }
  return value;
}

function validateWorkspaceLayoutMode(value: unknown): WorkspaceLayoutMode {
  if (!isWorkspaceLayoutMode(value)) {
    throw new Error(`Invalid project layout mode: ${String(value)}`);
  }
  return value;
}

/** Existing unmigrated panel persistence owns these entry-local UI changes. */
async function markWorkEntryCustomized(
  projectId: string,
  entryId: string,
): Promise<void> {
  if (!isWorkEntryWorkspace(projectId)) return;
  const { updateWorkEntry } = await import('../lib/cowork-work-entries');
  await updateWorkEntry(projectId, entryId, { hasUserChanges: true });
}
