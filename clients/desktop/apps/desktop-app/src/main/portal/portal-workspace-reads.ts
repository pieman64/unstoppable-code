import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import type {
  SidebarItemsFile,
  WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import { CanopyOperationError } from '@canopy/core-runtime';
import { getDesktopCanopyRuntime } from '../canopy-runtime/desktop-runtime-access';
import { getCanopyPortalState } from './portal-session-manager';
import { createPortalCaller } from './portal-caller';

async function preserveLegacyError<Result>(
  operation: Promise<Result>,
): Promise<Result> {
  try {
    return await operation;
  } catch (error) {
    if (
      error instanceof CanopyOperationError &&
      error.runtimeCause instanceof Error
    ) {
      throw error.runtimeCause;
    }
    throw error;
  }
}

function caller(
  grants: CanopyCallerDescriptor['grants'],
): CanopyCallerDescriptor {
  const sessionId = getCanopyPortalState().sessionId;
  if (!sessionId) throw new Error('Portal session is not active.');
  return createPortalCaller({ sessionId }, grants);
}

export async function readPortalSidebarItems(): Promise<SidebarItemsFile> {
  const runtime = getDesktopCanopyRuntime();
  const { legacyResult } = await preserveLegacyError(
    runtime.queryWorkspaceListForLegacyIpc(
      {},
      {
        caller: caller(['core.workspace.read']),
      },
    ),
  );
  return legacyResult;
}

export async function readPortalWorkspace(
  workspaceId: string,
): Promise<WorkspaceConfigFile> {
  const runtime = getDesktopCanopyRuntime();
  const { legacyResult } = await preserveLegacyError(
    runtime.queryWorkspaceGetForLegacyIpc(
      { workspaceId },
      {
        caller: caller(['core.workspace.read']),
      },
    ),
  );
  return legacyResult;
}
