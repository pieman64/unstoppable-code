import type { CoreSummaryScheduleHost } from '@canopy/core-runtime/node/summary';
import { hasActiveChatTurnsForWorktree } from '../agents/session-manager';
import { DESKTOP_SUMMARY_PUBLICATION_HOST } from '../ledger/summary-publication';
import { isE2eBuild } from '../lib/e2e-gate';
import { logMainProcessWarn } from '../lib/main-process-logging';

/** The desktop host facts and generation for the core summary schedule (CAN-4114). */
export function createDesktopSummaryScheduleHost(): CoreSummaryScheduleHost {
  return {
    // Under the UI-automation/E2E build, never auto-schedule worktree-summary
    // generation: it fires a debounced background LLM helper turn that would
    // mutate the summary panel mid-test. Build-gated, so production is
    // unaffected.
    isAutomaticSchedulingEnabled: () => !isE2eBuild(),
    cadence: () =>
      DESKTOP_SUMMARY_PUBLICATION_HOST.isEnabled() ? 'ledger' : 'debounce',
    hasActiveTurns: (scope) =>
      hasActiveChatTurnsForWorktree(scope.workspaceId, scope.worktreeId),
    now: () => Date.now(),
    setTimer: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      return { cancel: () => clearTimeout(timer) };
    },
    generate: async (scope, mode, signal) =>
      (
        await import('../lib/worktree-summary-scheduler')
      ).generateDesktopWorktreeSummary(
        scope.workspaceId,
        scope.worktreeId,
        mode,
        signal,
      ),
    onError: (error, context) =>
      logMainProcessWarn(`[summary-schedule] ${context} failed`, error),
  };
}
