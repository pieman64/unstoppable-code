import type { PersistedChatTab } from '@canopy/desktop-shared/types';

export const MAX_PENDING_CLAUDE_TERMINAL_WATCHER_MESSAGES = 20;

export function normalizePendingClaudeTerminalWatcherMessages(
  value: unknown,
): PersistedChatTab['pendingClaudeTerminalWatcherMessages'] {
  if (!Array.isArray(value)) return undefined;
  const normalized = value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const text: unknown = Reflect.get(entry, 'text');
    const submittedText: unknown = Reflect.get(entry, 'submittedText');
    const deliveryId: unknown = Reflect.get(entry, 'deliveryId');
    const watcherFired: unknown = Reflect.get(entry, 'watcherFired');
    if (!watcherFired || typeof watcherFired !== 'object') return [];
    const kind: unknown = Reflect.get(watcherFired, 'kind');
    if (
      typeof text !== 'string' ||
      text.length === 0 ||
      typeof kind !== 'string' ||
      kind.length === 0
    ) {
      return [];
    }
    return [
      {
        text,
        ...(typeof submittedText === 'string' ? { submittedText } : {}),
        ...(typeof deliveryId === 'string' ? { deliveryId } : {}),
        watcherFired: { kind },
      },
    ];
  });
  return normalized.slice(-MAX_PENDING_CLAUDE_TERMINAL_WATCHER_MESSAGES);
}
