import type { JSX, SVGProps } from 'react';
import { PortalIcon as AppCatalogPortalIcon } from './AppIcons';

export function PortalIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <AppCatalogPortalIcon
      width="20"
      height="20"
      aria-hidden="true"
      {...props}
    />
  );
}
