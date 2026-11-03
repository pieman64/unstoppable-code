import type { CSSProperties } from 'react';

const SVG_OPEN_TAG_PATTERN = /<svg\b([^>]*)>/i;
const SVG_SIZE_ATTR_PATTERN =
  /\s(?:width|height)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi;
const SVG_PRESERVE_ASPECT_RATIO_ATTR_PATTERN = /\spreserveAspectRatio\s*=/i;
const SVG_STYLE_ATTR_PATTERN = /\sstyle\s*=\s*("[^"]*"|'[^']*')/i;

export function toCssLength(
  value: number | string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'number' ? `${value}px` : value;
}

function appendDisplayBlockStyle(attributes: string): string {
  if (!SVG_STYLE_ATTR_PATTERN.test(attributes)) {
    return `${attributes} style="display:block"`;
  }

  return attributes.replace(
    SVG_STYLE_ATTR_PATTERN,
    (_styleAttribute, quotedValue: string) => {
      const quote = quotedValue[0];
      const styleValue = quotedValue.slice(1, -1).trim();
      const separator =
        styleValue.length > 0 && !styleValue.endsWith(';') ? ';' : '';
      return ` style=${quote}${styleValue}${separator}display:block${quote}`;
    },
  );
}

export function fitSvgToWrapper(svgMarkup: string): string {
  return svgMarkup.replace(
    SVG_OPEN_TAG_PATTERN,
    (_svgTag, rawAttributes: string) => {
      let attributes = rawAttributes.replace(SVG_SIZE_ATTR_PATTERN, '');
      attributes = appendDisplayBlockStyle(attributes);

      if (!SVG_PRESERVE_ASPECT_RATIO_ATTR_PATTERN.test(attributes)) {
        attributes += ' preserveAspectRatio="xMidYMid meet"';
      }

      attributes += ' width="100%" height="100%"';
      return `<svg ${attributes.trim()}>`;
    },
  );
}

/**
 * Sizing and accessibility props a host's `BrandLogo` accepts. Hosts resolve
 * the brand themselves (the desktop brand runtime, or the web
 * `BrandProvider`) and pass its markup and name to `brandLogoWrapperProps`.
 */
export interface BrandLogoSizeProps {
  /** Placement and ink classes for the wrapper element. */
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
   * `aria-label`. Otherwise the default `aria-label="<displayName> logo"`
   * is applied.
   */
  ['aria-hidden']?: boolean;
  /** Caller-supplied aria label override; takes precedence over the default. */
  ['aria-label']?: string;
  /** Optional test id. */
  ['data-testid']?: string;
}

export interface BrandLogoWrapperInput extends BrandLogoSizeProps {
  /** The active brand's inline logo SVG markup. */
  svgContent: string;
  /** The active brand's display name, used for the default label. */
  displayName: string;
  /** Wrapper size when neither `size` nor `width`/`height` is given. */
  defaultSize: number;
}

/** Wrapper `<span>` props. Exactly one of the two label shapes is set. */
export type BrandLogoWrapperProps = {
  className: string;
  style: CSSProperties;
  'data-testid': string | undefined;
  dangerouslySetInnerHTML: { __html: string };
} & ({ 'aria-hidden': true } | { role: 'img'; 'aria-label': string });

// The wrapper's fixed geometry; only the resolved size and the caller's
// overrides stay inline.
const BRAND_LOGO_WRAPPER_CLASS_NAME =
  'inline-flex flex-none items-center justify-center overflow-hidden leading-0';

/**
 * Props for the `<span>` that holds a brand logo, shared by the desktop and
 * web `BrandLogo`. The wrapper carries the pixel size and the caller's
 * placement and ink classes, and the SVG opening tag is normalized so
 * brand-authored intrinsic dimensions cannot overflow it. Inlining the markup
 * keeps every host build identical regardless of which brand is selected.
 */
export function brandLogoWrapperProps({
  svgContent,
  displayName,
  defaultSize,
  className,
  size,
  width,
  height,
  style,
  'aria-hidden': ariaHidden,
  'aria-label': ariaLabelOverride,
  'data-testid': dataTestId,
}: BrandLogoWrapperInput): BrandLogoWrapperProps {
  const resolvedWidth =
    toCssLength(width) ?? toCssLength(size) ?? `${defaultSize}px`;
  const resolvedHeight =
    toCssLength(height) ?? toCssLength(size) ?? `${defaultSize}px`;
  const base = {
    className: className
      ? `${BRAND_LOGO_WRAPPER_CLASS_NAME} ${className}`
      : BRAND_LOGO_WRAPPER_CLASS_NAME,
    style: { width: resolvedWidth, height: resolvedHeight, ...style },
    'data-testid': dataTestId,
    dangerouslySetInnerHTML: { __html: fitSvgToWrapper(svgContent) },
  };
  if (ariaHidden) return { ...base, 'aria-hidden': true };
  return {
    ...base,
    role: 'img',
    'aria-label': ariaLabelOverride ?? `${displayName} logo`,
  };
}
