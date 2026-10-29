import type { JSX, SVGProps } from 'react';
import { FailedIcon as AppCatalogFailedIcon } from './AppIcons';

export function FailedIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogFailedIcon width="12" height="12" {...props} />;
}
