import {
  memo,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { Button } from '@canopy/ui-shared/components';

/** Rows fully visible while collapsed; the row after them fades out. */
const COLLAPSED_VISIBLE_ROWS = 3;
/** Rows inside the clamp: the visible ones plus the faded cut-off row. */
const COLLAPSED_TOTAL_ROWS = COLLAPSED_VISIBLE_ROWS + 1;
/**
 * How much of the cut-off row survives the clamp. The point of that row is to
 * say "there is more" — sliced through the glyphs it reads as continuing,
 * while a whole row (even faded) reads as a fourth line of content.
 */
const CUT_ROW_VISIBLE_FRACTION = 0.6;
/**
 * Opacity the mask has reached by the cut. Deliberately low — the fade should
 * read as a fade — but not zero: at zero the row dissolves into nothing and
 * the crop stops looking like text continuing past an edge. The bubble's edge
 * still does the cutting; the mask says the row is not the end.
 */
const CUT_ROW_END_OPACITY = 0.12;
/**
 * Extra content revealed past the cut row's own budget. The row-based cut
 * alone stopped a shade too early to feel like the message continues; this
 * carries it just past the row so the gradient has a run to fade over.
 */
const EXTRA_REVEAL_PX = 6;
/** Fallback when a computed line-height cannot be parsed (e.g. `normal`). */
const FALLBACK_LINE_HEIGHT_PX = 20;
/**
 * Slack beyond the clamp before the collapse UI engages, as a fraction of the
 * cut row, so a message that just fits (plus sub-pixel rounding) never shows
 * a pointless "Show more".
 */
const OVERFLOW_TOLERANCE_ROWS = 0.5;
/**
 * Measurements kept for prompts that unmount, so a remount (a chat tab
 * switched back to) opens at its collapsed size instead of painting at full
 * height until the first ResizeObserver delivery. Bounded; oldest first out.
 */
const MAX_REMEMBERED_MEASUREMENTS = 2_000;
const FOCUSABLE_DESCENDANT_SELECTOR =
  'a[href], button, input, select, textarea, [tabindex]';

interface RowBox {
  top: number;
  bottom: number;
}

/**
 * Line-box geometry for the rendered content, relative to the element's own
 * top edge.
 *
 * Multiplying a computed `line-height` by a row count is not good enough here:
 * markdown blocks bring their own margins and per-block line-heights, so the
 * product drifts from where the text actually sits and the clamp lands
 * mid-row. Measuring the real line boxes makes "four rows" mean four rows.
 *
 * Returns an empty array where ranges are unavailable (jsdom), which sends
 * callers to the line-height fallback.
 */
function measureRowBoxes(element: HTMLElement): RowBox[] {
  if (
    typeof document.createRange !== 'function' ||
    typeof document.createTreeWalker !== 'function'
  ) {
    return [];
  }

  // Ranges are taken per text node rather than over the whole subtree:
  // `selectNodeContents` on a container also yields a rect for each block
  // child, which would be mistaken for a very tall first row and pull the
  // clamp a full line short.
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  // Client rects are viewport-relative; the element's own top is the origin
  // the clamp is expressed against.
  const originTop = element.getBoundingClientRect().top;
  const boxes: RowBox[] = [];

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const range = document.createRange();
    range.selectNodeContents(node);
    if (typeof range.getClientRects !== 'function') return [];
    Array.from(range.getClientRects()).forEach((rect) => {
      if (rect.height <= 0 || rect.width <= 0) return;
      boxes.push({
        top: rect.top - originTop,
        bottom: rect.bottom - originTop,
      });
    });
  }

  // Sort before merging: text nodes are walked in document order, but inline
  // layout can still emit a later node's line above an earlier one's
  // continuation.
  boxes.sort((a, b) => a.top - b.top);

  const rows: RowBox[] = [];
  boxes.forEach((box) => {
    const previous = rows[rows.length - 1];
    // Fragments of one visual line (inline code, links, emphasis) share a top
    // to within sub-pixel rounding.
    if (previous && Math.abs(previous.top - box.top) < 1) {
      previous.bottom = Math.max(previous.bottom, box.bottom);
      return;
    }
    rows.push({ ...box });
  });
  return rows;
}

interface SuppressedFocusableAttributes {
  ariaHidden: string | null;
  tabIndex: string | null;
}

interface ClampGeometry {
  /** Offset where the mask begins fading, i.e. the cut-off row's top. */
  fadeStartPx: number;
  /** Collapsed height: just past the cut-off row. */
  maxPx: number;
}

interface RememberedMeasurement {
  clamp: ClampGeometry;
  collapsible: boolean;
}

const rememberedMeasurements = new Map<string, RememberedMeasurement>();

function rememberMeasurement(
  key: string,
  measurement: RememberedMeasurement,
): void {
  rememberedMeasurements.delete(key);
  rememberedMeasurements.set(key, measurement);
  if (rememberedMeasurements.size <= MAX_REMEMBERED_MEASUREMENTS) return;
  const oldest = rememberedMeasurements.keys().next();
  if (!oldest.done) rememberedMeasurements.delete(oldest.value);
}

interface CollapsibleUserMessageContentProps {
  children: ReactNode;
  forceExpanded?: boolean;
  /**
   * Stable identity of the message (its id). When set, the last measurement
   * is reused on remount; the ResizeObserver still re-measures afterwards.
   */
  measurementKey?: string;
}

/**
 * Expand/collapse shell for sent user-message content. When the rendered
 * blocks exceed four line boxes, the content clamps to three full-strength
 * rows plus a fourth fading out under a mask, so it reads as continuing
 * rather than ending. A "Show more" pill appears over the cut on
 * hover or keyboard focus; expanding reveals the full message with a trailing
 * "Show less".
 *
 * The toggle carries `aria-expanded`, which also opts the enclosing
 * virtualized transcript row into interaction retention (`ChatMessageList`
 * keeps rows with toggled disclosure state mounted).
 */
export const CollapsibleUserMessageContent = memo(
  function CollapsibleUserMessageContent({
    children,
    forceExpanded = false,
    measurementKey,
  }: CollapsibleUserMessageContentProps): JSX.Element {
    const contentRef = useRef<HTMLDivElement | null>(null);
    const suppressedFocusableRef = useRef(
      new Map<HTMLElement, SuppressedFocusableAttributes>(),
    );
    const [expanded, setExpanded] = useState(false);
    const [remembered] = useState(() =>
      measurementKey === undefined
        ? undefined
        : rememberedMeasurements.get(measurementKey),
    );
    const [collapsible, setCollapsible] = useState(
      remembered?.collapsible ?? false,
    );
    const [clamp, setClamp] = useState<ClampGeometry>(
      () =>
        remembered?.clamp ?? {
          fadeStartPx: FALLBACK_LINE_HEIGHT_PX * COLLAPSED_VISIBLE_ROWS,
          maxPx: FALLBACK_LINE_HEIGHT_PX * COLLAPSED_TOTAL_ROWS,
        },
    );
    const [layoutRevision, setLayoutRevision] = useState(0);

    useEffect(() => {
      const el = contentRef.current;
      if (!el) return undefined;
      const measure = (): void => {
        const rows = measureRowBoxes(el);
        // Three rows read at full strength; the fourth fades from its top down
        // to the cut, which sits just past the row.
        const cutRow = rows[COLLAPSED_TOTAL_ROWS - 1];
        let geometry: ClampGeometry;
        if (cutRow) {
          geometry = {
            fadeStartPx: cutRow.top,
            maxPx:
              cutRow.top +
              (cutRow.bottom - cutRow.top) * CUT_ROW_VISIBLE_FRACTION +
              EXTRA_REVEAL_PX,
          };
        } else {
          // Fewer rendered rows than the budget, or no range geometry at all
          // (jsdom): fall back to the flat line-height budget.
          const parsed = Number.parseFloat(
            window.getComputedStyle(el).lineHeight,
          );
          const lineHeight =
            Number.isFinite(parsed) && parsed > 0
              ? parsed
              : FALLBACK_LINE_HEIGHT_PX;
          geometry = {
            fadeStartPx: lineHeight * COLLAPSED_VISIBLE_ROWS,
            maxPx:
              lineHeight * (COLLAPSED_VISIBLE_ROWS + CUT_ROW_VISIBLE_FRACTION) +
              EXTRA_REVEAL_PX,
          };
        }
        setClamp(geometry);

        // Overflow is decided by height, not by the row count. Rows only
        // measure TEXT: a short caption above a tall image renders few line
        // boxes but is enormous, and deciding from rows alone let exactly
        // those messages — the ones most likely to be oversized, and to hide
        // their own reply once pinned — skip the clamp entirely.
        // `scrollHeight` reports the natural content height even while the
        // element is clamped by max-height, so it stays stable across
        // collapsed and expanded states.
        const slack =
          (geometry.maxPx - geometry.fadeStartPx) * OVERFLOW_TOLERANCE_ROWS;
        const nextCollapsible = el.scrollHeight > geometry.maxPx + slack;
        setCollapsible(nextCollapsible);
        if (measurementKey !== undefined) {
          rememberMeasurement(measurementKey, {
            clamp: geometry,
            collapsible: nextCollapsible,
          });
        }
        setLayoutRevision((revision) => revision + 1);
      };
      // The observer delivers an initial notification after browser layout.
      // Measuring during mount also forced layout for every prompt in a newly
      // mounted transcript, then repeated the same work in that notification.
      const observer = new ResizeObserver(measure);
      observer.observe(el);
      return (): void => observer.disconnect();
    }, [measurementKey]);

    const collapsed = collapsible && !expanded && !forceExpanded;
    const { fadeStartPx, maxPx: collapsedMaxPx } = clamp;

    useEffect(() => {
      const suppressed = suppressedFocusableRef.current;
      const restoreSuppressed = (): void => {
        suppressed.forEach((attributes, element) => {
          if (attributes.tabIndex === null) {
            element.removeAttribute('tabindex');
          } else {
            element.setAttribute('tabindex', attributes.tabIndex);
          }
          if (attributes.ariaHidden === null) {
            element.removeAttribute('aria-hidden');
          } else {
            element.setAttribute('aria-hidden', attributes.ariaHidden);
          }
        });
        suppressed.clear();
      };

      restoreSuppressed();
      const content = contentRef.current;
      if (!collapsed || !content) return undefined;

      const hiddenBoundary =
        content.getBoundingClientRect().top + collapsedMaxPx;
      content
        .querySelectorAll<HTMLElement>(FOCUSABLE_DESCENDANT_SELECTOR)
        .forEach((element) => {
          if (element.getBoundingClientRect().top < hiddenBoundary) return;
          suppressed.set(element, {
            tabIndex: element.getAttribute('tabindex'),
            ariaHidden: element.getAttribute('aria-hidden'),
          });
          element.setAttribute('tabindex', '-1');
          element.setAttribute('aria-hidden', 'true');
        });

      return restoreSuppressed;
    }, [children, collapsed, collapsedMaxPx, layoutRevision]);

    return (
      // While collapsed the wrapper cancels the bubble's bottom padding
      // (`py-1.5` in `UserBubble`), so the sliced row runs to the bubble's
      // edge instead of stopping short of it with a band of padding beneath.
      <div
        className={`group/collapse relative flex flex-col gap-1${collapsed ? ' -mb-1.5' : ''}`}
      >
        <div
          ref={contentRef}
          data-testid="user-message-content"
          data-collapsed={collapsed ? 'true' : 'false'}
          // `data-collapsed="false"` alone also covers prompts too short to
          // clamp. The sticky transcript header only bottom-pins a prompt
          // that can collapse, so it reads this to tell the two apart.
          data-collapsible={collapsible ? 'true' : undefined}
          // Published in both states: the sticky transcript header reads it to
          // compute how much of an expansion scrolls out of view before the
          // message's bottom (collapsed-sized) edge pins.
          data-collapsed-max-px={collapsedMaxPx}
          style={
            collapsed
              ? {
                  maxHeight: `${collapsedMaxPx}px`,
                  overflow: 'hidden',
                  // Fade the fourth row out instead of hard-clipping it; a
                  // mask works over any bubble tint (accent or info) without
                  // needing a matching gradient color.
                  maskImage: `linear-gradient(to bottom, rgb(0 0 0) ${fadeStartPx}px, rgb(0 0 0 / ${CUT_ROW_END_OPACITY}) ${collapsedMaxPx}px)`,
                }
              : undefined
          }
        >
          {children}
        </div>
        {collapsible && !forceExpanded && (
          // One toggle, one look, always centred — only where it sits changes.
          // Collapsed it floats over the cut row, which is half-hidden text it
          // is fine to cover. Expanded there is nothing left to cover, so it
          // moves into flow below the message instead of sitting on the last
          // line. Revealed on hover (and on keyboard focus, so it stays
          // reachable without a pointer); it holds its space either way, so
          // the reveal never shifts layout.
          <div
            className={`flex justify-center opacity-0 transition-opacity focus-within:opacity-100 group-hover/collapse:opacity-100 ${
              expanded ? '' : 'absolute inset-x-0 bottom-1'
            }`}
          >
            <Button
              size="compact"
              aria-expanded={expanded}
              data-testid={
                expanded ? 'user-message-show-less' : 'user-message-show-more'
              }
              onClick={(): void => setExpanded((value) => !value)}
            >
              {expanded ? 'Show less' : 'Show more'}
            </Button>
          </div>
        )}
      </div>
    );
  },
);
