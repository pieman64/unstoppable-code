import type { JSX } from 'react';
import {
  ScheduleIcon as AppCatalogScheduleIcon,
  type AppIconProps,
} from './AppIcons';

export function ScheduleIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogScheduleIcon size="sm" {...props} />;
}
