import { useEffect, useLayoutEffect } from 'react';
import { subscribeChatCreationsInSession } from '@/stores/chat/created-in-session';
import { useProjectsStore } from '@/stores/projectsStore';
import { useOnboardingTipsStore } from '@canopy/app-state';
import { subscribeHomeTaskSends } from './homeSendEvents';
import { normalizeOnboardingTipDismissals } from '@canopy/protocol/onboarding-tips';

/**
 * Keeps the shared tip queue (CAN-4904) in step with the stored dismissals:
 * a tip dismissed in a Portal session, or in another window, leaves this one
 * when the desktop broadcasts its synced preferences.
 */
export function OnboardingTipsPreferencesBridge(): null {
  const noteCreated = useOnboardingTipsStore(
    (state) => state.noteWorktreeChatCreated,
  );
  useLayoutEffect(
    () =>
      subscribeChatCreationsInSession((creation) => {
        if (
          !useProjectsStore
            .getState()
            .projects.some(
              (project) =>
                project.id === creation.projectId && project.type !== 'cowork',
            )
        )
          return;
        noteCreated(
          {
            workspaceLocalId: creation.projectId,
            worktreeLocalId: creation.worktreeId,
            chatId: creation.chatId,
          },
          creation.confirmation,
        );
      }),
    [noteCreated],
  );
  const sync = useOnboardingTipsStore((state) => state.sync);
  const noteTurnSent = useOnboardingTipsStore((state) => state.noteTurnSent);
  useEffect(
    () =>
      subscribeHomeTaskSends((event) => {
        // ChatInput reports its own acceptance. Home has no tab composer; its
        // existing dispatch signal covers standalone and new-worktree sends.
        if (
          event.kind === 'chat' &&
          event.chatId === undefined &&
          event.acceptedTurn === true
        )
          noteTurnSent({ worktreeChat: event.worktreeChat === true });
      }),
    [noteTurnSent],
  );
  useEffect(
    () =>
      window.api.onPreferencesSynced((preferences) => {
        sync(
          normalizeOnboardingTipDismissals(preferences.onboardingTipsDismissed),
        );
      }),
    [sync],
  );
  return null;
}
