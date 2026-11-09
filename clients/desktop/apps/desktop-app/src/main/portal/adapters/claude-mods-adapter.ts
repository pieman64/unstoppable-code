import {
  parseClaudeModsGetArgs,
  parseClaudeModsUpdate,
} from '@canopy/protocol/claude-mods';
import type { PortalCommandEnvelope } from '@canopy/desktop-shared/types';
import { broadcastCommittedPreferences } from '../../ipc/preferences';
import {
  getClaudeModsState,
  updateClaudeModsState,
} from '../../lib/claude-mod-admission-service';
import type { PortalAdapterContext } from './types';
import { failServiceError } from './validation';

export async function handlePortalClaudeModsGet(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  const args = parseClaudeModsGetArgs(command.payload);
  if (args === null) {
    context.fail(command, 'invalid_payload', 'Invalid Claude Mod get payload.');
    return;
  }
  try {
    const state = await getClaudeModsState(args);
    context.complete(command, state);
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalClaudeModsUpdate(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  const update = parseClaudeModsUpdate(command.payload);
  if (update === null) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid Claude Mod update payload.',
    );
    return;
  }
  try {
    // A typed refusal (including flag-off) is still a completed command.
    const result = await updateClaudeModsState(
      update,
      broadcastCommittedPreferences,
    );
    context.complete(command, result);
  } catch (error) {
    failServiceError(command, context, error);
  }
}
