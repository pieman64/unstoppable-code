import type { JSX, SVGProps } from 'react';
import { DocumentIcon as AppCatalogDocumentIcon } from './AppIcons';

export function DocumentIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogDocumentIcon width="14" height="14" {...props} />;
}
