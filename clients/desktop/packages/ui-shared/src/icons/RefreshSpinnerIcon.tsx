import type { JSX, SVGProps } from 'react';
import { RefreshSpinnerIcon as AppCatalogRefreshSpinnerIcon } from './AppIcons';

interface RefreshSpinnerIconProps extends SVGProps<SVGSVGElement> {
  spinning?: boolean;
  size?: number;
}

/**
 * Refresh icon that optionally spins. Used as the icon glyph inside
 * {@link RefreshButton}; also re-exported as a stand-alone icon for the
 * desktop renderer's existing wrapper component.
 */
export function RefreshSpinnerIcon({
  spinning = false,
  size = 14,
  className,
  ...rest
}: RefreshSpinnerIconProps): JSX.Element {
  return (
    <AppCatalogRefreshSpinnerIcon
      width={size}
      height={size}
      spinning={spinning}
      className={className}
      {...rest}
    />
  );
}
