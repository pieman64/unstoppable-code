import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrowserProfileRepository } from '@canopy/desktop-shared/node/browser-profiles/repository';
import type {
  BrowserSessionSnapshot,
  PersistedWorktreeBrowserStateFile,
} from '@canopy/desktop-shared/types';
import { touchWorkspaceTargetWithoutOperationLock } from '../lib/workspace-activity';
import {
  BrowserStateHydrationError,
  loadAndMigrateWorktreeBrowserState,
  loadWorktreeBrowserState,
  saveWorktreeBrowserState,
} from '../browser/browser-persistence';

let mockStateFilePath = '';
const withArchivedWorkspaceOperationLockMock = jest.fn(
  (_projectId: string, operation: () => Promise<unknown>) => operation(),
);
const withWorkspaceTargetRuntimeStartReservationMock = jest.fn(
  (
    _projectId: string,
    _worktreeId: string,
    operation: () => Promise<unknown>,
  ) => operation(),
);

jest.mock('../lib/paths', () => ({
  getWorktreeBrowserStateFilePath: (): string => mockStateFilePath,
}));

jest.mock('../lib/workspace-activity', () => ({
  touchWorkspaceTarget: jest.fn().mockResolvedValue(undefined),
  touchWorkspaceTargetWithoutOperationLock: jest
    .fn()
    .mockResolvedValue(undefined),
}));

jest.mock('../lib/archived-containers', () => ({
  withArchivedWorkspaceOperationLock: (
    projectId: string,
    operation: () => Promise<unknown>,
  ): Promise<unknown> =>
    withArchivedWorkspaceOperationLockMock(projectId, operation),
}));

jest.mock('../lib/workspace-target-exclusion', () => ({
  withWorkspaceTargetRuntimeStartReservation: (
    projectId: string,
    worktreeId: string,
    operation: () => Promise<unknown>,
  ): Promise<unknown> =>
    withWorkspaceTargetRuntimeStartReservationMock(
      projectId,
      worktreeId,
      operation,
    ),
}));

function snapshot(
  id: string,
  overrides: Partial<BrowserSessionSnapshot> = {},
): BrowserSessionSnapshot {
  return {
    id,
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    createdAt: 1,
    updatedAt: 2,
    url: `http://localhost/${id}`,
    title: id,
    status: 'ready',
    canGoBack: false,
    canGoForward: false,
    loading: false,
    themeMode: 'light',
    pickMode: false,
    recording: false,
    ...overrides,
  };
}

it('never persists authorization browser URLs or touches workspace activity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oauth-browser-'));
  mockStateFilePath = join(dir, 'browser.json');
  try {
    await saveWorktreeBrowserState({
      projectId: 'app-oauth',
      worktreeId: 'mcp',
      state: {
        version: 1,
        browsers: [
          snapshot('sign-in', {
            projectId: 'app-oauth',
            worktreeId: 'mcp',
            url: 'https://auth.example.test/authorize?state=private',
          }),
        ],
        browserOrder: ['sign-in'],
        activeBrowserId: 'sign-in',
      },
    });
    expect(existsSync(mockStateFilePath)).toBe(false);
    expect(touchWorkspaceTargetWithoutOperationLock).not.toHaveBeenCalled();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function legacyState(
  browsers: unknown[],
  groups: unknown[],
  activeGroupId: string | null = null,
): Record<string, unknown> {
  return {
    version: 1,
    browsers,
    groups,
    activeGroupId,
    nextGroupOrdinal: 99,
    groupOrdinals: { obsolete: 1 },
    browserCustomNames: { obsolete: 'discarded' },
    groupCustomNames: { obsolete: 'discarded' },
  };
}

function writeJson(value: unknown): void {
  writeFileSync(mockStateFilePath, `${JSON.stringify(value, null, 2)}\n`);
}

function fallbackResponse(error: string): object {
  return {
    status: 'fallback',
    state: {
      version: 2,
      browserOrder: [],
      activeBrowserId: null,
      browsers: [],
    },
    error,
  };
}

describe('browser persistence', () => {
  let tempDir = '';

  beforeEach(() => {
    withArchivedWorkspaceOperationLockMock.mockClear();
    withWorkspaceTargetRuntimeStartReservationMock.mockClear();
    tempDir = mkdtempSync(join(tmpdir(), 'canopy-browser-state-'));
    mockStateFilePath = join(tempDir, 'browser-state.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('leaves profile metadata writable while awaiting the workspace lock and rechecks permissions after admission', async () => {
    const repository = new BrowserProfileRepository(join(tempDir, 'profiles'));
    const scope = {
      kind: 'worktree' as const,
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    };
    await repository.ensureTask(scope, 'owner', randomUUID());
    const slot = await repository.getTask(scope);
    if (!slot) throw new Error('Missing task slot');
    const created = await repository.createNamed(randomUUID(), {
      displayName: 'Work',
    });
    const enabled = await repository.updateProfile(
      randomUUID(),
      created.profileId,
      created.metadataRevision,
      { allowEnable: true },
    );
    let release = (): void => {};
    let started = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    withArchivedWorkspaceOperationLockMock.mockImplementationOnce(
      async (_project, operation) => {
        started();
        await gate;
        return operation();
      },
    );
    jest.mocked(touchWorkspaceTargetWithoutOperationLock).mockClear();
    const save = saveWorktreeBrowserState(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        state: {
          version: 2,
          browsers: [snapshot('browser-1')],
          browserOrder: ['browser-1'],
          activeBrowserId: null,
        },
      },
      (write) =>
        repository.withActiveBinding(
          {
            profileId: enabled.profileId,
            storageGeneration: enabled.storageGeneration,
            scope,
            incarnationId: slot.incarnationId,
            agentEnable: true,
          },
          write,
        ),
    );
    const rejected = expect(save).rejects.toMatchObject({
      code: 'agent_enable_denied',
    });
    try {
      await entered;
      await repository.updateProfile(
        randomUUID(),
        enabled.profileId,
        enabled.metadataRevision,
        { allowEnable: false },
      );
    } finally {
      release();
    }
    await rejected;
    expect(existsSync(mockStateFilePath)).toBe(false);
    expect(touchWorkspaceTargetWithoutOperationLock).not.toHaveBeenCalled();
  });

  it('keeps profile authority through both the durable binding and switch decision', async () => {
    const repository = new BrowserProfileRepository(join(tempDir, 'profiles'));
    const scope = {
      kind: 'worktree' as const,
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    };
    const profile = await repository.ensureTask(scope, 'owner', randomUUID());
    const slot = await repository.getTask(scope);
    if (!slot) throw new Error('Missing task slot');
    let release = (): void => {};
    let started = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const save = saveWorktreeBrowserState(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        state: {
          version: 2,
          browsers: [snapshot('browser-1')],
          browserOrder: ['browser-1'],
          activeBrowserId: null,
        },
      },
      (write) =>
        repository.withActiveBinding(
          {
            profileId: profile.profileId,
            storageGeneration: profile.storageGeneration,
            scope,
            incarnationId: slot.incarnationId,
          },
          async () => {
            await write();
            started();
            await gate; // The profile switch journal decision is part of the same commit.
          },
        ),
    );
    await entered;
    let metadataRead = false;
    const read = repository.get(profile.profileId).then(() => {
      metadataRead = true;
    });
    try {
      expect(loadWorktreeBrowserState('project-1', 'worktree-1').status).toBe(
        'loaded',
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(metadataRead).toBe(false);
    } finally {
      release();
      await Promise.all([save, read]);
    }
    expect(metadataRead).toBe(true);
  });

  it('backs up the original flat v1 bytes before migrating, then preserves a resolved v2 binding', async () => {
    writeJson({
      version: 1,
      browserOrder: ['browser-1'],
      activeBrowserId: 'browser-1',
      browsers: [snapshot('browser-1')],
    });
    const original = readFileSync(mockStateFilePath, 'utf8');
    const migrated = await loadAndMigrateWorktreeBrowserState(
      'project-1',
      'worktree-1',
    );
    expect(migrated.state?.version).toBe(2);
    expect(readFileSync(`${mockStateFilePath}.v1.backup`, 'utf8')).toBe(
      original,
    );
    const state: PersistedWorktreeBrowserStateFile = {
      version: 2,
      browserOrder: ['browser-1'],
      activeBrowserId: 'browser-1',
      browsers: [
        snapshot('browser-1', {
          taskScope: {
            kind: 'worktree',
            projectId: 'project-1',
            worktreeId: 'worktree-1',
          },
          profile: {
            selection: { kind: 'named', profileId: 'named-one' },
            resolvedProfileId: 'named-one',
            storageGeneration: 1,
            runtimeGeneration: 2,
            taskIncarnationId: 'incarnation-one',
          },
        }),
      ],
    };
    await saveWorktreeBrowserState({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      state,
    });
    expect(
      (await loadAndMigrateWorktreeBrowserState('project-1', 'worktree-1'))
        .state,
    ).toEqual(state);
    expect(readFileSync(`${mockStateFilePath}.v1.backup`, 'utf8')).toBe(
      original,
    );
  });

  it('preserves a damaged v2 profile binding as a recoverable error rather than falling back to Task', async () => {
    writeJson({
      version: 2,
      browserOrder: ['browser-1'],
      activeBrowserId: 'browser-1',
      browsers: [
        {
          ...snapshot('browser-1'),
          profile: { selection: { kind: 'named', profileId: 'named-one' } },
        },
      ],
    });
    const original = readFileSync(mockStateFilePath, 'utf8');
    expect(
      (await loadAndMigrateWorktreeBrowserState('project-1', 'worktree-1'))
        .status,
    ).toBe('fallback');
    expect(readFileSync(mockStateFilePath, 'utf8')).toBe(original);
  });

  it('flattens legacy groups in stored and left-to-right order', () => {
    writeJson(
      legacyState(
        [snapshot('browser-1'), snapshot('browser-2'), snapshot('browser-3')],
        [
          {
            id: 'group-1',
            browserIds: ['browser-2', 'browser-1'],
            focusedBrowserId: 'browser-1',
            splitSizes: [0.4, 0.6],
          },
          {
            id: 'group-2',
            browserIds: ['browser-3'],
            focusedBrowserId: 'browser-3',
          },
        ],
        'group-2',
      ),
    );

    expect(loadWorktreeBrowserState('project-1', 'worktree-1').state).toEqual({
      version: 2,
      browserOrder: ['browser-2', 'browser-1', 'browser-3'],
      activeBrowserId: 'browser-3',
      browsers: [
        snapshot('browser-2'),
        snapshot('browser-1'),
        snapshot('browser-3'),
      ],
    });
  });

  it('deduplicates references at their first valid occurrence and appends orphans in snapshot order', () => {
    writeJson(
      legacyState(
        [
          snapshot('browser-1'),
          snapshot('browser-2'),
          snapshot('browser-3'),
          snapshot('browser-2', { title: 'duplicate snapshot' }),
          snapshot('browser-4'),
        ],
        [
          {
            id: 'group-1',
            browserIds: [
              'browser-2',
              'browser-2',
              'missing-browser',
              'browser-1',
            ],
            focusedBrowserId: 'browser-2',
          },
          {
            id: 'group-2',
            browserIds: ['browser-1', 'browser-3'],
            focusedBrowserId: 'browser-3',
          },
        ],
        'group-1',
      ),
    );

    const state = loadWorktreeBrowserState('project-1', 'worktree-1').state;
    expect(state?.browserOrder).toEqual([
      'browser-2',
      'browser-1',
      'browser-3',
      'browser-4',
    ]);
    expect(state?.browsers.map((entry) => entry.title)).toEqual([
      'browser-2',
      'browser-1',
      'browser-3',
      'browser-4',
    ]);
  });

  it('uses the active group focus only when that browser survived validation', () => {
    writeJson(
      legacyState(
        [snapshot('browser-1'), snapshot('browser-2')],
        [
          {
            id: 'group-1',
            browserIds: ['browser-2'],
            focusedBrowserId: 'missing-browser',
          },
        ],
        'group-1',
      ),
    );
    expect(
      loadWorktreeBrowserState('project-1', 'worktree-1').state
        ?.activeBrowserId,
    ).toBe('browser-2');

    writeJson(
      legacyState(
        [snapshot('browser-1'), snapshot('browser-2')],
        [
          {
            id: 'group-1',
            browserIds: ['browser-2'],
            focusedBrowserId: 'browser-2',
          },
        ],
        'missing-group',
      ),
    );
    expect(
      loadWorktreeBrowserState('project-1', 'worktree-1').state
        ?.activeBrowserId,
    ).toBe('browser-2');
  });

  it('drops malformed and foreign snapshots and their references', () => {
    writeJson(
      legacyState(
        [
          snapshot('valid'),
          snapshot('foreign-project', { projectId: 'project-2' }),
          snapshot('foreign-worktree', { worktreeId: 'worktree-2' }),
          { ...snapshot('malformed'), createdAt: 'yesterday' },
          { id: 'missing-fields' },
        ],
        [
          {
            id: 'group-1',
            browserIds: [
              'foreign-project',
              'valid',
              'malformed',
              'foreign-worktree',
            ],
            focusedBrowserId: 'foreign-project',
          },
        ],
        'group-1',
      ),
    );

    expect(loadWorktreeBrowserState('project-1', 'worktree-1').state).toEqual({
      version: 2,
      browserOrder: ['valid'],
      activeBrowserId: 'valid',
      browsers: [snapshot('valid')],
    });
  });

  it('migrates a valid empty legacy state', () => {
    writeJson(legacyState([], [], null));

    expect(loadWorktreeBrowserState('project-1', 'worktree-1')).toEqual({
      status: 'loaded',
      state: {
        version: 2,
        browserOrder: [],
        activeBrowserId: null,
        browsers: [],
      },
    });
  });

  it('falls back for invalid legacy state without rewriting it', () => {
    const invalid = `${JSON.stringify({
      version: 1,
      browsers: [snapshot('browser-1')],
      groups: [{ id: 'group-1', browserIds: 'not-an-array' }],
      activeGroupId: 'group-1',
    })}\n`;
    writeFileSync(mockStateFilePath, invalid);
    const inode = statSync(mockStateFilePath).ino;

    expect(loadWorktreeBrowserState('project-1', 'worktree-1')).toEqual(
      fallbackResponse('Browser state has an invalid group at index 0.'),
    );
    expect(readFileSync(mockStateFilePath, 'utf8')).toBe(invalid);
    expect(statSync(mockStateFilePath).ino).toBe(inode);
  });

  it('falls back for corrupt JSON without rewriting it', () => {
    const original = '{not-json';
    writeFileSync(mockStateFilePath, original);
    const inode = statSync(mockStateFilePath).ino;

    expect(loadWorktreeBrowserState('project-1', 'worktree-1')).toEqual(
      fallbackResponse('Browser state contains invalid JSON.'),
    );
    expect(readFileSync(mockStateFilePath, 'utf8')).toBe(original);
    expect(statSync(mockStateFilePath).ino).toBe(inode);
  });

  it('falls back for a forward version and leaves it untouched', () => {
    const original = `${JSON.stringify({
      version: 3,
      browserOrder: [],
      activeBrowserId: null,
      browsers: [],
    })}\n`;
    writeFileSync(mockStateFilePath, original);
    const inode = statSync(mockStateFilePath).ino;

    expect(loadWorktreeBrowserState('project-1', 'worktree-1')).toEqual(
      fallbackResponse(
        'Browser state version 3 is newer than supported version 2.',
      ),
    );
    expect(readFileSync(mockStateFilePath, 'utf8')).toBe(original);
    expect(statSync(mockStateFilePath).ino).toBe(inode);
  });

  it('falls back for invalid version-1 state without rewriting it', () => {
    const original = `${JSON.stringify({
      version: 1,
      browserOrder: ['browser-1', 'browser-1'],
      activeBrowserId: 'browser-1',
      browsers: [snapshot('browser-1')],
    })}\n`;
    writeFileSync(mockStateFilePath, original);
    const inode = statSync(mockStateFilePath).ino;

    expect(loadWorktreeBrowserState('project-1', 'worktree-1')).toEqual(
      fallbackResponse(
        'Browser state contains an invalid order entry browser-1.',
      ),
    );
    expect(readFileSync(mockStateFilePath, 'utf8')).toBe(original);
    expect(statSync(mockStateFilePath).ino).toBe(inode);
  });

  it('does not rewrite valid version-2 state when loading repeatedly', () => {
    const state: PersistedWorktreeBrowserStateFile = {
      version: 2,
      browserOrder: ['browser-2', 'browser-1'],
      activeBrowserId: 'browser-1',
      browsers: [snapshot('browser-1'), snapshot('browser-2')],
    };
    writeJson(state);
    const original = readFileSync(mockStateFilePath, 'utf8');
    const inode = statSync(mockStateFilePath).ino;

    expect(loadWorktreeBrowserState('project-1', 'worktree-1').state).toEqual(
      state,
    );
    expect(loadWorktreeBrowserState('project-1', 'worktree-1').state).toEqual(
      state,
    );
    expect(readFileSync(mockStateFilePath, 'utf8')).toBe(original);
    expect(statSync(mockStateFilePath).ino).toBe(inode);
  });

  it('migrates legacy state asynchronously once and repeated reads are idempotent', async () => {
    writeJson(
      legacyState(
        [snapshot('browser-1')],
        [
          {
            id: 'group-1',
            browserIds: ['browser-1'],
            focusedBrowserId: 'browser-1',
          },
        ],
        'group-1',
      ),
    );

    const first = await loadAndMigrateWorktreeBrowserState(
      'project-1',
      'worktree-1',
    );
    const migrated = readFileSync(mockStateFilePath, 'utf8');
    const migratedInode = statSync(mockStateFilePath).ino;
    const second = await loadAndMigrateWorktreeBrowserState(
      'project-1',
      'worktree-1',
    );

    expect(second).toEqual(first);
    expect(readFileSync(mockStateFilePath, 'utf8')).toBe(migrated);
    expect(statSync(mockStateFilePath).ino).toBe(migratedInode);
  });

  it('falls back for an unreadable persistence path', () => {
    mockStateFilePath = tempDir;

    expect(loadWorktreeBrowserState('project-1', 'worktree-1')).toEqual(
      fallbackResponse('Browser state could not be read.'),
    );
  });

  it('distinguishes a missing persistence file', () => {
    expect(loadWorktreeBrowserState('project-1', 'worktree-1')).toEqual({
      status: 'missing',
      state: null,
    });
  });

  it('saves valid state through asynchronous atomic replacement', async () => {
    const state: PersistedWorktreeBrowserStateFile = {
      version: 2,
      browserOrder: ['browser-1'],
      activeBrowserId: 'browser-1',
      browsers: [snapshot('browser-1')],
    };

    await saveWorktreeBrowserState({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      state,
    });

    expect(loadWorktreeBrowserState('project-1', 'worktree-1')).toEqual({
      status: 'loaded',
      state,
    });
  });

  it('stores System mode in a form older builds still load', async () => {
    const state: PersistedWorktreeBrowserStateFile = {
      version: 2,
      browserOrder: ['browser-1', 'browser-2'],
      activeBrowserId: 'browser-1',
      browsers: [
        snapshot('browser-1', { themeMode: 'system' }),
        snapshot('browser-2', { themeMode: 'dark' }),
      ],
    };

    await saveWorktreeBrowserState({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      state,
    });

    // Builds without System accept only light or dark and drop the whole
    // saved state otherwise, so the file never holds `system` itself.
    const stored: unknown = JSON.parse(readFileSync(mockStateFilePath, 'utf8'));
    expect(stored).toMatchObject({
      browsers: [
        { id: 'browser-1', themeMode: 'light', themeFollowsApp: true },
        { id: 'browser-2', themeMode: 'dark' },
      ],
    });
    expect(JSON.stringify(stored)).not.toContain('"system"');
    expect(loadWorktreeBrowserState('project-1', 'worktree-1')).toEqual({
      status: 'loaded',
      state,
    });
  });

  it('keeps the activity watermark and browser-state write inside one archive lock', async () => {
    let releaseLock: (() => void) | undefined;
    withArchivedWorkspaceOperationLockMock.mockImplementationOnce(
      async (_projectId, operation) => {
        await new Promise<void>((resolve) => {
          releaseLock = resolve;
        });
        return operation();
      },
    );
    const state: PersistedWorktreeBrowserStateFile = {
      version: 1,
      browserOrder: ['browser-1'],
      activeBrowserId: 'browser-1',
      browsers: [snapshot('browser-1')],
    };

    const save = saveWorktreeBrowserState({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      state,
    });
    await Promise.resolve();

    expect(loadWorktreeBrowserState('project-1', 'worktree-1')).toEqual({
      status: 'missing',
      state: null,
    });
    expect(releaseLock).toBeDefined();
    releaseLock?.();
    await save;
    expect(withWorkspaceTargetRuntimeStartReservationMock).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      expect.any(Function),
    );
  });

  it('rejects invalid version-1 saves without replacing the prior file', async () => {
    const originalState: PersistedWorktreeBrowserStateFile = {
      version: 2,
      browserOrder: ['browser-1'],
      activeBrowserId: 'browser-1',
      browsers: [snapshot('browser-1')],
    };
    writeJson(originalState);
    const original = readFileSync(mockStateFilePath, 'utf8');
    const inode = statSync(mockStateFilePath).ino;

    await expect(
      saveWorktreeBrowserState({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        state: {
          version: 2,
          browserOrder: ['missing-browser'],
          activeBrowserId: null,
          browsers: [snapshot('browser-1')],
        },
      }),
    ).rejects.toThrow(BrowserStateHydrationError);
    expect(readFileSync(mockStateFilePath, 'utf8')).toBe(original);
    expect(statSync(mockStateFilePath).ino).toBe(inode);
  });
});
