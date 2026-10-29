import {
  getTerminalReadOnlyMessage as getSharedTerminalReadOnlyMessage,
  type TerminalSessionStateLike,
} from '@canopy/app-state/terminal';
import { brandText } from '@/lib/brand';
export {
  endedByAppShutdown,
  endedByWorktreeCleanup,
  endedByCanopyManagedCleanup,
  isIntentionalTerminalShutdown,
  normalizeTerminalExitSignal,
  isTerminalRestorableSession,
  isTerminalRestartableSession,
  getTerminalListStateLabel,
} from '@canopy/app-state/terminal';
export function getTerminalReadOnlyMessage(
  session: TerminalSessionStateLike,
): string | null {
  return getSharedTerminalReadOnlyMessage(session, brandText.appName);
}
