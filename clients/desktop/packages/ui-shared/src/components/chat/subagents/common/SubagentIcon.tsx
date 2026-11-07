import type { JSX } from 'react';
import { AgentIcon } from '../../../../icons/AgentIcon';
import type { AppIconProps } from '../../../../icons/AppIcons';

export interface SubagentIconProps {
  /** A step of the icon scale. Defaults to `sm`. */
  readonly size?: AppIconProps['size'];
  readonly className?: string;
}

/**
 * The one subagent glyph: the robot the chat's agent cards use (D28). Every
 * subagent surface renders this component instead of choosing its own icon.
 */
export function SubagentIcon({
  size = 'sm',
  className,
}: SubagentIconProps): JSX.Element {
  return <AgentIcon size={size} aria-hidden className={className} />;
}
