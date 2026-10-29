import type { JSX } from 'react';
import { DownloadIcon } from '@canopy/ui-shared/icons/AppIcons';

/**
 * Marks the element that takes a file drop for its chat: the chat's whole
 * area, transcript and composer together. While files are dragged over it the
 * area dims under {@link ChatDropOverlay}, and a drop anywhere on it attaches
 * them to the composer. Each chat in a split marks its own area, so only the
 * one under the pointer lights up.
 */
export const CHAT_DROP_ZONE_ATTRIBUTE = 'data-chat-drop-zone';

/**
 * The chat area while files are dragged over it: the area dims, with the
 * drop's outcome in the middle. It lets pointer events through, so the drag
 * keeps reaching the elements under it.
 */
export function ChatDropOverlay(): JSX.Element {
  return (
    <div
      data-testid="chat-drop-overlay"
      aria-hidden
      className="pointer-events-none absolute inset-0 z-40 flex flex-col items-center justify-center gap-2 bg-overlay-scrim fg-emphasis"
    >
      <DownloadIcon width={24} height={24} />
      <span className="text-s font-medium">Drop files to attach</span>
    </div>
  );
}
