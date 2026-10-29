import type { JSX } from 'react';
import { AgentIcon } from '../../../../icons/AgentIcon';

export interface SubagentIconProps {
  /** Glyph size in pixels. Defaults to 14. */
  readonly size?: number;
  readonly className?: string;
}

/**
 * The one subagent glyph: the robot the chat's agent cards use (D28). Every
 * subagent surface renders this component instead of choosing its own icon.
 */
export function SubagentIcon({
  size = 14,
  className,
}: SubagentIconProps): JSX.Element {
  return (
    <AgentIcon width={size} height={size} aria-hidden className={className} />
  );
}
