import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

const HOVER_OPEN_DELAY = 300;
const HOVER_CLOSE_DELAY = 150;

interface AttachmentHoverState {
  hoveredPath: string | null;
  anchorRef: MutableRefObject<HTMLElement | null>;
  handleMouseEnter: (absolutePath: string, el: HTMLElement) => void;
  handleMouseLeave: () => void;
  popoverMouseEnter: () => void;
  popoverMouseLeave: () => void;
}

export function useAttachmentHover(): AttachmentHoverState {
  const [hoveredPath, setHoveredPath] = useState<string | null>(null);
  const hoveredPathRef = useRef<string | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return (): void => {
      clearTimeout(timerRef.current);
    };
  }, []);

  const close = useCallback((): void => {
    clearTimeout(timerRef.current);
    hoveredPathRef.current = null;
    anchorRef.current = null;
    setHoveredPath(null);
  }, []);

  const handleMouseEnter = useCallback(
    (absolutePath: string, el: HTMLElement): void => {
      clearTimeout(timerRef.current);
      if (hoveredPathRef.current !== null) {
        // Already showing — switch immediately
        anchorRef.current = el;
        hoveredPathRef.current = absolutePath;
        setHoveredPath(absolutePath);
      } else {
        timerRef.current = setTimeout(() => {
          anchorRef.current = el;
          hoveredPathRef.current = absolutePath;
          setHoveredPath(absolutePath);
        }, HOVER_OPEN_DELAY);
      }
    },
    [],
  );

  const handleMouseLeave = useCallback((): void => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(close, HOVER_CLOSE_DELAY);
  }, [close]);

  const popoverMouseEnter = useCallback((): void => {
    clearTimeout(timerRef.current);
  }, []);

  const popoverMouseLeave = useCallback((): void => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(close, HOVER_CLOSE_DELAY);
  }, [close]);

  return {
    hoveredPath,
    anchorRef,
    handleMouseEnter,
    handleMouseLeave,
    popoverMouseEnter,
    popoverMouseLeave,
  };
}
