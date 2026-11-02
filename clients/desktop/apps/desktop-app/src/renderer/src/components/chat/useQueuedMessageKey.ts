import { useCallback, useRef } from 'react';
import type { QueuedChatMessage } from '@/stores/chatStore';

/**
 * Assign a stable React key per queued message object. Switching the edit
 * target between two queued messages must remount the editor so its local
 * state (editor content, attachments) resets to the newly-selected message
 * rather than carrying over from the previous one. Keying off the message
 * object's identity also lets the editor stay mounted across local queue
 * index shifts. Host snapshots replace message objects, so host-owned rows
 * use their durable queue entry id to keep an in-progress edit mounted.
 */
export function useQueuedMessageKey(): (message: QueuedChatMessage) => string {
  const keysRef = useRef<WeakMap<QueuedChatMessage, string> | null>(null);
  if (keysRef.current === null) {
    keysRef.current = new WeakMap();
  }
  const counterRef = useRef(0);
  return useCallback((message: QueuedChatMessage): string => {
    if (message.hostQueueEntryId) return `host-${message.hostQueueEntryId}`;
    const cache = keysRef.current;
    if (!cache) return 'qm-0';
    const existing = cache.get(message);
    if (existing !== undefined) return existing;
    counterRef.current += 1;
    const id = `qm-${counterRef.current}`;
    cache.set(message, id);
    return id;
  }, []);
}
