import type {
  ChatEvent,
  ChatInterestDeclaration,
  ChatInterestRunRef,
} from '@canopy/desktop-shared/types';
import { validateId } from '../lib/validation';

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
type RunInterestKeys = ReadonlySet<string>;

function runInterestKey(run: ChatInterestRunRef): string {
  return JSON.stringify([
    run.projectId,
    run.worktreeId,
    run.chatId,
    run.delegationId,
    run.runGeneration,
  ]);
}

/** Return focused runs that were not part of the previous declaration. */
export function runsEnteringInterest(
  previous: ChatInterestDeclaration | undefined,
  next: ChatInterestDeclaration,
): ChatInterestRunRef[] {
  const nextRuns = next.focusedRuns;
  if (!Array.isArray(nextRuns) || nextRuns.length === 0) return [];

  const previousKeys = new Set(
    previous?.focusedRuns?.map(runInterestKey) ?? [],
  );
  const seen = new Set<string>();
  const entering: ChatInterestRunRef[] = [];
  for (const run of nextRuns) {
    const key = runInterestKey(run);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!previousKeys.has(key)) entering.push(run);
  }
  return entering;
}

function chatRunInterestKeys(
  declaration: ChatInterestDeclaration,
): RunInterestKeys | undefined {
  const runs = declaration.focusedRuns;
  if (!Array.isArray(runs)) return undefined;
  return new Set(runs.map(runInterestKey));
}

function isSafeEventId(value: unknown): value is string {
  try {
    validateId(value, 'chat event id');
    return true;
  } catch {
    return false;
  }
}

function liveDetailRunKey(message: ChatEvent): string | undefined {
  const data = message.data;
  if (
    !isRecord(data) ||
    data.type !== 'canopy_delegation' ||
    data.delivery !== 'live' ||
    data.liveClass !== 'detail'
  ) {
    return undefined;
  }
  const delegation = data.delegation;
  if (
    !isRecord(delegation) ||
    !isSafeEventId(message.projectId) ||
    !isSafeEventId(message.worktreeId) ||
    !isSafeEventId(message.chatId) ||
    !isSafeEventId(delegation.delegationId) ||
    typeof delegation.runGeneration !== 'number' ||
    !Number.isSafeInteger(delegation.runGeneration) ||
    delegation.runGeneration < 0
  ) {
    return undefined;
  }
  return JSON.stringify([
    message.projectId,
    message.worktreeId,
    message.chatId,
    delegation.delegationId,
    delegation.runGeneration,
  ]);
}

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
  focusedRunKeys?: RunInterestKeys,
): boolean {
  if (!interestedChatKeys || !isChatEvent(message)) return false;
  const data = message.data;
  if (!isRecord(data)) return false;
  if (data.type === 'canopy_delegation') {
    if (focusedRunKeys === undefined) return false;
    const runKey = liveDetailRunKey(message);
    return runKey !== undefined && !focusedRunKeys.has(runKey);
  }
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
    {
      declaration: ChatInterestDeclaration;
      keys: InterestKeys;
      runKeys: RunInterestKeys | undefined;
    }
  >();

  shouldDrop(
    target: object,
    declaration: ChatInterestDeclaration | undefined,
    message: unknown,
  ): boolean {
    if (!declaration) return false;
    let cached = this.cache.get(target);
    if (cached?.declaration !== declaration) {
      cached = {
        declaration,
        keys: chatInterestKeys(declaration),
        runKeys: chatRunInterestKeys(declaration),
      };
      this.cache.set(target, cached);
    }
    return shouldDropChatEvent(cached.keys, message, cached.runKeys);
  }
}
