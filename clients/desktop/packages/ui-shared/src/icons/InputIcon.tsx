import type { JSX, SVGProps } from 'react';
import { InputIcon as AppCatalogInputIcon } from './AppIcons';

export function InputIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogInputIcon width="14" height="14" {...props} />;
}
