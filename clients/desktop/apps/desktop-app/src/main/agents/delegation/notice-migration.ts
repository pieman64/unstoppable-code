import type { DelegationNoticeAckStore } from './notice-acks';
import { noticeId, type OwedNotice } from './notice-acks';

export interface LegacyDelegateWatcher {
  readonly id: string;
  readonly targets: readonly {
    readonly delegationId: string;
    readonly runGeneration: number;
    readonly resultIndex: number | null;
  }[];
  readonly delivered: boolean;
}

export async function migrateDelegateWatchersToNotices(options: {
  readonly store: DelegationNoticeAckStore;
  readonly records: readonly {
    readonly delegationId: string;
    readonly latestResultIndex: number | null;
    /** Durable results, to resolve a target whose watcher index is stale. */
    readonly results?: readonly {
      readonly runGeneration: number;
      readonly resultIndex: number;
    }[];
    /** The durable results could not be read, so a stale target is unknown. */
    readonly resultsUnavailable?: boolean;
  }[];
  readonly watchers: {
    list(): Promise<readonly LegacyDelegateWatcher[]>;
    remove(ids: readonly string[]): Promise<void>;
  };
}): Promise<{ owed: number; removed: number }> {
  const { store, records, watchers } = options;

  if (store.isBaselined()) {
    await store.flush();
    const leftoverWatchers = await watchers.list();
    const watcherIds = leftoverWatchers.map(({ id }) => id);
    await watchers.remove(watcherIds);
    return { owed: 0, removed: watcherIds.length };
  }

  // A retry reuses the first baseline: results settled since then are new.
  if (!store.isBaselineCaptured()) {
    for (const record of records) {
      if (record.latestResultIndex !== null) {
        store.acknowledge(record.delegationId, record.latestResultIndex);
      }
    }
    store.markBaselineCaptured();
  }
  let legacyWatchers: readonly LegacyDelegateWatcher[];
  try {
    legacyWatchers = await watchers.list();
  } catch (error) {
    // Persist the baseline so old results are never announced, but leave the
    // migration unmarked so the next start can still owe legacy targets.
    await store.flush();
    throw error;
  }
  const resultsByDelegation = new Map(
    records.map(({ delegationId, results }) => [delegationId, results ?? []]),
  );
  const unreadable = new Set(
    records
      .filter(({ resultsUnavailable }) => resultsUnavailable)
      .map(({ delegationId }) => delegationId),
  );
  const unresolved = legacyWatchers.some(
    ({ delivered, targets }) =>
      !delivered &&
      targets.some(
        ({ delegationId, resultIndex }) =>
          resultIndex === null && unreadable.has(delegationId),
      ),
  );
  if (unresolved) {
    // Keep every legacy watcher and stay unmarked so the next start can
    // resolve the stale target; the baseline still prevents old notices.
    await store.flush();
    throw new Error(
      'Delegate results are unavailable; the watcher migration will retry.',
    );
  }

  const owedByNoticeId = new Map<string, OwedNotice>();
  for (const watcher of legacyWatchers) {
    if (watcher.delivered) continue;
    for (const target of watcher.targets) {
      // A crash between commit and the watcher update leaves the index null.
      const resultIndex =
        target.resultIndex ??
        resultsByDelegation
          .get(target.delegationId)
          ?.filter(
            ({ runGeneration }) => runGeneration === target.runGeneration,
          )
          .reduce<number | null>(
            (latest, { resultIndex: index }) =>
              latest === null ? index : Math.max(latest, index),
            null,
          ) ??
        null;
      if (resultIndex === null) continue;
      const id = noticeId(
        target.delegationId,
        target.runGeneration,
        resultIndex,
      );
      owedByNoticeId.set(id, {
        noticeId: id,
        delegationId: target.delegationId,
        runGeneration: target.runGeneration,
        resultIndex,
      });
    }
  }

  store.owe(Array.from(owedByNoticeId.values()));
  store.markBaselined();
  await store.flush();

  const watcherIds = legacyWatchers.map(({ id }) => id);
  await watchers.remove(watcherIds);
  return { owed: owedByNoticeId.size, removed: watcherIds.length };
}
