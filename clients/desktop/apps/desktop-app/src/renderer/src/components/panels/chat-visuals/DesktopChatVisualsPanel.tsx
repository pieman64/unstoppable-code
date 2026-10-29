import type { JSX } from 'react';
import { ChatVisualsPanel } from '@canopy/ui-app';
import { desktopChatVisualsKey } from '@/lib/desktop-chat-visuals-key';

export interface DesktopChatVisualsPanelProps {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

/**
 * The desktop host of the shared Chat visuals panel. The chat with this id
 * publishes its visuals under the same key, so the panel needs nothing else.
 */
export function DesktopChatVisualsPanel(
  props: DesktopChatVisualsPanelProps,
): JSX.Element {
  return <ChatVisualsPanel sourceKey={desktopChatVisualsKey(props)} />;
}
