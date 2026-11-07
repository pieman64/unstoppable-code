import type { JSX } from 'react';
import {
  TerminalIcon as AppCatalogTerminalIcon,
  type AppIconProps,
} from './AppIcons';

export function TerminalIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogTerminalIcon size="sm" {...props} />;
}
