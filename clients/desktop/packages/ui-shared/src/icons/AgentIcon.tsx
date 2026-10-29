import type { JSX, SVGProps } from 'react';
import { AgentIcon as AppCatalogAgentIcon } from './AppIcons';

export function AgentIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogAgentIcon width="14" height="14" {...props} />;
}
