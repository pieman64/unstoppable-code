import {
  isScriptActionsContext,
  isScriptActionsReceiptRequest,
} from '@canopy/protocol/script-actions';
import { scriptActionsService } from '../../services/script-actions-host';
import {
  dispatchScriptActionsOperation,
  validScriptActionsRequest,
  type ScriptActionsOperation,
} from '../../services/script-actions-operations';
import type { PortalCommandAdapter } from './types';
/** Uses the existing authenticated Portal session and explicit workspace routing target. */
export function createPortalScriptActionsAdapter(
  operation: ScriptActionsOperation,
): PortalCommandAdapter {
  return async (command, context) => {
    if (
      !(
        isScriptActionsContext(command.payload) ||
        (operation === 'receipt' &&
          isScriptActionsReceiptRequest(command.payload))
      ) ||
      !validScriptActionsRequest(operation, command.payload)
    ) {
      context.fail(
        command,
        'invalid_payload',
        'Invalid script action request.',
      );
      return;
    }
    if (
      !context.sessionId ||
      command.target?.workspaceLocalId !== command.payload.projectId ||
      command.target?.worktreeLocalId !== command.payload.worktreeId
    ) {
      context.fail(
        command,
        'invalid_target',
        'Script action context must match the authorized target.',
      );
      return;
    }
    const result = await dispatchScriptActionsOperation(
      scriptActionsService,
      operation,
      command.payload,
    );
    if (result.ok) context.complete(command, result.value);
    else context.fail(command, result.error.code, result.error.message, false);
  };
}
