import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
  createCoreWorkspaceInstructionsHandlers,
  type CoreWorkspaceInstructionsHandlers,
  type CoreWorkspaceInstructionsHost,
} from '@canopy/core-runtime/node/workspace/workspace-instructions';
import { IdentifierValidationError } from '../lib/identifier-validation-error';
import {
  loadWorkspaceClaudeMd,
  saveWorkspaceClaudeMd,
} from '../lib/workspace-claude-md';

/** Existing update-telemetry sources: Portal saves, and every other editor. */
export function workspaceInstructionsTelemetrySource(
  caller: Pick<CanopyCallerDescriptor, 'interfaceKind'>,
): string {
  return caller.interfaceKind === 'portal' ? 'portal' : 'claude_md';
}

export const desktopWorkspaceInstructionsHost: CoreWorkspaceInstructionsHost = {
  read: loadWorkspaceClaudeMd,
  write: (workspaceId, content, caller) =>
    saveWorkspaceClaudeMd(
      workspaceId,
      content,
      workspaceInstructionsTelemetrySource(caller),
    ),
  isInvalidWorkspaceId: (error) => error instanceof IdentifierValidationError,
};

/** `core.workspace.instructions.*` handlers over the desktop host modules. */
export function createCoreWorkspaceInstructionsAdapter(
  host: CoreWorkspaceInstructionsHost = desktopWorkspaceInstructionsHost,
): CoreWorkspaceInstructionsHandlers {
  return createCoreWorkspaceInstructionsHandlers(host);
}
