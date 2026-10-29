import type { JSX, SVGProps } from 'react';
import { EyeIcon as AppCatalogEyeIcon } from './AppIcons';

export function EyeIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogEyeIcon width="14" height="14" {...props} />;
}
