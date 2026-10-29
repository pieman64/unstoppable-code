import type { JSX, SVGProps } from 'react';
import { MoreHorizontalIcon as AppCatalogMoreHorizontalIcon } from './AppIcons';

export function MoreHorizontalIcon(
  props: SVGProps<SVGSVGElement>,
): JSX.Element {
  return (
    <AppCatalogMoreHorizontalIcon
      width="14"
      height="14"
      aria-hidden="true"
      {...props}
    />
  );
}
