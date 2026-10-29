import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { getDocument, getWindow } from '@canopy/ui-shared/panels';
import { SkillIcon } from '@canopy/ui-shared/icons';
import type { InvocableMentionTarget } from '@/lib/invocableMentionIndex';
import { useInvocableMentionContent } from '@/hooks/useInvocableMentionContent';
import { InvocableDetailsModal } from './InvocableDetailsModal';

const DESCRIPTION_LIMIT = 200;
const POPOVER_GAP = 6;
const VIEWPORT_PADDING = 8;

function truncateDescription(description: string): string {
  const normalized = description.trim().replace(/\s+/g, ' ');
  if (normalized.length <= DESCRIPTION_LIMIT) return normalized;
  return `${normalized.slice(0, DESCRIPTION_LIMIT).trimEnd()}...`;
}

interface InvocableMentionProps {
  target: InvocableMentionTarget;
  children: ReactNode;
}

export const InvocableMention = memo(function InvocableMention({
  target,
  children,
}: InvocableMentionProps): JSX.Element {
  const tooltipId = useId();
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLSpanElement | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const { content, loading } = useInvocableMentionContent(target, detailsOpen);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewPosition, setPreviewPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);

  const updatePreviewPosition = useCallback((): void => {
    const trigger = triggerRef.current;
    const tooltip = tooltipRef.current;
    if (!trigger || !tooltip) return;

    const rect = trigger.getBoundingClientRect();
    const view = getWindow(trigger);
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;
    const preferredTop = rect.top - POPOVER_GAP - tooltipHeight;
    const fallbackTop = rect.bottom + POPOVER_GAP;
    const maxTop = Math.max(
      VIEWPORT_PADDING,
      view.innerHeight - tooltipHeight - VIEWPORT_PADDING,
    );
    const top =
      preferredTop >= VIEWPORT_PADDING
        ? preferredTop
        : Math.min(fallbackTop, maxTop);
    const centeredLeft = rect.left + rect.width / 2 - tooltipWidth / 2;
    const maxLeft = Math.max(
      VIEWPORT_PADDING,
      view.innerWidth - tooltipWidth - VIEWPORT_PADDING,
    );
    const left = Math.min(Math.max(VIEWPORT_PADDING, centeredLeft), maxLeft);

    setPreviewPosition((previous) => {
      if (previous && previous.top === top && previous.left === left) {
        return previous;
      }
      return { top, left };
    });
  }, []);

  useLayoutEffect((): (() => void) | void => {
    if (!previewOpen) {
      setPreviewPosition(null);
      return;
    }

    updatePreviewPosition();
    const view = getWindow(triggerRef.current);
    const frame = view.requestAnimationFrame(updatePreviewPosition);
    return (): void => {
      view.cancelAnimationFrame(frame);
    };
  }, [previewOpen, updatePreviewPosition]);

  useEffect((): (() => void) | void => {
    if (!previewOpen) return;

    // Bind to the window the mention lives in (aux window when popped out).
    const view = getWindow(triggerRef.current);
    let frame: number | null = null;
    const schedulePositionUpdate = (): void => {
      if (frame !== null) return;
      frame = view.requestAnimationFrame((): void => {
        frame = null;
        updatePreviewPosition();
      });
    };

    view.addEventListener('resize', schedulePositionUpdate);
    view.addEventListener('scroll', schedulePositionUpdate, {
      capture: true,
      passive: true,
    });

    return (): void => {
      view.removeEventListener('resize', schedulePositionUpdate);
      view.removeEventListener('scroll', schedulePositionUpdate, {
        capture: true,
      });
      if (frame !== null) {
        view.cancelAnimationFrame(frame);
      }
    };
  }, [previewOpen, updatePreviewPosition]);

  const showPreview = useCallback((): void => {
    setPreviewOpen(true);
  }, []);

  const hidePreview = useCallback((): void => {
    setPreviewOpen(false);
  }, []);

  const description = truncateDescription(
    content?.description || target.entry.description,
  );

  return (
    <>
      <span
        ref={triggerRef}
        className="inline-flex items-baseline gap-0.5 align-baseline"
        onMouseEnter={showPreview}
        onMouseLeave={hidePreview}
        onFocus={showPreview}
        onBlur={hidePreview}
      >
        <button
          type="button"
          className="focus-ring -mb-px inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm fg-accent hover:bg-accent-subtle"
          aria-label={`Open ${target.label} details`}
          aria-describedby={previewOpen ? tooltipId : undefined}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setDetailsOpen(true);
          }}
        >
          <SkillIcon width={13} height={13} aria-hidden="true" />
        </button>
        <span>{children}</span>
      </span>

      {/* Portaled out of the transcript's and composer's replay blocks: the
          skill's name and description are recorded. */}
      {previewOpen &&
        typeof document !== 'undefined' &&
        createPortal(
          <span
            ref={tooltipRef}
            id={tooltipId}
            role="tooltip"
            className="pointer-events-none fixed z-tooltip block w-72 rounded-md bg-popover px-3 py-2 text-left text-xs shadow-tooltip fg-primary"
            style={
              previewPosition
                ? { top: previewPosition.top, left: previewPosition.left }
                : { visibility: 'hidden', top: 0, left: 0 }
            }
          >
            <span className="block truncate font-medium fg-primary">
              {target.label}
            </span>
            {description ? (
              <span className="mt-1 block fg-secondary">{description}</span>
            ) : null}
          </span>,
          getDocument(triggerRef.current).body,
        )}

      {detailsOpen && typeof document !== 'undefined' ? (
        <InvocableDetailsModal
          target={target}
          content={content}
          loading={loading}
          ownerDocument={getDocument(triggerRef.current)}
          onClose={() => setDetailsOpen(false)}
        />
      ) : null}
    </>
  );
});
