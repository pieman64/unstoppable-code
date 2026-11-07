import type { JSX } from 'react';
import { ChatIcon as AppCatalogChatIcon, type AppIconProps } from './AppIcons';

export function ChatIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogChatIcon size="sm" {...props} />;
}
