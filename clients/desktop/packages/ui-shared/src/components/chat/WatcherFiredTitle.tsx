'use client';

import { memo, type JSX } from 'react';
import { visibleMessageParts } from '@canopy/agent-transcript';
import { AppAdvisorWatcherIcon } from '../../icons';
import type { ChatWatcherFiredInfo } from '@canopy/protocol/portal';
import { RichHoverTooltip } from '../RichHoverTooltip';

interface WatcherFiredTitleProps {
  watcherFired: ChatWatcherFiredInfo;
}

/**
 * Title line rendered above the content of watcher-generated chat messages
 * (both queued and sent), mirroring the `hook_info` "Chat initiated by …"
 * pattern: a small broadcast icon followed by
 * "<kind> watcher has fired".
 */
export const WatcherFiredTitle = memo(function WatcherFiredTitle({
  watcherFired,
}: WatcherFiredTitleProps): JSX.Element {
  const combinedWatchers = watcherFired.combinedWatchers;
  const title = combinedWatchers?.length
    ? watcherFired.kind
    : `${watcherFired.kind} watcher has fired`;
  const titleRow = (
    <span
      data-testid="watcher-fired-title"
      tabIndex={combinedWatchers?.length ? 0 : undefined}
      role={combinedWatchers?.length ? 'button' : undefined}
      className={`mb-1 flex items-center gap-1.5 text-3xs font-medium fg-info${combinedWatchers?.length ? ' cursor-help' : ''}`}
    >
      <AppAdvisorWatcherIcon width={11} height={11} className="shrink-0" />
      <span>{title}</span>
    </span>
  );

  if (!combinedWatchers?.length) return titleRow;

  return (
    <RichHoverTooltip
      interactive
      dataTestId="watcher-fired-tooltip"
      surfaceClassName="w-[min(360px,calc(100vw-16px))]"
      surfacePadding="card"
      content={
        <div
          role="region"
          aria-label="Combined watcher details"
          data-rich-tooltip-autofocus
          tabIndex={0}
          className="max-h-48 space-y-2 overflow-y-auto overscroll-contain rounded-sm pr-1 focus-ring"
        >
          {combinedWatchers.map((watcher, index) => (
            <div
              key={`${watcher.kind}-${index}`}
              className="border-b line-base pb-2 last:border-b-0 last:pb-0"
            >
              <div className="font-medium fg-info">
                {watcher.kind} watcher has fired
              </div>
              <div className="mt-0.5 whitespace-pre-wrap break-words fg-secondary">
                {watcher.text}
              </div>
            </div>
          ))}
        </div>
      }
    >
      {titleRow}
    </RichHoverTooltip>
  );
});

/**
 * How a bubble shows a fired watcher that reached the chat as one message, as
 * a host that cannot hide context (a cloud chat) delivers it: the visible
 * notice under {@link WatcherFiredTitle}, on the info tint, without the
 * instruction block the model reads. Undefined for any other message.
 */
export interface WatcherFiredPresentation {
  readonly text: string;
  readonly title: JSX.Element;
  readonly variant: 'info';
}

export function watcherFiredPresentation(
  text: string,
): WatcherFiredPresentation | undefined {
  const parts = visibleMessageParts(text);
  const watcher = parts.find((part) => part.kind === 'watcher');
  if (watcher?.kind !== 'watcher') return undefined;
  if (parts.some((part) => part.kind === 'steering_request')) return undefined;
  const notice = parts
    .flatMap((part) => (part.kind === 'text' ? [part.text] : []))
    .join('\n\n');
  return {
    text: notice.length > 0 ? notice : watcher.text,
    title: <WatcherFiredTitle watcherFired={watcher.watcherFired} />,
    variant: 'info',
  };
}
