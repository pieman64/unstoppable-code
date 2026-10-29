import type {
  ChatEvent,
  ChatInterestDeclaration,
} from '@canopy/desktop-shared/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isChatEvent(value: unknown): value is ChatEvent {
  return (
    isRecord(value) &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    typeof value.chatId === 'string'
  );
}

type InterestKeys = ReadonlyMap<
  string,
  ReadonlyMap<string, ReadonlySet<string>>
>;

/** Build only when a window or remote session declares a new interest. */
export function chatInterestKeys(
  declaration: ChatInterestDeclaration,
): InterestKeys {
  const keys = new Map<string, Map<string, Set<string>>>();
  for (const chat of [...declaration.focused, ...declaration.warm]) {
    let worktrees = keys.get(chat.projectId);
    if (!worktrees) {
      worktrees = new Map();
      keys.set(chat.projectId, worktrees);
    }
    let chats = worktrees.get(chat.worktreeId);
    if (!chats) {
      chats = new Set();
      worktrees.set(chat.worktreeId, chats);
    }
    chats.add(chat.chatId);
  }
  return keys;
}

/** Pure, fail-open decision on one published raw event. */
export function shouldDropChatEvent(
  interestedChatKeys: InterestKeys | undefined,
  message: unknown,
): boolean {
  if (!interestedChatKeys || !isChatEvent(message)) return false;
  const data = message.data;
  if (!isRecord(data) || data.type === 'canopy_delegation') return false;
  const droppable =
    (data.type === 'codex' &&
      isRecord(data.event) &&
      data.event.type === 'item.updated') ||
    (data.type === 'stream_event' &&
      isRecord(data.event) &&
      data.event.type === 'content_block_delta' &&
      isRecord(data.event.delta) &&
      (data.event.delta.type === 'text_delta' ||
        data.event.delta.type === 'thinking_delta'));
  return (
    droppable &&
    !interestedChatKeys
      .get(message.projectId)
      ?.get(message.worktreeId)
      ?.has(message.chatId)
  );
}

/** Declaration-identity cache scoped to each receiving page or session. */
export class ChatEventInterestFilter {
  private readonly cache = new WeakMap<
    object,
    { declaration: ChatInterestDeclaration; keys: InterestKeys }
  >();

  shouldDrop(
    target: object,
    declaration: ChatInterestDeclaration | undefined,
    message: unknown,
  ): boolean {
    if (!declaration) return false;
    let cached = this.cache.get(target);
    if (cached?.declaration !== declaration) {
      cached = { declaration, keys: chatInterestKeys(declaration) };
      this.cache.set(target, cached);
    }
    return shouldDropChatEvent(cached.keys, message);
  }
}
