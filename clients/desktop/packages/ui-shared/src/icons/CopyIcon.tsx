import type { JSX, SVGProps } from 'react';
import { CopyIcon as AppCatalogCopyIcon } from './AppIcons';

export function CopyIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogCopyIcon width="14" height="14" {...props} />;
}
