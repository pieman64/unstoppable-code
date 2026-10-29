import type { JSX, SVGProps } from 'react';
import { MoreVerticalIcon as AppCatalogMoreVerticalIcon } from './AppIcons';

export function MoreVerticalIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <AppCatalogMoreVerticalIcon
      width="14"
      height="14"
      aria-hidden="true"
      {...props}
    />
  );
}
