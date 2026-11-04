import { useLayoutEffect, useRef, type JSX, type RefObject } from 'react';

/**
 * `bar` holds a line of text; `circle` a person's avatar; `square` an
 * organization logo or tile; `toggle` a switch at the end of a setting row;
 * `dot` a status glyph or a radio; `badge` a 20px status pill; `control` a
 * 28px capsule field or button.
 */
export type SkeletonBlockShape =
  | 'bar'
  | 'circle'
  | 'square'
  | 'toggle'
  | 'dot'
  | 'badge'
  | 'control';

/** A bar's height, named for the text it stands in for. */
export type SkeletonBarHeight = 'meta' | 'label' | 'text' | 'title' | 'value';

/** A bar's width, as a fraction of its container. */
export type SkeletonBarWidth =
  | '1/5'
  | '1/4'
  | '1/3'
  | '2/5'
  | '1/2'
  | '3/5'
  | '2/3'
  | '3/4'
  | '5/6'
  | 'full';

const SHAPE_CLASS: Record<Exclude<SkeletonBlockShape, 'bar'>, string> = {
  circle: 'size-8 shrink-0 rounded-full',
  square: 'size-8 shrink-0 rounded-md',
  toggle: 'h-5 w-9 shrink-0 rounded-full',
  dot: 'size-3.5 shrink-0 rounded-full',
  badge: 'h-5 w-16 shrink-0 rounded-full',
  control: 'h-7 w-20 shrink-0 rounded-full',
};

const BAR_HEIGHT_CLASS: Record<SkeletonBarHeight, string> = {
  meta: 'h-2',
  label: 'h-2.5',
  text: 'h-3',
  title: 'h-3.5',
  value: 'h-5',
};

const BAR_WIDTH_CLASS: Record<SkeletonBarWidth, string> = {
  '1/5': 'w-1/5',
  '1/4': 'w-1/4',
  '1/3': 'w-1/3',
  '2/5': 'w-2/5',
  '1/2': 'w-1/2',
  '3/5': 'w-3/5',
  '2/3': 'w-2/3',
  '3/4': 'w-3/4',
  '5/6': 'w-5/6',
  full: 'w-full',
};

/**
 * A slow fade of the fill, the same pulse skullet draws on measured
 * skeletons (its slow duration and opacity floor), whose own sweep mixes a
 * highlight from a color outside the tokens. Drawn here rather than through
 * `skullet/internal`, whose entry is the whole measuring library: every page
 * with a skeleton block would download it. Measured skeletons take the same
 * motion from `--skullet-animation` in the tokens stylesheet.
 */
const PULSE_DURATION_MS = 2400;
const PULSE_FLOOR_OPACITY = 0.45;

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Starts the pulse on a mounted element. Every skeleton runs on the document
 * clock, so blocks that mount late pulse in step with the rest. The pulse
 * never runs under reduced motion, and follows the setting while the
 * skeleton is mounted: each change of the query cancels the element's pulse
 * and asks again.
 */
export function useSkeletonMotion(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const query =
      element.ownerDocument.defaultView?.matchMedia?.(REDUCED_MOTION_QUERY) ??
      null;
    const pulse = (): void => {
      for (const animation of element.getAnimations?.() ?? []) {
        animation.cancel();
      }
      if (query?.matches === true || typeof element.animate !== 'function') {
        return;
      }
      const animation = element.animate(
        [
          { opacity: 1, easing: 'ease-in-out' },
          { opacity: PULSE_FLOOR_OPACITY, easing: 'ease-in-out' },
          { opacity: 1 },
        ],
        { duration: PULSE_DURATION_MS, iterations: Infinity },
      );
      animation.startTime = 0;
    };
    pulse();
    query?.addEventListener?.('change', pulse);
    return (): void => query?.removeEventListener?.('change', pulse);
  }, [ref]);
}

export interface SkeletonBoneProps<T extends HTMLElement> {
  readonly ref: RefObject<T | null>;
  readonly 'aria-hidden': true;
  /** skullet's stylesheet fills this element with `--bg-muted`. */
  readonly 'skullet-bar': '';
}

/**
 * Props that make an element a skeleton block: the muted fill and the pulse,
 * hidden from assistive technology. Spread them on an empty element whose
 * own classes give its geometry, for the few shapes `SkeletonBlock` does not
 * name (a chart bar, a preview card's rows).
 */
export function useSkeletonBone<T extends HTMLElement>(): SkeletonBoneProps<T> {
  const ref = useRef<T>(null);
  useSkeletonMotion(ref);
  return { ref, 'aria-hidden': true, 'skullet-bar': '' };
}

export interface SkeletonBlockProps {
  readonly shape?: SkeletonBlockShape;
  /** A bar's height. Ignored by the other shapes, which own their size. */
  readonly height?: SkeletonBarHeight;
  /** A bar's width. Ignored by the other shapes, which own their size. */
  readonly width?: SkeletonBarWidth;
  /** Placement only: margin and flex participation. */
  readonly className?: string;
}

/**
 * A block that holds the place of content that has not arrived. It carries
 * no text and is hidden from assistive technology; the skeleton around it
 * owns the `role="status"` announcement. Bars are capsules, like every other
 * block that stands in for text or a control.
 */
export function SkeletonBlock({
  shape = 'bar',
  height = 'text',
  width = 'full',
  className = '',
}: SkeletonBlockProps): JSX.Element {
  const bone = useSkeletonBone<HTMLSpanElement>();
  const geometry =
    shape === 'bar'
      ? `rounded-full ${BAR_HEIGHT_CLASS[height]} ${BAR_WIDTH_CLASS[width]}`
      : SHAPE_CLASS[shape];
  return <span {...bone} className={`block ${geometry} ${className}`} />;
}
