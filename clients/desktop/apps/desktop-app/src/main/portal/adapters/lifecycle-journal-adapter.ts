import type { PortalCommandEnvelope } from '@canopy/desktop-shared/types';
import {
  inspectLifecycleJournal,
  LifecycleJournalQuarantineRefusedError,
  quarantineLifecycleJournalEntry,
} from '../../lib/w5-lifecycle-journal-quarantine';
import type { PortalAdapterContext } from './types';
import { logMainProcessWarn } from '../../lib/main-process-logging';
import { failServiceError } from './validation';

const INSPECT_FAILED = "Couldn't review the operation records. Try again.";

/**
 * CAN-5335 user-only gate (Q6 A): only a paired person's browser session may
 * inspect or move an unreadable journal entry; agent provenance is refused.
 */
function refuseNonUser(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): boolean {
  if (context.origin === undefined && context.sessionId) return false;
  context.fail(
    command,
    'forbidden',
    'Only you can review or move an unreadable operation record.',
  );
  return true;
}

export async function handlePortalLifecycleJournalInspect(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  if (refuseNonUser(command, context)) return;
  try {
    context.complete(command, await inspectLifecycleJournal());
  } catch (error) {
    // The browser shows this copy; the underlying error can name host paths.
    logMainProcessWarn('W5 lifecycle journal inspection failed', { error });
    context.fail(command, 'execution_failed', INSPECT_FAILED);
  }
}

export async function handlePortalLifecycleJournalQuarantine(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  if (refuseNonUser(command, context)) return;
  try {
    context.complete(
      command,
      await quarantineLifecycleJournalEntry(command.payload),
    );
  } catch (error) {
    if (error instanceof LifecycleJournalQuarantineRefusedError) {
      context.fail(
        command,
        error.reason === 'missing' ? 'not_found' : 'execution_failed',
        error.message,
      );
      return;
    }
    failServiceError(command, context, error);
  }
}
