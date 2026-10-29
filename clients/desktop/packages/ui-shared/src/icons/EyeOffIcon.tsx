import type { JSX, SVGProps } from 'react';
import { EyeOffIcon as AppCatalogEyeOffIcon } from './AppIcons';

export function EyeOffIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogEyeOffIcon width="14" height="14" {...props} />;
}
