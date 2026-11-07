import type { JSX } from 'react';
import {
  PipelineIcon as AppCatalogPipelineIcon,
  type AppIconProps,
} from './AppIcons';

export function PipelineIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogPipelineIcon size="sm" {...props} />;
}
