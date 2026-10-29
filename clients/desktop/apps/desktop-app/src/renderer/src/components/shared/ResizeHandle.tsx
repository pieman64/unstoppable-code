import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type MouseEvent,
} from 'react';

type Orientation = 'horizontal' | 'vertical';

interface ResizeHandleProps {
  orientation: Orientation;
  onDrag: (clientCoordinate: number) => void;
  onCommit?: () => void;
  /**
   * Draw the hairline along the handle's leading edge (top of a vertical
   * handle, left of a horizontal one) so it doubles as the edge line of the
   * pane it resizes, such as the comments tray's top border.
   */
  divider?: boolean;
  /** Placement classes for the handle: position, flex participation. */
  className?: string;
  indicatorClassName?: string;
  style?: CSSProperties;
  ariaLabel?: string;
  ariaValueMin?: number;
  ariaValueMax?: number;
  ariaValueNow?: number;
}

export function ResizeHandle({
  orientation,
  onDrag,
  onCommit,
  divider = false,
  className,
  indicatorClassName,
  style,
  ariaLabel,
  ariaValueMin,
  ariaValueMax,
  ariaValueNow,
}: ResizeHandleProps): JSX.Element {
  const [isResizing, setIsResizing] = useState(false);
  const onDragRef = useRef(onDrag);
  const onCommitRef = useRef(onCommit);

  useEffect(() => {
    onDragRef.current = onDrag;
  }, [onDrag]);

  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);

  const handleMouseDown = useCallback(
    (event: MouseEvent<HTMLDivElement>): void => {
      event.preventDefault();
      setIsResizing(true);
      const coord =
        orientation === 'horizontal' ? event.clientX : event.clientY;
      onDragRef.current(coord);
    },
    [orientation],
  );

  useEffect(() => {
    if (!isResizing) {
      return undefined;
    }

    const move = (event: globalThis.MouseEvent): void => {
      const coord =
        orientation === 'horizontal' ? event.clientX : event.clientY;
      onDragRef.current(coord);
    };

    const up = (): void => {
      setIsResizing(false);
      onCommitRef.current?.();
    };

    const originalCursor = document.body.style.cursor;
    const originalUserSelect = document.body.style.userSelect;
    document.body.style.cursor =
      orientation === 'horizontal' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';

    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);

    return (): void => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = originalCursor;
      document.body.style.userSelect = originalUserSelect;
    };
  }, [isResizing, orientation]);

  const axisCursor =
    orientation === 'horizontal' ? 'cursor-col-resize' : 'cursor-row-resize';
  const axisShape = orientation === 'horizontal' ? 'h-full w-2' : 'h-2 w-full';
  const indicatorShape =
    orientation === 'horizontal'
      ? `my-2 rounded-full transition-all ${
          isResizing
            ? 'w-0.5 bg-accent/80'
            : 'w-px bg-line-base/70 group-hover:w-0.5 group-hover:bg-accent/60'
        }`
      : `mx-2 rounded-full transition-all ${
          isResizing
            ? 'h-0.5 bg-accent/80'
            : 'h-px bg-line-base/70 group-hover:h-0.5 group-hover:bg-accent/60'
        }`;
  const flexShape =
    orientation === 'horizontal'
      ? 'items-stretch justify-center'
      : 'flex-col items-center justify-stretch';
  const dividerShape = divider
    ? orientation === 'horizontal'
      ? 'border-l'
      : 'border-t'
    : '';

  return (
    <div
      className={`group flex shrink-0 ${axisShape} ${axisCursor} ${flexShape} ${dividerShape} ${className ?? ''}`}
      style={style}
      onMouseDown={handleMouseDown}
      role="separator"
      aria-orientation={orientation}
      aria-label={ariaLabel}
      aria-valuemin={ariaValueMin}
      aria-valuemax={ariaValueMax}
      aria-valuenow={ariaValueNow}
    >
      <div
        className={
          indicatorClassName
            ? `${indicatorShape} ${indicatorClassName}`
            : indicatorShape
        }
      />
    </div>
  );
}
