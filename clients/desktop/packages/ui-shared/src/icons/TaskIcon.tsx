import type { JSX, SVGProps } from 'react';
import { TaskIcon as AppCatalogTaskIcon } from './AppIcons';

export function TaskIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogTaskIcon width="14" height="14" {...props} />;
}
