// Icon button + anchored popover for setting an optional follow-up instruction
// on a watcher (the text sent to the notified chat when the watcher fires).
// Shows the "assignment add" glyph in default colors when no instruction is set
// and the filled "assignment" glyph in the primary color once one is. Clicking
// opens a small popover with a textarea; the popover is portaled to
// `document.body` and positioned with `fixed` coordinates so it is never
// clipped by an ancestor's `overflow-hidden` (e.g. the pipeline-run modal).

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
} from 'react';
import { createPortal } from 'react-dom';
import { AssignmentAddIcon, AssignmentIcon } from '@canopy/ui-shared/icons';
import { Tooltip } from '@canopy/ui-shared';

const POPOVER_GAP = 6;
const VIEWPORT_PADDING = 8;
const POPOVER_WIDTH = 288; // matches w-72

export interface WatcherFollowUpButtonProps {
  value: string;
  onChange: (value: string) => void;
  /** Open the popover above (`top`) or below (`bottom`). Defaults to top. */
  placement?: 'top' | 'bottom';
  dataTestId?: string;
}

export function WatcherFollowUpButton({
  value,
  onChange,
  placement = 'top',
  dataTestId = 'watcher-followup',
}: WatcherFollowUpButtonProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);

  const hasInstruction = value.trim().length > 0;

  const updatePosition = useCallback((): void => {
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;

    const rect = trigger.getBoundingClientRect();
    const popoverHeight = popover.offsetHeight;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const above = rect.top - POPOVER_GAP - popoverHeight;
    const below = rect.bottom + POPOVER_GAP;
    let top: number;
    if (placement === 'top') {
      top = above >= VIEWPORT_PADDING ? above : below;
    } else {
      top =
        below + popoverHeight <= viewportHeight - VIEWPORT_PADDING
          ? below
          : above;
    }
    top = Math.min(
      Math.max(VIEWPORT_PADDING, top),
      Math.max(
        VIEWPORT_PADDING,
        viewportHeight - popoverHeight - VIEWPORT_PADDING,
      ),
    );

    // Align the popover's right edge to the trigger's right edge, clamped.
    const left = Math.min(
      Math.max(VIEWPORT_PADDING, rect.right - POPOVER_WIDTH),
      Math.max(
        VIEWPORT_PADDING,
        viewportWidth - POPOVER_WIDTH - VIEWPORT_PADDING,
      ),
    );

    setPosition((previous) => {
      if (previous && previous.top === top && previous.left === left) {
        return previous;
      }
      return { top, left };
    });
  }, [placement]);

  useLayoutEffect((): void => {
    if (!open) {
      setPosition(null);
      return;
    }
    updatePosition();
  }, [open, updatePosition]);

  useEffect((): (() => void) | undefined => {
    if (!open) return undefined;
    let frame: number | null = null;
    const schedule = (): void => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame((): void => {
        frame = null;
        updatePosition();
      });
    };
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, {
      capture: true,
      passive: true,
    });
    return (): void => {
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, { capture: true });
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointer = (event: MouseEvent): void => {
      if (!(event.target instanceof Node)) return;
      if (triggerRef.current?.contains(event.target)) return;
      if (popoverRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('keydown', handleKey);
    return (): void => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const Icon = hasInstruction ? AssignmentIcon : AssignmentAddIcon;

  return (
    <div className="electron-no-drag relative inline-flex">
      <Tooltip label="Set follow-up instructions">
        <button
          ref={triggerRef}
          type="button"
          onClick={(): void => setOpen((prev) => !prev)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label="Set follow-up instructions"
          data-testid={`${dataTestId}-trigger`}
          data-has-instruction={hasInstruction ? 'true' : 'false'}
          className={`focus-ring inline-flex h-7 w-7 items-center justify-center rounded-lg border transition ${
            hasInstruction
              ? 'border-line-accent/40 bg-accent-subtle fg-accent hover:bg-accent-subtle/80'
              : 'bg-popover fg-secondary hover:bg-fg-primary/[0.06] hover:fg-primary'
          }`}
        >
          <Icon width={15} height={15} aria-hidden="true" />
        </button>
      </Tooltip>

      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label="Follow-up instruction"
            data-testid={`${dataTestId}-popover`}
            className="electron-no-drag fixed z-dropdown w-72 rounded-lg bg-popover p-2.5 shadow-lg"
            style={
              position
                ? { top: position.top, left: position.left }
                : { visibility: 'hidden', top: 0, left: 0 }
            }
          >
            <div className="mb-1.5 text-3xs font-semibold fg-secondary">
              Follow-up instruction
            </div>
            <textarea
              value={value}
              onChange={(event): void => onChange(event.target.value)}
              rows={4}
              autoFocus
              placeholder="Instruction for the notified chat when this pipeline completes…"
              data-testid={`${dataTestId}-textarea`}
              className="focus-ring w-full resize-none rounded-md border bg-base px-2 py-1.5 text-xs fg-primary placeholder:fg-secondary"
            />
          </div>,
          document.body,
        )}
    </div>
  );
}
