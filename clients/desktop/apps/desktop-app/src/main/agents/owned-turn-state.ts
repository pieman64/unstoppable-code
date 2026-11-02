import {
  getSessionKeyOwnership,
  markTurnActive,
  markTurnAwaitingUser,
  markTurnIdle,
  noteSessionMessageQueued,
  recordSessionEvent,
} from './session-manager';
import type { AgentSession } from './types';

/**
 * One provider session instance's key-scoped turn bookkeeping. A registration
 * can displace an instance whose turn is still ending; the key's turn
 * identity, wake lock and activity are then its successor's, so these calls
 * act only while this instance is the key's registered session.
 */
export interface OwnedTurnState {
  markTurnActive(userMessageId?: string): void;
  markTurnIdle(): void;
  markTurnAwaitingUser(): void;
  recordSessionEvent(data: unknown): void;
  noteSessionMessageQueued(pendingMessageCount: number): void;
  /**
   * False once another instance registered under the key: key-scoped
   * resources such as proxy routes are then the successor's to release.
   */
  ownsKeyResources(): boolean;
}

/** `getSession` is read per call, so it may close over a later declaration. */
export function createOwnedTurnState(
  key: string,
  getSession: () => AgentSession,
): OwnedTurnState {
  const registered = (): boolean =>
    getSessionKeyOwnership(key, getSession()) === 'registered';
  return {
    markTurnActive(userMessageId?: string): void {
      if (registered()) markTurnActive(key, userMessageId);
    },
    markTurnIdle(): void {
      if (registered()) markTurnIdle(key);
    },
    markTurnAwaitingUser(): void {
      if (registered()) markTurnAwaitingUser(key);
    },
    recordSessionEvent(data: unknown): void {
      if (registered()) recordSessionEvent(key, data);
    },
    noteSessionMessageQueued(pendingMessageCount: number): void {
      if (registered()) noteSessionMessageQueued(key, pendingMessageCount);
    },
    ownsKeyResources(): boolean {
      return getSessionKeyOwnership(key, getSession()) !== 'replaced';
    },
  };
}
