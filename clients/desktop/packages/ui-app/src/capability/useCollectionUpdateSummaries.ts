import { useEffect, useMemo, useRef, useState } from 'react';
import type { UnifiedPluginEntry } from '@canopy/ui-shared/lib';
import {
  summarizeCollectionUpdate,
  type CollectionUpdatePorts,
} from './collectionUpdateSummary';

const MAX_CANDIDATES = 100;
const CONCURRENCY = 4;

function countsOf(entry: UnifiedPluginEntry): {
  skills: number;
  plugins: number;
} {
  return {
    skills: entry.components.skills,
    plugins: entry.components.plugins ?? 0,
  };
}

function fallback(entry: UnifiedPluginEntry): string {
  return summarizeCollectionUpdate({
    localCounts: countsOf(entry),
    liveCounts: entry.sharedSource?.latestItemCounts,
  });
}

/** Bounded comparison loads, fenced by context, local snapshot and live revision. */
export function useCollectionUpdateSummaries(
  entries: readonly UnifiedPluginEntry[],
  ports: CollectionUpdatePorts | null,
): ReadonlyMap<string, string> {
  const candidates = useMemo(
    () =>
      entries.flatMap((entry) => {
        const source = entry.sharedSource;
        if (
          entry.kind !== 'collection' ||
          entry.updateAvailable !== true ||
          entry.ref.type !== 'local-collection' ||
          !source?.remoteId
        )
          return [];
        return [
          {
            entry,
            collectionId: entry.ref.collectionId,
            remoteId: source.remoteId,
            key: JSON.stringify([
              ports?.contextKey,
              ports?.refreshKey,
              entry.id,
              entry.collectionRevision,
              source.remoteId,
              source.installedContentHash,
              source.latestContentHash,
              source.sharedBy,
              countsOf(entry),
              source.latestItemCounts,
            ]),
          },
        ];
      }),
    [entries, ports?.contextKey, ports?.refreshKey],
  );
  // A stable description prevents ordinary rerenders from restarting requests.
  const signature = JSON.stringify(
    candidates.map((candidate) => candidate.key),
  );
  const [loaded, setLoaded] = useState<{
    ports: CollectionUpdatePorts;
    signature: string;
    summaries: ReadonlyMap<string, string>;
  } | null>(null);
  const stableCandidates = useMemo(
    () => candidates.slice(0, MAX_CANDIDATES),
    // Requests depend on the complete serialized candidate identity above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature],
  );

  const reportedMismatches = useRef(new Set<string>());
  useEffect(() => {
    if (!ports) return;
    const activePorts = ports;
    let cancelled = false;
    let cursor = 0;
    let mismatchReported = false;
    const summaries = new Map<string, string>();
    const liveLoads = new Map<
      string,
      ReturnType<CollectionUpdatePorts['loadSharedDocument']>
    >();
    async function worker(): Promise<void> {
      while (!cancelled) {
        const candidate = stableCandidates[cursor++];
        if (!candidate) return;
        const { entry, remoteId, collectionId, key } = candidate;
        const liveKey = JSON.stringify([
          remoteId,
          entry.sharedSource?.latestContentHash,
        ]);
        try {
          let liveLoad = liveLoads.get(liveKey);
          if (!liveLoad) {
            liveLoad = activePorts.loadSharedDocument(remoteId);
            liveLoads.set(liveKey, liveLoad);
          }
          const [localMembers, live] = await Promise.all([
            activePorts.loadLocalMembers(collectionId),
            liveLoad,
          ]);
          if (cancelled || !localMembers || !live) continue;
          const localRevision = localMembers.revision ?? localMembers.updatedAt;
          if (
            live.id !== remoteId ||
            live.contentHash !== entry.sharedSource?.latestContentHash ||
            (entry.collectionRevision !== undefined &&
              localRevision !== undefined &&
              entry.collectionRevision !== localRevision)
          ) {
            const mismatchKey = JSON.stringify([
              activePorts.contextKey,
              remoteId,
              entry.sharedSource?.latestContentHash,
              live.contentHash,
              entry.collectionRevision,
              localRevision,
            ]);
            if (
              !mismatchReported &&
              !reportedMismatches.current.has(mismatchKey)
            ) {
              mismatchReported = true;
              reportedMismatches.current.add(mismatchKey);
              if (reportedMismatches.current.size > MAX_CANDIDATES) {
                const oldest = reportedMismatches.current.values().next().value;
                if (oldest !== undefined)
                  reportedMismatches.current.delete(oldest);
              }
              activePorts.onRevisionMismatch?.();
            }
            continue;
          }
          summaries.set(
            key,
            summarizeCollectionUpdate({
              localMembers,
              live: live.collection,
              sharerName: entry.sharedSource?.sharedBy,
              localCounts: countsOf(entry),
              liveCounts: entry.sharedSource?.latestItemCounts,
            }),
          );
          if (!cancelled)
            setLoaded({
              ports: activePorts,
              signature,
              summaries: new Map(summaries),
            });
        } catch {
          // Explicit refresh or a changed context/revision retries failed reads.
        }
      }
    }
    for (let i = 0; i < Math.min(CONCURRENCY, stableCandidates.length); i++)
      void worker();
    return (): void => {
      cancelled = true;
    };
  }, [ports, signature, stableCandidates]);

  return useMemo(
    () =>
      new Map(
        candidates.map(({ entry, key }) => [
          entry.id,
          ports && loaded?.ports === ports && loaded.signature === signature
            ? (loaded.summaries.get(key) ?? fallback(entry))
            : fallback(entry),
        ]),
      ),
    [candidates, ports, loaded, signature],
  );
}
