import type { JSX } from 'react';
import {
  brandLogoWrapperProps,
  type BrandLogoSizeProps,
} from '@canopy/ui-shared/lib';
import { brand } from '@/lib/brand';

const DEFAULT_SIZE = 24;

/**
 * BrandLogo renders the active brand's logo through the shared
 * `brandLogoWrapperProps`, the same wrapper the web `BrandLogo` renders. The
 * desktop brand runtime (`@canopy/brand/current`) exposes the inline SVG
 * markup at `brand.assets.logoSvg`.
 */
export function BrandLogo(props: BrandLogoSizeProps = {}): JSX.Element {
  return (
    <span
      {...brandLogoWrapperProps({
        ...props,
        svgContent: brand.assets.logoSvg,
        displayName: brand.displayName,
        defaultSize: DEFAULT_SIZE,
      })}
    />
  );
}
