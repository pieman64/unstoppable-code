import type { JSX } from 'react';
import { MapIcon, type AppIconProps } from './AppIcons';

export function PlanModeIcon(props: AppIconProps): JSX.Element {
  const { active = false, ...svgProps } = props;

  return <MapIcon active={active} {...svgProps} />;
}
