/**
 * Remote Control projection of canonical turn timers (phase 35c5c). Once
 * canonical turn state owns root turns, each acknowledged turn-state commit
 * projects its committed timer rows onto the portal stream of the chat's
 * host, in place of the hosts' own timer machines (contracts §8).
 */
import {
  APP_ADVISOR_PROJECT_ID,
  type PortalEventEnvelope,
} from '@canopy/desktop-shared/types';
import { getChatStateService } from '../services/chat-state-service';
import { projectCanonicalPortalTurnTimers } from '../services/chat-transcript-projector';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import { logMainProcessError } from '../lib/main-process-logging';
import { createPortalEvent } from './portal-event-bus';

export function subscribePortalCanonicalTurnTimers(
  emit: (event: PortalEventEnvelope) => void,
): () => void {
  const service = getChatStateService();
  return service.onTurnStateCommitted((commit): void => {
    try {
      const { projectId, worktreeId, chatId } = commit.scope;
      const scope =
        projectId === APP_ADVISOR_PROJECT_ID
          ? 'app_advisor'
          : isCoworkWorkspace(projectId)
            ? 'standalone'
            : 'worktree';
      const messages = projectCanonicalPortalTurnTimers({
        scope,
        chatId,
        effects: commit.effects ?? [],
        timerMessages: commit.timerMessages ?? [],
        ...(commit.autoRoutedModels
          ? { autoRoutedModels: commit.autoRoutedModels }
          : {}),
      });
      for (const message of messages)
        emit(
          scope === 'app_advisor'
            ? createPortalEvent('portal.app_advisor.event', { chatId, message })
            : scope === 'standalone'
              ? createPortalEvent('portal.chat.event', {
                  scope,
                  projectLocalId: projectId,
                  projectId,
                  workEntryId: worktreeId,
                  chatId,
                  message,
                })
              : createPortalEvent('portal.chat.event', {
                  scope,
                  workspaceLocalId: projectId,
                  worktreeLocalId: worktreeId,
                  chatId,
                  message,
                }),
        );
    } catch (error: unknown) {
      logMainProcessError(
        'Portal canonical turn timer projection failed',
        error,
      );
    }
  });
}
