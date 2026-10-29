import type { JSX } from 'react';
import { SingleSignOnIcon as AppCatalogSingleSignOnIcon } from './AppIcons';

interface SingleSignOnIconProps {
  size?: number;
}

/** Brand-neutral key glyph; its labeled parent supplies the accessible name. */
export function SingleSignOnIcon({
  size = 18,
}: SingleSignOnIconProps): JSX.Element {
  return (
    <AppCatalogSingleSignOnIcon
      width={size}
      height={size}
      aria-hidden="true"
      data-testid="single-sign-on-icon"
    />
  );
}
