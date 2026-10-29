import type { JSX, SVGProps } from 'react';
import { DocumentSearchIcon as AppCatalogDocumentSearchIcon } from './AppIcons';

export function DocumentSearchIcon(
  props: SVGProps<SVGSVGElement>,
): JSX.Element {
  return <AppCatalogDocumentSearchIcon width="14" height="14" {...props} />;
}
