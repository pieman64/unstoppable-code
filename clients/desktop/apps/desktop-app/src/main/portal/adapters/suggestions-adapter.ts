import { parseSuggestionsUpdate } from '@canopy/protocol/suggestions';
import type { PortalCommandEnvelope } from '@canopy/desktop-shared/types';
import { broadcastCommittedPreferences } from '../../ipc/preferences';
import {
  readSuggestionsPreferences,
  updateSuggestionsPreferences,
} from '../../lib/suggestions-preferences';
import type { PortalAdapterContext } from './types';
import { failServiceError, isRecord } from './validation';

export async function handlePortalSuggestionsGet(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  if (!isRecord(command.payload) || Object.keys(command.payload).length !== 0) {
    context.fail(
      command,
      'invalid_payload',
      'Suggestions get requires an empty object.',
    );
    return;
  }
  try {
    context.complete(command, await readSuggestionsPreferences());
  } catch (error) {
    failServiceError(command, context, error);
  }
}
export async function handlePortalSuggestionsUpdate(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  const update = parseSuggestionsUpdate(command.payload);
  if (update === null) {
    context.fail(command, 'invalid_payload', 'Invalid suggestions update.');
    return;
  }
  try {
    const saved = await updateSuggestionsPreferences(update);
    broadcastCommittedPreferences(saved);
    context.complete(command, saved.suggestions);
  } catch (error) {
    failServiceError(command, context, error);
  }
}
