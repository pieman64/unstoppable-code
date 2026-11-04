import type { RunConsolidationOptions } from '../memory/local/consolidation-task';

interface MockPreferences {
  localMemoryEnabled: boolean;
  localMemoryModel: string;
  localMemoryThinkingLevel: 'off' | 'medium';
  summaryModel: string;
  summaryThinkingLevel: 'off';
  providerModelConfigDefaults: undefined;
}

const enabledPreferences: MockPreferences = {
  localMemoryEnabled: true,
  localMemoryModel: 'claude-sonnet-4-6',
  localMemoryThinkingLevel: 'medium',
  summaryModel: 'claude-haiku-4-5-20251001',
  summaryThinkingLevel: 'off',
  providerModelConfigDefaults: undefined,
};

let mockUserDir = '';
const mockReadPreferencesFile = jest.fn<Promise<MockPreferences>, []>(() =>
  Promise.resolve(enabledPreferences),
);
const mockRunLocalMemoryConsolidation = jest.fn<
  Promise<{ status: string; reason?: string; inputHash?: string }>,
  [RunConsolidationOptions]
>();
const mockBroadcast = jest.fn();
const mockIsModelBlockedByStoredPolicy = jest.fn<
  Promise<boolean>,
  [string | undefined, unknown]
>(() => Promise.resolve(false));
const mockResolveHelperWorkOwner = jest.fn<Promise<undefined>, [unknown]>(() =>
  Promise.resolve(undefined),
);

jest.mock('../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: (
    model: string | undefined,
    owner: unknown,
  ): ReturnType<typeof mockIsModelBlockedByStoredPolicy> =>
    mockIsModelBlockedByStoredPolicy(model, owner),
}));

jest.mock('../ollama/helper-invocation', () => ({
  resolveHelperWorkOwner: (
    options: unknown,
  ): ReturnType<typeof mockResolveHelperWorkOwner> =>
    mockResolveHelperWorkOwner(options),
}));

jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: (): ReturnType<typeof mockReadPreferencesFile> =>
    mockReadPreferencesFile(),
}));

jest.mock('../lib/paths', () => ({
  getUserMemoryDir: (): string => mockUserDir,
  getWorkspaceMemoryDir: (workspaceId: string): string =>
    `${mockUserDir}-${workspaceId}`,
}));

jest.mock('../lib/background-helper-queue', () => ({
  BACKGROUND_HELPER_PRIORITIES: { memoryConsolidation: 3 },
  enqueueBackgroundHelperTask: (options: {
    task: () => Promise<unknown>;
  }): Promise<unknown> => options.task(),
}));

jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

jest.mock('../memory/local/consolidation-task', () => ({
  runLocalMemoryConsolidation: (
    options: RunConsolidationOptions,
  ): ReturnType<typeof mockRunLocalMemoryConsolidation> =>
    mockRunLocalMemoryConsolidation(options),
}));

const mockSourceUndo: {
  reportFailure: boolean;
  /** Runs right after sources are restored, before memory is cleared. */
  afterRestore: (() => Promise<void>) | null;
} = { reportFailure: false, afterRestore: null };

jest.mock('../memory/local/rebuild', () => {
  const actual = jest.requireActual<typeof RebuildModule>(
    '../memory/local/rebuild',
  );
  return {
    ...actual,
    restoreConsolidatedSources: async (
      ...args: Parameters<typeof actual.restoreConsolidatedSources>
    ): ReturnType<typeof actual.restoreConsolidatedSources> => {
      const handle = await actual.restoreConsolidatedSources(...args);
      await mockSourceUndo.afterRestore?.();
      if (!mockSourceUndo.reportFailure) return handle;
      return {
        ...handle,
        undo: async (): Promise<boolean> => {
          await handle.undo();
          return false;
        },
      };
    },
  };
});

jest.mock('../memory/local/change-events', () => ({
  broadcastLocalMemoryChanged: (...args: unknown[]): unknown =>
    mockBroadcast(...args),
}));

import type * as RebuildModule from '../memory/local/rebuild';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initClaudeModels } from '@canopy/desktop-shared/types';
import {
  LOCAL_MEMORY_MODEL_BLOCKED_MESSAGE,
  LOCAL_MEMORY_MODEL_UNAVAILABLE_MESSAGE,
} from '@canopy/desktop-shared/types/local-memory';
import {
  beginLocalMemoryConsolidationRun,
  endLocalMemoryConsolidationRun,
  isLocalMemoryRebuildRunning,
  localMemoryConsolidationRunTrackerTestExports,
} from '../memory/local/consolidation-run-tracker';
import { readConsolidationState } from '../memory/local/consolidation-state';
import { readImportState } from '../memory/local/import/ledger';
import { prepareMemoryScopeForWrite } from '../memory/local/scope-manifest';
import {
  restoreManualLocalMemorySnapshot,
  runManualLocalMemoryConsolidation,
  runManualLocalMemoryRebuild,
} from '../memory/local/manual-consolidation-trigger';
import {
  REBUILD_IMPORT_ORIGIN_UNKNOWN_REASON,
  REBUILD_IMPORT_LEDGER_MISSING_REASON,
  REBUILD_IMPORT_LEDGER_UNREADABLE_REASON,
  REBUILD_SOURCES_MISSING_REASON,
} from '../memory/local/rebuild';
import {
  listLocalMemorySnapshots,
  readLocalMemorySnapshot,
} from '../memory/local/snapshots';

const itOnPosix = process.platform === 'win32' ? it.skip : it;

initClaudeModels([
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
]);

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function markdownIn(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory))
      .filter((name) => name.endsWith('.md'))
      .sort();
  } catch {
    return [];
  }
}

/** Stands in for a real run: consumes up to `batch` pending inbox notes. */
function consumeInbox(batch: number) {
  return async (
    options: RunConsolidationOptions,
  ): Promise<{ status: string; inputHash: string }> => {
    const inbox = join(options.scopeDir, 'inbox');
    const pending = await markdownIn(inbox);
    if (pending.length === 0)
      return { status: 'clean', inputHash: 'a'.repeat(64) };
    await mkdir(join(inbox, '.consolidated'), { recursive: true });
    for (const name of pending.slice(0, batch)) {
      await rename(join(inbox, name), join(inbox, '.consolidated', name));
    }
    await writeFile(join(options.scopeDir, 'MEMORY.md'), '# Rebuilt\n');
    return { status: 'success', inputHash: 'b'.repeat(64) };
  };
}

describe('manual local memory rebuild', () => {
  // A rebuild loads the importer lazily. On a cold transform cache, loading
  // it inside the first restage test alone takes longer than a test timeout.
  beforeAll(async () => {
    await import('../memory/local/import/import-runner');
  }, 120_000);

  beforeEach(async () => {
    jest.clearAllMocks();
    localMemoryConsolidationRunTrackerTestExports.reset();
    mockSourceUndo.reportFailure = false;
    mockSourceUndo.afterRestore = null;
    mockReadPreferencesFile.mockResolvedValue(enabledPreferences);
    mockIsModelBlockedByStoredPolicy.mockResolvedValue(false);
    mockUserDir = await mkdtemp(join(tmpdir(), 'local-memory-rebuild-run-'));
    // Already given note identities, so a rebuild changes only what it means to.
    await prepareMemoryScopeForWrite(mockUserDir);
    await mkdir(join(mockUserDir, 'inbox', '.consolidated'), {
      recursive: true,
    });
    await mkdir(join(mockUserDir, 'topics'), { recursive: true });
    await writeFile(
      join(mockUserDir, 'MEMORY.md'),
      '# Old\n\n- [Travel](topics/travel.md)\n',
    );
    await writeFile(join(mockUserDir, 'topics', 'travel.md'), 'Window seat');
    for (const name of [
      '2026-09-01-a.md',
      '2026-09-02-b.md',
      '2026-09-03-c.md',
    ])
      await writeFile(join(mockUserDir, 'inbox', '.consolidated', name), name);
    await writeFile(
      join(mockUserDir, 'inbox', '.consolidated', 'topic-old.md'),
      'Retired topic',
    );
  });

  afterEach(async () => {
    await rm(mockUserDir, { recursive: true, force: true });
  });

  it('snapshots, restores sources, clears the index, and drains with the memory model while owning the scope', async () => {
    const heldDuringRuns: boolean[] = [];
    const competing: string[] = [];
    const seenByRuns: Array<{ index: boolean; topics: string[] }> = [];
    mockRunLocalMemoryConsolidation.mockImplementation(async (options) => {
      heldDuringRuns.push(isLocalMemoryRebuildRunning(mockUserDir));
      seenByRuns.push({
        index: await pathExists(join(mockUserDir, 'MEMORY.md')),
        topics: await markdownIn(join(mockUserDir, 'topics')),
      });
      competing.push(
        (await runManualLocalMemoryConsolidation({ scope: 'user' })).reason ??
          '',
      );
      return consumeInbox(2)(options);
    });

    const result = await runManualLocalMemoryRebuild({ scope: 'user' });

    expect(result).toMatchObject({
      status: 'completed',
      restoredInboxNotes: 3,
      restoredImports: 0,
      runs: 2,
    });
    expect(heldDuringRuns).toEqual([true, true]);
    expect(competing).toEqual(['already-running', 'already-running']);
    expect(isLocalMemoryRebuildRunning(mockUserDir)).toBe(false);
    for (const [options] of mockRunLocalMemoryConsolidation.mock.calls) {
      expect(options).toMatchObject({
        scopeDir: mockUserDir,
        model: 'claude-sonnet-4-6',
        thinkingLevel: 'medium',
        snapshotBeforeWrite: false,
      });
    }
    expect(seenByRuns[0]).toEqual({ index: false, topics: [] });
    expect(await pathExists(join(mockUserDir, 'topics', 'travel.md'))).toBe(
      false,
    );
    expect(await readFile(join(mockUserDir, 'MEMORY.md'), 'utf8')).toBe(
      '# Rebuilt\n',
    );
    expect(
      await markdownIn(join(mockUserDir, 'inbox', '.consolidated')),
    ).toEqual([
      '2026-09-01-a.md',
      '2026-09-02-b.md',
      '2026-09-03-c.md',
      'topic-old.md',
    ]);
    const snapshots = await listLocalMemorySnapshots(mockUserDir);
    expect(snapshots).toHaveLength(1);
    expect(result.snapshotId).toBe(snapshots[0].id);
    const saved = await readLocalMemorySnapshot(mockUserDir, snapshots[0].id);
    expect(saved.summary.reason).toBe('rebuild');
    expect(saved.memoryMd).toBe('# Old\n\n- [Travel](topics/travel.md)\n');
    expect(saved.topicFiles).toEqual([
      { filename: 'travel.md', content: 'Window seat' },
    ]);
    expect(await readConsolidationState(mockUserDir)).toMatchObject({
      lastResult: 'success',
    });
  });

  it('stops at a failed run, records it, and releases the scope', async () => {
    mockRunLocalMemoryConsolidation
      .mockImplementationOnce(consumeInbox(1))
      .mockResolvedValueOnce({ status: 'failed', reason: 'model unavailable' });

    const result = await runManualLocalMemoryRebuild({ scope: 'user' });

    expect(result).toMatchObject({
      status: 'stopped',
      reason: 'model unavailable',
      runs: 2,
    });
    expect(await readConsolidationState(mockUserDir)).toMatchObject({
      lastResult: 'failed',
      lastReason: 'model unavailable',
    });
    expect(await markdownIn(join(mockUserDir, 'inbox'))).toHaveLength(2);
    expect(beginLocalMemoryConsolidationRun(mockUserDir)).toBe(true);
  });

  it('leaves a scope alone while another run owns it', async () => {
    expect(beginLocalMemoryConsolidationRun(mockUserDir)).toBe(true);
    await expect(
      runManualLocalMemoryRebuild({ scope: 'user' }),
    ).resolves.toMatchObject({ status: 'skipped', reason: 'already-running' });
    endLocalMemoryConsolidationRun(mockUserDir);
    expect(await markdownIn(join(mockUserDir, 'inbox'))).toEqual([]);
    expect(await pathExists(join(mockUserDir, 'topics', 'travel.md'))).toBe(
      true,
    );
    expect(mockRunLocalMemoryConsolidation).not.toHaveBeenCalled();
  });

  it('does nothing while local memory is off', async () => {
    mockReadPreferencesFile.mockResolvedValue({
      ...enabledPreferences,
      localMemoryEnabled: false,
    });
    await expect(
      runManualLocalMemoryRebuild({ scope: 'user' }),
    ).resolves.toMatchObject({
      status: 'skipped',
      reason: 'local-memory-disabled',
      snapshotId: null,
    });
    expect(await listLocalMemorySnapshots(mockUserDir)).toEqual([]);
  });

  it('leaves memory untouched and says why when the chosen model is unavailable', async () => {
    mockReadPreferencesFile.mockResolvedValue({
      ...enabledPreferences,
      localMemoryModel: 'ollama-offline-model',
    });
    const indexBefore = await readFile(join(mockUserDir, 'MEMORY.md'), 'utf8');
    await expect(
      runManualLocalMemoryRebuild({ scope: 'user' }),
    ).resolves.toMatchObject({
      status: 'skipped',
      reason: LOCAL_MEMORY_MODEL_UNAVAILABLE_MESSAGE,
      snapshotId: null,
      runs: 0,
    });
    expect(mockRunLocalMemoryConsolidation).not.toHaveBeenCalled();
    expect(await listLocalMemorySnapshots(mockUserDir)).toEqual([]);
    expect(await readFile(join(mockUserDir, 'MEMORY.md'), 'utf8')).toBe(
      indexBefore,
    );
    // Archived sources stay archived: nothing was queued for another model.
    expect(await markdownIn(join(mockUserDir, 'inbox'))).toEqual([]);
    expect(await pathExists(join(mockUserDir, 'topics', 'travel.md'))).toBe(
      true,
    );
    expect(isLocalMemoryRebuildRunning(mockUserDir)).toBe(false);
  });

  it('leaves memory untouched and says why when organization policy blocks the memory model', async () => {
    mockIsModelBlockedByStoredPolicy.mockResolvedValue(true);
    const indexBefore = await readFile(join(mockUserDir, 'MEMORY.md'), 'utf8');

    const result = await runManualLocalMemoryRebuild({ scope: 'user' });

    expect(result).toEqual({
      status: 'skipped',
      reason: LOCAL_MEMORY_MODEL_BLOCKED_MESSAGE,
      snapshotId: null,
      restoredInboxNotes: 0,
      restoredImports: 0,
      runs: 0,
    });
    expect(mockResolveHelperWorkOwner).toHaveBeenCalledWith({});
    expect(mockIsModelBlockedByStoredPolicy).toHaveBeenCalledWith(
      'claude-sonnet-4-6',
      undefined,
    );
    expect(mockRunLocalMemoryConsolidation).not.toHaveBeenCalled();
    expect(await listLocalMemorySnapshots(mockUserDir)).toEqual([]);
    expect(await readFile(join(mockUserDir, 'MEMORY.md'), 'utf8')).toBe(
      indexBefore,
    );
    expect(
      await readFile(join(mockUserDir, 'topics', 'travel.md'), 'utf8'),
    ).toBe('Window seat');
    expect(await markdownIn(join(mockUserDir, 'inbox'))).toEqual([]);
    expect(isLocalMemoryRebuildRunning(mockUserDir)).toBe(false);
  });

  it('checks the policy for the workspace that owns the memory', async () => {
    mockIsModelBlockedByStoredPolicy.mockResolvedValue(true);
    await expect(
      runManualLocalMemoryRebuild({
        scope: 'workspace',
        workspaceId: 'workspace-1',
      }),
    ).resolves.toMatchObject({
      status: 'skipped',
      reason: LOCAL_MEMORY_MODEL_BLOCKED_MESSAGE,
    });
    expect(mockResolveHelperWorkOwner).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
    });
  });

  it('stops before the next run when organization policy blocks the model midway', async () => {
    mockRunLocalMemoryConsolidation.mockImplementationOnce(async (options) => {
      mockIsModelBlockedByStoredPolicy.mockResolvedValue(true);
      return consumeInbox(1)(options);
    });

    await expect(
      runManualLocalMemoryRebuild({ scope: 'user' }),
    ).resolves.toMatchObject({
      status: 'stopped',
      reason: LOCAL_MEMORY_MODEL_BLOCKED_MESSAGE,
      runs: 2,
    });
    expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledTimes(1);
    expect(await readConsolidationState(mockUserDir)).toMatchObject({
      lastResult: 'skipped',
      lastReason: LOCAL_MEMORY_MODEL_BLOCKED_MESSAGE,
    });
  });

  it('runs each queued run with the model saved when it starts', async () => {
    mockRunLocalMemoryConsolidation.mockImplementationOnce(async (options) => {
      mockReadPreferencesFile.mockResolvedValue({
        ...enabledPreferences,
        localMemoryModel: 'claude-haiku-4-5-20251001',
      });
      return consumeInbox(1)(options);
    });
    mockRunLocalMemoryConsolidation.mockImplementation(consumeInbox(10));

    await expect(
      runManualLocalMemoryRebuild({ scope: 'user' }),
    ).resolves.toMatchObject({ status: 'completed', runs: 2 });

    expect(
      mockRunLocalMemoryConsolidation.mock.calls.map(
        ([options]) => options.model,
      ),
    ).toEqual(['claude-sonnet-4-6', 'claude-haiku-4-5-20251001']);
  });

  it('stops instead of switching models when the chosen model can no longer run', async () => {
    mockRunLocalMemoryConsolidation.mockImplementationOnce(async (options) => {
      mockReadPreferencesFile.mockResolvedValue({
        ...enabledPreferences,
        localMemoryModel: 'ollama-offline-model',
      });
      return consumeInbox(1)(options);
    });

    await expect(
      runManualLocalMemoryRebuild({ scope: 'user' }),
    ).resolves.toMatchObject({
      status: 'stopped',
      reason: LOCAL_MEMORY_MODEL_UNAVAILABLE_MESSAGE,
      runs: 2,
    });
    expect(mockRunLocalMemoryConsolidation).toHaveBeenCalledTimes(1);
    expect(await readConsolidationState(mockUserDir)).toMatchObject({
      lastResult: 'skipped',
      lastReason: LOCAL_MEMORY_MODEL_UNAVAILABLE_MESSAGE,
    });
  });

  it('stops before the next run when local memory is turned off midway', async () => {
    mockRunLocalMemoryConsolidation.mockImplementationOnce(async (options) => {
      mockReadPreferencesFile.mockResolvedValue({
        ...enabledPreferences,
        localMemoryEnabled: false,
      });
      return consumeInbox(1)(options);
    });
    await expect(
      runManualLocalMemoryRebuild({ scope: 'user' }),
    ).resolves.toMatchObject({
      status: 'stopped',
      reason: 'local-memory-disabled',
      runs: 1,
    });
  });

  describe('when memory changes between the plan and the clear', () => {
    const MEMORY_CHANGED =
      'memories changed while the rebuild was getting ready, so nothing was changed';

    it('deletes nothing and puts sources back when a topic is edited', async () => {
      mockSourceUndo.afterRestore = (): Promise<void> =>
        writeFile(join(mockUserDir, 'topics', 'travel.md'), 'Aisle seat');

      const result = await runManualLocalMemoryRebuild({ scope: 'user' });

      expect(result).toMatchObject({
        status: 'failed',
        reason: MEMORY_CHANGED,
        runs: 0,
      });
      expect(
        await readFile(join(mockUserDir, 'topics', 'travel.md'), 'utf8'),
      ).toBe('Aisle seat');
      expect(await readFile(join(mockUserDir, 'MEMORY.md'), 'utf8')).toBe(
        '# Old\n\n- [Travel](topics/travel.md)\n',
      );
      expect(await markdownIn(join(mockUserDir, 'inbox'))).toEqual([]);
      expect(
        await markdownIn(join(mockUserDir, 'inbox', '.consolidated')),
      ).toHaveLength(4);
      expect(mockRunLocalMemoryConsolidation).not.toHaveBeenCalled();
      expect(isLocalMemoryRebuildRunning(mockUserDir)).toBe(false);
    });

    it('deletes nothing when a topic appears in a scope that was empty', async () => {
      await rm(join(mockUserDir, 'MEMORY.md'));
      await rm(join(mockUserDir, 'topics', 'travel.md'));
      mockSourceUndo.afterRestore = async (): Promise<void> => {
        await writeFile(join(mockUserDir, 'topics', 'new.md'), 'Written now');
        await writeFile(join(mockUserDir, 'MEMORY.md'), '# Written now\n');
      };

      const result = await runManualLocalMemoryRebuild({ scope: 'user' });

      expect(result).toMatchObject({
        status: 'failed',
        reason: MEMORY_CHANGED,
        snapshotId: null,
        runs: 0,
      });
      expect(
        await readFile(join(mockUserDir, 'topics', 'new.md'), 'utf8'),
      ).toBe('Written now');
      expect(await readFile(join(mockUserDir, 'MEMORY.md'), 'utf8')).toBe(
        '# Written now\n',
      );
      expect(await markdownIn(join(mockUserDir, 'inbox'))).toEqual([]);
      expect(mockRunLocalMemoryConsolidation).not.toHaveBeenCalled();
    });
  });

  describe('when imported memories cannot be restored', () => {
    const STAGED = 'claude-projects-memory-notes-0123456789abcdef.md';

    async function memoryState(): Promise<{
      index: string;
      topics: string[];
      inbox: string[];
      archivedNotes: string[];
      archivedImports: string[];
    }> {
      return {
        index: await readFile(join(mockUserDir, 'MEMORY.md'), 'utf8'),
        topics: await markdownIn(join(mockUserDir, 'topics')),
        inbox: await markdownIn(join(mockUserDir, 'inbox')),
        archivedNotes: await markdownIn(
          join(mockUserDir, 'inbox', '.consolidated'),
        ),
        archivedImports: await markdownIn(
          join(mockUserDir, 'imported', '.consolidated'),
        ),
      };
    }

    beforeEach(async () => {
      await mkdir(join(mockUserDir, 'imported', '.consolidated'), {
        recursive: true,
      });
      await writeFile(
        join(mockUserDir, 'imported', '.consolidated', STAGED),
        'Imported fact',
      );
    });

    it.each([
      [
        'unreadable',
        async (): Promise<void> =>
          writeFile(join(mockUserDir, 'import-state.json'), '{"version":1,'),
        REBUILD_IMPORT_LEDGER_UNREADABLE_REASON,
      ],
      [
        'missing',
        (): Promise<void> => Promise.resolve(),
        REBUILD_IMPORT_LEDGER_MISSING_REASON,
      ],
    ])(
      'changes nothing and says why when the import ledger is %s',
      async (_label, arrangeLedger, reason) => {
        await arrangeLedger();
        const before = await memoryState();

        const result = await runManualLocalMemoryRebuild({ scope: 'user' });

        expect(result).toEqual({
          status: 'failed',
          reason,
          snapshotId: null,
          restoredInboxNotes: 0,
          restoredImports: 0,
          runs: 0,
        });
        expect(await memoryState()).toEqual(before);
        expect(before.topics).toEqual(['travel.md']);
        expect(mockRunLocalMemoryConsolidation).not.toHaveBeenCalled();
        expect(await listLocalMemorySnapshots(mockUserDir)).toEqual([]);
        expect(isLocalMemoryRebuildRunning(mockUserDir)).toBe(false);
      },
    );

    it('changes nothing and says why when staged imports have no ledger', async () => {
      await rm(join(mockUserDir, 'imported', '.consolidated', STAGED));
      await writeFile(join(mockUserDir, 'imported', STAGED), 'Staged fact');
      const before = await memoryState();

      const result = await runManualLocalMemoryRebuild({ scope: 'user' });

      expect(result).toEqual({
        status: 'failed',
        reason: REBUILD_IMPORT_LEDGER_MISSING_REASON,
        snapshotId: null,
        restoredInboxNotes: 0,
        restoredImports: 0,
        runs: 0,
      });
      expect(await memoryState()).toEqual(before);
      expect(before.topics).toEqual(['travel.md']);
      expect(
        await readFile(join(mockUserDir, 'imported', STAGED), 'utf8'),
      ).toBe('Staged fact');
      expect(mockRunLocalMemoryConsolidation).not.toHaveBeenCalled();
      expect(await listLocalMemorySnapshots(mockUserDir)).toEqual([]);
    });

    it('does not report a rebuild finished while restored imports go unread', async () => {
      await writeFile(
        join(mockUserDir, 'import-state.json'),
        `${JSON.stringify({
          version: 1,
          sources: {
            '/source.md': {
              fileHash: 'a'.repeat(64),
              importedAt: '2026-09-01T00:00:00.000Z',
              stagedAs: `imported/${STAGED}`,
              consolidatedAt: '2026-09-02T00:00:00.000Z',
            },
          },
        })}\n`,
      );
      // The run consumes the notes, but the ledger goes bad underneath it,
      // so the restored import can never be consolidated.
      mockRunLocalMemoryConsolidation.mockImplementation(async (options) => {
        await writeFile(join(mockUserDir, 'import-state.json'), 'garbage');
        return consumeInbox(10)(options);
      });

      const result = await runManualLocalMemoryRebuild({ scope: 'user' });

      expect(result.status).toBe('stopped');
      expect(result.reason).toBe(
        "some imports couldn't be read back, so they weren't rebuilt",
      );
      expect(result.restoredImports).toBe(1);
      expect(await pathExists(join(mockUserDir, 'imported', STAGED))).toBe(
        true,
      );
    });

    it('does not report a rebuild finished while an import staged before it goes unread', async () => {
      await rm(join(mockUserDir, 'imported', '.consolidated', STAGED));
      await writeFile(join(mockUserDir, 'imported', STAGED), 'Staged fact');
      await writeFile(
        join(mockUserDir, 'import-state.json'),
        `${JSON.stringify({
          version: 1,
          sources: {
            '/source.md': {
              fileHash: 'a'.repeat(64),
              importedAt: '2026-09-01T00:00:00.000Z',
              stagedAs: `imported/${STAGED}`,
            },
          },
        })}\n`,
      );
      // The import was already pending, so the rebuild restores nothing for
      // it; the ledger then goes bad after memory is cleared.
      mockRunLocalMemoryConsolidation.mockImplementation(async (options) => {
        await writeFile(join(mockUserDir, 'import-state.json'), 'garbage');
        return consumeInbox(10)(options);
      });

      const result = await runManualLocalMemoryRebuild({ scope: 'user' });

      expect(result.status).toBe('stopped');
      expect(result.reason).toBe(
        "some imports couldn't be read back, so they weren't rebuilt",
      );
      expect(result.restoredImports).toBe(0);
      expect(await pathExists(join(mockUserDir, 'imported', STAGED))).toBe(
        true,
      );
    });
  });

  it('stops instead of finishing when a tracked import disappears from staging', async () => {
    const STAGED = 'claude-projects-memory-notes-fedcba9876543210.md';
    await mkdir(join(mockUserDir, 'imported'), { recursive: true });
    await writeFile(join(mockUserDir, 'imported', STAGED), 'Staged fact');
    await writeFile(
      join(mockUserDir, 'import-state.json'),
      `${JSON.stringify({
        version: 1,
        sources: {
          '/source.md': {
            fileHash: 'a'.repeat(64),
            importedAt: '2026-09-01T00:00:00.000Z',
            stagedAs: `imported/${STAGED}`,
          },
        },
      })}\n`,
    );
    // The import is deleted before consolidation reads it; the run consumes
    // only the notes, so the import is neither stamped nor archived.
    mockRunLocalMemoryConsolidation.mockImplementation(async (options) => {
      await rm(join(mockUserDir, 'imported', STAGED));
      return consumeInbox(10)(options);
    });

    const result = await runManualLocalMemoryRebuild({ scope: 'user' });

    expect(result).toMatchObject({
      status: 'stopped',
      reason: REBUILD_SOURCES_MISSING_REASON,
      runs: 1,
    });
    expect(await readConsolidationState(mockUserDir)).toMatchObject({
      lastResult: 'success',
    });
  });

  it('finishes when every tracked import was consumed into its archive', async () => {
    const STAGED = 'claude-projects-memory-notes-fedcba9876543210.md';
    await mkdir(join(mockUserDir, 'imported'), { recursive: true });
    await writeFile(join(mockUserDir, 'imported', STAGED), 'Staged fact');
    await writeFile(
      join(mockUserDir, 'import-state.json'),
      `${JSON.stringify({
        version: 1,
        sources: {
          '/source.md': {
            fileHash: 'a'.repeat(64),
            importedAt: '2026-09-01T00:00:00.000Z',
            stagedAs: `imported/${STAGED}`,
          },
        },
      })}\n`,
    );
    mockRunLocalMemoryConsolidation.mockImplementation(async (options) => {
      await mkdir(join(mockUserDir, 'imported', '.consolidated'), {
        recursive: true,
      });
      await rename(
        join(mockUserDir, 'imported', STAGED),
        join(mockUserDir, 'imported', '.consolidated', STAGED),
      );
      return consumeInbox(10)(options);
    });

    const result = await runManualLocalMemoryRebuild({ scope: 'user' });

    expect(result).toMatchObject({ status: 'completed', runs: 1 });
  });

  describe("when an import's archived copy is gone but its original remains", () => {
    const OLD_STAGED = 'imported/claude-notes-0123456789abcdef.md';
    let sourceDir = '';
    let sourcePath = '';

    // A Codex import: routed to user memory with no project policy, so it
    // still belongs where the rebuild stages it.
    async function writeLedger(
      entry: Record<string, string> = { sourceTool: 'codex' },
    ): Promise<string> {
      const raw = `${JSON.stringify({
        version: 1,
        sources: {
          [sourcePath]: {
            fileHash: 'a'.repeat(64),
            importedAt: '2026-09-01T00:00:00.000Z',
            stagedAs: OLD_STAGED,
            consolidatedAt: '2026-09-02T00:00:00.000Z',
            ...entry,
          },
        },
      })}\n`;
      await writeFile(join(mockUserDir, 'import-state.json'), raw);
      return raw;
    }

    /** Consumes every pending inbox note and staged import. */
    async function consumeAll(
      options: RunConsolidationOptions,
    ): Promise<{ status: string; inputHash: string }> {
      for (const folder of ['inbox', 'imported']) {
        const directory = join(options.scopeDir, folder);
        const pending = await markdownIn(directory);
        await mkdir(join(directory, '.consolidated'), { recursive: true });
        for (const name of pending) {
          await rename(
            join(directory, name),
            join(directory, '.consolidated', name),
          );
        }
      }
      await writeFile(join(options.scopeDir, 'MEMORY.md'), '# Rebuilt\n');
      return { status: 'success', inputHash: 'b'.repeat(64) };
    }

    beforeEach(async () => {
      sourceDir = await mkdtemp(join(tmpdir(), 'local-memory-rebuild-src-'));
      sourcePath = join(sourceDir, 'notes.md');
    });

    afterEach(async () => {
      await rm(sourceDir, { recursive: true, force: true });
    });

    it('stages the original again and rebuilds from it in this run', async () => {
      await writeFile(sourcePath, 'Prefers green tea');
      await writeLedger();
      const importsSeen: string[] = [];
      mockRunLocalMemoryConsolidation.mockImplementation(async (options) => {
        for (const name of await markdownIn(join(mockUserDir, 'imported'))) {
          importsSeen.push(
            await readFile(join(mockUserDir, 'imported', name), 'utf8'),
          );
        }
        return consumeAll(options);
      });

      const result = await runManualLocalMemoryRebuild({ scope: 'user' });

      expect(result).toMatchObject({
        status: 'completed',
        restoredInboxNotes: 3,
        restoredImports: 1,
        runs: 1,
      });
      expect(importsSeen).toEqual(['Prefers green tea']);
      const entry = (await readImportState(mockUserDir)).sources[sourcePath];
      if (entry === undefined || !('stagedAs' in entry)) {
        throw new Error('expected a staged ledger entry');
      }
      expect(entry.stagedAs).toMatch(/^imported\/.+\.md$/);
      expect(entry.consolidatedAt).toBeUndefined();
      expect(entry.fileHash).not.toBe('a'.repeat(64));
    });

    it('changes nothing and says why when the original cannot be staged again', async () => {
      // A folder where the original file was: it exists but cannot be read.
      await mkdir(sourcePath);
      const ledgerBefore = await writeLedger();
      const indexBefore = await readFile(
        join(mockUserDir, 'MEMORY.md'),
        'utf8',
      );

      const result = await runManualLocalMemoryRebuild({ scope: 'user' });

      expect(result).toEqual({
        status: 'failed',
        reason:
          "an imported memory couldn't be staged again from its original, so nothing was changed",
        snapshotId: null,
        restoredInboxNotes: 0,
        restoredImports: 0,
        runs: 0,
      });
      expect(mockRunLocalMemoryConsolidation).not.toHaveBeenCalled();
      expect(await listLocalMemorySnapshots(mockUserDir)).toEqual([]);
      expect(await readFile(join(mockUserDir, 'MEMORY.md'), 'utf8')).toBe(
        indexBefore,
      );
      expect(
        await readFile(join(mockUserDir, 'topics', 'travel.md'), 'utf8'),
      ).toBe('Window seat');
      expect(
        await readFile(join(mockUserDir, 'import-state.json'), 'utf8'),
      ).toBe(ledgerBefore);
      expect(await markdownIn(join(mockUserDir, 'imported'))).toEqual([]);
      expect(await markdownIn(join(mockUserDir, 'inbox'))).toEqual([]);
    });

    it('changes nothing and says why when an import does not record the project it came from', async () => {
      await writeFile(sourcePath, '---\ntype: user\n---\nPrefers green tea');
      const ledgerBefore = await writeLedger({});
      const indexBefore = await readFile(
        join(mockUserDir, 'MEMORY.md'),
        'utf8',
      );

      const result = await runManualLocalMemoryRebuild({ scope: 'user' });

      expect(result).toEqual({
        status: 'failed',
        reason: REBUILD_IMPORT_ORIGIN_UNKNOWN_REASON,
        snapshotId: null,
        restoredInboxNotes: 0,
        restoredImports: 0,
        runs: 0,
      });
      expect(mockRunLocalMemoryConsolidation).not.toHaveBeenCalled();
      expect(await readFile(join(mockUserDir, 'MEMORY.md'), 'utf8')).toBe(
        indexBefore,
      );
      expect(
        await readFile(join(mockUserDir, 'import-state.json'), 'utf8'),
      ).toBe(ledgerBefore);
      expect(await markdownIn(join(mockUserDir, 'imported'))).toEqual([]);
    });

    it('takes the restaged import back out when a later check refuses', async () => {
      await writeFile(sourcePath, 'Prefers green tea');
      const ledgerBefore = await writeLedger();
      // A file where the snapshots folder belongs: the snapshot cannot be saved.
      await writeFile(join(mockUserDir, '.snapshots'), 'not a folder');

      const result = await runManualLocalMemoryRebuild({ scope: 'user' });

      expect(result).toMatchObject({
        status: 'failed',
        reason:
          "the snapshot of current memories couldn't be saved, so nothing was changed",
        runs: 0,
      });
      expect(mockRunLocalMemoryConsolidation).not.toHaveBeenCalled();
      expect(
        await readFile(join(mockUserDir, 'import-state.json'), 'utf8'),
      ).toBe(ledgerBefore);
      expect(await markdownIn(join(mockUserDir, 'imported'))).toEqual([]);
      expect(
        await readFile(join(mockUserDir, 'topics', 'travel.md'), 'utf8'),
      ).toBe('Window seat');
    });
  });

  itOnPosix('puts memory back when it cannot be cleared', async () => {
    const index = join(mockUserDir, 'MEMORY.md');
    const indexBefore = await readFile(index, 'utf8');
    // Deleting a topic fails: its folder is read-only.
    await chmod(join(mockUserDir, 'topics'), 0o500);
    try {
      const result = await runManualLocalMemoryRebuild({ scope: 'user' });
      expect(result).toMatchObject({
        status: 'failed',
        reason:
          "current memories couldn't be cleared, so they were put back as they were",
        runs: 0,
      });
      expect(result.snapshotId).not.toBeNull();
    } finally {
      await chmod(join(mockUserDir, 'topics'), 0o700);
    }
    expect(await readFile(index, 'utf8')).toBe(indexBefore);
    expect(
      await readFile(join(mockUserDir, 'topics', 'travel.md'), 'utf8'),
    ).toBe('Window seat');
    // The archived notes went back to the archive.
    expect(await markdownIn(join(mockUserDir, 'inbox'))).toEqual([]);
    expect(
      await markdownIn(join(mockUserDir, 'inbox', '.consolidated')),
    ).toHaveLength(4);
    expect(mockRunLocalMemoryConsolidation).not.toHaveBeenCalled();
  });

  itOnPosix(
    'says when sources stay pending after memory is put back',
    async () => {
      const indexBefore = await readFile(
        join(mockUserDir, 'MEMORY.md'),
        'utf8',
      );
      mockSourceUndo.reportFailure = true;
      await chmod(join(mockUserDir, 'topics'), 0o500);
      try {
        await expect(
          runManualLocalMemoryRebuild({ scope: 'user' }),
        ).resolves.toMatchObject({
          status: 'failed',
          reason:
            "some saved notes or imports couldn't be put back in their archive; memories weren't changed, and those sources will be consolidated again",
          runs: 0,
        });
      } finally {
        await chmod(join(mockUserDir, 'topics'), 0o700);
      }
      expect(await readFile(join(mockUserDir, 'MEMORY.md'), 'utf8')).toBe(
        indexBefore,
      );
    },
  );

  it('restores a snapshot while holding the scope and refuses unknown ids', async () => {
    mockRunLocalMemoryConsolidation.mockImplementation(consumeInbox(10));
    const rebuilt = await runManualLocalMemoryRebuild({ scope: 'user' });

    await expect(
      restoreManualLocalMemorySnapshot({ scope: 'user' }, 'not-a-snapshot'),
    ).rejects.toThrow('Choose a memory snapshot.');

    await expect(
      restoreManualLocalMemorySnapshot(
        { scope: 'user' },
        rebuilt.snapshotId ?? '',
      ),
    ).resolves.toMatchObject({ status: 'restored' });
    expect(await readFile(join(mockUserDir, 'MEMORY.md'), 'utf8')).toBe(
      '# Old\n\n- [Travel](topics/travel.md)\n',
    );
    expect(
      await readFile(join(mockUserDir, 'topics', 'travel.md'), 'utf8'),
    ).toBe('Window seat');

    expect(beginLocalMemoryConsolidationRun(mockUserDir)).toBe(true);
    await expect(
      restoreManualLocalMemorySnapshot(
        { scope: 'user' },
        rebuilt.snapshotId ?? '',
      ),
    ).resolves.toEqual({
      status: 'skipped',
      reason: 'already-running',
      previousSnapshotId: null,
    });
  });
});
