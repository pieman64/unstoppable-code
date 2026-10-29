import type { JSX, SVGProps } from 'react';
import { McpServerIcon as AppCatalogMcpServerIcon } from './AppIcons';

export function McpServerIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <AppCatalogMcpServerIcon
      width="14"
      height="14"
      fillRule="evenodd"
      {...props}
    />
  );
}
