import type { AgentSentSender, AgentSentSenderOpener } from '@canopy/ui-shared';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { isArchivedChat } from '@/lib/chat-archive-status';
import { navigateToUnreadChat } from '@/stores/chat/notifications';

function isAppAdvisor(sender: AgentSentSender): boolean {
  return sender.kind === 'bot' && sender.botId === 'app_advisor';
}

/**
 * Opens the sender's chat, or, once it is archived, its transcript read-only.
 * A pipeline sender has no chat to open.
 */
export async function openSender(sender: AgentSentSender): Promise<void> {
  if (sender.kind === 'pipeline') return;
  const target = {
    projectId:
      sender.kind === 'project' ? sender.projectId : APP_ADVISOR_PROJECT_ID,
    worktreeId: sender.taskId,
    chatId: sender.chatId,
  };
  const archived =
    sender.kind === 'project' && (await isArchivedChat(target, target.chatId));
  await navigateToUnreadChat({
    ...target,
    ...(archived ? { openArchivedTranscript: true } : {}),
  });
}

function open(sender: AgentSentSender): void {
  void openSender(sender);
}

/** The main window opens a project sender in place and App Advisor in its window. */
export const mainWindowSenderOpener: AgentSentSenderOpener = {
  canOpen: (sender) => sender.kind === 'project' || isAppAdvisor(sender),
  open,
};

/**
 * The App Advisor window opens only its own chats.
 * shortcut: project senders need an App Advisor to main window navigation
 * bridge; add one when the Advisor window should open project chats.
 */
export const appAdvisorWindowSenderOpener: AgentSentSenderOpener = {
  canOpen: isAppAdvisor,
  open,
};
