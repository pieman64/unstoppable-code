import type { DecodedBoxModel } from './cdp-decode';

/** Tolerance, in CSS pixels, for an owner quad to count as axis-aligned. */
const AXIS_ALIGNED_TOLERANCE = 0.5;

/**
 * Whether a quad (top-left, top-right, bottom-right, bottom-left) is an
 * axis-aligned rectangle with positive width and height: not rotated,
 * skewed or mirrored.
 */
export function isAxisAlignedQuad(quad: number[]): boolean {
  const [x1, y1, x2, y2, x3, y3, x4, y4] = quad;
  if (
    x1 === undefined ||
    y1 === undefined ||
    x2 === undefined ||
    y2 === undefined ||
    x3 === undefined ||
    y3 === undefined ||
    x4 === undefined ||
    y4 === undefined
  ) {
    return false;
  }
  const near = (first: number, second: number): boolean =>
    Math.abs(first - second) <= AXIS_ALIGNED_TOLERANCE;
  return (
    near(y1, y2) &&
    near(x2, x3) &&
    near(y3, y4) &&
    near(x4, x1) &&
    x2 - x1 > AXIS_ALIGNED_TOLERANCE &&
    y4 - y1 > AXIS_ALIGNED_TOLERANCE
  );
}

/**
 * How a frame's viewport sits in its owner's document: a point `p` in the
 * frame maps to `origin + scale * p` there.
 */
export interface FrameMapping {
  originX: number;
  originY: number;
  scaleX: number;
  scaleY: number;
  /** The content box in the owner's document coordinates. */
  width: number;
  height: number;
}

/**
 * The mapping of a frame owner's `DOM.getBoxModel`: the content quad's
 * origin and the scale of the border quad over the untransformed size.
 * `transformed` for a rotated, skewed or mirrored owner.
 */
export function frameMappingOf(
  box: DecodedBoxModel,
): FrameMapping | 'transformed' | undefined {
  const content = box.content;
  if (!content) return undefined;
  if (!isAxisAlignedQuad(box.border) || !isAxisAlignedQuad(content)) {
    return 'transformed';
  }
  const borderWidth = (box.border[2] ?? 0) - (box.border[0] ?? 0);
  const borderHeight = (box.border[7] ?? 0) - (box.border[1] ?? 0);
  const scaleX = box.width > 0 ? borderWidth / box.width : 1;
  const scaleY = box.height > 0 ? borderHeight / box.height : 1;
  const originX = content[0] ?? 0;
  const originY = content[1] ?? 0;
  return {
    originX,
    originY,
    scaleX,
    scaleY,
    width: (content[2] ?? originX) - originX,
    height: (content[7] ?? originY) - originY,
  };
}
