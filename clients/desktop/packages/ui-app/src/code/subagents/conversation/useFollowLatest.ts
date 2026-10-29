import { useCallback, useEffect, useRef, useState } from 'react';

/** How close to the bottom still counts as reading the latest output. */
const FOLLOW_THRESHOLD_PX = 48;

export interface FollowLatestRefs {
  /** Attach to the scrolling element. */
  readonly scrollerRef: (element: HTMLElement | null) => void;
  /** Attach to the content inside it, whose growth is followed. */
  readonly contentRef: (element: HTMLElement | null) => void;
}

/**
 * Keeps a transcript scrolled to its latest output, as the main chat does:
 * it opens at the bottom and follows new content while the reader is at the
 * bottom. Scrolling up stops following until the reader returns.
 */
export function useFollowLatest(): FollowLatestRefs {
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [content, setContent] = useState<HTMLElement | null>(null);
  const following = useRef(true);

  useEffect((): (() => void) | void => {
    if (!scroller || !content) return;
    const onScroll = (): void => {
      following.current =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <
        FOLLOW_THRESHOLD_PX;
    };
    const follow = (): void => {
      if (following.current) scroller.scrollTop = scroller.scrollHeight;
    };
    following.current = true;
    follow();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(follow);
    observer?.observe(content);
    return (): void => {
      scroller.removeEventListener('scroll', onScroll);
      observer?.disconnect();
    };
  }, [content, scroller]);

  return {
    scrollerRef: useCallback(
      (element: HTMLElement | null): void => setScroller(element),
      [],
    ),
    contentRef: useCallback(
      (element: HTMLElement | null): void => setContent(element),
      [],
    ),
  };
}
