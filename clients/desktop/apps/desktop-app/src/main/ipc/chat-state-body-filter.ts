import type {
  ChatInterestDeclaration,
  ChatStateChange,
  ChatStateChangedEvent,
} from '@canopy/desktop-shared/types';
import { chatInterestKeys } from './chat-event-interest';

const interestKeys = new WeakMap<
  ChatInterestDeclaration,
  ReturnType<typeof chatInterestKeys>
>();

/** Pure, fail-open projection for one receiver, before its events are merged. */
export function filterChatStateBodies(
  declaration: ChatInterestDeclaration | undefined,
  event: ChatStateChangedEvent,
): ChatStateChangedEvent {
  // Only windows that declared they handle the marker; older builds fail open.
  if (declaration?.acceptsMessagesOmitted !== true) return event;
  let keys = interestKeys.get(declaration);
  if (!keys) {
    keys = chatInterestKeys(declaration);
    interestKeys.set(declaration, keys);
  }
  const interested = keys.get(event.projectId)?.get(event.worktreeId);
  let changes: ChatStateChange[] | undefined;
  let omitted: Set<string> | undefined;
  // tab.upserted may carry the newest page on creation/fork/restore; deliberately keep it.
  for (let index = 0; index < event.changes.length; index += 1) {
    const change = event.changes[index];
    if (
      (change.type === 'messages.replaced' ||
        (change.type === 'message.upserted' &&
          change.message.role !== 'user')) &&
      !interested?.has(change.chatId)
    ) {
      changes ??= event.changes.slice(0, index);
      omitted ??= new Set<string>();
      omitted.add(change.chatId);
    } else {
      changes?.push(change);
    }
  }
  if (!changes || !omitted) return event;
  const filtered = changes;
  omitted.forEach((chatId: string): void => {
    filtered.push({ type: 'messages.omitted', chatId });
  });
  return { ...event, changes: filtered };
}
