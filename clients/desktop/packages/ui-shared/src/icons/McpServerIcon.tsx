import type { JSX } from 'react';
import {
  McpServerIcon as AppCatalogMcpServerIcon,
  type AppIconProps,
} from './AppIcons';

export function McpServerIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogMcpServerIcon size="sm" fillRule="evenodd" {...props} />;
}
