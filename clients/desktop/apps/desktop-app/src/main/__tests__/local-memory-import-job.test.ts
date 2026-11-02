import type { ClaudeMemoryDiscoveryResult } from '../memory/local/import/discovery';
import type * as FsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockReadLocalMemoryEnabledPreference = jest.fn<Promise<boolean>, []>();
const mockDiscoverClaudeMemoryFiles = jest.fn<
  Promise<ClaudeMemoryDiscoveryResult>,
  [string]
>();
const mockDiscoverCodexMemoryFiles = jest.fn<
  Promise<ClaudeMemoryDiscoveryResult>,
  []
>();
const mockReadImportState = jest.fn();
const mockRunClaudeMemoryImport = jest.fn();
const mockRunCodexMemoryImport = jest.fn();
const mockReadFile = jest.fn<Promise<string>, [string, string]>();
const mockReadAllSidebarItems = jest.fn();
const mockReadWorkspaceConfig = jest.fn();
const mockRequestLocalMemoryConsolidation = jest.fn();
const mockResolveLocalMemoryPolicy = jest.fn();

jest.mock('node:fs/promises', () => ({
  ...jest.requireActual<typeof FsPromises>('node:fs/promises'),
  readFile: (path: string, encoding: string): Promise<string> =>
    mockReadFile(path, encoding),
}));

jest.mock('../lib/preferences-store', () => ({
  get readLocalMemoryEnabledPreference(): typeof mockReadLocalMemoryEnabledPreference {
    return mockReadLocalMemoryEnabledPreference;
  },
}));

jest.mock('../lib/sidebar-items', () => ({
  get readAllSidebarItems(): typeof mockReadAllSidebarItems {
    return mockReadAllSidebarItems;
  },
}));

jest.mock('../lib/workspace-persistence', () => ({
  get readWorkspaceConfig(): typeof mockReadWorkspaceConfig {
    return mockReadWorkspaceConfig;
  },
}));

jest.mock('../memory/local/consolidation-scheduler', () => ({
  get requestLocalMemoryConsolidation(): typeof mockRequestLocalMemoryConsolidation {
    return mockRequestLocalMemoryConsolidation;
  },
}));

jest.mock('../lib/paths', () => ({
  getUserMemoryDir: (): string => join(mockMemoryRoot, 'user'),
  getWorkspaceMemoryDir: (workspaceId: string): string =>
    join(mockMemoryRoot, 'workspaces', workspaceId),
  coworkWorkspaceRootDirFor: (
    workspaceId: string,
    externalPath: string | undefined,
  ): string =>
    externalPath ?? join(mockMemoryRoot, 'workspaces', workspaceId, 'home'),
}));

jest.mock('../memory/local/import/discovery', () => ({
  get discoverClaudeMemoryFiles(): typeof mockDiscoverClaudeMemoryFiles {
    return mockDiscoverClaudeMemoryFiles;
  },
  get discoverCodexMemoryFiles(): typeof mockDiscoverCodexMemoryFiles {
    return mockDiscoverCodexMemoryFiles;
  },
}));

jest.mock('../memory/local/import/ledger', () => ({
  get readImportState(): typeof mockReadImportState {
    return mockReadImportState;
  },
}));

jest.mock('../memory/local/import/import-runner', () => ({
  get runClaudeMemoryImport(): typeof mockRunClaudeMemoryImport {
    return mockRunClaudeMemoryImport;
  },
  get runCodexMemoryImport(): typeof mockRunCodexMemoryImport {
    return mockRunCodexMemoryImport;
  },
}));

jest.mock('../memory/local/policy', () => ({
  get resolveLocalMemoryPolicy(): typeof mockResolveLocalMemoryPolicy {
    return mockResolveLocalMemoryPolicy;
  },
}));

import { backgroundHelperQueueTestExports } from '../lib/background-helper-queue';
import {
  enqueueClaudeMemoryImport,
  enqueueCodexMemoryImport,
  enqueueManualLocalMemoryImportBatch,
  enqueueStartupLocalMemoryImportBatch,
  enqueueWorkspaceLocalMemoryImportBatch,
} from '../memory/local/import/import-job';

const NOW = new Date('2026-08-31T12:00:00.000Z');
const SOURCE_PATH = '/claude/projects/repo/memory/MEMORY.md';
const RECENT_SOURCE_PATH = '/claude/projects/repo/memory/recent.md';
const CODEX_SOURCE_PATH = '/codex/memories/MEMORY.md';
let mockMemoryRoot = '';

describe('Claude memory import queue job', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] }).setSystemTime(NOW);
    backgroundHelperQueueTestExports.reset();
    mockReadLocalMemoryEnabledPreference.mockResolvedValue(true);
    mockResolveLocalMemoryPolicy.mockResolvedValue({
      kind: 'scoped',
      workspaceId: 'workspace-1',
      privateMemory: false,
    });
    mockDiscoverClaudeMemoryFiles.mockResolvedValue({
      sourceDir: '/claude/projects/repo/memory',
      files: [
        {
          sourcePath: SOURCE_PATH,
          originalName: 'MEMORY.md',
          size: 12,
          modifiedAt: NOW,
        },
        {
          sourcePath: RECENT_SOURCE_PATH,
          originalName: 'recent.md',
          size: 10,
          modifiedAt: NOW,
        },
      ],
      oversizeFiles: [],
    });
    mockDiscoverCodexMemoryFiles.mockResolvedValue({
      sourceDir: '/codex/memories',
      files: [
        {
          sourcePath: CODEX_SOURCE_PATH,
          originalName: 'MEMORY.md',
          size: 12,
          modifiedAt: NOW,
        },
      ],
      oversizeFiles: [],
    });
    mockReadFile.mockResolvedValue('Project fact');
    mockMemoryRoot = await mkdtemp(join(tmpdir(), 'memory-import-job-'));
    mockReadImportState.mockResolvedValue({ version: 1, sources: {} });
    mockReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [
        {
          id: 'workspace-1',
          name: 'Workspace 1',
          type: 'single-repo',
          repoPath: '/repos/app',
        },
      ],
    });
    mockReadWorkspaceConfig.mockResolvedValue({
      id: 'workspace-1',
      name: 'Workspace 1',
      type: 'single-repo',
      repoPath: '/repos/app',
    });
    mockRunClaudeMemoryImport.mockResolvedValue({
      staged: 1,
      skippedUnchanged: 0,
      skippedOversize: 0,
      oversizePaths: [],
      skippedUndrainable: 0,
      deferred: 0,
      errors: [],
    });
    mockRunCodexMemoryImport.mockResolvedValue({
      staged: 0,
      skippedUnchanged: 0,
      skippedOversize: 0,
      oversizePaths: [],
      skippedUndrainable: 0,
      deferred: 0,
      errors: [],
    });
  });

  afterEach(async () => {
    jest.useRealTimers();
    await rm(mockMemoryRoot, { recursive: true, force: true });
  });

  it('no-ops without discovering or importing when local memory is disabled', async () => {
    mockReadLocalMemoryEnabledPreference.mockResolvedValue(false);

    const result = await enqueueClaudeMemoryImport({
      scope: 'workspace',
      workspaceId: 'workspace-1',
      repoPath: '/repos/app',
      repoId: 'app',
    });

    expect(result.status).toBe('disabled');
    expect(mockDiscoverClaudeMemoryFiles).not.toHaveBeenCalled();
    expect(mockRunClaudeMemoryImport).not.toHaveBeenCalled();
  });

  it('no-ops when every source in the target scope was checked within 24 hours', async () => {
    mockReadImportState.mockResolvedValue({
      version: 1,
      sources: {
        [SOURCE_PATH]: {
          fileHash: 'a'.repeat(64),
          importedAt: '2026-08-30T10:00:00.000Z',
          checkedAt: '2026-08-31T11:00:00.000Z',
          stagedAs: 'imported/memory.md',
        },
        [RECENT_SOURCE_PATH]: {
          fileHash: 'b'.repeat(64),
          importedAt: '2026-08-30T10:00:00.000Z',
          checkedAt: '2026-08-31T11:00:00.000Z',
          stagedAs: 'imported/recent.md',
        },
      },
    });

    const result = await enqueueClaudeMemoryImport({
      scope: 'workspace',
      workspaceId: 'workspace-1',
      repoPath: '/repos/app',
    });

    expect(result.status).toBe('min-interval');
    expect(mockRunClaudeMemoryImport).not.toHaveBeenCalled();
  });

  it('runs due sources through the lowest-priority queued importer', async () => {
    mockReadImportState.mockResolvedValue({
      version: 1,
      sources: {
        [SOURCE_PATH]: {
          fileHash: 'a'.repeat(64),
          importedAt: '2026-08-29T10:00:00.000Z',
          checkedAt: '2026-08-30T11:59:59.999Z',
          stagedAs: 'imported/memory.md',
        },
        [RECENT_SOURCE_PATH]: {
          fileHash: 'b'.repeat(64),
          importedAt: '2026-08-30T10:00:00.000Z',
          checkedAt: '2026-08-31T11:00:00.000Z',
          stagedAs: 'imported/recent.md',
        },
      },
    });

    const result = await enqueueClaudeMemoryImport({
      scope: 'workspace',
      workspaceId: 'workspace-1',
      repoPath: '/repos/app',
      repoId: 'app',
    });

    expect(result.status).toBe('completed');
    expect(mockRunClaudeMemoryImport).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      repoPath: '/repos/app',
      repoId: 'app',
      scopeFilter: 'workspace',
      checkedAt: NOW.toISOString(),
      sourcePaths: [SOURCE_PATH],
    });
  });

  it('schedules user-frontmatter Claude files for a private workspace', async () => {
    mockResolveLocalMemoryPolicy.mockResolvedValue({
      kind: 'scoped',
      workspaceId: 'workspace-1',
      privateMemory: true,
    });
    mockReadFile.mockResolvedValue('---\ntype: user\n---\nPrivate fact');

    await enqueueClaudeMemoryImport({
      scope: 'workspace',
      workspaceId: 'workspace-1',
      repoPath: '/repos/app',
    });

    expect(mockRunClaudeMemoryImport).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        scopeFilter: 'workspace',
        sourcePaths: [SOURCE_PATH, RECENT_SOURCE_PATH],
      }),
    );
  });

  it('forces a manual import despite a fresh checkedAt while background imports remain gated', async () => {
    mockReadImportState.mockResolvedValue({
      version: 1,
      sources: {
        [SOURCE_PATH]: {
          fileHash: 'a'.repeat(64),
          importedAt: '2026-08-30T10:00:00.000Z',
          checkedAt: '2026-08-31T11:00:00.000Z',
          stagedAs: 'imported/memory.md',
        },
        [RECENT_SOURCE_PATH]: {
          fileHash: 'b'.repeat(64),
          importedAt: '2026-08-30T10:00:00.000Z',
          checkedAt: '2026-08-31T11:00:00.000Z',
          stagedAs: 'imported/recent.md',
        },
      },
    });

    const backgroundResult = await enqueueClaudeMemoryImport({
      scope: 'user',
      repoPath: '/repos/app',
    });
    expect(backgroundResult.status).toBe('min-interval');
    expect(mockRunClaudeMemoryImport).not.toHaveBeenCalled();

    const manualResult = await enqueueManualLocalMemoryImportBatch();

    expect(manualResult.staged).toBe(1);
    expect(mockRunClaudeMemoryImport).toHaveBeenCalledWith({
      userScope: true,
      workspaceId: 'workspace-1',
      repoPath: '/repos/app',
      scopeFilter: 'user',
      checkedAt: NOW.toISOString(),
    });
    expect(mockRunCodexMemoryImport).toHaveBeenCalledWith({
      userScope: true,
      checkedAt: NOW.toISOString(),
    });
  });

  it('enqueues the instance-global Codex target once in startup and manual user batches', async () => {
    await enqueueStartupLocalMemoryImportBatch();

    expect(mockRunCodexMemoryImport).toHaveBeenCalledTimes(1);
    expect(mockRunCodexMemoryImport).toHaveBeenLastCalledWith({
      userScope: true,
      checkedAt: NOW.toISOString(),
      sourcePaths: [CODEX_SOURCE_PATH],
    });

    await enqueueManualLocalMemoryImportBatch('workspace-1');

    expect(mockRunCodexMemoryImport).toHaveBeenCalledTimes(2);
    expect(mockRunCodexMemoryImport).toHaveBeenLastCalledWith({
      userScope: true,
      checkedAt: NOW.toISOString(),
    });
  });

  it('applies the per-source minimum interval to Codex memory checks', async () => {
    mockReadImportState.mockResolvedValue({
      version: 1,
      sources: {
        [CODEX_SOURCE_PATH]: {
          fileHash: 'c'.repeat(64),
          importedAt: '2026-08-30T10:00:00.000Z',
          checkedAt: '2026-08-31T11:00:00.000Z',
          stagedAs: 'imported/codex-memory.md',
          sourceTool: 'codex',
        },
      },
    });

    const result = await enqueueCodexMemoryImport();

    expect(result.status).toBe('min-interval');
    expect(mockRunCodexMemoryImport).not.toHaveBeenCalled();
  });

  it('requests consolidation for every scope that staged files', async () => {
    const result = await enqueueManualLocalMemoryImportBatch('workspace-1');

    expect(result.staged).toBe(2);
    expect(mockRequestLocalMemoryConsolidation).toHaveBeenCalledTimes(2);
    expect(mockRequestLocalMemoryConsolidation).toHaveBeenCalledWith({});
    expect(mockRequestLocalMemoryConsolidation).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
    });
  });

  it('includes Codex outcomes in user-scope consolidation totals', async () => {
    const codexOversizePath = '/codex/memories/memory_summary.md';
    mockRunClaudeMemoryImport.mockResolvedValue({
      staged: 0,
      skippedUnchanged: 0,
      skippedOversize: 0,
      oversizePaths: [],
      skippedUndrainable: 0,
      deferred: 0,
      errors: [],
    });
    mockRunCodexMemoryImport.mockResolvedValue({
      staged: 1,
      skippedUnchanged: 0,
      skippedOversize: 1,
      oversizePaths: [codexOversizePath],
      skippedUndrainable: 1,
      deferred: 1,
      errors: ['Codex import warning'],
    });

    const result = await enqueueManualLocalMemoryImportBatch('workspace-1');

    expect(result).toEqual({
      disabled: false,
      staged: 1,
      skipped: 2,
      deferred: 1,
      errors: ['Codex import warning'],
    });
    expect(mockRequestLocalMemoryConsolidation).toHaveBeenCalledTimes(1);
    expect(mockRequestLocalMemoryConsolidation).toHaveBeenCalledWith({});
  });

  it('deduplicates one oversize source shared by user and project targets', async () => {
    mockRunClaudeMemoryImport.mockResolvedValue({
      staged: 0,
      skippedUnchanged: 0,
      skippedOversize: 1,
      oversizePaths: [SOURCE_PATH],
      skippedUndrainable: 0,
      deferred: 0,
      errors: [],
    });

    const result = await enqueueManualLocalMemoryImportBatch('workspace-1');

    expect(mockRunClaudeMemoryImport).toHaveBeenCalledTimes(2);
    expect(result.skipped).toBe(1);
  });

  it('re-arms consolidation when an unchanged batch has an unconsolidated ledger entry', async () => {
    mockRunClaudeMemoryImport.mockResolvedValue({
      staged: 0,
      skippedUnchanged: 2,
      skippedOversize: 0,
      oversizePaths: [],
      skippedUndrainable: 0,
      deferred: 0,
      errors: [],
    });
    mockReadImportState.mockResolvedValue({
      version: 1,
      sources: {
        [SOURCE_PATH]: {
          fileHash: 'a'.repeat(64),
          importedAt: NOW.toISOString(),
          stagedAs: 'imported/memory.md',
        },
      },
    });

    const result = await enqueueManualLocalMemoryImportBatch();

    expect(result.staged).toBe(0);
    expect(mockRequestLocalMemoryConsolidation).toHaveBeenCalledWith({});
  });

  it('ignores the consolidated archive but re-arms for a loose staged markdown file', async () => {
    mockRunClaudeMemoryImport.mockResolvedValue({
      staged: 0,
      skippedUnchanged: 2,
      skippedOversize: 0,
      oversizePaths: [],
      skippedUndrainable: 0,
      deferred: 0,
      errors: [],
    });
    const importedDir = join(mockMemoryRoot, 'user', 'imported');
    await mkdir(join(importedDir, '.consolidated'), { recursive: true });
    await writeFile(
      join(importedDir, '.consolidated', 'archived.md'),
      'already consolidated',
      'utf8',
    );

    await enqueueManualLocalMemoryImportBatch();

    expect(mockRequestLocalMemoryConsolidation).not.toHaveBeenCalled();

    await writeFile(join(importedDir, 'pending.md'), 'pending', 'utf8');
    await enqueueManualLocalMemoryImportBatch();

    expect(mockRequestLocalMemoryConsolidation).toHaveBeenCalledWith({});
  });

  it('does not request consolidation when the batch has no pending staged work', async () => {
    mockRunClaudeMemoryImport.mockResolvedValue({
      staged: 0,
      skippedUnchanged: 2,
      skippedOversize: 0,
      oversizePaths: [],
      skippedUndrainable: 0,
      deferred: 0,
      errors: [],
    });

    const result = await enqueueManualLocalMemoryImportBatch();

    expect(result.staged).toBe(0);
    expect(mockRequestLocalMemoryConsolidation).not.toHaveBeenCalled();
  });

  it('returns actionable skipped and deferred counts without requiring UI delivery', async () => {
    mockRunClaudeMemoryImport.mockResolvedValue({
      staged: 0,
      skippedUnchanged: 0,
      skippedOversize: 2,
      oversizePaths: [SOURCE_PATH, RECENT_SOURCE_PATH],
      skippedUndrainable: 1,
      deferred: 3,
      errors: [],
    });

    const result = await enqueueManualLocalMemoryImportBatch();

    expect(result).toEqual({
      disabled: false,
      staged: 0,
      skipped: 3,
      deferred: 3,
      errors: [],
    });
  });

  it('gates repeated background oversize checks while manual force still processes them', async () => {
    mockDiscoverClaudeMemoryFiles.mockResolvedValue({
      sourceDir: '/claude/projects/repo/memory',
      files: [],
      oversizeFiles: [SOURCE_PATH],
    });
    mockRunClaudeMemoryImport.mockResolvedValue({
      staged: 0,
      skippedUnchanged: 0,
      skippedOversize: 1,
      oversizePaths: [SOURCE_PATH],
      skippedUndrainable: 0,
      deferred: 0,
      errors: [],
    });

    await enqueueWorkspaceLocalMemoryImportBatch('workspace-1');

    expect(mockRunClaudeMemoryImport).toHaveBeenCalledWith(
      expect.objectContaining({ sourcePaths: [SOURCE_PATH] }),
    );

    mockRunClaudeMemoryImport.mockClear();
    mockReadImportState.mockResolvedValue({
      version: 1,
      sources: {
        [SOURCE_PATH]: {
          checkedAt: NOW.toISOString(),
          skipReason: 'oversize',
        },
      },
    });

    const second = await enqueueClaudeMemoryImport({
      scope: 'workspace',
      workspaceId: 'workspace-1',
      repoPath: '/repos/app',
    });

    expect(second.status).toBe('min-interval');
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockRunClaudeMemoryImport).not.toHaveBeenCalled();
    await enqueueManualLocalMemoryImportBatch();

    expect(mockRunClaudeMemoryImport).toHaveBeenCalledWith(
      expect.objectContaining({
        userScope: true,
        repoPath: '/repos/app',
      }),
    );
  });

  describe('cowork workspaces', () => {
    const COWORK_FOLDER = '/folders/notes';

    it('imports workspace-scope memory from the attached folder of a cowork workspace', async () => {
      mockReadWorkspaceConfig.mockResolvedValue({
        version: 1,
        type: 'cowork',
        repos: [],
        externalPath: COWORK_FOLDER,
      });

      const result = await enqueueWorkspaceLocalMemoryImportBatch('cowork-1');

      expect(result.staged).toBe(1);
      expect(mockDiscoverClaudeMemoryFiles).toHaveBeenCalledWith(COWORK_FOLDER);
      expect(mockRunClaudeMemoryImport).toHaveBeenCalledTimes(1);
      expect(mockRunClaudeMemoryImport).toHaveBeenCalledWith({
        workspaceId: 'cowork-1',
        repoPath: COWORK_FOLDER,
        scopeFilter: 'workspace',
        checkedAt: NOW.toISOString(),
        sourcePaths: [SOURCE_PATH, RECENT_SOURCE_PATH],
      });
      expect(mockRequestLocalMemoryConsolidation).toHaveBeenCalledWith({
        workspaceId: 'cowork-1',
      });
    });

    it('uses the managed home folder for a cowork workspace without an attached folder', async () => {
      mockReadWorkspaceConfig.mockResolvedValue({
        version: 1,
        type: 'cowork',
        repos: [],
      });

      await enqueueWorkspaceLocalMemoryImportBatch('cowork-1');

      const homeDir = join(mockMemoryRoot, 'workspaces', 'cowork-1', 'home');
      expect(mockDiscoverClaudeMemoryFiles).toHaveBeenCalledWith(homeDir);
      expect(mockRunClaudeMemoryImport).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'cowork-1',
          repoPath: homeDir,
          scopeFilter: 'workspace',
        }),
      );
    });

    it('includes cowork sidebar items in the startup user-scope batch', async () => {
      mockReadFile.mockResolvedValue('---\ntype: user\n---\nUser fact');
      mockReadAllSidebarItems.mockResolvedValue({
        version: 1,
        items: [
          {
            id: 'cowork-1',
            name: 'Notes',
            type: 'cowork',
            externalPath: COWORK_FOLDER,
          },
        ],
      });

      await enqueueStartupLocalMemoryImportBatch();

      expect(mockRunClaudeMemoryImport).toHaveBeenCalledTimes(1);
      expect(mockRunClaudeMemoryImport).toHaveBeenCalledWith({
        userScope: true,
        workspaceId: 'cowork-1',
        repoPath: COWORK_FOLDER,
        scopeFilter: 'user',
        checkedAt: NOW.toISOString(),
        sourcePaths: [SOURCE_PATH, RECENT_SOURCE_PATH],
      });
    });

    it('covers both scopes when a cowork workspace is imported manually', async () => {
      mockReadWorkspaceConfig.mockResolvedValue({
        version: 1,
        type: 'cowork',
        repos: [],
        externalPath: COWORK_FOLDER,
      });

      await enqueueManualLocalMemoryImportBatch('cowork-1');

      expect(mockRunClaudeMemoryImport).toHaveBeenCalledTimes(2);
      expect(mockRunClaudeMemoryImport).toHaveBeenCalledWith(
        expect.objectContaining({
          userScope: true,
          repoPath: COWORK_FOLDER,
          scopeFilter: 'user',
        }),
      );
      expect(mockRunClaudeMemoryImport).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'cowork-1',
          repoPath: COWORK_FOLDER,
          scopeFilter: 'workspace',
        }),
      );
      expect(mockRunCodexMemoryImport).toHaveBeenCalledTimes(1);
    });
  });
});
