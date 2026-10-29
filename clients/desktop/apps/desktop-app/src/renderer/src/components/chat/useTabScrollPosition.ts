import {
  useCallback,
  useEffect,
  useRef,
  type RefObject,
  type UIEvent,
} from 'react';
import {
  getFileViewerScrollPosition,
  saveFileViewerScrollPosition,
} from '@/lib/tab-scroll-positions';

interface TabScrollPositionBinding<T extends HTMLElement> {
  scrollRef: RefObject<T | null>;
  handleScroll: (event: UIEvent<T>) => void;
  scheduleRestoreScrollPosition: () => void;
}
export function useTabScrollPosition<T extends HTMLElement>(
  tabId: string,
): TabScrollPositionBinding<T> {
  const scrollRef = useRef<T | null>(null);
  const restoreFrameIdRef = useRef<number | null>(null);
  const restoreGuardFrameIdRef = useRef<number | null>(null);
  const restoreGuardTimeoutIdRef = useRef<number | null>(null);
  const isRestoringScrollRef = useRef(false);

  const restoreScrollPosition = useCallback((): void => {
    const saved = getFileViewerScrollPosition(tabId);
    const node = scrollRef.current;
    if (!saved || !node) return;

    isRestoringScrollRef.current = true;
    node.scrollTop = saved.top;
    node.scrollLeft = saved.left;

    if (restoreGuardFrameIdRef.current !== null) {
      cancelAnimationFrame(restoreGuardFrameIdRef.current);
    }
    if (restoreGuardTimeoutIdRef.current !== null) {
      window.clearTimeout(restoreGuardTimeoutIdRef.current);
    }
    restoreGuardFrameIdRef.current = requestAnimationFrame(() => {
      restoreGuardFrameIdRef.current = null;
      restoreGuardTimeoutIdRef.current = window.setTimeout(() => {
        restoreGuardTimeoutIdRef.current = null;
        isRestoringScrollRef.current = false;
      }, 0);
    });
  }, [tabId]);

  const scheduleRestoreScrollPosition = useCallback((): void => {
    if (restoreFrameIdRef.current !== null) {
      cancelAnimationFrame(restoreFrameIdRef.current);
    }
    restoreFrameIdRef.current = requestAnimationFrame(() => {
      restoreFrameIdRef.current = null;
      restoreScrollPosition();
    });
  }, [restoreScrollPosition]);

  useEffect(() => {
    scheduleRestoreScrollPosition();
    return (): void => {
      if (restoreFrameIdRef.current !== null) {
        cancelAnimationFrame(restoreFrameIdRef.current);
        restoreFrameIdRef.current = null;
      }
      if (restoreGuardFrameIdRef.current !== null) {
        cancelAnimationFrame(restoreGuardFrameIdRef.current);
        restoreGuardFrameIdRef.current = null;
      }
      if (restoreGuardTimeoutIdRef.current !== null) {
        window.clearTimeout(restoreGuardTimeoutIdRef.current);
        restoreGuardTimeoutIdRef.current = null;
      }
      isRestoringScrollRef.current = false;
    };
  }, [scheduleRestoreScrollPosition]);

  const handleScroll = useCallback(
    (event: UIEvent<T>): void => {
      if (isRestoringScrollRef.current) return;

      saveFileViewerScrollPosition(tabId, {
        top: event.currentTarget.scrollTop,
        left: event.currentTarget.scrollLeft,
      });
    },
    [tabId],
  );

  return { scrollRef, handleScroll, scheduleRestoreScrollPosition };
}
