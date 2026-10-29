import type { JSX, SVGProps } from 'react';
import { MapIcon } from './AppIcons';

export function PlanModeIcon(
  props: SVGProps<SVGSVGElement> & { active?: boolean },
): JSX.Element {
  const { active = false, ...svgProps } = props;

  return <MapIcon active={active} {...svgProps} />;
}
