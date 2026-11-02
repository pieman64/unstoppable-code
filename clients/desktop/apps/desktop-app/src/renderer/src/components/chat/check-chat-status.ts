import type { StuckAgentCheckResult } from '@canopy/ui-shared/components';
import type { CanonicalTurnConfirmation } from '@/stores/chat/turn-confirmation';

/**
 * Check status for the stuck-agent notice, answered from a fresh read of
 * canonical runtime rather than the tab's local status. A chat main reports
 * inactive is settled (and the tabs are verified so the composer catches up);
 * an unknown answer rejects, so the notice says it could not check.
 */
export async function checkChatStatus({
  confirmTurn,
  verifyStreamingTabs,
}: {
  confirmTurn: () => Promise<CanonicalTurnConfirmation>;
  verifyStreamingTabs: () => Promise<void>;
}): Promise<StuckAgentCheckResult> {
  const { state } = await confirmTurn();
  if (state === 'active') return 'running';
  if (state === 'inactive') {
    // The answer stands on the fresh read; verification only settles the tab.
    await verifyStreamingTabs().catch(() => undefined);
    return 'settled';
  }
  throw new Error('Canonical runtime could not be read for this chat.');
}
