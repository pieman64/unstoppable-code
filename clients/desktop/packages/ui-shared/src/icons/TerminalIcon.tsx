import type { JSX, SVGProps } from 'react';
import { TerminalIcon as AppCatalogTerminalIcon } from './AppIcons';

export function TerminalIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogTerminalIcon width="14" height="14" {...props} />;
}
