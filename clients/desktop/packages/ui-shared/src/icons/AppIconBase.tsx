import type { JSX, SVGProps } from 'react';

export type AppIconBaseProps = SVGProps<SVGSVGElement> & {
  /** Rendered as `${size}px` width and height when numeric. Default 24. */
  size?: number | string;
  /** Hidden from assistive technology unless set to false. Default true. */
  ariaHidden?: boolean;
  /** Accessible name, applied as `aria-label` (never a `<title>` element). */
  title?: string;
  /** Catalog artwork uses the shared 14px compact / 20px regular size tiers. */
  artworkFamily?: 'lucide';
  /**
   * Renders Lucide artwork at the requested size instead of snapping it to
   * the 14px / 20px tiers, for a surface that sizes every glyph to one box.
   */
  exactSize?: boolean;
  /**
   * Lucide artwork only: the line's drawn width in CSS px at the rendered
   * size, rather than the catalog's 2 of 24 units scaled down (about 1.17px
   * at the compact 14px tier).
   */
  drawnStrokeWidth?: number;
};

function numericDimension(value: number | string | undefined): number | null {
  if (typeof value === 'number') return value;
  return typeof value === 'string' && /^\d+(?:\.\d+)?(?:px)?$/.test(value)
    ? Number.parseFloat(value)
    : null;
}

function lucideDimension(
  value: number | string | undefined,
): number | string | undefined {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+(?:\.\d+)?(?:px)?$/.test(value)
        ? Number.parseFloat(value)
        : undefined;
  return numeric === undefined ? value : numeric <= 16 ? 14 : 20;
}

/**
 * The one SVG root every app glyph renders through: generated Lucide icons
 * and brand marks, Canopy-authored glyphs, and app-local banner glyphs. It
 * paints `currentColor` by default; stroke art passes `fill="none"`.
 */
export function AppIconBase({
  children,
  size = 24,
  ariaHidden = true,
  title,
  color,
  style,
  viewBox = '0 0 24 24',
  fill = 'currentColor',
  artworkFamily,
  exactSize = false,
  drawnStrokeWidth,
  ...props
}: AppIconBaseProps): JSX.Element {
  const tiered = artworkFamily === 'lucide' && !exactSize;
  const resolvedSize = tiered
    ? lucideDimension(style?.width ?? size)
    : exactSize
      ? (style?.width ?? size)
      : size;
  const dimension =
    typeof resolvedSize === 'number' ? `${resolvedSize}px` : resolvedSize;
  // User units that draw `drawnStrokeWidth` CSS px at the rendered size.
  const renderedPx = numericDimension(resolvedSize);
  const viewBoxWidth = Number(String(viewBox).trim().split(/\s+/)[2]);
  const strokeWidth =
    drawnStrokeWidth !== undefined &&
    artworkFamily === 'lucide' &&
    renderedPx !== null &&
    renderedPx > 0 &&
    viewBoxWidth > 0
      ? (drawnStrokeWidth * viewBoxWidth) / renderedPx
      : undefined;
  return (
    <svg
      {...props}
      aria-hidden={ariaHidden}
      role={ariaHidden ? undefined : 'img'}
      aria-label={title ?? props['aria-label']}
      width={dimension}
      height={dimension}
      viewBox={viewBox}
      fill={fill}
      xmlns="http://www.w3.org/2000/svg"
      data-icon-family={artworkFamily}
      data-icon-size={
        artworkFamily === 'lucide' && exactSize ? 'exact' : undefined
      }
      style={{
        color,
        ...(strokeWidth !== undefined ? { strokeWidth } : {}),
        ...style,
        ...(tiered
          ? {
              ...(style?.width !== undefined
                ? { width: lucideDimension(style.width) }
                : {}),
              ...(style?.height !== undefined
                ? { height: lucideDimension(style.height) }
                : {}),
            }
          : {}),
      }}
    >
      {children}
    </svg>
  );
}
