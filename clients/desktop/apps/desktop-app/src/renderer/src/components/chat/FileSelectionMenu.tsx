import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type MouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ChatIcon,
  CheckIcon,
  CopyIcon,
  MessageIcon,
} from '@canopy/ui-shared/icons';
import { Tooltip } from '@canopy/ui-shared';

interface FileSelectionMenuProps {
  anchorRect: DOMRect;
  onSendToChat: () => void;
  onCopy: () => boolean | Promise<boolean>;
  onComment: () => void;
  onClose: () => void;
}

const COPIED_DURATION_MS = 1500;
const MENU_ESTIMATED_WIDTH = 225;
const MENU_HEIGHT = 28;
const VIEWPORT_MARGIN = 6;

function menuPosition(rect: DOMRect): { top: number; left: number } {
  const above = rect.top - MENU_HEIGHT - VIEWPORT_MARGIN;
  const below = rect.bottom + VIEWPORT_MARGIN;
  const top =
    above >= VIEWPORT_MARGIN
      ? above
      : Math.min(below, window.innerHeight - MENU_HEIGHT - VIEWPORT_MARGIN);
  return {
    top: Math.max(VIEWPORT_MARGIN, top),
    left: Math.max(
      VIEWPORT_MARGIN,
      Math.min(
        rect.right - MENU_ESTIMATED_WIDTH,
        window.innerWidth - MENU_ESTIMATED_WIDTH - VIEWPORT_MARGIN,
      ),
    ),
  };
}

/**
 * Compact action pill shown after selecting text in Monaco. It deliberately
 * mirrors the terminal selection affordance, while adding the file-specific
 * option to turn the selection into a comment thread.
 */
export function FileSelectionMenu({
  anchorRect,
  onSendToChat,
  onCopy,
  onComment,
  onClose,
}: FileSelectionMenuProps): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copied, setCopied] = useState(false);
  const { top, left } = menuPosition(anchorRect);

  const clearCopiedTimer = useCallback((): void => {
    if (copiedTimerRef.current !== null) {
      clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    const handleMouseDown = (event: globalThis.MouseEvent): void => {
      if (
        event.target instanceof Node &&
        !menuRef.current?.contains(event.target)
      ) {
        onClose();
      }
    };
    const handleKeyDown = (): void => {
      onClose();
    };
    document.addEventListener('mousedown', handleMouseDown);
    // Monaco consumes several editing shortcuts before they bubble. Capture
    // keyboard input first so any attempt to resume typing dismisses the
    // selection pill without interfering with the editor's own command.
    document.addEventListener('keydown', handleKeyDown, true);
    return (): void => {
      clearCopiedTimer();
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [clearCopiedTimer, onClose]);

  const preserveSelection = (event: MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    event.stopPropagation();
  };

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="Selected file text actions"
      data-testid="file-selection-menu"
      className="fixed z-dropdown flex overflow-hidden whitespace-nowrap rounded-md bg-card/95 text-2xs font-medium fg-primary shadow-md backdrop-blur"
      style={{ top, left }}
      onMouseDown={(event): void => event.stopPropagation()}
    >
      <Tooltip label="Send the selected file text to the chat composer">
        <button
          type="button"
          role="menuitem"
          data-testid="file-selection-send-to-chat"
          onMouseDown={preserveSelection}
          onClick={(event): void => {
            event.preventDefault();
            event.stopPropagation();
            onSendToChat();
          }}
          className="flex items-center gap-1.5 px-2 py-1 transition-colors hover:bg-accent-subtle hover:fg-accent"
        >
          <ChatIcon className="h-3 w-3" />
          <span>Send to chat</span>
        </button>
      </Tooltip>
      <Tooltip label={copied ? 'Copied' : 'Copy the selected file text'}>
        <button
          type="button"
          role="menuitem"
          data-testid="file-selection-copy"
          onMouseDown={preserveSelection}
          onClick={(event): void => {
            event.preventDefault();
            event.stopPropagation();
            void (async (): Promise<void> => {
              if (!(await onCopy())) return;
              clearCopiedTimer();
              setCopied(true);
              copiedTimerRef.current = setTimeout(() => {
                setCopied(false);
                copiedTimerRef.current = null;
              }, COPIED_DURATION_MS);
            })();
          }}
          className="flex items-center gap-1.5 border-l px-2 py-1 transition-colors hover:bg-accent-subtle hover:fg-accent"
          aria-label={copied ? 'Copied' : 'Copy the selected file text'}
        >
          {copied ? (
            <CheckIcon className="h-3 w-3" />
          ) : (
            <CopyIcon className="h-3 w-3" />
          )}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </Tooltip>
      <Tooltip label="Comment on the selected file text">
        <button
          type="button"
          role="menuitem"
          data-testid="file-selection-comment"
          onMouseDown={preserveSelection}
          onClick={(event): void => {
            event.preventDefault();
            event.stopPropagation();
            onComment();
          }}
          className="flex items-center gap-1.5 border-l px-2 py-1 transition-colors hover:bg-accent-subtle hover:fg-accent"
        >
          <MessageIcon className="h-3 w-3" />
          <span>Comment</span>
        </button>
      </Tooltip>
    </div>,
    document.body,
  );
}
