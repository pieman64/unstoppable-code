import { useEffect, useRef, useSyncExternalStore, type JSX } from 'react';
import type { CanopyClient } from '@canopy/app-core';
import { useProjectDeletionDiscardOffer } from '@canopy/app-state';
import type { ProjectDeletionItemDiscarded } from '@canopy/app-state/worktree-discard';
import type * as PanelModule from './ProjectDeletionDiscardPanel';

type LoadedPanel = typeof PanelModule;

// The confirmation loads with the first refused deletion, not with a route.
let loadedPanel: LoadedPanel | null = null;
let pendingLoad: Promise<LoadedPanel> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

function getSnapshot(): LoadedPanel | null {
  return loadedPanel;
}

function loadPanel(): Promise<LoadedPanel> {
  pendingLoad ??= import('./ProjectDeletionDiscardPanel').then(
    (module) => {
      loadedPanel = module;
      for (const listener of Array.from(listeners)) listener();
      return module;
    },
    (error: unknown) => {
      // Let the next refusal retry a failed chunk load.
      pendingLoad = null;
      throw error;
    },
  );
  return pendingLoad;
}

/**
 * CAN-5337: the one confirmation for discarding what keeps a project's
 * deletion from finishing, opened by `offerProjectDeletionDiscard` from a
 * refused deletion. Mounted once per host with that host's client; desktop
 * and Portal differ only in transport and in `onItemDiscarded`, the host's
 * own list and panel cleanup after each discard. Without the capability, or
 * with nothing to discard, the refusing surface keeps its own message.
 */
export function ProjectDeletionDiscardHost({
  client,
  onItemDiscarded,
}: {
  client: CanopyClient;
  onItemDiscarded: (discarded: ProjectDeletionItemDiscarded) => void;
}): JSX.Element | null {
  const supported =
    client.capabilities.projectDeletionDiscard === true &&
    client.capabilities.worktreeDiscard === true;
  const { token, offer } = useProjectDeletionDiscardOffer();
  const answered = useRef(token);
  const onItemDiscardedRef = useRef(onItemDiscarded);
  useEffect(() => {
    onItemDiscardedRef.current = onItemDiscarded;
  });
  const loaded = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (token === answered.current) return;
    answered.current = token;
    if (!offer || !supported) return;
    void loadPanel()
      .then((panel) => panel.openProjectDeletionDiscard(client, offer))
      .catch(() => undefined);
  }, [client, offer, supported, token]);
  if (!loaded || !supported) return null;
  const { ProjectDeletionDiscardPanel } = loaded;
  return (
    <ProjectDeletionDiscardPanel
      client={client}
      onItemDiscarded={(discarded) => onItemDiscardedRef.current(discarded)}
    />
  );
}
