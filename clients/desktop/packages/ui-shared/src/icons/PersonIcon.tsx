import type { JSX, SVGProps } from 'react';
import { PersonIcon as AppCatalogPersonIcon } from './AppIcons';

/**
 * Anonymous person silhouette. Used for the not-signed-in / guest account
 * avatar in place of a generic "?" glyph.
 */
export function PersonIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogPersonIcon width="14" height="14" {...props} />;
}
