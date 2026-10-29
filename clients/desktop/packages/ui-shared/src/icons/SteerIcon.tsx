import type { JSX, SVGProps } from 'react';
import { SteerIcon as AppCatalogSteerIcon } from './AppIcons';

/** The steering glyph previously used by the queued-message Interrupt action. */
export function SteerIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <AppCatalogSteerIcon width="16" height="16" aria-hidden="true" {...props} />
  );
}
