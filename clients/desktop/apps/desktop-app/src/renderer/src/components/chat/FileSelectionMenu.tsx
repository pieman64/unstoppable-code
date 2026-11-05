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
import { Button } from '@canopy/ui-shared/components';

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
      className="fixed z-dropdown flex whitespace-nowrap rounded-full bg-card/95 shadow-md backdrop-blur"
      style={{ top, left }}
      onMouseDown={(event): void => event.stopPropagation()}
    >
      <Tooltip label="Send the selected file text to the chat composer">
        <Button
          variant="ghost"
          size="compact"
          role="menuitem"
          data-testid="file-selection-send-to-chat"
          onMouseDown={preserveSelection}
          onClick={(event): void => {
            event.preventDefault();
            event.stopPropagation();
            onSendToChat();
          }}
        >
          <ChatIcon aria-hidden="true" />
          <span>Send to chat</span>
        </Button>
      </Tooltip>
      <Tooltip label={copied ? 'Copied' : 'Copy the selected file text'}>
        <Button
          variant="ghost"
          size="compact"
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
          aria-label={copied ? 'Copied' : 'Copy the selected file text'}
        >
          {copied ? (
            <CheckIcon aria-hidden="true" />
          ) : (
            <CopyIcon aria-hidden="true" />
          )}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </Button>
      </Tooltip>
      <Tooltip label="Comment on the selected file text">
        <Button
          variant="ghost"
          size="compact"
          role="menuitem"
          data-testid="file-selection-comment"
          onMouseDown={preserveSelection}
          onClick={(event): void => {
            event.preventDefault();
            event.stopPropagation();
            onComment();
          }}
        >
          <MessageIcon aria-hidden="true" />
          <span>Comment</span>
        </Button>
      </Tooltip>
    </div>,
    document.body,
  );
}
