import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import type * as CodexRuntime from '@canopy/desktop-shared/node/codex-runtime';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

let mockProjectsDir = '';
let mockCandidateNames: string[] = [];
let mockUserScopeDir = '';
let mockWorkspaceScopeDir = '';
let mockObservedCodexHome: string | null = null;
const mockGetCanonicalState = jest.fn<Promise<{ codexHome: string }>, []>();
const mockResolveLocalMemoryPolicy = jest.fn();
jest.mock('../memory/local/policy', () => ({
  resolveLocalMemoryPolicy: (...args: unknown[]): unknown =>
    mockResolveLocalMemoryPolicy(...args),
}));

jest.mock('../lib/claude-project-paths', () => ({
  getClaudeCodeProjectsDir: (): string => mockProjectsDir,
  claudeProjectDirCandidates: (): Promise<string[]> =>
    Promise.resolve(mockCandidateNames),
}));

jest.mock('../lib/paths', () => ({
  getUserMemoryDir: (): string => mockUserScopeDir,
  getWorkspaceMemoryDir: (): string => mockWorkspaceScopeDir,
}));

jest.mock('@canopy/desktop-shared/node/codex-runtime', () => ({
  ...jest.requireActual<typeof CodexRuntime>(
    '@canopy/desktop-shared/node/codex-runtime',
  ),
  getObservedCanonicalCodexHome: (): string | null => mockObservedCodexHome,
}));

jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: (): {
    getCanonicalState: typeof mockGetCanonicalState;
  } => ({
    getCanonicalState: mockGetCanonicalState,
  }),
}));

import { resolveCodexMemoryHome } from '../memory/local/import/codex-home';
import {
  discoverClaudeMemoryFiles,
  discoverCodexMemoryFiles,
} from '../memory/local/import/discovery';
import * as inputBudget from '../memory/local/input-budget';
import {
  readImportState,
  writeImportState,
} from '../memory/local/import/ledger';
import * as ledgerModule from '../memory/local/import/ledger';
import {
  ImportRestageRefusedError,
  restageImportSource,
  runClaudeMemoryImport,
  runCodexMemoryImport,
} from '../memory/local/import/import-runner';
import type { ImportStateStagedEntry } from '../memory/local/import/ledger';
import {
  routeClaudeMemoryContent,
  routeCodexMemoryContent,
} from '../memory/local/import/scope-routing';
import { prepareStagedMemoryContent } from '../memory/local/import/staging';

const NOW = new Date('2026-08-31T12:00:00.000Z');

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function pathArgument(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value instanceof URL) return value.pathname;
  return '';
}

async function createSourceMemory(
  rootDir: string,
  candidate = 'candidate',
): Promise<string> {
  mockProjectsDir = join(rootDir, 'claude-projects');
  mockCandidateNames = [candidate];
  const memoryDir = join(mockProjectsDir, candidate, 'memory');
  await mkdir(join(memoryDir, 'topics'), { recursive: true });
  return memoryDir;
}

describe('local memory Claude import', () => {
  let rootDir: string;
  let sourceDir: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockResolveLocalMemoryPolicy.mockResolvedValue({
      kind: 'scoped',
      workspaceId: 'workspace-1',
      privateMemory: false,
    });
    rootDir = await mkdtemp(join(tmpdir(), 'local-memory-import-'));
    mockUserScopeDir = join(rootDir, 'user-memory');
    mockWorkspaceScopeDir = join(rootDir, 'workspace-memory');
    mockObservedCodexHome = null;
    mockGetCanonicalState.mockResolvedValue({
      codexHome: join(rootDir, 'canonical-codex'),
    });
    sourceDir = await createSourceMemory(rootDir);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(rootDir, { recursive: true, force: true });
  });

  it('uses the first existing Claude project candidate and discovers only supported files', async () => {
    const missingCandidate = 'missing-candidate';
    mockCandidateNames = [missingCandidate, 'candidate', 'later-candidate'];
    await writeFile(join(sourceDir, 'MEMORY.md'), '# Index', 'utf8');
    await writeFile(join(sourceDir, 'topics', 'alpha.md'), '# Alpha', 'utf8');
    await writeFile(join(sourceDir, 'topics', 'ignore.txt'), 'ignored', 'utf8');
    const fsPromises = jest.requireActual<{ stat: typeof stat }>(
      'node:fs/promises',
    );
    const statSpy = jest.spyOn(fsPromises, 'stat');

    const discovered = await discoverClaudeMemoryFiles('/repo/path');

    expect(discovered.sourceDir).toBe(sourceDir);
    expect(discovered.files.map((file) => file.sourcePath)).toEqual([
      join(sourceDir, 'MEMORY.md'),
      join(sourceDir, 'topics', 'alpha.md'),
    ]);
    expect(statSpy).toHaveBeenCalledWith(
      join(mockProjectsDir, missingCandidate, 'memory'),
    );
    expect(statSpy).toHaveBeenCalledWith(sourceDir);
    expect(
      statSpy.mock.calls.some(
        ([path]) =>
          String(path) === join(mockProjectsDir, 'later-candidate', 'memory'),
      ),
    ).toBe(false);
  });

  it('resolves Codex home from already-observed canonical state without falling back', async () => {
    const canonicalCodexHome = join(rootDir, 'canonical-codex');
    mockObservedCodexHome = canonicalCodexHome;
    mockGetCanonicalState.mockResolvedValue({ codexHome: canonicalCodexHome });

    await expect(
      resolveCodexMemoryHome({
        CODEX_HOME: join(rootDir, 'fallback-codex'),
        HOME: join(rootDir, 'fallback-home'),
      }),
    ).resolves.toBe(canonicalCodexHome);
    expect(mockGetCanonicalState).toHaveBeenCalledTimes(1);
  });

  it('resolves Codex home from CODEX_HOME then HOME without starting the runtime', async () => {
    const configuredCodexHome = join(rootDir, 'configured-codex');
    const fallbackHome = join(rootDir, 'fallback-home');

    await expect(
      resolveCodexMemoryHome({
        CODEX_HOME: `  ${configuredCodexHome}  `,
        HOME: fallbackHome,
      }),
    ).resolves.toBe(configuredCodexHome);
    await expect(resolveCodexMemoryHome({ HOME: fallbackHome })).resolves.toBe(
      join(fallbackHome, '.codex'),
    );
    expect(mockGetCanonicalState).not.toHaveBeenCalled();
  });

  it('discovers only Codex MEMORY.md and memory_summary.md', async () => {
    const codexHome = join(rootDir, 'codex-home');
    const memoriesDir = join(codexHome, 'memories');
    await mkdir(join(memoriesDir, 'rollout_summaries'), { recursive: true });
    await mkdir(join(memoriesDir, 'skills'), { recursive: true });
    await writeFile(join(memoriesDir, 'MEMORY.md'), '# Codex memory', 'utf8');
    await writeFile(
      join(memoriesDir, 'memory_summary.md'),
      '# Codex summary',
      'utf8',
    );
    await writeFile(join(memoriesDir, 'raw_memories.md'), 'ignored', 'utf8');
    await writeFile(join(memoriesDir, 'other.md'), 'ignored', 'utf8');
    await writeFile(
      join(memoriesDir, 'rollout_summaries', 'rollout.md'),
      'ignored',
      'utf8',
    );

    const discovered = await discoverCodexMemoryFiles(codexHome);

    expect(discovered.sourceDir).toBe(memoriesDir);
    expect(discovered.files.map((file) => file.sourcePath)).toEqual([
      join(memoriesDir, 'MEMORY.md'),
      join(memoriesDir, 'memory_summary.md'),
    ]);
    expect(discovered.oversizeFiles).toEqual([]);
  });

  it.each([
    {
      name: 'user frontmatter',
      raw: '---\ntype: user\nmodified: 2026-08-30T10:00:00.000Z\n---\nUser fact',
      scope: 'user',
      modified: '2026-08-30T10:00:00.000Z',
      content: 'User fact',
    },
    {
      name: 'untyped content',
      raw: 'Project fact',
      scope: 'workspace',
      modified: NOW.toISOString(),
      content: 'Project fact',
    },
    {
      name: 'malformed frontmatter',
      raw: '---\ntype: [broken\nmodified: nope\n---\nFallback fact',
      scope: 'workspace',
      modified: NOW.toISOString(),
      content: 'Fallback fact',
    },
  ])('routes and strips $name', (testCase) => {
    expect(routeClaudeMemoryContent(testCase.raw, NOW)).toEqual({
      scope: testCase.scope,
      modified: testCase.modified,
      content: testCase.content,
    });
  });

  it('routes Codex memories verbatim to user scope with mtime metadata', () => {
    const raw = '---\ntype: project\n---\nCodex keeps this verbatim';

    expect(routeCodexMemoryContent(raw, NOW)).toEqual({
      scope: 'user',
      modified: NOW.toISOString(),
      content: raw,
    });
  });

  it('coexists with Claude entries in one user ledger and reruns idempotently per source', async () => {
    const claudeSourcePath = join(sourceDir, 'MEMORY.md');
    await writeFile(
      claudeSourcePath,
      '---\ntype: user\n---\nClaude user fact',
      'utf8',
    );
    const codexHome = join(rootDir, 'codex-home');
    const codexSourceDir = join(codexHome, 'memories');
    const codexSourcePath = join(codexSourceDir, 'MEMORY.md');
    await mkdir(codexSourceDir, { recursive: true });
    await writeFile(codexSourcePath, 'Codex user fact', 'utf8');

    const claudeFirst = await runClaudeMemoryImport({
      userScope: true,
      repoPath: '/repo/path',
    });
    const codexFirst = await runCodexMemoryImport({
      userScope: true,
      codexHome,
    });
    const claudeSecond = await runClaudeMemoryImport({
      userScope: true,
      repoPath: '/repo/path',
    });
    const codexSecond = await runCodexMemoryImport({
      userScope: true,
      codexHome,
    });

    expect(claudeFirst.staged).toBe(1);
    expect(codexFirst.staged).toBe(1);
    expect(claudeSecond.skippedUnchanged).toBe(1);
    expect(codexSecond.skippedUnchanged).toBe(1);
    const state = await readImportState(mockUserScopeDir);
    expect(Object.keys(state.sources).sort()).toEqual(
      [claudeSourcePath, codexSourcePath].sort(),
    );
    const claudeEntry = state.sources[claudeSourcePath];
    if (!claudeEntry || !('stagedAs' in claudeEntry)) {
      throw new Error('Expected staged Claude source ledger entry');
    }
    expect(claudeEntry.sourceTool).toBeUndefined();
    expect(state.sources[codexSourcePath]).toEqual(
      expect.objectContaining({ sourceTool: 'codex' }),
    );
    expect(await readdir(join(mockUserScopeDir, 'imported'))).toHaveLength(2);
  });

  it('applies oversize and undrainable guards to Codex sources', async () => {
    const codexHome = join(rootDir, 'codex-home');
    const codexSourceDir = join(codexHome, 'memories');
    const oversizePath = join(codexSourceDir, 'MEMORY.md');
    const undrainablePath = join(codexSourceDir, 'memory_summary.md');
    await mkdir(codexSourceDir, { recursive: true });
    await writeFile(oversizePath, Buffer.alloc(4 * 1024 * 1024 + 1, 120));
    await writeFile(undrainablePath, 'x'.repeat(200 * 1024), 'utf8');
    const emitWarningSpy = jest
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);

    const result = await runCodexMemoryImport({
      userScope: true,
      codexHome,
      checkedAt: NOW.toISOString(),
    });

    expect(result).toMatchObject({
      staged: 0,
      skippedOversize: 1,
      skippedUndrainable: 1,
      deferred: 0,
      errors: [],
    });
    expect(result.oversizePaths).toEqual([oversizePath]);
    expect(emitWarningSpy).toHaveBeenCalledWith(
      expect.stringMatching(/4 MiB/i),
      {
        code: 'LOCAL_MEMORY_IMPORT_OVERSIZE_SKIPPED',
      },
    );
    expect(emitWarningSpy).toHaveBeenCalledWith(
      expect.stringMatching(/never fit.*budget/i),
      { code: 'LOCAL_MEMORY_IMPORT_UNDRAINABLE_SKIPPED' },
    );
    expect((await readImportState(mockUserScopeDir)).sources).toEqual({
      [oversizePath]: {
        checkedAt: NOW.toISOString(),
        skipReason: 'oversize',
      },
      [undrainablePath]: {
        checkedAt: NOW.toISOString(),
        skipReason: 'undrainable',
      },
    });
  });

  it('redacts imported content, strips frontmatter, and writes owner-only staging files', async () => {
    const sourcePath = join(sourceDir, 'MEMORY.md');
    await writeFile(
      sourcePath,
      '---\ntype: project\n---\nDeploy with api_key=supersecretvalue.',
      'utf8',
    );
    const budgetSpy = jest.spyOn(inputBudget, 'importEntryFitsBudget');

    const result = await runClaudeMemoryImport({
      workspaceId: 'workspace-1',
      repoPath: '/repo/path',
      repoId: 'api',
    });

    expect(result).toMatchObject({
      staged: 1,
      skippedUnchanged: 0,
      skippedOversize: 0,
      skippedUndrainable: 0,
      deferred: 0,
      errors: [],
    });
    const state = await readImportState(mockWorkspaceScopeDir);
    const entry = state.sources[sourcePath];
    expect(entry).toBeDefined();
    if (!entry || !('stagedAs' in entry)) {
      throw new Error('Expected staged source ledger entry');
    }
    const staged = await readFile(
      join(mockWorkspaceScopeDir, entry.stagedAs),
      'utf8',
    );
    const prepared = prepareStagedMemoryContent(
      'Deploy with api_key=supersecretvalue.',
    );
    const budgetedContent = budgetSpy.mock.calls[0]?.[0].content;
    const budgetedOriginalPath = budgetSpy.mock.calls[0]?.[0].originalPath;
    if (budgetedContent === undefined) {
      throw new Error('Expected the import budget guard to measure content');
    }
    expect((await stat(join(mockWorkspaceScopeDir, entry.stagedAs))).size).toBe(
      Buffer.byteLength(budgetedContent, 'utf8'),
    );
    expect(budgetedContent).toBe(prepared);
    expect(budgetedOriginalPath).toBe('claude-code-memory/MEMORY.md');
    expect(result.oversizePaths).toEqual([]);
    expect(staged).toBe(prepared);
    expect(staged).toContain('api_key=<redacted>');
    expect(staged).not.toContain('supersecretvalue');
    expect(staged).not.toContain('type: project');
    expect(entry.repo).toBe('api');
    if (process.platform !== 'win32') {
      expect(
        (await stat(join(mockWorkspaceScopeDir, entry.stagedAs))).mode & 0o777,
      ).toBe(0o600);
    }
  });

  it('routes user-tagged Claude files into a private project only', async () => {
    mockResolveLocalMemoryPolicy.mockResolvedValue({
      kind: 'scoped',
      workspaceId: 'workspace-1',
      privateMemory: true,
    });
    const sourcePath = join(sourceDir, 'MEMORY.md');
    await writeFile(
      sourcePath,
      '---\ntype: user\n---\nPrivate marker.',
      'utf8',
    );
    const result = await runClaudeMemoryImport({
      workspaceId: 'workspace-1',
      repoPath: '/repo/path',
    });
    expect(result.staged).toBe(1);
    expect(
      (await readImportState(mockWorkspaceScopeDir)).sources[sourcePath],
    ).toBeDefined();
    expect(await pathExists(mockUserScopeDir)).toBe(false);
  });

  it('records the project an import came from', async () => {
    const sourcePath = join(sourceDir, 'MEMORY.md');
    await writeFile(sourcePath, '---\ntype: user\n---\nUser fact', 'utf8');

    await runClaudeMemoryImport({
      userScope: true,
      workspaceId: 'workspace-1',
      repoPath: '/repo/path',
      scopeFilter: 'user',
    });

    expect(
      (await readImportState(mockUserScopeDir)).sources[sourcePath],
    ).toEqual(expect.objectContaining({ workspaceId: 'workspace-1' }));
  });

  describe('staging an import again for a rebuild', () => {
    const previous = (
      overrides: Partial<ImportStateStagedEntry> = {},
    ): ImportStateStagedEntry => ({
      fileHash: 'a'.repeat(64),
      importedAt: '2026-08-01T00:00:00.000Z',
      stagedAs: 'imported/claude-old-0123456789abcdef.md',
      consolidatedAt: '2026-08-02T00:00:00.000Z',
      ...overrides,
    });
    const stagedIn = async (scopeDir: string): Promise<string[]> =>
      readdir(join(scopeDir, 'imported')).catch(() => []);

    it('stages a project import again while it still routes to the project', async () => {
      const sourcePath = join(sourceDir, 'MEMORY.md');
      await writeFile(sourcePath, 'Project fact', 'utf8');

      const entry = await restageImportSource({
        scopeDir: mockWorkspaceScopeDir,
        target: { scope: 'workspace', workspaceId: 'workspace-1' },
        sourcePath,
        previous: previous(),
      });

      expect(entry.workspaceId).toBe('workspace-1');
      expect(await stagedIn(mockWorkspaceScopeDir)).toEqual([
        entry.stagedAs.slice('imported/'.length),
      ]);
    });

    it('does not stage into the project an import whose frontmatter now routes it to user memory', async () => {
      const sourcePath = join(sourceDir, 'MEMORY.md');
      await writeFile(sourcePath, '---\ntype: user\n---\nUser fact', 'utf8');

      await expect(
        restageImportSource({
          scopeDir: mockWorkspaceScopeDir,
          target: { scope: 'workspace', workspaceId: 'workspace-1' },
          sourcePath,
          previous: previous(),
        }),
      ).rejects.toEqual(new ImportRestageRefusedError('moved', sourcePath));

      expect(await stagedIn(mockWorkspaceScopeDir)).toEqual([]);
      expect(await stagedIn(mockUserScopeDir)).toEqual([]);
    });

    it('does not stage into a project whose memory is now blocked', async () => {
      mockResolveLocalMemoryPolicy.mockResolvedValue({
        kind: 'blocked',
        workspaceId: 'workspace-1',
      });
      const sourcePath = join(sourceDir, 'MEMORY.md');
      await writeFile(sourcePath, 'Project fact', 'utf8');

      await expect(
        restageImportSource({
          scopeDir: mockWorkspaceScopeDir,
          target: { scope: 'workspace', workspaceId: 'workspace-1' },
          sourcePath,
          previous: previous(),
        }),
      ).rejects.toEqual(new ImportRestageRefusedError('moved', sourcePath));
      expect(await stagedIn(mockWorkspaceScopeDir)).toEqual([]);
    });

    it('stages a user import again through the project it came from', async () => {
      const sourcePath = join(sourceDir, 'MEMORY.md');
      await writeFile(sourcePath, '---\ntype: user\n---\nUser fact', 'utf8');

      const entry = await restageImportSource({
        scopeDir: mockUserScopeDir,
        target: { scope: 'user' },
        sourcePath,
        previous: previous({ workspaceId: 'workspace-1' }),
      });

      expect(mockResolveLocalMemoryPolicy).toHaveBeenCalledWith({
        projectId: 'workspace-1',
        worktreeId: 'workspace-1',
      });
      expect(entry.workspaceId).toBe('workspace-1');
      expect(await stagedIn(mockUserScopeDir)).toHaveLength(1);
    });

    it("does not stage into user memory an import whose project's memory is now private", async () => {
      mockResolveLocalMemoryPolicy.mockResolvedValue({
        kind: 'scoped',
        workspaceId: 'workspace-1',
        privateMemory: true,
      });
      const sourcePath = join(sourceDir, 'MEMORY.md');
      await writeFile(sourcePath, '---\ntype: user\n---\nUser fact', 'utf8');

      await expect(
        restageImportSource({
          scopeDir: mockUserScopeDir,
          target: { scope: 'user' },
          sourcePath,
          previous: previous({ workspaceId: 'workspace-1' }),
        }),
      ).rejects.toEqual(new ImportRestageRefusedError('moved', sourcePath));
      expect(await stagedIn(mockUserScopeDir)).toEqual([]);
      expect(await stagedIn(mockWorkspaceScopeDir)).toEqual([]);
    });

    it('does not stage a user import that did not record its project', async () => {
      const sourcePath = join(sourceDir, 'MEMORY.md');
      await writeFile(sourcePath, '---\ntype: user\n---\nUser fact', 'utf8');

      await expect(
        restageImportSource({
          scopeDir: mockUserScopeDir,
          target: { scope: 'user' },
          sourcePath,
          previous: previous(),
        }),
      ).rejects.toEqual(
        new ImportRestageRefusedError('origin-unknown', sourcePath),
      );
      expect(await stagedIn(mockUserScopeDir)).toEqual([]);
    });

    it('stages a Codex import again into user memory only', async () => {
      const sourcePath = join(rootDir, 'codex', 'memories', 'MEMORY.md');
      await mkdir(join(rootDir, 'codex', 'memories'), { recursive: true });
      await writeFile(sourcePath, 'Codex fact', 'utf8');

      await expect(
        restageImportSource({
          scopeDir: mockWorkspaceScopeDir,
          target: { scope: 'workspace', workspaceId: 'workspace-1' },
          sourcePath,
          previous: previous({ sourceTool: 'codex' }),
        }),
      ).rejects.toEqual(new ImportRestageRefusedError('moved', sourcePath));
      const entry = await restageImportSource({
        scopeDir: mockUserScopeDir,
        target: { scope: 'user' },
        sourcePath,
        previous: previous({ sourceTool: 'codex' }),
      });
      expect(entry.sourceTool).toBe('codex');
      expect(await stagedIn(mockUserScopeDir)).toHaveLength(1);
    });
  });

  it('never promotes a private project file in a queued user-scope job', async () => {
    mockResolveLocalMemoryPolicy.mockResolvedValue({
      kind: 'scoped',
      workspaceId: 'workspace-1',
      privateMemory: true,
    });
    const sourcePath = join(sourceDir, 'MEMORY.md');
    await writeFile(
      sourcePath,
      '---\ntype: user\n---\nPrivate marker.',
      'utf8',
    );
    const result = await runClaudeMemoryImport({
      userScope: true,
      workspaceId: 'workspace-1',
      repoPath: '/repo/path',
      scopeFilter: 'user',
    });
    expect(result.staged).toBe(0);
    expect(await pathExists(mockUserScopeDir)).toBe(false);
  });

  it('processes only the source paths selected by a trigger', async () => {
    const duePath = join(sourceDir, 'MEMORY.md');
    const recentPath = join(sourceDir, 'topics', 'recent.md');
    await writeFile(duePath, 'Due project fact', 'utf8');
    await writeFile(recentPath, 'Recent project fact', 'utf8');

    const result = await runClaudeMemoryImport({
      workspaceId: 'workspace-1',
      repoPath: '/repo/path',
      sourcePaths: [duePath],
    });

    expect(result.staged).toBe(1);
    const state = await readImportState(mockWorkspaceScopeDir);
    expect(Object.keys(state.sources)).toEqual([duePath]);
    expect(state.sources[recentPath]).toBeUndefined();
  });

  it('skips files over 4 MiB and emits a stable warning', async () => {
    const sourcePath = join(sourceDir, 'MEMORY.md');
    await writeFile(sourcePath, Buffer.alloc(4 * 1024 * 1024 + 1, 120));
    const emitWarningSpy = jest
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);

    const result = await runClaudeMemoryImport({
      workspaceId: 'workspace-1',
      repoPath: '/repo/path',
      checkedAt: NOW.toISOString(),
    });

    expect(result.skippedOversize).toBe(1);
    expect(result.oversizePaths).toEqual([sourcePath]);
    expect(result.staged).toBe(0);
    expect(emitWarningSpy).toHaveBeenCalledWith(
      expect.stringMatching(/4 MiB/i),
      { code: 'LOCAL_MEMORY_IMPORT_OVERSIZE_SKIPPED' },
    );
    expect((await readImportState(mockWorkspaceScopeDir)).sources).toEqual({
      [sourcePath]: {
        checkedAt: NOW.toISOString(),
        skipReason: 'oversize',
      },
    });
  });

  it('removes a previously staged file when changed source content becomes oversize', async () => {
    const sourcePath = join(sourceDir, 'MEMORY.md');
    await writeFile(sourcePath, '# Initially stageable', 'utf8');
    await runClaudeMemoryImport({
      workspaceId: 'workspace-1',
      repoPath: '/repo/path',
    });
    const initialEntry = (await readImportState(mockWorkspaceScopeDir)).sources[
      sourcePath
    ];
    if (!initialEntry || !('stagedAs' in initialEntry)) {
      throw new Error('Expected initially staged source');
    }
    const previousStagedPath = join(
      mockWorkspaceScopeDir,
      initialEntry.stagedAs,
    );
    await writeFile(sourcePath, Buffer.alloc(4 * 1024 * 1024 + 1, 120));

    const result = await runClaudeMemoryImport({
      workspaceId: 'workspace-1',
      repoPath: '/repo/path',
      checkedAt: NOW.toISOString(),
    });

    expect(await pathExists(previousStagedPath)).toBe(false);
    expect(result.oversizePaths).toEqual([sourcePath]);
    expect(
      (await readImportState(mockWorkspaceScopeDir)).sources[sourcePath],
    ).toEqual({
      checkedAt: NOW.toISOString(),
      skipReason: 'oversize',
    });
    expect(
      (await readdir(join(mockWorkspaceScopeDir, 'imported'))).filter((name) =>
        name.endsWith('.md'),
      ),
    ).toEqual([]);
  });

  it('stages oldest files up to 256 KiB and defers the remainder', async () => {
    const memoryPath = join(sourceDir, 'MEMORY.md');
    const topicPath = join(sourceDir, 'topics', 'later.md');
    await writeFile(memoryPath, 'a'.repeat(140 * 1024), 'utf8');
    await writeFile(topicPath, 'b'.repeat(140 * 1024), 'utf8');
    await utimes(
      memoryPath,
      new Date(NOW.getTime() - 1_000),
      new Date(NOW.getTime() - 1_000),
    );
    await utimes(topicPath, NOW, NOW);
    const emitWarningSpy = jest
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);

    const result = await runClaudeMemoryImport({
      workspaceId: 'workspace-1',
      repoPath: '/repo/path',
    });

    expect(result.staged).toBe(1);
    expect(result.deferred).toBe(1);
    expect(emitWarningSpy).toHaveBeenCalledWith(
      expect.stringMatching(/deferred/i),
      { code: 'LOCAL_MEMORY_IMPORT_DEFERRED' },
    );
    const state = await readImportState(mockWorkspaceScopeDir);
    expect(state.sources[topicPath]).toEqual(
      expect.objectContaining({ skipReason: 'deferred' }),
    );

    const stillCapped = await runClaudeMemoryImport({
      workspaceId: 'workspace-1',
      repoPath: '/repo/path',
    });
    expect(stillCapped.staged).toBe(0);
    expect(stillCapped.skippedUnchanged).toBe(1);
    expect(stillCapped.deferred).toBe(1);

    const firstEntry = state.sources[memoryPath];
    if (!firstEntry || !('stagedAs' in firstEntry)) {
      throw new Error('Expected first staged source');
    }
    state.sources[memoryPath] = {
      ...firstEntry,
      consolidatedAt: NOW.toISOString(),
    };
    await writeImportState(mockWorkspaceScopeDir, state);
    await rm(join(mockWorkspaceScopeDir, firstEntry.stagedAs));

    const drained = await runClaudeMemoryImport({
      workspaceId: 'workspace-1',
      repoPath: '/repo/path',
    });
    expect(drained.staged).toBe(1);
    expect(drained.skippedUnchanged).toBe(1);
    expect(drained.deferred).toBe(0);
    const drainedEntry = (await readImportState(mockWorkspaceScopeDir)).sources[
      topicPath
    ];
    if (!drainedEntry || !('stagedAs' in drainedEntry)) {
      throw new Error('Expected deferred source to become staged');
    }
    expect(drainedEntry.fileHash).toMatch(/^[a-f0-9]{64}$/);
    expect(drainedEntry.stagedAs).toMatch(/^imported\//);
  });

  it('removes a previously staged file when changed source content is deferred', async () => {
    const memoryPath = join(sourceDir, 'MEMORY.md');
    const deferredPath = join(sourceDir, 'topics', 'later.md');
    await writeFile(memoryPath, 'initial index', 'utf8');
    await writeFile(deferredPath, 'initial topic', 'utf8');
    await runClaudeMemoryImport({
      workspaceId: 'workspace-1',
      repoPath: '/repo/path',
    });
    const initialEntry = (await readImportState(mockWorkspaceScopeDir)).sources[
      deferredPath
    ];
    if (!initialEntry || !('stagedAs' in initialEntry)) {
      throw new Error('Expected initially staged deferred source');
    }
    const previousStagedPath = join(
      mockWorkspaceScopeDir,
      initialEntry.stagedAs,
    );
    await writeFile(memoryPath, 'a'.repeat(140 * 1024), 'utf8');
    await writeFile(deferredPath, 'b'.repeat(140 * 1024), 'utf8');
    await utimes(
      memoryPath,
      new Date(NOW.getTime() - 1_000),
      new Date(NOW.getTime() - 1_000),
    );
    await utimes(deferredPath, NOW, NOW);

    const result = await runClaudeMemoryImport({
      workspaceId: 'workspace-1',
      repoPath: '/repo/path',
      checkedAt: NOW.toISOString(),
    });

    expect(result.staged).toBe(1);
    expect(result.deferred).toBe(1);
    expect(await pathExists(previousStagedPath)).toBe(false);
    expect(
      (await readImportState(mockWorkspaceScopeDir)).sources[deferredPath],
    ).toEqual({
      checkedAt: NOW.toISOString(),
      skipReason: 'deferred',
    });
  });

  it('skips a source file whose serialized prompt entry can never fit the imports budget', async () => {
    // 200 KiB raw fits the 256 KiB source cap, but its serialized prompt
    // entry exceeds the 192 KiB imports budget — staging it would leave a
    // file consolidation can never drain.
    await writeFile(
      join(sourceDir, 'topics', 'huge.md'),
      'x'.repeat(200 * 1024),
      'utf8',
    );
    const emitWarningSpy = jest
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);

    const result = await runClaudeMemoryImport({
      workspaceId: 'workspace-1',
      repoPath: '/repo/path',
    });

    expect(result.staged).toBe(0);
    expect(result.skippedUndrainable).toBe(1);
    expect(result.skippedOversize).toBe(0);
    expect(result.errors).toEqual([]);
    expect(emitWarningSpy).toHaveBeenCalledWith(
      expect.stringMatching(/never fit.*budget/i),
      { code: 'LOCAL_MEMORY_IMPORT_UNDRAINABLE_SKIPPED' },
    );
    expect(await pathExists(join(mockWorkspaceScopeDir, 'imported'))).toBe(
      false,
    );
    expect(
      (await readImportState(mockWorkspaceScopeDir)).sources[
        join(sourceDir, 'topics', 'huge.md')
      ],
    ).toEqual(expect.objectContaining({ skipReason: 'undrainable' }));
    emitWarningSpy.mockRestore();
  });

  it('removes a previously staged file when changed source content becomes undrainable', async () => {
    const sourcePath = join(sourceDir, 'topics', 'huge.md');
    await writeFile(sourcePath, '# Initially stageable', 'utf8');
    await runClaudeMemoryImport({
      workspaceId: 'workspace-1',
      repoPath: '/repo/path',
    });
    const initialEntry = (await readImportState(mockWorkspaceScopeDir)).sources[
      sourcePath
    ];
    if (!initialEntry || !('stagedAs' in initialEntry)) {
      throw new Error('Expected initially staged source');
    }
    const previousStagedPath = join(
      mockWorkspaceScopeDir,
      initialEntry.stagedAs,
    );
    await writeFile(sourcePath, 'x'.repeat(200 * 1024), 'utf8');

    const result = await runClaudeMemoryImport({
      workspaceId: 'workspace-1',
      repoPath: '/repo/path',
      checkedAt: NOW.toISOString(),
    });

    expect(result.skippedUndrainable).toBe(1);
    expect(await pathExists(previousStagedPath)).toBe(false);
    expect(
      (await readImportState(mockWorkspaceScopeDir)).sources[sourcePath],
    ).toEqual({
      checkedAt: NOW.toISOString(),
      skipReason: 'undrainable',
    });
    expect(
      (await readdir(join(mockWorkspaceScopeDir, 'imported'))).filter((name) =>
        name.endsWith('.md'),
      ),
    ).toEqual([]);
  });

  it('skips a source whose redacted staged form cannot fit the imports budget', async () => {
    const sourcePath = join(sourceDir, 'topics', 'redaction-expands.md');
    const rawContent = `${'1.1.1.1\n'.repeat(15_000)}`;
    await writeFile(sourcePath, rawContent, 'utf8');
    const emitWarningSpy = jest
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);

    const result = await runClaudeMemoryImport({
      workspaceId: 'workspace-1',
      repoPath: '/repo/path',
    });

    expect(Buffer.byteLength(rawContent, 'utf8')).toBeLessThan(192 * 1024);
    expect(result.staged).toBe(0);
    expect(result.skippedUndrainable).toBe(1);
    expect(result.errors).toEqual([]);
    expect(emitWarningSpy).toHaveBeenCalledWith(
      expect.stringMatching(/never fit.*budget/i),
      { code: 'LOCAL_MEMORY_IMPORT_UNDRAINABLE_SKIPPED' },
    );
    expect(await pathExists(join(mockWorkspaceScopeDir, 'imported'))).toBe(
      false,
    );
  });

  it('never leaves stale ledger metadata pointing at re-staged bytes when the ledger write fails', async () => {
    const sourcePath = join(sourceDir, 'MEMORY.md');
    await writeFile(sourcePath, '# Revision one', 'utf8');
    const options = { workspaceId: 'workspace-1', repoPath: '/repo/path' };
    const first = await runClaudeMemoryImport(options);
    expect(first.staged).toBe(1);
    const v1State = await readImportState(mockWorkspaceScopeDir);
    const v1Entry = v1State.sources[sourcePath];
    if (!v1Entry || !('stagedAs' in v1Entry)) {
      throw new Error('Expected a staged v1 ledger entry');
    }

    await writeFile(sourcePath, '# Revision two', 'utf8');
    const writeSpy = jest
      .spyOn(ledgerModule, 'writeImportState')
      .mockRejectedValueOnce(new Error('disk full'));
    try {
      const failed = await runClaudeMemoryImport(options);
      expect(failed.errors.length).toBeGreaterThan(0);
    } finally {
      writeSpy.mockRestore();
    }

    // The surviving (v1) ledger entry must not describe the freshly written
    // v2 bytes: revision-hashed staged names guarantee the entry's stagedAs
    // never aliases the new file.
    const staleState = await readImportState(mockWorkspaceScopeDir);
    const staleEntry = staleState.sources[sourcePath];
    if (!staleEntry || !('stagedAs' in staleEntry)) {
      throw new Error('Expected the v1 ledger entry to survive');
    }
    const importedDir = join(mockWorkspaceScopeDir, 'imported');
    const stagedNow = (await readdir(importedDir)).filter((name) =>
      name.endsWith('.md'),
    );
    expect(stagedNow).toHaveLength(1);
    expect(`imported/${stagedNow[0]}`).not.toBe(staleEntry.stagedAs);

    // A retry with a working ledger converges: one staged file, entry
    // matching it, v2 hash recorded.
    const retried = await runClaudeMemoryImport(options);
    expect(retried.staged).toBe(1);
    const finalState = await readImportState(mockWorkspaceScopeDir);
    const finalEntry = finalState.sources[sourcePath];
    if (!finalEntry || !('stagedAs' in finalEntry)) {
      throw new Error('Expected a staged v2 ledger entry');
    }
    const finalFiles = (await readdir(importedDir)).filter((name) =>
      name.endsWith('.md'),
    );
    expect(finalFiles).toHaveLength(1);
    expect(`imported/${finalFiles[0]}`).toBe(finalEntry.stagedAs);
    expect(finalEntry.fileHash).not.toBe(v1Entry.fileHash);
  });

  it('keeps one note ID when two runs import the same source at once', async () => {
    const sourcePath = join(sourceDir, 'MEMORY.md');
    await writeFile(sourcePath, '# Shared fact', 'utf8');
    const options = { workspaceId: 'workspace-1', repoPath: '/repo/path' };
    // Both runs read the ledger before either one stages the source.
    const readLedger = ledgerModule.readImportState;
    const writeLedger = ledgerModule.writeImportState;
    let reads = 0;
    let bothRead = (): void => undefined;
    const bothReadPromise = new Promise<void>((resolve) => {
      bothRead = resolve;
    });
    jest
      .spyOn(ledgerModule, 'readImportState')
      .mockImplementation(async (scopeDir) => {
        const state = await readLedger(scopeDir);
        reads += 1;
        if (reads === 2) bothRead();
        if (reads <= 2) await bothReadPromise;
        return state;
      });
    const persistedNoteIds: Array<string | undefined> = [];
    jest
      .spyOn(ledgerModule, 'writeImportState')
      .mockImplementation(async (scopeDir, state) => {
        await writeLedger(scopeDir, state);
        const entry = state.sources[sourcePath];
        if (entry && 'stagedAs' in entry) persistedNoteIds.push(entry.noteId);
      });

    const results = await Promise.all([
      runClaudeMemoryImport(options),
      runClaudeMemoryImport(options),
    ]);

    expect(results.map((result) => result.errors)).toEqual([[], []]);
    const entry = (await readImportState(mockWorkspaceScopeDir)).sources[
      sourcePath
    ];
    if (!entry || !('stagedAs' in entry)) {
      throw new Error('Expected a staged ledger entry');
    }
    expect(entry.noteId).toBeDefined();
    // Once persisted, the import's identity never changes.
    expect(new Set(persistedNoteIds)).toEqual(new Set([entry.noteId]));
    expect(results.map((result) => result.staged).sort()).toEqual([0, 1]);
    expect(await readdir(join(mockWorkspaceScopeDir, 'imported'))).toEqual([
      basename(entry.stagedAs),
    ]);
  });

  it('is idempotent when the original content hash is unchanged', async () => {
    await writeFile(join(sourceDir, 'MEMORY.md'), '# Stable fact', 'utf8');
    const options = {
      workspaceId: 'workspace-1',
      repoPath: '/repo/path',
    };

    const first = await runClaudeMemoryImport(options);
    const second = await runClaudeMemoryImport(options);

    expect(first.staged).toBe(1);
    expect(second).toEqual({
      staged: 0,
      skippedUnchanged: 1,
      skippedOversize: 0,
      oversizePaths: [],
      skippedUndrainable: 0,
      deferred: 0,
      errors: [],
    });
  });

  it.each([
    ['malformed JSON', '{corrupt'],
    ['an unknown version', JSON.stringify({ version: 2, sources: {} })],
  ])(
    'quarantines %s in the import ledger and rewrites valid state',
    async (_name, corruptState) => {
      const sourcePath = join(sourceDir, 'MEMORY.md');
      await writeFile(sourcePath, '# Recoverable fact', 'utf8');
      await mkdir(mockWorkspaceScopeDir, { recursive: true });
      const ledgerPath = join(mockWorkspaceScopeDir, 'import-state.json');
      await writeFile(ledgerPath, corruptState, 'utf8');
      const emitWarningSpy = jest
        .spyOn(process, 'emitWarning')
        .mockImplementation(() => undefined);

      const result = await runClaudeMemoryImport({
        workspaceId: 'workspace-1',
        repoPath: '/repo/path',
      });

      expect(result.staged).toBe(1);
      expect(result.errors).toEqual([]);
      await expect(readFile(`${ledgerPath}.corrupt`, 'utf8')).resolves.toBe(
        corruptState,
      );
      const recovered = await readImportState(mockWorkspaceScopeDir);
      expect(recovered.sources[sourcePath]).toBeDefined();
      expect(emitWarningSpy).toHaveBeenCalledWith(
        expect.stringMatching(/quarantined/i),
        { code: 'LOCAL_MEMORY_IMPORT_LEDGER_QUARANTINED' },
      );
      emitWarningSpy.mockRestore();
    },
  );

  it('re-stages changed files and clears consolidatedAt', async () => {
    const sourcePath = join(sourceDir, 'MEMORY.md');
    await writeFile(sourcePath, '# Original fact', 'utf8');
    await runClaudeMemoryImport({
      workspaceId: 'workspace-1',
      repoPath: '/repo/path',
    });
    const originalState = await readImportState(mockWorkspaceScopeDir);
    const originalEntry = originalState.sources[sourcePath];
    if (!originalEntry) throw new Error('Expected source ledger entry');
    await writeImportState(mockWorkspaceScopeDir, {
      version: 1,
      sources: {
        [sourcePath]: {
          ...originalEntry,
          consolidatedAt: NOW.toISOString(),
        },
      },
    });
    await writeFile(sourcePath, '# Changed fact', 'utf8');

    const result = await runClaudeMemoryImport({
      workspaceId: 'workspace-1',
      repoPath: '/repo/path',
    });

    expect(result.staged).toBe(1);
    const changedState = await readImportState(mockWorkspaceScopeDir);
    const changedEntry = changedState.sources[sourcePath];
    if (!changedEntry || !('stagedAs' in changedEntry)) {
      throw new Error('Expected changed staged ledger entry');
    }
    expect(changedEntry.consolidatedAt).toBeUndefined();
    await expect(
      readFile(join(mockWorkspaceScopeDir, changedEntry.stagedAs), 'utf8'),
    ).resolves.toContain('# Changed fact');
  });

  it('writes the import ledger atomically with a sibling temp file', async () => {
    const fsPromises = jest.requireActual<{
      rename: (source: string, destination: string) => Promise<void>;
    }>('node:fs/promises');
    const renameSpy = jest.spyOn(fsPromises, 'rename');

    await writeImportState(mockWorkspaceScopeDir, {
      version: 1,
      sources: {},
    });

    expect(renameSpy).toHaveBeenCalledTimes(1);
    const renameCall = renameSpy.mock.calls[0];
    if (!renameCall) throw new Error('Expected atomic ledger rename');
    // A sibling dot entry, which readers ignore and a crash's sweep removes.
    expect(dirname(renameCall[0])).toBe(mockWorkspaceScopeDir);
    expect(basename(renameCall[0])).toMatch(/^\.memory-write-.+\.tmp$/);
    expect(renameCall[1]).toBe(
      join(mockWorkspaceScopeDir, 'import-state.json'),
    );
    expect(
      (await readdir(mockWorkspaceScopeDir)).some((name) =>
        name.endsWith('.tmp'),
      ),
    ).toBe(false);
  });

  it('never writes, renames, removes, creates, or chmods inside the source directory', async () => {
    const sourcePath = join(sourceDir, 'MEMORY.md');
    await writeFile(sourcePath, '# Read only source', 'utf8');
    const before = await readFile(sourcePath, 'utf8');
    const beforeMtime = (await stat(sourcePath)).mtimeMs;
    const fsPromises = jest.requireActual<{
      writeFile: typeof writeFile;
      rename: (source: string, destination: string) => Promise<void>;
      unlink: (path: string) => Promise<void>;
      mkdir: typeof mkdir;
      chmod: (path: string, mode: number) => Promise<void>;
    }>('node:fs/promises');
    const writeSpy = jest.spyOn(fsPromises, 'writeFile');
    const renameSpy = jest.spyOn(fsPromises, 'rename');
    const unlinkSpy = jest.spyOn(fsPromises, 'unlink');
    const mkdirSpy = jest.spyOn(fsPromises, 'mkdir');
    const chmodSpy = jest.spyOn(fsPromises, 'chmod');

    await runClaudeMemoryImport({
      workspaceId: 'workspace-1',
      repoPath: '/repo/path',
    });

    const mutatedPaths = [
      ...writeSpy.mock.calls.map(([path]) => pathArgument(path)),
      ...renameSpy.mock.calls.flatMap(([source, destination]) => [
        pathArgument(source),
        pathArgument(destination),
      ]),
      ...unlinkSpy.mock.calls.map(([path]) => pathArgument(path)),
      ...mkdirSpy.mock.calls.map(([path]) => pathArgument(path)),
      ...chmodSpy.mock.calls.map(([path]) => pathArgument(path)),
    ];
    expect(mutatedPaths.some((path) => path.startsWith(sourceDir))).toBe(false);
    await expect(readFile(sourcePath, 'utf8')).resolves.toBe(before);
    expect((await stat(sourcePath)).mtimeMs).toBe(beforeMtime);
    expect(await pathExists(join(sourceDir, 'import-state.json'))).toBe(false);
  });

  it('keeps the Codex memories source directory read-only during import', async () => {
    const codexHome = join(rootDir, 'codex-home');
    const codexSourceDir = join(codexHome, 'memories');
    const sourcePath = join(codexSourceDir, 'MEMORY.md');
    await mkdir(codexSourceDir, { recursive: true });
    await writeFile(sourcePath, '# Read only Codex source', 'utf8');
    const beforeMtime = (await stat(sourcePath)).mtimeMs;

    await runCodexMemoryImport({ userScope: true, codexHome });

    await expect(readFile(sourcePath, 'utf8')).resolves.toBe(
      '# Read only Codex source',
    );
    expect((await stat(sourcePath)).mtimeMs).toBe(beforeMtime);
    expect(await pathExists(join(codexSourceDir, 'import-state.json'))).toBe(
      false,
    );
    expect(await pathExists(join(codexSourceDir, 'imported'))).toBe(false);
  });
});
