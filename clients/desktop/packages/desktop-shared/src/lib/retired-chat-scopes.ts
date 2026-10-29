// Chat scopes that keep their data but no longer accept turns. The retired
// Plan Explore takeover's dedicated plan chats live in the plan-explore
// sentinel scope: plans are discussed in their worktree's ordinary chats, so
// a legacy plan chat stays readable and is reclaimed with its plan, but
// every send path refuses it (the renderer before persisting anything, main
// at each dispatch funnel).
import { PLAN_EXPLORE_CHAT_PROJECT_ID } from '../types';

/** Shown when anything tries to start a turn in a legacy plan chat. */
export const RETIRED_PLAN_CHAT_MESSAGE =
  'This plan chat is no longer available.';

/** The retired plan-explore chat scope: legacy data only, never a new turn. */
export function isRetiredPlanChatScope(projectId: string): boolean {
  return projectId === PLAN_EXPLORE_CHAT_PROJECT_ID;
}
