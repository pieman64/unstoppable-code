import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import {
  formatElapsed,
  getElapsedMs,
  isActiveTiming,
  parseIsoToEpoch,
  TIMING_NOT_AVAILABLE,
  type PipelineTimingKind,
  type PipelineTimingSource,
  type PipelineTimingStatus,
} from '@/lib/pipelineTiming';

interface PipelineTimerProps {
  identity: string;
  kind: PipelineTimingKind;
  status: PipelineTimingStatus;
  startedAt?: string;
  completedAt?: string;
  /**
   * `ExecutionState.paused_at` for an `execution` timer: the instant the whole
   * run paused. The displayed duration freezes there instead of tracking
   * wall-clock time while the run waits.
   */
  pausedAt?: string;
  /** `ExecutionState.paused_ms` — time already spent in closed pauses. */
  pausedMs?: number;
  source?: PipelineTimingSource;
  fallbackLabel?: string;
  className?: string;
}

export function PipelineTimer({
  identity,
  kind,
  status,
  startedAt,
  completedAt,
  pausedAt,
  pausedMs,
  source = 'current',
  fallbackLabel = TIMING_NOT_AVAILABLE,
  className,
}: PipelineTimerProps): JSX.Element {
  const completedAtMs = parseIsoToEpoch(completedAt);
  const isActive = isActiveTiming({
    kind,
    status,
    source,
    startedAt,
    completedAt,
  });
  const [displayNowMs, setDisplayNowMs] = useState<number | null>(
    () => completedAtMs,
  );
  const previousIdentityRef = useRef<string>(identity);
  const prevCompletedAtMsRef = useRef<number | null>(completedAtMs);
  const displayNowMsRef = useRef<number | null>(displayNowMs);

  const setDisplayNowMsIfChanged = useCallback(
    (next: number | null, compareSeconds = false): void => {
      const current = displayNowMsRef.current;
      if (
        current === next ||
        (compareSeconds &&
          current !== null &&
          next !== null &&
          Math.floor(current / 1000) === Math.floor(next / 1000))
      ) {
        return;
      }
      displayNowMsRef.current = next;
      setDisplayNowMs(next);
    },
    [],
  );

  useEffect(() => {
    displayNowMsRef.current = displayNowMs;
  }, [displayNowMs]);

  useEffect(() => {
    const identityChanged = previousIdentityRef.current !== identity;
    previousIdentityRef.current = identity;

    const completedAtCleared =
      prevCompletedAtMsRef.current !== null && completedAtMs === null;
    prevCompletedAtMsRef.current = completedAtMs;

    if (completedAtMs !== null) {
      setDisplayNowMsIfChanged(completedAtMs);
      return;
    }

    if (identityChanged) {
      setDisplayNowMsIfChanged(isActive ? Date.now() : null, isActive);
      return;
    }

    if (isActive && (displayNowMsRef.current === null || completedAtCleared)) {
      setDisplayNowMsIfChanged(Date.now(), true);
      return;
    }

    if (!isActive) {
      setDisplayNowMsIfChanged(null);
    }
  }, [completedAtMs, identity, isActive, setDisplayNowMsIfChanged]);

  useEffect(() => {
    if (!isActive) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setDisplayNowMsIfChanged(Date.now(), true);
    }, 1000);

    return (): void => {
      window.clearInterval(intervalId);
    };
  }, [isActive, setDisplayNowMsIfChanged]);

  const elapsed = getElapsedMs({
    startedAt,
    completedAt,
    pausedAt,
    pausedMs,
    nowMs: displayNowMs ?? Date.now(),
    // A paused run is not active, but `pausedAt` supplies its own stop point,
    // so the frozen duration still renders instead of "Not available".
    fallbackToNow: isActive || displayNowMs !== null,
  });
  const formatted = formatElapsed(elapsed);

  return (
    <span className={className}>
      {formatted === TIMING_NOT_AVAILABLE ? fallbackLabel : formatted}
    </span>
  );
}
