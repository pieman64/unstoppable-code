import {
  CORE_WORKSPACE_INSTRUCTIONS_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { validateId } from '../lib/validation';
import type { DesktopCanopyDispatcher } from './desktop-runtime';
import { preserveRuntimeCauseError } from './runtime-cause-error';

/*
 * The `core.workspace.instructions.*` projection shared by the
 * `workspace:*-claude-md` IPC handlers and the Portal `claude_md` commands.
 * Each call adds only the grant its operation requires.
 */

export type WorkspaceInstructionsDispatcher = Pick<
  DesktopCanopyDispatcher,
  'query' | 'instruction'
>;

// Validate before dispatch: the wire accepts any string, and a rejected
// params schema would replace the legacy identifier message.
export async function getWorkspaceInstructions(
  dispatcher: WorkspaceInstructionsDispatcher,
  caller: CanopyCallerDescriptor,
  workspaceId: unknown,
): Promise<string> {
  validateId(workspaceId, 'workspaceId');
  const { content } = await preserveRuntimeCauseError(
    dispatcher.query(
      'core.workspace.instructions.get',
      { workspaceId },
      {
        caller: {
          ...caller,
          grants: [CORE_WORKSPACE_INSTRUCTIONS_GRANTS.read],
        },
      },
    ),
  );
  return content;
}

export async function updateWorkspaceInstructions(
  dispatcher: WorkspaceInstructionsDispatcher,
  caller: CanopyCallerDescriptor,
  workspaceId: unknown,
  content: string,
): Promise<void> {
  validateId(workspaceId, 'workspaceId');
  await preserveRuntimeCauseError(
    dispatcher.instruction(
      'core.workspace.instructions.update',
      { workspaceId, content },
      {
        caller: {
          ...caller,
          grants: [CORE_WORKSPACE_INSTRUCTIONS_GRANTS.write],
        },
      },
    ),
  );
}
