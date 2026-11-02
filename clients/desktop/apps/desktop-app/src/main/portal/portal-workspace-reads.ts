import {
  CORE_SCRIPT_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import type {
  ScriptSourceInfoRequest,
  ScriptSourceInfoResponse,
  SidebarItemsFile,
  WorkspaceAttachmentItem,
  WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import { getDesktopCanopyRuntime } from '../canopy-runtime/desktop-runtime-access';
import { getCanopyPortalState } from './portal-session-manager';
import { createPortalCaller } from './portal-caller';
import { preserveRuntimeCauseError } from '../canopy-runtime/runtime-cause-error';
import {
  readScriptSourceInfo,
  readWorkspaceScriptCommands,
} from '../lib/script-source-info';
import {
  getWorkspaceInstructions,
  updateWorkspaceInstructions,
} from '../canopy-runtime/workspace-instructions-dispatch';
import { listAttachmentsForIpc } from '../canopy-runtime/workspace-item-attachments-dispatch';

function caller(
  grants: CanopyCallerDescriptor['grants'],
): CanopyCallerDescriptor {
  const sessionId = getCanopyPortalState().sessionId;
  if (!sessionId) throw new Error('Portal session is not active.');
  return createPortalCaller({ sessionId }, grants);
}

export async function readPortalSidebarItems(): Promise<SidebarItemsFile> {
  const runtime = getDesktopCanopyRuntime();
  const { legacyResult } = await preserveRuntimeCauseError(
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
  const { legacyResult } = await preserveRuntimeCauseError(
    runtime.queryWorkspaceGetForLegacyIpc(
      { workspaceId },
      {
        caller: caller(['core.workspace.read']),
      },
    ),
  );
  return legacyResult;
}

/** `core.workspace.instructions.get` for the Portal workspace settings dialog. */
export function readPortalWorkspaceInstructions(
  workspaceId: string,
): Promise<string> {
  return getWorkspaceInstructions(
    getDesktopCanopyRuntime(),
    caller([]),
    workspaceId,
  );
}

/** `core.workspace.instructions.update`; records `portal` update telemetry. */
export function writePortalWorkspaceInstructions(
  workspaceId: string,
  content: string,
): Promise<void> {
  return updateWorkspaceInstructions(
    getDesktopCanopyRuntime(),
    caller([]),
    workspaceId,
    content,
  );
}

/** `portal.script.source_info` through `core.script.definition.get`. */
export function readPortalScriptSourceInfo(
  request: ScriptSourceInfoRequest,
): Promise<ScriptSourceInfoResponse> {
  return readScriptSourceInfo(
    getDesktopCanopyRuntime(),
    caller([CORE_SCRIPT_GRANTS.read]),
    request,
  );
}

/** `portal.workspace.scripts.get` through `core.script.definition.list`. */
export function readPortalWorkspaceScriptCommands(
  workspaceId: string,
): Promise<Record<string, string>> {
  return readWorkspaceScriptCommands(
    getDesktopCanopyRuntime(),
    caller([CORE_SCRIPT_GRANTS.read]),
    workspaceId,
  );
}

/** `portal.workspace_items.list_attachments` through `core.workspace.item.list`. */
export function listPortalWorkspaceAttachments(
  projectId: unknown,
  worktreeId: unknown,
): Promise<WorkspaceAttachmentItem[]> {
  return listAttachmentsForIpc(
    getDesktopCanopyRuntime(),
    caller([]),
    projectId,
    worktreeId,
  );
}
