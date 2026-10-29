import type { JSX, SVGProps } from 'react';
import { TerminalBorderedIcon as AppCatalogTerminalBorderedIcon } from './AppIcons';

export function TerminalBorderedIcon(
  props: SVGProps<SVGSVGElement>,
): JSX.Element {
  return <AppCatalogTerminalBorderedIcon width="14" height="14" {...props} />;
}
