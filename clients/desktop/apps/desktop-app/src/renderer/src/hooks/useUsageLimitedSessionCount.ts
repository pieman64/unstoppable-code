import { useEffect, useState } from 'react';
import { useResumeQueueStore } from '@/stores/resumeQueueStore';
import { useUsageLimitResumePromptStore } from '@/stores/usageLimitResumePromptStore';

/**
 * Number of usage-limited idle sessions (chats + pipelines) recorded for a
 * provider — the population the {@link UsageLimitResumeModal} offers to
 * resume. Drives the Usage page/panel "Resume" button.
 *
 * Refetches when `nowMs` ticks (the usage surfaces already re-render on a
 * 30s clock, which also covers limits going stale), when the resume modal
 * closes, and when the asynchronous resume queue changes. The queue's terminal
 * revision arrives after dispatch updates the registry, so a completed resume
 * shrinks or hides the button. The previous count remains visible during refresh.
 * Returns 0 before the first successful load, on error, or in environments
 * without the preload API (jsdom tests).
 */
export function useUsageLimitedSessionCount(
  provider: 'claude' | 'codex' | null,
  nowMs: number,
): number {
  const [count, setCount] = useState(0);
  const resumeModalOpen = useUsageLimitResumePromptStore((s) => s.isOpen);
  const resumeQueueRevision = useResumeQueueStore((s) => s.snapshot?.revision);

  useEffect(() => {
    // While the modal is open it owns the registry interaction; the close
    // transition re-runs this effect and refreshes the count.
    if (resumeModalOpen) {
      return;
    }
    const api = window.api;
    const listSessions =
      api && typeof api.listUsageLimitedIdleSessions === 'function'
        ? api.listUsageLimitedIdleSessions
        : undefined;
    const listChats =
      api && typeof api.listUsageLimitedIdleChats === 'function'
        ? api.listUsageLimitedIdleChats
        : undefined;
    if (!listSessions && !listChats) {
      return;
    }
    let cancelled = false;
    void (async (): Promise<void> => {
      let next = 0;
      try {
        if (listSessions) {
          const groups = await listSessions(
            provider ? { provider } : { resumeReason: 'app_shutdown' },
          );
          next = groups.reduce((sum, group) => sum + group.sessions.length, 0);
        } else if (listChats && provider) {
          const groups = await listChats({ provider });
          next = groups.reduce((sum, group) => sum + group.chats.length, 0);
        }
      } catch {
        // Leave the button hidden rather than surfacing a fetch error on a
        // read-only affordance.
        next = 0;
      }
      if (!cancelled) {
        setCount(next);
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [provider, nowMs, resumeModalOpen, resumeQueueRevision]);

  return count;
}
