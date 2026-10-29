import type { JSX, SVGProps } from 'react';
import { MicIcon as AppCatalogMicIcon } from './AppIcons';

export function MicIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogMicIcon width="14" height="14" {...props} />;
}
