const mockReadFile = jest.fn<Promise<string>, [string, string]>();
const mockWriteFile = jest.fn<Promise<void>, [string, string, string]>();
const mockMkdir = jest.fn<Promise<void>, [string, { recursive: boolean }]>();

jest.mock('node:fs/promises', () => ({
  mkdir: (path: string, options: { recursive: boolean }): Promise<void> =>
    mockMkdir(path, options),
  readFile: (path: string, encoding: string): Promise<string> =>
    mockReadFile(path, encoding),
  writeFile: (
    path: string,
    contents: string,
    encoding: string,
  ): Promise<void> => mockWriteFile(path, contents, encoding),
}));

// Mirrors the real `getOnboardingChecklistFilePath()` shape
// (`<dataDir>/onboarding-checklist.json`) so assertions pin the filename and
// parent directory the production helper resolves.
const mockDataDir = '/mock/data-dir';
const mockFilePath = `${mockDataDir}/onboarding-checklist.json`;

jest.mock('../lib/paths', () => ({
  getOnboardingChecklistFilePath: (): string => mockFilePath,
}));

import {
  latchOnboardingChecklistItemComplete,
  readOnboardingChecklistPersistedState,
  resetOnboardingChecklistStateForTests,
  setOnboardingChecklistDismissedAt,
  setOnboardingChecklistProviderNotUsed,
  setOnboardingChecklistSnoozedUntil,
} from '../lib/onboarding-checklist-state';

function enoent(): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error('ENOENT');
  error.code = 'ENOENT';
  return error;
}

async function flushWrites(): Promise<void> {
  // The module serializes best-effort writes behind mutation resolution;
  // yield a few microtask turns so pending writeFile calls land.
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  resetOnboardingChecklistStateForTests();
  mockMkdir.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);
  mockReadFile.mockRejectedValue(enoent());
});

describe('readOnboardingChecklistPersistedState', () => {
  it('returns empty defaults when the file is missing', async () => {
    const state = await readOnboardingChecklistPersistedState();
    expect(state).toEqual({
      completedItems: {},
      dismissedAt: null,
      snoozedUntil: null,
      providersNotUsed: [],
    });
  });

  it('returns empty defaults for corrupt JSON', async () => {
    mockReadFile.mockResolvedValue('{not json');
    const state = await readOnboardingChecklistPersistedState();
    expect(state.completedItems).toEqual({});
    expect(state.providersNotUsed).toEqual([]);
  });

  it('returns empty defaults for an unknown version', async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ version: 99, completedItems: { 'start-chat': 'x' } }),
    );
    const state = await readOnboardingChecklistPersistedState();
    expect(state.completedItems).toEqual({});
  });

  it('keeps known entries and drops unknown item ids and providers', async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        updatedAt: '2026-08-25T00:00:00.000Z',
        completedItems: {
          'start-chat': '2026-08-25T00:00:00.000Z',
          'not-a-real-item': '2026-08-25T00:00:00.000Z',
          // A latch written before CAN-2663 retired the item. Dropping it
          // silently is the required behavior: these files are on disk for
          // every existing user, and throwing would strand the whole
          // checklist rather than one dead row.
          'run-pipeline': '2026-08-25T00:00:00.000Z',
          'add-capability': 42,
        },
        dismissedAt: '2026-08-24T00:00:00.000Z',
        snoozedUntil: null,
        providersNotUsed: ['linear', 'not-a-provider', 'linear'],
      }),
    );
    const state = await readOnboardingChecklistPersistedState();
    expect(state.completedItems).toEqual({
      'start-chat': '2026-08-25T00:00:00.000Z',
    });
    expect(state.dismissedAt).toBe('2026-08-24T00:00:00.000Z');
    expect(state.snoozedUntil).toBeNull();
    expect(state.providersNotUsed).toEqual(['linear']);
  });
});

describe('latchOnboardingChecklistItemComplete', () => {
  it('persists a new latch with the versioned envelope and reports change', async () => {
    const result =
      await latchOnboardingChecklistItemComplete('connect-accounts');
    expect(result.changed).toBe(true);
    expect(result.state.completedItems['connect-accounts']).toEqual(
      expect.any(String),
    );
    await flushWrites();
    expect(mockMkdir).toHaveBeenCalledWith(mockDataDir, { recursive: true });
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const [path, contents, encoding] = mockWriteFile.mock.calls[0];
    expect(path).toBe(mockFilePath);
    expect(encoding).toBe('utf8');
    expect(contents.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(contents) as {
      version: number;
      completedItems: Record<string, unknown>;
      dismissedAt: string | null;
      snoozedUntil: string | null;
      providersNotUsed: string[];
    };
    expect(parsed.version).toBe(1);
    expect(typeof parsed.completedItems['connect-accounts']).toBe('string');
    expect(parsed.dismissedAt).toBeNull();
    expect(parsed.snoozedUntil).toBeNull();
    expect(parsed.providersNotUsed).toEqual([]);
  });

  it('is idempotent: a second latch reports no change and writes nothing', async () => {
    await latchOnboardingChecklistItemComplete('connect-accounts');
    await flushWrites();
    mockWriteFile.mockClear();
    const result =
      await latchOnboardingChecklistItemComplete('connect-accounts');
    expect(result.changed).toBe(false);
    await flushWrites();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});

describe('visibility mutations', () => {
  it('persists dismissal and clears it on restore', async () => {
    const dismissed = await setOnboardingChecklistDismissedAt(
      '2026-08-25T12:00:00.000Z',
    );
    expect(dismissed.state.dismissedAt).toBe('2026-08-25T12:00:00.000Z');
    const restored = await setOnboardingChecklistDismissedAt(null);
    expect(restored.state.dismissedAt).toBeNull();
  });

  it('persists snooze deadlines', async () => {
    const result = await setOnboardingChecklistSnoozedUntil(
      '2026-09-01T00:00:00.000Z',
    );
    expect(result.state.snoozedUntil).toBe('2026-09-01T00:00:00.000Z');
  });

  it('adds and removes provider not-used marks without duplicates', async () => {
    await setOnboardingChecklistProviderNotUsed('linear', true);
    const second = await setOnboardingChecklistProviderNotUsed('linear', true);
    expect(second.state.providersNotUsed).toEqual(['linear']);
    expect(second.changed).toBe(false);
    const removed = await setOnboardingChecklistProviderNotUsed(
      'linear',
      false,
    );
    expect(removed.state.providersNotUsed).toEqual([]);
    expect(removed.changed).toBe(true);
  });
});

describe('concurrent mutations', () => {
  it('persists every latch when several items complete concurrently', async () => {
    // computeOnboardingChecklistState() latches newly complete items via
    // Promise.all, so concurrent mutations must serialize instead of
    // cloning the same base state and losing all but the last write.
    await Promise.all([
      latchOnboardingChecklistItemComplete('start-chat'),
      latchOnboardingChecklistItemComplete('connect-accounts'),
      latchOnboardingChecklistItemComplete('add-capability'),
    ]);
    const state = await readOnboardingChecklistPersistedState();
    expect(Object.keys(state.completedItems).sort()).toEqual([
      'add-capability',
      'connect-accounts',
      'start-chat',
    ]);
    await flushWrites();
    const writeCalls = mockWriteFile.mock.calls;
    expect(writeCalls.length).toBeGreaterThan(0);
    const persisted = JSON.parse(writeCalls[writeCalls.length - 1][1]) as {
      completedItems: Record<string, unknown>;
    };
    expect(Object.keys(persisted.completedItems).sort()).toEqual([
      'add-capability',
      'connect-accounts',
      'start-chat',
    ]);
  });

  it('serializes a mutation racing the initial disk load', async () => {
    let releaseRead: ((value: string) => void) | null = null;
    mockReadFile.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          releaseRead = resolve;
        }),
    );
    const first = latchOnboardingChecklistItemComplete('start-chat');
    const second = latchOnboardingChecklistItemComplete('connect-accounts');
    // The serialized chain starts the disk read asynchronously; wait for it
    // before releasing so the latches genuinely race the pending load.
    let release: ((value: string) => void) | null = releaseRead;
    while (release === null) {
      await Promise.resolve();
      release = releaseRead;
    }
    release(
      JSON.stringify({
        version: 1,
        completedItems: { 'add-capability': '2026-08-01T00:00:00.000Z' },
        dismissedAt: null,
        snoozedUntil: null,
        providersNotUsed: [],
      }),
    );
    await Promise.all([first, second]);
    const state = await readOnboardingChecklistPersistedState();
    expect(Object.keys(state.completedItems).sort()).toEqual([
      'add-capability',
      'connect-accounts',
      'start-chat',
    ]);
  });
});

describe('write failure isolation', () => {
  it('keeps serving the in-memory state when the disk write fails', async () => {
    mockWriteFile.mockRejectedValue(new Error('disk full'));
    const result = await latchOnboardingChecklistItemComplete('add-capability');
    expect(result.changed).toBe(true);
    await flushWrites();
    const state = await readOnboardingChecklistPersistedState();
    expect(state.completedItems['add-capability']).toEqual(expect.any(String));
  });
});
