import type { JSX, SVGProps } from 'react';
import { ChatIcon as AppCatalogChatIcon } from './AppIcons';

export function ChatIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogChatIcon width="14" height="14" {...props} />;
}
