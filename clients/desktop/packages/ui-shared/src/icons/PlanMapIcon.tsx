import type { JSX, SVGProps } from 'react';
import { MapIcon as AppCatalogMapIcon } from './AppIcons';

/** Shared Lucide map for planning and plan approval. */
export function PlanMapIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <AppCatalogMapIcon width="16" height="16" aria-hidden="true" {...props} />
  );
}
