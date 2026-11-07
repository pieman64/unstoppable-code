import type { JSX } from 'react';
import {
  SteerIcon as AppCatalogSteerIcon,
  type AppIconProps,
} from './AppIcons';

/** The steering glyph previously used by the queued-message Interrupt action. */
export function SteerIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogSteerIcon size="sm" aria-hidden="true" {...props} />;
}
