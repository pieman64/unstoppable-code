import {
  IPC_CHANNELS,
  type DeleteWorktreePanelLayoutRequest,
  type InitializeWorktreeModeRequest,
  type InitializeWorktreeModeResponse,
  type LoadDefaultPanelLayoutRequest,
  type LoadDefaultPanelLayoutResponse,
  type LoadWorktreeModeRequest,
  type LoadWorktreeModeResponse,
  type LoadWorktreePanelLayoutRequest,
  type LoadWorktreePanelLayoutResponse,
  type PanelLayoutApi,
  type SaveDefaultPanelLayoutRequest,
  type SaveWorktreeModeRequest,
  type SaveWorktreePanelLayoutRequest,
} from '@canopy/desktop-shared/types';

interface PanelLayoutIpc {
  invoke(
    channel: typeof IPC_CHANNELS.panelLayoutLoad,
    request: LoadWorktreePanelLayoutRequest,
  ): Promise<LoadWorktreePanelLayoutResponse>;
  invoke(
    channel: typeof IPC_CHANNELS.panelLayoutSave,
    request: SaveWorktreePanelLayoutRequest,
  ): Promise<void>;
  invoke(
    channel: typeof IPC_CHANNELS.panelLayoutDelete,
    request: DeleteWorktreePanelLayoutRequest,
  ): Promise<void>;
  invoke(
    channel: typeof IPC_CHANNELS.panelLayoutLoadMode,
    request: LoadWorktreeModeRequest,
  ): Promise<LoadWorktreeModeResponse>;
  invoke(
    channel: typeof IPC_CHANNELS.panelLayoutInitializeMode,
    request: InitializeWorktreeModeRequest,
  ): Promise<InitializeWorktreeModeResponse>;
  invoke(
    channel: typeof IPC_CHANNELS.panelLayoutSaveMode,
    request: SaveWorktreeModeRequest,
  ): Promise<void>;
  invoke(
    channel: typeof IPC_CHANNELS.panelLayoutSaveDefault,
    request: SaveDefaultPanelLayoutRequest,
  ): Promise<void>;
  invoke(
    channel: typeof IPC_CHANNELS.panelLayoutLoadDefault,
    request: LoadDefaultPanelLayoutRequest,
  ): Promise<LoadDefaultPanelLayoutResponse>;
}

/** Build the narrow panel-layout bridge against an injectable IPC seam. */
export function createPanelLayoutApi(ipc: PanelLayoutIpc): PanelLayoutApi {
  return {
    loadWorktreeLayout: (request) =>
      ipc.invoke(IPC_CHANNELS.panelLayoutLoad, request),
    saveWorktreeLayout: async (request): Promise<void> => {
      await ipc.invoke(IPC_CHANNELS.panelLayoutSave, request);
    },
    deleteWorktreeLayout: async (request): Promise<void> => {
      await ipc.invoke(IPC_CHANNELS.panelLayoutDelete, request);
    },
    loadWorktreeMode: (request) =>
      ipc.invoke(IPC_CHANNELS.panelLayoutLoadMode, request),
    initializeWorktreeMode: (request) =>
      ipc.invoke(IPC_CHANNELS.panelLayoutInitializeMode, request),
    saveWorktreeMode: async (request): Promise<void> => {
      await ipc.invoke(IPC_CHANNELS.panelLayoutSaveMode, request);
    },
    saveDefaultLayout: async (request): Promise<void> => {
      await ipc.invoke(IPC_CHANNELS.panelLayoutSaveDefault, request);
    },
    loadDefaultLayout: (request) =>
      ipc.invoke(IPC_CHANNELS.panelLayoutLoadDefault, request),
  };
}
