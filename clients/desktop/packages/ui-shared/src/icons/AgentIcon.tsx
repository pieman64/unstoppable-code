import type { JSX } from 'react';
import {
  AgentIcon as AppCatalogAgentIcon,
  type AppIconProps,
} from './AppIcons';

export function AgentIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogAgentIcon size="sm" {...props} />;
}
