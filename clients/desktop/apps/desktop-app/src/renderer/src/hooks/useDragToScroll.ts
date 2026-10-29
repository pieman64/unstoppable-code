import { useCallback, useEffect, useRef, useState } from 'react';

interface DragToScrollOptions {
  draggingCursor?: string;
  hoverCursor?: string;
  dragThreshold?: number;
}

interface DragToScrollResult<T extends HTMLElement> {
  ref: (node: T | null) => void;
}

const INTERACTIVE_SELECTOR =
  'button, a, input, select, textarea, [role="button"]';

function findInteractiveTarget(event: MouseEvent): Element | null {
  for (const target of event.composedPath()) {
    if (!(target instanceof Element)) {
      continue;
    }

    const interactiveTarget = target.closest(INTERACTIVE_SELECTOR);
    if (interactiveTarget) {
      return interactiveTarget;
    }
  }

  return null;
}

export function useDragToScroll<T extends HTMLElement = HTMLDivElement>(
  options: DragToScrollOptions = {},
): DragToScrollResult<T> {
  const {
    draggingCursor = 'grabbing',
    hoverCursor = 'grab',
    dragThreshold = 5,
  } = options;

  const elementRef = useRef<T | null>(null);
  const [element, setElement] = useState<T | null>(null);

  const ref = useCallback((node: T | null): void => {
    elementRef.current = node;
    setElement(node);
  }, []);

  const isMouseDown = useRef(false);
  const isActiveDrag = useRef(false);
  const justDragged = useRef(false);
  const justDraggedTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startX = useRef(0);
  const startY = useRef(0);
  const scrollLeft = useRef(0);
  const scrollTop = useRef(0);
  const originalDragElementCursor = useRef<string | null>(null);
  const originalDragElementUserSelect = useRef<string | null>(null);
  const originalBodyCursor = useRef<string | null>(null);

  const restoreDragStyles = useCallback((target: T | null): void => {
    if (target && originalDragElementCursor.current !== null) {
      target.style.cursor = originalDragElementCursor.current;
      originalDragElementCursor.current = null;
    }

    if (target && originalDragElementUserSelect.current !== null) {
      target.style.userSelect = originalDragElementUserSelect.current;
      originalDragElementUserSelect.current = null;
    }

    if (originalBodyCursor.current !== null) {
      document.body.style.cursor = originalBodyCursor.current;
      originalBodyCursor.current = null;
    }
  }, []);

  const handleMouseDown = useCallback((event: MouseEvent): void => {
    const el = elementRef.current;
    if (!el) return;
    if (event.button !== 0) return;

    if (findInteractiveTarget(event)) {
      return;
    }

    isMouseDown.current = true;
    isActiveDrag.current = false;
    startX.current = event.clientX;
    startY.current = event.clientY;
    scrollLeft.current = el.scrollLeft;
    scrollTop.current = el.scrollTop;
  }, []);

  const handleMouseMove = useCallback(
    (event: MouseEvent): void => {
      if (!isMouseDown.current) return;
      const el = elementRef.current;
      if (!el) return;

      const deltaX = event.clientX - startX.current;
      const deltaY = event.clientY - startY.current;

      if (!isActiveDrag.current) {
        const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
        if (distance < dragThreshold) {
          return;
        }
        isActiveDrag.current = true;
        originalDragElementCursor.current = el.style.cursor;
        originalDragElementUserSelect.current = el.style.userSelect;
        originalBodyCursor.current = document.body.style.cursor;
        el.style.cursor = draggingCursor;
        el.style.userSelect = 'none';
        document.body.style.cursor = draggingCursor;
      }

      event.preventDefault();
      el.scrollLeft = scrollLeft.current - deltaX;
      el.scrollTop = scrollTop.current - deltaY;
    },
    [dragThreshold, draggingCursor],
  );

  const handleMouseUp = useCallback((): void => {
    const el = elementRef.current;
    if (!el) return;
    if (!isMouseDown.current) return;

    if (isActiveDrag.current) {
      justDragged.current = true;
      if (justDraggedTimeout.current !== null) {
        clearTimeout(justDraggedTimeout.current);
      }
      justDraggedTimeout.current = setTimeout(() => {
        justDragged.current = false;
        justDraggedTimeout.current = null;
      }, 0);
    }

    isMouseDown.current = false;
    isActiveDrag.current = false;
    restoreDragStyles(el);
  }, [restoreDragStyles]);

  const handleMouseLeave = useCallback((): void => {
    const el = elementRef.current;
    if (!el) return;
    if (!isActiveDrag.current) {
      el.style.cursor = hoverCursor;
    }
  }, [hoverCursor]);

  const handleClick = useCallback((event: MouseEvent): void => {
    if (justDragged.current) {
      event.stopPropagation();
      event.preventDefault();
      justDragged.current = false;
    }
  }, []);

  useEffect(() => {
    if (!element) return;

    const originalElementCursor = element.style.cursor;
    element.style.cursor = hoverCursor;
    element.addEventListener('mousedown', handleMouseDown);
    element.addEventListener('mouseleave', handleMouseLeave);
    element.addEventListener('click', handleClick, true);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return (): void => {
      element.removeEventListener('mousedown', handleMouseDown);
      element.removeEventListener('mouseleave', handleMouseLeave);
      element.removeEventListener('click', handleClick, true);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);

      if (justDraggedTimeout.current !== null) {
        clearTimeout(justDraggedTimeout.current);
        justDraggedTimeout.current = null;
      }

      restoreDragStyles(element);
      element.style.cursor = originalElementCursor;
    };
  }, [
    element,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleMouseLeave,
    handleClick,
    hoverCursor,
    restoreDragStyles,
  ]);

  return { ref };
}
