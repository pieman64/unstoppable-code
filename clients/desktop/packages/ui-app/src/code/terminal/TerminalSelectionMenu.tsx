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
      className="absolute z-20 flex overflow-hidden rounded-md bg-card/95 text-2xs font-medium fg-primary shadow-md backdrop-blur"
      style={{ top, left }}
    >
      <Tooltip label={copied ? 'Copied' : 'Copy the selected terminal text'}>
        <button
          type="button"
          data-testid="terminal-selection-copy"
          onMouseDown={handleMouseDown}
          onClick={handleCopyClick}
          className="flex items-center gap-1.5 px-2 py-1 transition-colors hover:bg-accent-subtle hover:fg-accent"
          aria-label={copied ? 'Copied' : 'Copy the selected terminal text'}
        >
          {copied ? (
            <CheckIcon className="h-3 w-3" />
          ) : (
            <CopyIcon className="h-3 w-3" />
          )}
          <span>Copy</span>
        </button>
      </Tooltip>
      {onAddToChat ? (
        <Tooltip label="Send the selected terminal text to the chat composer">
          <button
            type="button"
            data-testid="terminal-selection-add-to-chat"
            onMouseDown={handleMouseDown}
            onClick={handleAddToChatClick}
            className="flex items-center gap-1.5 border-l px-2 py-1 transition-colors hover:bg-accent-subtle hover:fg-accent"
          >
            <ChatIcon className="h-3 w-3" />
            <span>Send to chat</span>
            <span className="rounded border bg-muted/60 px-1 py-px text-3xs font-normal fg-secondary">
              {PLATFORM_MOD_LABEL}
            </span>
          </button>
        </Tooltip>
      ) : null}
    </div>
  );
}
