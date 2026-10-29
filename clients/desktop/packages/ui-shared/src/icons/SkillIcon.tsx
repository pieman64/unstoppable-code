import type { JSX, SVGProps } from 'react';
import { SkillIcon as AppCatalogSkillIcon } from './AppIcons';

export function SkillIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogSkillIcon width="14" height="14" {...props} />;
}
