import { useEffect, useRef, useSyncExternalStore, type JSX } from 'react';
import type { CanopyClient } from '@canopy/app-core';
import { useLifecycleJournalQuarantineRequest } from '@canopy/app-state';
import type * as ReviewModule from './LifecycleJournalQuarantineReview';

export { LIFECYCLE_JOURNAL_QUARANTINE_TEST_ID } from './test-ids';

type LoadedReview = typeof ReviewModule;

// The review and its store load with the first refusal, not with every route.
// A manual `import()`, not `React.lazy`: no Suspense fallback holds the
// dialog back once the inspection has answered.
let loadedReview: LoadedReview | null = null;
let pendingLoad: Promise<LoadedReview> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

function getSnapshot(): LoadedReview | null {
  return loadedReview;
}

function loadReview(): Promise<LoadedReview> {
  pendingLoad ??= import('./LifecycleJournalQuarantineReview').then(
    (module) => {
      loadedReview = module;
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
 * CAN-5335: the one review of an unreadable destructive lifecycle journal,
 * opened by `offerLifecycleJournalQuarantine` from any deletion or archive
 * refusal. Mounted once per host with that host's client; desktop and Portal
 * differ only in transport.
 */
export function LifecycleJournalQuarantineHost({
  client,
}: {
  client: CanopyClient;
}): JSX.Element | null {
  const supported = client.capabilities.lifecycleJournalQuarantine === true;
  const request = useLifecycleJournalQuarantineRequest();
  const answered = useRef(request);
  const loaded = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (request === answered.current) return;
    answered.current = request;
    if (!supported) return;
    // Opens the client's store, not this mount, so a remount mid-load keeps
    // the request. A failed load leaves the refusal's own message; the next
    // refusal retries.
    loadReview().then(
      (review) => review.openLifecycleJournalQuarantineReview(client),
      () => undefined,
    );
  }, [client, request, supported]);
  if (!loaded) return null;
  const { LifecycleJournalQuarantineReview } = loaded;
  return (
    <LifecycleJournalQuarantineReview client={client} supported={supported} />
  );
}
