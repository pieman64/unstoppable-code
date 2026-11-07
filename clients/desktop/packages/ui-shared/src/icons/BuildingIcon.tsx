import type { JSX } from 'react';
import {
  BuildingIcon as AppCatalogBuildingIcon,
  type AppIconProps,
} from './AppIcons';

/**
 * Office/organization building glyph. Used for the Organization entry in the
 * account menu (originally the web TopNav's icon-only mobile form, CAN-1220).
 * Monochrome; inherits `currentColor`.
 */
export function BuildingIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogBuildingIcon size="xl" aria-hidden="true" {...props} />;
}
