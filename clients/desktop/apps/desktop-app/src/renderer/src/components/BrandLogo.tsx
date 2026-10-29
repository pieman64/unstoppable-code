import type { CSSProperties, JSX } from 'react';
import { fitSvgToWrapper, toCssLength } from '@canopy/ui-shared/lib';
import { brand } from '@/lib/brand';

/**
 * BrandLogo renders the active brand's logo SVG inside a sizing wrapper.
 *
 * The desktop brand runtime (`@canopy/brand/current`) exposes the inline SVG
 * markup at `brand.assets.logoSvg`. The wrapper `<span>` carries the actual
 * pixel size and className overrides supplied by the call site, and the SVG
 * opening tag is normalized so brand-authored intrinsic dimensions cannot
 * overflow that wrapper.
 *
 * Using `dangerouslySetInnerHTML` avoids a Vite SVG-as-component loader and
 * keeps the renderer build identical regardless of which brand is selected.
 */
export interface BrandLogoProps {
  /** Optional class overrides forwarded to the wrapper element. */
  className?: string;
  /** Pixel size for both width and height. Mutually exclusive with width/height. */
  size?: number;
  /** Wrapper width override. Number is treated as pixels. */
  width?: number | string;
  /** Wrapper height override. Number is treated as pixels. */
  height?: number | string;
  /** Optional inline-style overrides merged with the size styles. */
  style?: CSSProperties;
  /**
   * When `true`, the wrapper renders with `aria-hidden="true"` and no
   * `aria-label`. Otherwise the default `aria-label="${brand.displayName} logo"`
   * is applied.
   */
  ['aria-hidden']?: boolean;
  /** Caller-supplied aria label override; takes precedence over the default. */
  ['aria-label']?: string;
  /** Optional test id. */
  ['data-testid']?: string;
}

const DEFAULT_SIZE = 24;

// The wrapper's fixed geometry; only the resolved size and the caller's
// overrides stay inline.
const WRAPPER_CLASS_NAME =
  'inline-flex flex-none items-center justify-center overflow-hidden leading-0';

export function BrandLogo({
  className,
  size,
  width,
  height,
  style,
  'aria-hidden': ariaHidden,
  'aria-label': ariaLabelOverride,
  'data-testid': dataTestId,
}: BrandLogoProps = {}): JSX.Element {
  const resolvedWidth =
    toCssLength(width) ?? toCssLength(size) ?? `${DEFAULT_SIZE}px`;
  const resolvedHeight =
    toCssLength(height) ?? toCssLength(size) ?? `${DEFAULT_SIZE}px`;

  const wrapperStyle: CSSProperties = {
    width: resolvedWidth,
    height: resolvedHeight,
    ...style,
  };

  const accessibilityProps = ariaHidden
    ? ({ 'aria-hidden': true } as const)
    : ({
        role: 'img',
        'aria-label': ariaLabelOverride ?? `${brand.displayName} logo`,
      } as const);

  return (
    <span
      className={
        className ? `${WRAPPER_CLASS_NAME} ${className}` : WRAPPER_CLASS_NAME
      }
      style={wrapperStyle}
      data-testid={dataTestId}
      {...accessibilityProps}
      dangerouslySetInnerHTML={{
        __html: fitSvgToWrapper(brand.assets.logoSvg),
      }}
    />
  );
}
