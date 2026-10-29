import type { JSX, SVGProps } from 'react';
import { LabelIcon as AppCatalogLabelIcon } from './AppIcons';

export function LabelIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogLabelIcon width="14" height="14" {...props} />;
}
