import type { JSX, SVGProps } from 'react';
import { PipelineIcon as AppCatalogPipelineIcon } from './AppIcons';

export function PipelineIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogPipelineIcon width="14" height="14" {...props} />;
}
