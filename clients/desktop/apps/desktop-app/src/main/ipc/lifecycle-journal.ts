import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  inspectLifecycleJournal,
  lifecycleJournalLocationLabel,
  quarantineLifecycleJournalEntry,
} from '../lib/w5-lifecycle-journal-quarantine';
import { registerIpcHandler } from './register';

const localLabel = (path: string): string =>
  lifecycleJournalLocationLabel(path);

/**
 * CAN-5335: the renderer is the user's own interface; no agent action binds
 * these (Q6 A). Quarantine validates its request itself. As the trusted host
 * adapter, it shows the local location; the Portal gets the portable label.
 */
export function registerLifecycleJournalHandlers(): void {
  registerIpcHandler(IPC_CHANNELS.lifecycleJournalInspect, () =>
    inspectLifecycleJournal(localLabel),
  );
  registerIpcHandler(
    IPC_CHANNELS.lifecycleJournalQuarantine,
    (_event, request: unknown) =>
      quarantineLifecycleJournalEntry(request, localLabel),
  );
}
