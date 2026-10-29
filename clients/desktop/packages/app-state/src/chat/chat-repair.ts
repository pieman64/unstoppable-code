import type { CanopyClient } from '@canopy/app-core';

export const CHAT_SEMANTIC_STALE_MS = 55_000;

export interface ChatRepairRequest {
  readonly chatId: string;
  readonly scope: 'worktree' | 'standalone' | 'app_advisor';
  readonly workspaceLocalId?: string;
  readonly worktreeLocalId?: string;
  readonly trigger: 'semantic';
  /** Release the consumed signature when transport dispatch does not queue. */
  readonly onDispatchFailure: () => void;
}

export type ChatRepairRequester = (
  request: ChatRepairRequest,
) => boolean | void;

const requesters = new WeakMap<CanopyClient, ChatRepairRequester>();

export function configureChatRepairRequester(
  client: CanopyClient,
  requester: ChatRepairRequester,
): void {
  requesters.set(client, requester);
}

export function removeChatRepairRequester(client: CanopyClient): void {
  requesters.delete(client);
}

export function hasChatRepairRequester(client: CanopyClient): boolean {
  return requesters.has(client);
}

export function requestChatRepair(
  client: CanopyClient,
  request: ChatRepairRequest,
): boolean {
  const requester = requesters.get(client);
  return requester ? requester(request) !== false : false;
}
