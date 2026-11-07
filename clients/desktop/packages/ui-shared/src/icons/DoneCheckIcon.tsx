import type { JSX } from 'react';
import {
  CircleCheckIcon as AppCatalogCircleCheckIcon,
  type AppIconProps,
} from './AppIcons';

/** Circled Lucide checkmark for a completed sidebar item. */
export function DoneCheckIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogCircleCheckIcon size="sm" aria-hidden="true" {...props} />;
}
