import type { JSX } from 'react';
import {
  PersonIcon as AppCatalogPersonIcon,
  type AppIconProps,
} from './AppIcons';

/**
 * Anonymous person silhouette. Used for the not-signed-in / guest account
 * avatar in place of a generic "?" glyph.
 */
export function PersonIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogPersonIcon size="sm" {...props} />;
}
