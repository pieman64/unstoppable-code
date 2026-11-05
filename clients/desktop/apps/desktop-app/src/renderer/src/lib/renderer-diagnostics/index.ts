/**
 * This renderer's frame and delivery diagnostics: long animation frames of
 * at least 1 s with the largest focused chat's committed-row bucket, and the
 * chat and terminal deliveries it applies, aggregated per 30-second window
 * and sent to main on the local `observability:record-renderer-summary` channel
 * (recorded on this computer only, as `renderer_frame_summary`).
 *
 * Started once per renderer ({@link useRendererDiagnostics} in `App.tsx` and
 * `AppAdvisorWindowApp.tsx`). Delivery sites call the `record…Applied`
 * functions in `./recorder`.
 */
import { useEffect } from 'react';
import type { RendererDiagnosticsSummary } from '@canopy/desktop-shared/types/observability';
import { getChatInterest, subscribeChatInterest } from '@/lib/chat-interest';
import { useChatStore } from '@/stores/chatStore';
import { readRemoteControlContext } from '@/stores/remoteControlStore';
import {
  RENDERER_DIAGNOSTICS_WINDOW_MS,
  createRendererDiagnosticsAggregator,
} from './aggregator';
import { setActiveRendererDiagnostics } from './recorder';

export {
  recordChatEventApplied,
  recordChatStateApplied,
  recordTerminalOutputApplied,
} from './recorder';

const LONG_ANIMATION_FRAME = 'long-animation-frame';

let runningDispose: (() => void) | null = null;

function sendSummary(summary: RendererDiagnosticsSummary): void {
  // Older preloads have no `recordRendererSummary`; such a window records
  // nothing.
  const observability = window.api?.observability;
  if (typeof observability?.recordRendererSummary !== 'function') return;
  try {
    observability.recordRendererSummary(summary);
  } catch {
    // A diagnostic that cannot be sent is dropped.
  }
}

/** Largest committed transcript row count among this window's focused chats. */
export function readFocusedChatRowCount(): number | null {
  const interest = getChatInterest();
  if (interest === null || interest.focused.length === 0) return null;

  const worktreeChats = useChatStore.getState().worktreeChats;
  let largest: number | null = null;
  for (const ref of interest.focused) {
    const scope = worktreeChats[`${ref.projectId}/${ref.worktreeId}`];
    const tab = scope?.tabs.find((candidate) => candidate.id === ref.chatId);
    // The descriptor's committed rows only: `messageCount` also counts the
    // uncommitted active suffix, and `messages` holds only loaded pages.
    const committedMessageCount = tab?.transcript?.committedMessageCount;
    if (
      typeof committedMessageCount !== 'number' ||
      !Number.isFinite(committedMessageCount) ||
      committedMessageCount < 0
    ) {
      continue;
    }
    largest =
      largest === null
        ? committedMessageCount
        : Math.max(largest, committedMessageCount);
  }
  return largest;
}

/** Observe long animation frames where supported; returns a disconnect. */
function observeLongAnimationFrames(
  record: (entries: readonly unknown[]) => void,
): () => void {
  if (
    typeof PerformanceObserver === 'undefined' ||
    !Array.isArray(PerformanceObserver.supportedEntryTypes) ||
    !PerformanceObserver.supportedEntryTypes.includes(LONG_ANIMATION_FRAME)
  ) {
    return (): void => {};
  }
  const observer = new PerformanceObserver((list) => {
    record(list.getEntries());
  });
  observer.observe({ type: LONG_ANIMATION_FRAME, buffered: false });
  return (): void => observer.disconnect();
}

/**
 * Start aggregating and sending this renderer's diagnostics. Idempotent;
 * returns a disposer that drops the current window's data.
 */
export function startRendererDiagnostics(): () => void {
  if (runningDispose !== null) return runningDispose;
  const aggregator = createRendererDiagnosticsAggregator({
    now: () => performance.now(),
    isHidden: () => document.visibilityState === 'hidden',
    // The preload's window context: `remote` when main opened this window to
    // show another computer (its `--canopy-remote-window=` argument).
    remoteWindow: readRemoteControlContext().mode === 'remote',
    focusedChatRowCount: readFocusedChatRowCount,
    send: sendSummary,
  });
  aggregator.setInterest(getChatInterest());
  const unsubscribeInterest = subscribeChatInterest((interest) => {
    aggregator.setInterest(interest);
  });
  const disconnectFrames = observeLongAnimationFrames(
    aggregator.recordFrameEntries,
  );
  const timer = window.setInterval((): void => {
    // Picks up an interest that was computed before this subscribed and has
    // not changed since; an unchanged interest is not rebuilt.
    aggregator.setInterest(getChatInterest());
    aggregator.flush();
  }, RENDERER_DIAGNOSTICS_WINDOW_MS);
  setActiveRendererDiagnostics(aggregator);
  const dispose = (): void => {
    window.clearInterval(timer);
    disconnectFrames();
    unsubscribeInterest();
    setActiveRendererDiagnostics(null);
    if (runningDispose === dispose) runningDispose = null;
  };
  runningDispose = dispose;
  return dispose;
}

/** Aggregate and send this renderer's diagnostics while mounted. */
export function useRendererDiagnostics(): void {
  useEffect(() => startRendererDiagnostics(), []);
}
