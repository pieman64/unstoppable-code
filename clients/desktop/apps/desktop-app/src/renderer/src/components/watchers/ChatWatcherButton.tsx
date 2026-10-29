// Eye button rendered next to the fork action on a worktree chat's active turn
// (the active turn timer and the Claude terminal floating bar). Unlike
// {@link WatcherManagementButton} — which lists watchers whose *destination* is
// this chat and hides when empty — this button is always shown for an active
// turn and reflects watchers whose *target* is this chat (i.e. what is watching
// it). Clicking opens the app-level modal hosted by {@link WatcherModalHost};
// the modal (not this button) owns the open lifetime and the firing hold, so it
// stays open even after the turn ends and this button unmounts.

import { useEffect, useMemo, type JSX } from 'react';
import { WatcherEyeIcon } from '@canopy/ui-shared/icons';
import { ActionTooltip } from '@/components/shared/ActionTooltip';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';
import { useWatcherModalStore } from '@/stores/watcherModalStore';

export interface ChatWatcherButtonProps {
  projectId: string;
  worktreeId: string;
  chatId: string;
  /** Extra classes appended to the button (optional). */
  className?: string;
}

export function ChatWatcherButton({
  projectId,
  worktreeId,
  chatId,
  className,
}: ChatWatcherButtonProps): JSX.Element {
  const allWatchers = useAppAdvisorWatchersStore((s) => s.watchers);
  const openModal = useWatcherModalStore((s) => s.open);

  // Keep the watcher store hydrated/subscribed (safe to mount from multiple
  // consumers — each call mounts its own listener).
  useEffect(() => {
    const unsubscribe = useAppAdvisorWatchersStore.getState().subscribeBridge();
    void useAppAdvisorWatchersStore.getState().hydrate();
    return unsubscribe;
  }, []);

  const watchers = useMemo(
    () =>
      allWatchers.filter(
        (watcher) =>
          watcher.target.kind === 'worktree_chat' &&
          watcher.target.projectId === projectId &&
          watcher.target.worktreeId === worktreeId &&
          watcher.target.chatId === chatId &&
          (watcher.status === 'active' || watcher.status === 'delivery_failed'),
      ),
    [allWatchers, projectId, worktreeId, chatId],
  );

  const hasWatchers = watchers.length > 0;
  const buttonClasses = [
    hasWatchers
      ? 'focus-ring inline-flex h-6 items-center justify-center gap-1 rounded-md border border-fg-info/30 bg-info-subtle px-1.5 fg-info transition hover:bg-info-subtle/80'
      : 'focus-ring flex h-6 w-6 items-center justify-center rounded-md border bg-fg-primary/[0.04] fg-primary/80 transition hover:bg-fg-primary/[0.08] hover:fg-primary',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <ActionTooltip
      title="Watch this chat"
      description={
        hasWatchers
          ? 'Manage who gets notified when this chat finishes its turn.'
          : 'Notify a chat when this one finishes its turn.'
      }
    >
      <button
        type="button"
        onClick={(): void => openModal({ projectId, worktreeId, chatId })}
        aria-label="Watch this chat"
        data-testid={`chat-watcher-button-${chatId}`}
        // Footer rows keep the active-watchers info styling instead of the
        // muted icon look.
        data-attention={hasWatchers ? '' : undefined}
        className={buttonClasses}
      >
        <WatcherEyeIcon width={13} height={13} aria-hidden="true" />
        {hasWatchers && (
          <span
            data-testid={`chat-watcher-button-${chatId}-count`}
            className="text-3xs font-semibold leading-none fg-info"
          >
            {watchers.length}
          </span>
        )}
      </button>
    </ActionTooltip>
  );
}
