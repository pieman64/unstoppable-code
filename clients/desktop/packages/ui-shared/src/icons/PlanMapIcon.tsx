import type { JSX } from 'react';
import { MapIcon as AppCatalogMapIcon, type AppIconProps } from './AppIcons';

/** Shared Lucide map for planning and plan approval. */
export function PlanMapIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogMapIcon size="sm" aria-hidden="true" {...props} />;
}
