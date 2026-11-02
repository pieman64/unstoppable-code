import { subscribeAcceptedWorktreeTurns } from '@/components/onboarding-tips/homeSendEvents';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';

export interface PresentationMilestoneCallbacks {
  /** Navigation or worktree selection changed: the user is busy. */
  readonly onInteraction: () => void;
  /** A return to Home after leaving it, or an accepted user send. */
  readonly onMilestone: () => void;
  readonly onAcceptedTurn: () => void;
  readonly watchAcceptedTurns: boolean;
}

/**
 * Watches the navigation and send signals behind release-highlights idle
 * milestones (CAN-5006). Accepted sends come from the composer seam in
 * `homeSendEvents.ts`: only live worktree dispatch acceptance from ChatInput and
 * Home, never hydration, replay, schedules, blank creation, or chat switches.
 * Standalone/cowork sends remain outside this milestone; Home return offers a
 * milestone. Each navigation change is reported as an interaction before any
 * milestone it carries, so a return to Home always arrives after its own
 * deferral.
 */
export function watchPresentationMilestones(
  callbacks: PresentationMilestoneCallbacks,
): () => void {
  const unsubscribeNavigation = useNavigationStore.subscribe(
    (state, previous): void => {
      if (state.activePage === previous.activePage) return;
      callbacks.onInteraction();
      if (state.activePage === 'home') callbacks.onMilestone();
    },
  );
  const unsubscribeSelection = useChatStore.subscribe(
    (state, previous): void => {
      const next = state.selectedWorktree;
      const prior = previous.selectedWorktree;
      if (
        next === prior ||
        (next?.projectId === prior?.projectId &&
          next?.worktreeId === prior?.worktreeId)
      )
        return;
      callbacks.onInteraction();
    },
  );
  let unsubscribeSends = (): void => undefined;
  if (callbacks.watchAcceptedTurns) {
    unsubscribeSends = subscribeAcceptedWorktreeTurns((): void => {
      unsubscribeSends();
      // Acceptance itself is not user input. The first accepted turn is
      // consumed even if it precedes the first interaction/deferral.
      callbacks.onAcceptedTurn();
    });
  }
  return (): void => {
    unsubscribeNavigation();
    unsubscribeSelection();
    unsubscribeSends();
  };
}
