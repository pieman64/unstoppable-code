import {
  WORKER_FILESYSTEM_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import type {
  FileTreeMutationRequest,
  FileTreeMutationResponse,
} from '@canopy/desktop-shared/types';
import {
  getActiveDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { isSplitLocked } from '../services/split-lock-service';
import type { AdvisorFileTreeActionHost } from './advisor-file-tree-actions';

/**
 * The explorer's `file-tree:mutate` owners in main, as the advisor chat with
 * only `worker.filesystem.write` (CAN-6006). The worker keeps every path
 * inside the worktree's file roots.
 */
export function mainAdvisorFileTreeActionHost(options: {
  chatId: string;
  runtime?: () => DesktopCanopyDispatcher;
}): AdvisorFileTreeActionHost {
  const runtime = options.runtime ?? getActiveDesktopRuntime;
  const caller: CanopyCallerDescriptor = {
    principalId: 'local-desktop-user',
    clientInstanceId: `agent-action:${options.chatId}`,
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'mcp',
    grants: [WORKER_FILESYSTEM_GRANTS.write],
  };
  return {
    isSplitLocked,
    mutate: (
      request: FileTreeMutationRequest,
    ): Promise<FileTreeMutationResponse> => {
      const dispatcher = runtime();
      switch (request.operation) {
        case 'create-file':
        case 'create-directory':
          return dispatcher.createFileTreeEntryForLegacyIpc(request, {
            caller,
          });
        case 'copy':
        case 'move':
          return dispatcher.transferFileTreeEntryForLegacyIpc(request, {
            caller,
          });
        case 'delete':
          return dispatcher.deleteFileTreeEntryForLegacyIpc(request, {
            caller,
          });
      }
    },
  };
}
