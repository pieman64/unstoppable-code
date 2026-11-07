import type { JSX } from 'react';
import {
  TerminalBorderedIcon as AppCatalogTerminalBorderedIcon,
  type AppIconProps,
} from './AppIcons';

export function TerminalBorderedIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogTerminalBorderedIcon size="sm" {...props} />;
}
