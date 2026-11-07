import type { JSX } from 'react';
import {
  SkillIcon as AppCatalogSkillIcon,
  type AppIconProps,
} from './AppIcons';

export function SkillIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogSkillIcon size="sm" {...props} />;
}
