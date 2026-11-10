'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type MouseEvent,
} from 'react';
import { ChatIcon, CheckIcon, CopyIcon } from '@canopy/ui-shared/icons';
import { Tooltip } from '@canopy/ui-shared';
import { Button } from '@canopy/ui-shared/components';

interface TerminalSelectionMenuProps {
  /** Pixel offset from the host container's top edge. */
  top: number;
  /** Pixel offset from the host container's left edge. */
  left: number;
  onCopy: () => boolean | Promise<boolean>;
  onAddToChat?: () => void;
}

const COPIED_DURATION_MS = 1500;

const PLATFORM_MOD_LABEL =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
    ? '⌘L'
    : 'Ctrl+L';

export function TerminalSelectionMenu({
  top,
  left,
  onCopy,
  onAddToChat,
}: TerminalSelectionMenuProps): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCopiedTimer = useCallback((): void => {
    if (copiedTimerRef.current !== null) {
      clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = null;
    }
  }, []);

  useEffect((): (() => void) => clearCopiedTimer, [clearCopiedTimer]);

  // Prevent mousedown from clearing the active terminal selection before the
  // click handler can capture its text.
  const handleMouseDown = (e: MouseEvent<HTMLButtonElement>): void => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleCopyClick = (e: MouseEvent<HTMLButtonElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    void (async (): Promise<void> => {
      const success = await onCopy();
      if (!success) {
        return;
      }
      clearCopiedTimer();
      setCopied(true);
      copiedTimerRef.current = setTimeout((): void => {
        setCopied(false);
        copiedTimerRef.current = null;
      }, COPIED_DURATION_MS);
    })();
  };

  const handleAddToChatClick = (e: MouseEvent<HTMLButtonElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    if (!onAddToChat) return;
    onAddToChat();
  };

  return (
    <div
      className="absolute z-20 flex gap-0.5 overflow-hidden rounded-md bg-card/95 p-0.5 fg-primary shadow-xl backdrop-blur"
      style={{ top, left }}
    >
      <Tooltip label={copied ? 'Copied' : 'Copy the selected terminal text'}>
        <Button
          variant="ghost"
          size="compact"
          data-testid="terminal-selection-copy"
          onMouseDown={handleMouseDown}
          onClick={handleCopyClick}
          aria-label={copied ? 'Copied' : 'Copy the selected terminal text'}
        >
          {copied ? <CheckIcon size="sm" /> : <CopyIcon size="sm" />}
          <span>Copy</span>
        </Button>
      </Tooltip>
      {onAddToChat ? (
        <Tooltip label="Send the selected terminal text to the chat composer">
          <Button
            variant="ghost"
            size="compact"
            data-testid="terminal-selection-add-to-chat"
            onMouseDown={handleMouseDown}
            onClick={handleAddToChatClick}
            shortcut={PLATFORM_MOD_LABEL}
          >
            <ChatIcon size="sm" />
            <span>Send to chat</span>
          </Button>
        </Tooltip>
      ) : null}
    </div>
  );
}
