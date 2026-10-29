import type { JSX, SVGProps } from 'react';
import { LoginIcon as AppCatalogLoginIcon } from './AppIcons';

/**
 * "Log in" glyph — an arrow entering a door. Used for the not-signed-in account
 * action, where the circular sync glyph would misleadingly imply an existing
 * synced session.
 */
export function LoginIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogLoginIcon width="14" height="14" {...props} />;
}
