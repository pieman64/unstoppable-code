import type { JSX, SVGProps } from 'react';
import { AutomationsIcon as AppCatalogAutomationsIcon } from './AppIcons';

export function AutomationsIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <AppCatalogAutomationsIcon
      width="20"
      height="20"
      aria-hidden="true"
      {...props}
    />
  );
}
