/**
 * @jest-environment jsdom
 */
import {
  clearRepeatTaskHistory,
  REPEAT_TASK_HISTORY_STORAGE_KEY,
  recordRepeatTask,
  repeatTaskScope,
  resolveRepeatTask,
} from '../history';
import type { RepeatTaskHistoryEntry } from '../history';
import {
  REPEAT_TASK_HISTORY_LIMIT,
  REPEAT_TASK_WINDOW_MS,
} from '../similarity';

interface MemoryStorage extends Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem'
> {
  read(): string | null;
}

function createStorage(initialValue: string | null = null): MemoryStorage {
  let value = initialValue;
  return {
    getItem: (key: string): string | null =>
      key === REPEAT_TASK_HISTORY_STORAGE_KEY ? value : null,
    setItem: (key: string, nextValue: string): void => {
      if (key === REPEAT_TASK_HISTORY_STORAGE_KEY) value = nextValue;
    },
    removeItem: (key: string): void => {
      if (key === REPEAT_TASK_HISTORY_STORAGE_KEY) value = null;
    },
    read: (): string | null => value,
  };
}

function readPersistedEntries(storage: MemoryStorage): unknown {
  const raw = storage.read();
  return raw === null ? null : JSON.parse(raw);
}

const TOKENS = ['billing', 'failures', 'service'];
const SCOPE = repeatTaskScope('account-1', 'workspace-1');

describe('repeat task history', () => {
  it('appends token signatures without persisting prompt text', () => {
    const storage = createStorage();
    const prompt = 'Summarize billing failures for every service';

    expect(
      recordRepeatTask({ scope: SCOPE, tokens: TOKENS }, 10, storage),
    ).toBe(null);
    const raw = storage.read();
    expect(raw).not.toContain(prompt);
    expect(readPersistedEntries(storage)).toEqual([
      expect.objectContaining({
        scope: SCOPE,
        tokens: ['billing', 'failures', 'service'],
        lastRunAt: 10,
      }),
    ]);
  });

  it('updates the best matching entry and offers it until explicitly resolved', () => {
    const storage = createStorage();
    recordRepeatTask({ scope: SCOPE, tokens: TOKENS }, 10, storage);

    const offer = recordRepeatTask(
      { scope: SCOPE, tokens: ['billing', 'failures', 'service'] },
      20,
      storage,
    );
    expect(offer).not.toBeNull();
    expect(readPersistedEntries(storage)).toEqual([
      expect.objectContaining({ lastRunAt: 20 }),
    ]);

    if (offer === null) throw new Error('Expected a repeat offer');
    resolveRepeatTask(offer.entryId, 25, storage);
    expect(
      recordRepeatTask({ scope: SCOPE, tokens: TOKENS }, 30, storage),
    ).toBeNull();
    expect(readPersistedEntries(storage)).toEqual([
      expect.objectContaining({ resolvedAt: 25, lastRunAt: 30 }),
    ]);
  });

  it('offers again on a repeat when an earlier unresolved offer expired unseen', () => {
    const storage = createStorage();
    recordRepeatTask({ scope: SCOPE, tokens: TOKENS }, 10, storage);

    const firstOffer = recordRepeatTask(
      { scope: SCOPE, tokens: TOKENS },
      20,
      storage,
    );
    const secondOffer = recordRepeatTask(
      { scope: SCOPE, tokens: TOKENS },
      30,
      storage,
    );

    expect(firstOffer).not.toBeNull();
    expect(secondOffer).toEqual(firstOffer);
  });

  it('matches at exactly 30 days and starts a new entry one millisecond later', () => {
    const boundaryStorage = createStorage();
    recordRepeatTask({ scope: SCOPE, tokens: TOKENS }, 0, boundaryStorage);
    expect(
      recordRepeatTask(
        { scope: SCOPE, tokens: TOKENS },
        REPEAT_TASK_WINDOW_MS,
        boundaryStorage,
      ),
    ).not.toBeNull();

    const expiredStorage = createStorage();
    recordRepeatTask({ scope: SCOPE, tokens: TOKENS }, 0, expiredStorage);
    expect(readPersistedEntries(expiredStorage)).toEqual([
      expect.objectContaining({ lastRunAt: 0 }),
    ]);
    expect(
      recordRepeatTask(
        { scope: SCOPE, tokens: TOKENS },
        REPEAT_TASK_WINDOW_MS + 1,
        expiredStorage,
      ),
    ).toBeNull();
    expect(readPersistedEntries(expiredStorage)).toEqual([
      expect.objectContaining({ lastRunAt: REPEAT_TASK_WINDOW_MS + 1 }),
    ]);
  });

  it('does not match tasks from another account or workspace', () => {
    for (const scope of [
      repeatTaskScope('account-1', 'workspace-2'),
      repeatTaskScope('account-2', 'workspace-1'),
    ]) {
      const storage = createStorage();
      recordRepeatTask({ scope: SCOPE, tokens: TOKENS }, 10, storage);
      expect(
        recordRepeatTask({ scope, tokens: TOKENS }, 20, storage),
      ).toBeNull();
      expect(readPersistedEntries(storage)).toHaveLength(2);
    }
  });

  it('keeps the newest 50 entries', () => {
    const storage = createStorage();
    for (let index = 0; index <= REPEAT_TASK_HISTORY_LIMIT; index += 1) {
      recordRepeatTask(
        {
          scope: `scope-${index}`,
          tokens: ['alpha', 'bravo', 'charlie'],
        },
        index,
        storage,
      );
    }

    const persisted: unknown = readPersistedEntries(storage);
    expect(persisted).toHaveLength(REPEAT_TASK_HISTORY_LIMIT);
    expect(persisted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ lastRunAt: 1 }),
        expect.objectContaining({ lastRunAt: REPEAT_TASK_HISTORY_LIMIT }),
      ]),
    );
    expect(persisted).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ lastRunAt: 0 })]),
    );
  });

  it('ignores malformed JSON, wrong roots, and malformed individual entries', () => {
    const malformed = createStorage('{bad json');
    expect(
      recordRepeatTask({ scope: SCOPE, tokens: TOKENS }, 10, malformed),
    ).toBe(null);

    const wrongRoot = createStorage('{"entries":[]}');
    expect(
      recordRepeatTask({ scope: SCOPE, tokens: TOKENS }, 10, wrongRoot),
    ).toBe(null);

    const validEntry: RepeatTaskHistoryEntry = {
      id: 'valid-entry',
      scope: SCOPE,
      tokens: TOKENS,
      lastRunAt: 10,
    };
    const mixed = createStorage(
      JSON.stringify([validEntry, null, { id: 'broken', tokens: [1, 2, 3] }]),
    );
    const offer = recordRepeatTask({ scope: SCOPE, tokens: TOKENS }, 20, mixed);

    expect(offer).toEqual({ entryId: 'valid-entry' });
    expect(readPersistedEntries(mixed)).toEqual([
      expect.objectContaining({ id: 'valid-entry', lastRunAt: 20 }),
    ]);
  });

  it('treats throwing storage as empty and skips failed writes', () => {
    const storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = {
      getItem: (): string => {
        throw new Error('storage unavailable');
      },
      setItem: (): void => {
        throw new Error('storage unavailable');
      },
      removeItem: (): void => {
        throw new Error('storage unavailable');
      },
    };

    expect(() =>
      recordRepeatTask({ scope: SCOPE, tokens: TOKENS }, 10, storage),
    ).not.toThrow();
    expect(() => resolveRepeatTask('missing', 20, storage)).not.toThrow();
    expect(() => clearRepeatTaskHistory(storage)).not.toThrow();
  });

  it('forgets every recorded task when cleared', () => {
    const storage = createStorage();
    recordRepeatTask({ scope: SCOPE, tokens: TOKENS }, 10, storage);
    expect(storage.read()).not.toBeNull();

    clearRepeatTaskHistory(storage);
    expect(storage.read()).toBeNull();
    expect(
      recordRepeatTask({ scope: SCOPE, tokens: TOKENS }, 20, storage),
    ).toBeNull();
  });

  it('ignores signatures shorter than the minimum token count', () => {
    const storage = createStorage();

    expect(
      recordRepeatTask(
        { scope: SCOPE, tokens: ['two', 'tokens'] },
        10,
        storage,
      ),
    ).toBeNull();
    expect(storage.read()).toBeNull();
  });
});
