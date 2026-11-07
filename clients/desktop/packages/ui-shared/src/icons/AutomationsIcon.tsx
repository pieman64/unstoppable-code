import type { JSX } from 'react';
import {
  AutomationsIcon as AppCatalogAutomationsIcon,
  type AppIconProps,
} from './AppIcons';

export function AutomationsIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogAutomationsIcon size="xl" aria-hidden="true" {...props} />;
}
