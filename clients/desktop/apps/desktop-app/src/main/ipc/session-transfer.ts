import type { BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  type ChatSessionCloudExportDeleteRequest,
  type ChatSessionCloudExportDeleteResponse,
  type ChatSessionCloudExportListRequest,
  type ChatSessionCloudExportListResponse,
  type ChatSessionExportRequest,
  type ChatSessionExportResponse,
  type ChatSessionImportDiscardRequest,
  type ChatSessionImportDiscardResponse,
  type ChatSessionImportInspectRequest,
  type ChatSessionImportInspectResponse,
  type ChatSessionImportRequest,
  type ChatSessionImportResponse,
} from '@canopy/desktop-shared/types';
import {
  deleteSessionExport,
  discardStagedSessionImport,
  exportChatSession,
  importChatSession,
  inspectChatSessionImport,
  listSessionExports,
} from '../lib/session-transfer';
import { validateId } from '../lib/validation';
import { registerIpcHandler } from './register';

export function registerSessionTransferHandlers(
  getWindow: () => BrowserWindow | null,
): void {
  registerIpcHandler<[ChatSessionExportRequest], ChatSessionExportResponse>(
    IPC_CHANNELS.chatSessionExport,
    async (_event, request) => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      validateId(request.chatId, 'chatId');
      return exportChatSession(request);
    },
  );

  registerIpcHandler<
    [ChatSessionCloudExportListRequest],
    ChatSessionCloudExportListResponse
  >(IPC_CHANNELS.chatSessionCloudExportList, async (_event, request) => {
    return listSessionExports(request);
  });

  registerIpcHandler<
    [ChatSessionCloudExportDeleteRequest],
    ChatSessionCloudExportDeleteResponse
  >(IPC_CHANNELS.chatSessionCloudExportDelete, async (_event, request) => {
    validateId(request.exportId, 'exportId');
    return deleteSessionExport(request.exportId);
  });

  registerIpcHandler<
    [ChatSessionImportInspectRequest],
    ChatSessionImportInspectResponse
  >(IPC_CHANNELS.chatSessionImportInspect, async (_event, request) => {
    validateId(request.workspaceId, 'workspaceId');
    validateId(request.exportId, 'exportId');
    return inspectChatSessionImport(request);
  });

  registerIpcHandler<[ChatSessionImportRequest], ChatSessionImportResponse>(
    IPC_CHANNELS.chatSessionImport,
    async (_event, request) => {
      validateId(request.workspaceId, 'workspaceId');
      validateId(request.exportId, 'exportId');
      return importChatSession(request, getWindow);
    },
  );

  registerIpcHandler<
    [ChatSessionImportDiscardRequest],
    ChatSessionImportDiscardResponse
  >(IPC_CHANNELS.chatSessionImportDiscard, async (_event, request) => {
    validateId(request.exportId, 'exportId');
    await discardStagedSessionImport(request.exportId);
    return { discarded: true };
  });
}
