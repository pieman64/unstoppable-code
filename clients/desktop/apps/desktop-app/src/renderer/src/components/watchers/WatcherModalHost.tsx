// App-level host for the "watch this chat" modal. Mounted once so the modal
// survives the {@link ChatWatcherButton} unmounting when its turn ends — the
// button is only visible during an active turn, but the modal must stay open
// until the user closes it. Open/close (and the firing hold/release) are driven
// by `watcherModalStore`.

import { useEffect, useMemo, type JSX } from 'react';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';
import { useWatcherModalStore } from '@/stores/watcherModalStore';
import { WatcherManagementModal } from './WatcherManagementModal';
import type { WatcherManagementModalAddConfig } from './WatcherManagementModal';
import { useWatcherRecipientGroups } from './useWatcherRecipientGroups';

export function WatcherModalHost(): JSX.Element {
  const target = useWatcherModalStore((s) => s.target);
  const close = useWatcherModalStore((s) => s.close);
  const allWatchers = useAppAdvisorWatchersStore((s) => s.watchers);
  const recipientGroups = useWatcherRecipientGroups();

  // Keep the watcher store hydrated/subscribed so the list and created watchers
  // stay in sync even if no other consumer is mounted.
  useEffect(() => {
    const unsubscribe = useAppAdvisorWatchersStore.getState().subscribeBridge();
    void useAppAdvisorWatchersStore.getState().hydrate();
    return unsubscribe;
  }, []);

  const watchers = useMemo(() => {
    if (!target) return [];
    return allWatchers.filter(
      (watcher) =>
        watcher.target.kind === 'worktree_chat' &&
        watcher.target.projectId === target.projectId &&
        watcher.target.worktreeId === target.worktreeId &&
        watcher.target.chatId === target.chatId &&
        (watcher.status === 'active' || watcher.status === 'delivery_failed'),
    );
  }, [allWatchers, target]);

  const add = useMemo<WatcherManagementModalAddConfig | null>(() => {
    if (!target) return null;
    // A destination that already has a watcher on this chat would just dedupe,
    // so drop it from the "add" picker. Deleting that watcher updates
    // `watchers`, which recomputes this and returns the destination to the
    // dropdown so it can be re-added.
    const watchedDestinationKeys = new Set(
      watchers.map(
        (watcher) =>
          `${watcher.destination.projectId}/${watcher.destination.worktreeId}/${watcher.destination.chatId}`,
      ),
    );
    const availableRecipientGroups = recipientGroups.map((group) => ({
      ...group,
      options: group.options.filter(
        (option) =>
          !watchedDestinationKeys.has(
            `${option.destination.projectId}/${option.destination.worktreeId}/${option.destination.chatId}`,
          ),
      ),
    }));
    return {
      trigger: 'worktree_chat_completion',
      target: { kind: 'worktree_chat', ...target },
      recipientGroups: availableRecipientGroups,
      heading: 'Watch this chat',
      description:
        'Notify an App Advisor chat when this chat finishes its current turn.',
    };
  }, [target, recipientGroups, watchers]);

  if (!target || !add) return <></>;

  return (
    <WatcherManagementModal
      title="Chat watchers"
      emptyMessage="No watchers are watching this chat yet."
      watchers={watchers}
      onClose={close}
      add={add}
      allowEditFollowUp
    />
  );
}
