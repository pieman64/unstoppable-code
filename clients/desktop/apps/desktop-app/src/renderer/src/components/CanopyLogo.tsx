import type { JSX, SVGProps } from 'react';
import { BrandLogo, type BrandLogoProps } from '@/components/BrandLogo';

/**
 * @deprecated Use `BrandLogo` directly. This re-export preserves backwards
 * compatibility for callers that previously imported `CanopyLogo` and forwards
 * the legacy `SVGProps<SVGSVGElement>` shape onto the brand-aware wrapper.
 *
 * Only the props the underlying wrapper actually uses are forwarded; other
 * SVG-only attributes are intentionally dropped (the underlying SVG is now
 * inlined as brand-provided markup and is no longer authored as a React
 * element).
 */
export function CanopyLogo(
  props: SVGProps<SVGSVGElement> & { size?: number } = {},
): JSX.Element {
  const {
    className,
    size,
    width,
    height,
    style,
    'aria-hidden': ariaHidden,
    'aria-label': ariaLabel,
  } = props;

  const brandProps: BrandLogoProps = {
    className: className ?? undefined,
    size,
    width:
      typeof width === 'number' || typeof width === 'string'
        ? width
        : undefined,
    height:
      typeof height === 'number' || typeof height === 'string'
        ? height
        : undefined,
    style: style ?? undefined,
    'aria-hidden':
      typeof ariaHidden === 'boolean'
        ? ariaHidden
        : ariaHidden === 'true'
          ? true
          : ariaHidden === 'false'
            ? false
            : undefined,
    'aria-label': typeof ariaLabel === 'string' ? ariaLabel : undefined,
  };

  return <BrandLogo {...brandProps} />;
}

export { BrandLogo };
