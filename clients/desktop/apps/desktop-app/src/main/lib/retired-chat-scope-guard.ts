import {
  isRetiredPlanChatScope,
  RETIRED_PLAN_CHAT_MESSAGE,
} from '@canopy/desktop-shared/lib/retired-chat-scopes';

/** A turn was refused because its chat scope no longer accepts turns. */
export class RetiredChatScopeError extends Error {
  constructor() {
    super(RETIRED_PLAN_CHAT_MESSAGE);
    this.name = 'RetiredChatScopeError';
  }
}

/**
 * Refuse a turn for a retired chat scope (a legacy plan chat) before any of
 * its state is read or written. Every main-side send funnel calls this, so
 * the portal, automations, resumes and queue drains are refused too, not
 * only the renderer's composer.
 */
export function assertChatScopeAcceptsTurns(projectId: string): void {
  if (isRetiredPlanChatScope(projectId)) throw new RetiredChatScopeError();
}
