import type { JSX } from 'react';
import type { AppIconProps } from './AppIcons';
import { McpServerIcon } from './McpServerIcon';

export function McpIcon(props: AppIconProps): JSX.Element {
  return <McpServerIcon {...props} />;
}
