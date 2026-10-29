import type { JSX, SVGProps } from 'react';
import { PluginsIcon as AppCatalogPluginsIcon } from './AppIcons';

export function PluginsIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogPluginsIcon width="14" height="14" {...props} />;
}
