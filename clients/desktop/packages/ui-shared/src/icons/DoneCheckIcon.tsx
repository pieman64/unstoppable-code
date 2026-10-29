import type { JSX, SVGProps } from 'react';
import { CircleCheckIcon as AppCatalogCircleCheckIcon } from './AppIcons';

/** Circled Lucide checkmark for a completed sidebar item. */
export function DoneCheckIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <AppCatalogCircleCheckIcon
      width="16"
      height="16"
      aria-hidden="true"
      {...props}
    />
  );
}
