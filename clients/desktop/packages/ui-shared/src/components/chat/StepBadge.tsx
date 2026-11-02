import {
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { useStepTense } from '../chat-look';

/**
 * A step's file, search target or command in a small code badge (chat
 * detail `detailed`): the shared code chip on tokens, one radius, one
 * padding, mono at `text-2xs` in secondary ink. The badge shrinks with its
 * row (`min-w-0`) so its four corners and right padding always show; only
 * the text inside truncates, with one "…".
 */
export const STEP_BADGE_CLASS =
  'inline-flex min-w-0 max-w-full items-center rounded bg-subtle px-1 py-px font-mono text-2xs fg-secondary';

const ELLIPSIS = '…';

/**
 * Extra right padding, in px, that moves a CSS ellipsis off a trailing dot.
 * The browser cuts after the last character that fits; when that is a dot
 * ("file.…"), padding the box by the gap left before the dot makes the cut
 * land before it ("file…"). `width` is the text box's full width, this
 * padding included (it sits inside the box); `measure` returns a string's
 * rendered width in px. Returns 0
 * when the text fits or the cut does not land after a dot.
 */
export function dotSafeEllipsisPadding(
  text: string,
  width: number,
  measure: (value: string) => number,
): number {
  if (width <= 0 || measure(text) <= width) return 0;
  const room = width - measure(ELLIPSIS);
  // The longest prefix that fits beside the ellipsis.
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measure(text.slice(0, mid)) <= room) low = mid;
    else high = mid - 1;
  }
  let fits = low;
  if (fits === 0 || text[fits - 1] !== '.') return 0;
  while (fits > 0 && text[fits - 1] === '.') fits -= 1;
  return Math.max(0, room - measure(text.slice(0, fits)) - 0.5);
}

/** Measures a badge may take from its own resizes between line resizes. */
const OWN_RESIZE_MEASURES = 3;

let measureContext: CanvasRenderingContext2D | null | undefined;

function textMeasurer(element: HTMLElement): (value: string) => number {
  if (measureContext === undefined) {
    measureContext =
      typeof document === 'undefined'
        ? null
        : document.createElement('canvas').getContext('2d');
  }
  const context = measureContext;
  if (context === null) return (): number => 0;
  const style = getComputedStyle(element);
  context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  return (value: string): number => context.measureText(value).width;
}

export function StepBadge({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  const textRef = useRef<HTMLSpanElement>(null);
  const [padding, setPadding] = useState(0);
  // The padding on the page, read by the measure without rerunning it.
  const paddingRef = useRef(0);
  paddingRef.current = padding;
  const text = typeof children === 'string' ? children : null;
  // A finished step's verb changes length ("Reading" → "Read") and so the
  // badge's room, while the line keeps its size: measure again then too.
  const tense = useStepTense();

  useLayoutEffect(() => {
    const element = textRef.current;
    if (element === null || text === null) return undefined;
    const update = (): void => {
      // Most badges fit; only a cut one needs its text measured.
      if (
        paddingRef.current === 0 &&
        element.scrollWidth <= element.clientWidth
      )
        return;
      setPadding(
        dotSafeEllipsisPadding(
          text,
          element.clientWidth,
          textMeasurer(element),
        ),
      );
    };
    update();
    // The row's words, even when the badge sits in a label's own span.
    const line =
      element.closest('[data-step-row-words]') ??
      element.parentElement?.parentElement;
    if (typeof ResizeObserver === 'undefined' || line == null) return undefined;
    // The line resizes only with its column: measure each time it does.
    // The badge's own box also changes when a badge beside it pads, but in a
    // flex line this badge's padding changes its own share too, so measures
    // from its own box are capped until the line or the text changes.
    let ownMeasures = OWN_RESIZE_MEASURES;
    const lineObserver = new ResizeObserver(() => {
      ownMeasures = OWN_RESIZE_MEASURES;
      update();
    });
    const ownObserver = new ResizeObserver(() => {
      if (ownMeasures === 0) return;
      ownMeasures -= 1;
      update();
    });
    lineObserver.observe(line);
    ownObserver.observe(element);
    return (): void => {
      lineObserver.disconnect();
      ownObserver.disconnect();
    };
  }, [text, tense]);

  return (
    <code className={STEP_BADGE_CLASS} data-step-badge="">
      <span
        ref={textRef}
        className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
        style={padding > 0 ? { paddingRight: `${padding}px` } : undefined}
      >
        {children}
      </span>
    </code>
  );
}
