import type { JSX, SVGProps } from 'react';
import { HookIcon as AppCatalogHookIcon } from './AppIcons';

export function HookIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogHookIcon width="14" height="14" {...props} />;
}
