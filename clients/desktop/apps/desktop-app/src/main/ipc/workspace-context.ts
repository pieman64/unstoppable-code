import { BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  isWorkspaceContext,
  type SetWorkspaceContextRequest,
  type WorkspaceContextState,
} from '@canopy/desktop-shared/types';
import { validateId } from '../lib/validation';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import { registerIpcHandler } from './register';
import { sendToWebContents } from '../lib/web-contents-send';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSetRequest(value: unknown): SetWorkspaceContextRequest {
  if (!isRecord(value) || !isWorkspaceContext(value.context)) {
    throw new Error('Invalid workspace context.');
  }
  if (value.context.kind === 'organization') {
    validateId(value.context.organizationId, 'organization id');
  }
  const { expectedRevision } = value;
  if (expectedRevision === undefined) {
    return { context: value.context };
  }
  if (
    typeof expectedRevision !== 'number' ||
    !Number.isInteger(expectedRevision) ||
    expectedRevision < 0
  ) {
    throw new Error('Invalid workspace context revision.');
  }
  return { context: value.context, expectedRevision };
}

export function registerWorkspaceContextHandlers(): void {
  const service = getWorkspaceContextService();

  service.subscribe((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        sendToWebContents(
          window.webContents,
          IPC_CHANNELS.workspaceContextChanged,
          state,
        );
      }
    }
  });

  registerIpcHandler<[], WorkspaceContextState>(
    IPC_CHANNELS.workspaceContextGet,
    () => Promise.resolve(service.getState()),
  );

  registerIpcHandler<[unknown], WorkspaceContextState>(
    IPC_CHANNELS.workspaceContextSet,
    async (_event, request) => {
      const parsed = parseSetRequest(request);
      return service.setContext(parsed.context, parsed.expectedRevision);
    },
  );
}
