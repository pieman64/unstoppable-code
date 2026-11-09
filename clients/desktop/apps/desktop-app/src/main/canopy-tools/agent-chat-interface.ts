import { randomUUID } from 'node:crypto';
import { BRAND } from '@canopy/brand/current';
import type { AppAdvisorAction } from '@canopy/desktop-shared/types';
import { getSessionInterfaceToolRegistry } from '../agents/interface-tool-binding';
import { routeRendererToolRequest } from '../ipc/app-advisor';

/** The model-visible texts of the CAN-5830 interface guard (tests import them). */
export const AGENT_CHAT_INTERFACE_TEXTS = Object.freeze({
  needsWindow: `Starting a chat in a new worktree needs the ${BRAND.displayName} window open. Open the app and try again.`,
});

/**
 * CAN-5830 D9: whether a person can see this chat's work, so an agent may
 * create a worktree or prompt a new agent from it. True while the main
 * window's interface lease serves its presentation tool, or while another
 * computer drives the chat. Headless, both refuse, as they did when they ran
 * in the renderer.
 */
export function agentChatInterfacePresent(chat: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  action: AppAdvisorAction;
}): boolean {
  const live = getSessionInterfaceToolRegistry()?.available().toolNames ?? [];
  if (live.includes('ui.app_advisor.present')) return true;
  return (
    routeRendererToolRequest({
      kind: 'dispatch_action',
      requestId: randomUUID(),
      action: chat.action,
      originProjectId: chat.projectId,
      originWorktreeId: chat.worktreeId,
      originChatTabId: chat.chatId,
    }) !== null
  );
}
