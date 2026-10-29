import { useLayoutEffect, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import {
  ClaudeLogo,
  CodexLogo,
  CursorLogo,
  OllamaLogo,
  PlanModeIcon,
} from '../icons';
import { GitHubIcon } from '../icons/AppIcons';
import { REPLAY_BLOCK_CLASS, REPLAY_MASK_CLASS } from '../lib/replay-privacy';

export type ChatPreviewProviderType =
  | 'claude'
  | 'codex'
  | 'ollama'
  | 'cursor'
  | 'copilot'
  | 'opencode';

/**
 * Compact chat row rendered inside sidebar badge hover popovers.
 */
export interface ChatPreviewRow {
  chatId: string;
  title: string;
  providerType: ChatPreviewProviderType | undefined;
  preview: string | undefined;
  scheduledAt?: string;
  /**
   * Host-formatted schedule line (`Every hour · next 6:00 PM`,
   * `Sends Tue 9:00 AM`). When present it replaces the generic
   * `Scheduled for …` line derived from `scheduledAt`.
   */
  scheduleLabel?: string;
  /** Marks a plan-explore chat row so the popover renders a plan icon. */
  isPlan?: boolean;
}

export interface ChatPreviewPopoverProps {
  anchorRect: DOMRect;
  rows: ChatPreviewRow[];
  heading: string;
}

export function getInitialBadgePopoverPosition(anchorRect: DOMRect): {
  top: number;
  left: number;
} {
  return {
    top: anchorRect.bottom + 4,
    left: anchorRect.left,
  };
}

export function getMeasuredBadgePopoverPosition(
  anchorRect: DOMRect,
  popoverHeight: number,
  popoverWidth: number,
): { top: number; left: number } {
  const padding = 8;

  let top = anchorRect.bottom + 4;
  if (top + popoverHeight > window.innerHeight - padding) {
    top = anchorRect.top - popoverHeight - 4;
  }
  top = Math.max(padding, top);

  let left = anchorRect.left;
  left = Math.max(
    padding,
    Math.min(left, window.innerWidth - popoverWidth - padding),
  );

  return { top, left };
}

interface ChatPreviewProviderIconProps {
  providerType: ChatPreviewProviderType | undefined;
}

function ChatPreviewProviderIcon({
  providerType,
}: ChatPreviewProviderIconProps): JSX.Element {
  if (providerType === 'copilot')
    return <GitHubIcon size={12} className="fg-secondary" />;
  if (providerType === 'cursor')
    return <CursorLogo width={12} height={12} className="fg-secondary" />;
  if (providerType === 'codex') {
    return <CodexLogo width={12} height={12} className="fg-secondary" />;
  }
  if (providerType === 'ollama') {
    return <OllamaLogo width={12} height={12} className="fg-secondary" />;
  }
  return <ClaudeLogo width={12} height={12} className="fg-secondary" />;
}

function formatScheduledDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString();
}

export function ChatPreviewPopover({
  anchorRect,
  rows,
  heading,
}: ChatPreviewPopoverProps): JSX.Element {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>(
    getInitialBadgePopoverPosition(anchorRect),
  );

  useLayoutEffect((): void => {
    const el = popoverRef.current;
    if (!el) return;
    setPosition(
      getMeasuredBadgePopoverPosition(
        anchorRect,
        el.offsetHeight,
        el.offsetWidth,
      ),
    );
  }, [anchorRect]);

  // Portaled to the body, out of any parent's replay block. Chat titles are
  // recorded; each message preview is conversation content and carries its
  // own block.
  return createPortal(
    <div
      ref={popoverRef}
      className="pointer-events-none fixed z-tooltip min-w-50 max-w-75 rounded-lg bg-popover px-3 py-2 shadow-lg"
      style={{ top: position.top, left: position.left }}
    >
      <div className="mb-1 text-3xs font-semibold fg-secondary">{heading}</div>
      {rows.length === 0 ? (
        <div className="text-xs fg-secondary">No chat details</div>
      ) : (
        <div className="space-y-1.5">
          {rows.map((row) => (
            <div key={row.chatId} className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs">
                <span className="inline-flex shrink-0 items-center">
                  {row.isPlan ? (
                    <PlanModeIcon
                      width={12}
                      height={12}
                      className="fg-secondary"
                    />
                  ) : (
                    <ChatPreviewProviderIcon providerType={row.providerType} />
                  )}
                </span>
                <span
                  className={`${REPLAY_MASK_CLASS} truncate font-medium fg-primary`}
                >
                  {row.title}
                </span>
              </div>
              <div
                className={`${REPLAY_BLOCK_CLASS} truncate pl-4.5 text-3xs fg-secondary`}
              >
                {row.preview ?? 'No response yet'}
              </div>
              {row.scheduleLabel ? (
                <div className="truncate pl-4.5 text-3xs fg-secondary">
                  {row.scheduleLabel}
                </div>
              ) : (
                row.scheduledAt && (
                  <div className="truncate pl-4.5 text-3xs fg-secondary">
                    Scheduled for {formatScheduledDateTime(row.scheduledAt)}
                  </div>
                )
              )}
            </div>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}
