import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

interface WorkspaceIndexEntry {
  id: string;
  name: string;
  type: 'single-repo' | 'multi-repo';
  color: string;
  collapsed: boolean;
  order: number;
}

interface WorkspaceIndexFile {
  version: 1;
  workspaces: WorkspaceIndexEntry[];
}

function getRepoRoot(): string {
  return path.resolve(__dirname, '../../../../..');
}

function getMigrationScriptPath(): string {
  return path.join(
    getRepoRoot(),
    'scripts',
    'migrate-workspaces-to-unified-schema.sh',
  );
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

function writeJsonFile(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function createWorkspaceRecord(
  dataDir: string,
  entry: WorkspaceIndexEntry,
  workspaceConfig: Record<string, unknown>,
): void {
  const workspaceDir = path.join(dataDir, 'workspaces', entry.id);
  writeJsonFile(path.join(workspaceDir, 'workspace.json'), workspaceConfig);
  writeJsonFile(path.join(workspaceDir, 'worktrees.json'), {
    version: 1,
    worktrees: [],
  });
}

function createLegacySingleRepoWorkspace(
  dataDir: string,
  project: {
    id: string;
    name: string;
    repoPath: string;
    color: string;
    collapsed?: boolean;
    order?: number;
  },
): void {
  writeJsonFile(path.join(dataDir, 'projects.json'), {
    version: 1,
    projects: [project],
  });

  const projectDir = path.join(dataDir, 'projects', project.id);
  writeJsonFile(path.join(projectDir, 'worktrees.json'), {
    version: 1,
    worktrees: [],
  });
}

function createLegacyMultiRepoWorkspace(
  dataDir: string,
  workspace: {
    id: string;
    name: string;
    color: string;
    collapsed?: boolean;
    order?: number;
  },
): void {
  writeJsonFile(
    path.join(dataDir, 'multi-repo-workspaces', 'workspaces.json'),
    {
      version: 1,
      workspaces: [workspace],
    },
  );

  const workspaceDir = path.join(
    dataDir,
    'multi-repo-workspaces',
    workspace.id,
  );
  writeJsonFile(path.join(workspaceDir, 'workspace.json'), {
    version: 1,
    repos: [],
  });
  writeJsonFile(path.join(workspaceDir, 'worktrees.json'), {
    version: 1,
    worktrees: [],
  });
}

function addLegacyWorktreeSummary(
  workspaceDir: string,
  worktreeId: string,
  summaryFile: Record<string, unknown>,
): void {
  writeJsonFile(path.join(workspaceDir, 'worktrees.json'), {
    version: 1,
    worktrees: [
      {
        id: worktreeId,
        branchName: `feature/${worktreeId}`,
        createdAt: '2026-03-25T12:00:00.000Z',
      },
    ],
  });
  writeJsonFile(
    path.join(workspaceDir, 'worktrees', worktreeId, 'summary.json'),
    summaryFile,
  );
}

function runMigrationScript(dataDir: string): void {
  execFileSync(
    'bash',
    [getMigrationScriptPath(), '--data-dir', dataDir, '--copy'],
    {
      cwd: getRepoRoot(),
      encoding: 'utf8',
    },
  );
}

describe('migrate-workspaces-to-unified-schema.sh', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'canopy-unified-migration-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('merges migrated projects into an existing unified index', () => {
    const existingEntry: WorkspaceIndexEntry = {
      id: 'existing-workspace',
      name: 'Existing Workspace',
      type: 'single-repo',
      color: '#111111',
      collapsed: false,
      order: 0,
    };
    writeJsonFile(path.join(tempDir, 'workspaces', 'index.json'), {
      version: 1,
      workspaces: [existingEntry],
    } satisfies WorkspaceIndexFile);
    createWorkspaceRecord(tempDir, existingEntry, {
      version: 1,
      type: 'single-repo',
      repoPath: '/repos/existing',
      repos: [],
    });
    createLegacySingleRepoWorkspace(tempDir, {
      id: 'legacy-workspace',
      name: 'Legacy Workspace',
      repoPath: '/repos/legacy',
      color: '#222222',
    });

    runMigrationScript(tempDir);

    const index = readJsonFile<WorkspaceIndexFile>(
      path.join(tempDir, 'workspaces', 'index.json'),
    );

    expect(index.workspaces).toEqual([
      {
        id: 'existing-workspace',
        name: 'Existing Workspace',
        type: 'single-repo',
        color: '#111111',
        collapsed: false,
        order: 0,
      },
      {
        id: 'legacy-workspace',
        name: 'Legacy Workspace',
        type: 'single-repo',
        color: '#222222',
        collapsed: false,
        order: 1,
      },
    ]);
    expect(
      existsSync(
        path.join(tempDir, 'workspaces', 'legacy-workspace', 'workspace.json'),
      ),
    ).toBe(true);
  });

  it('skips a legacy project when its id clashes with an existing unified entry', () => {
    const existingEntry: WorkspaceIndexEntry = {
      id: 'legacy-workspace',
      name: 'Existing Workspace',
      type: 'single-repo',
      color: '#111111',
      collapsed: false,
      order: 0,
    };
    writeJsonFile(path.join(tempDir, 'workspaces', 'index.json'), {
      version: 1,
      workspaces: [existingEntry],
    } satisfies WorkspaceIndexFile);
    createWorkspaceRecord(tempDir, existingEntry, {
      version: 1,
      type: 'single-repo',
      repoPath: '/repos/existing',
      repos: [],
    });
    createLegacySingleRepoWorkspace(tempDir, {
      id: 'legacy-workspace',
      name: 'Legacy Workspace',
      repoPath: '/repos/legacy',
      color: '#222222',
    });

    runMigrationScript(tempDir);

    const index = readJsonFile<WorkspaceIndexFile>(
      path.join(tempDir, 'workspaces', 'index.json'),
    );
    const existingConfig = readJsonFile<Record<string, unknown>>(
      path.join(tempDir, 'workspaces', 'legacy-workspace', 'workspace.json'),
    );

    expect(index.workspaces).toEqual([
      {
        id: 'legacy-workspace',
        name: 'Existing Workspace',
        type: 'single-repo',
        color: '#111111',
        collapsed: false,
        order: 0,
      },
    ]);
    expect(existingConfig).toEqual({
      version: 1,
      type: 'single-repo',
      repoPath: '/repos/existing',
      repos: [],
    });
  });

  it('skips a legacy project when its name clashes with an existing unified entry', () => {
    const existingEntry: WorkspaceIndexEntry = {
      id: 'existing-workspace',
      name: 'Legacy Workspace',
      type: 'single-repo',
      color: '#111111',
      collapsed: false,
      order: 0,
    };
    writeJsonFile(path.join(tempDir, 'workspaces', 'index.json'), {
      version: 1,
      workspaces: [existingEntry],
    } satisfies WorkspaceIndexFile);
    createWorkspaceRecord(tempDir, existingEntry, {
      version: 1,
      type: 'single-repo',
      repoPath: '/repos/existing',
      repos: [],
    });
    createLegacySingleRepoWorkspace(tempDir, {
      id: 'legacy-workspace',
      name: 'Legacy Workspace',
      repoPath: '/repos/legacy',
      color: '#222222',
    });

    runMigrationScript(tempDir);

    const index = readJsonFile<WorkspaceIndexFile>(
      path.join(tempDir, 'workspaces', 'index.json'),
    );

    expect(index.workspaces).toEqual([
      {
        id: 'existing-workspace',
        name: 'Legacy Workspace',
        type: 'single-repo',
        color: '#111111',
        collapsed: false,
        order: 0,
      },
    ]);
    expect(
      existsSync(
        path.join(tempDir, 'workspaces', 'legacy-workspace', 'workspace.json'),
      ),
    ).toBe(false);
  });

  it('migrates single-repo worktree summaries into summaries/{worktreeId}.json', () => {
    createLegacySingleRepoWorkspace(tempDir, {
      id: 'legacy-workspace',
      name: 'Legacy Workspace',
      repoPath: '/repos/legacy',
      color: '#222222',
    });

    const legacySummary = {
      version: 1,
      summary: {
        title: 'Legacy summary',
        description: 'Migrated from the old path',
      },
    };
    addLegacyWorktreeSummary(
      path.join(tempDir, 'projects', 'legacy-workspace'),
      'wt-1',
      legacySummary,
    );

    runMigrationScript(tempDir);

    expect(
      readJsonFile<Record<string, unknown>>(
        path.join(
          tempDir,
          'workspaces',
          'legacy-workspace',
          'summaries',
          'wt-1.json',
        ),
      ),
    ).toEqual(legacySummary);
    expect(
      existsSync(
        path.join(
          tempDir,
          'workspaces',
          'legacy-workspace',
          'worktrees',
          'wt-1',
          'summary.json',
        ),
      ),
    ).toBe(false);
  });

  it('migrates multi-repo worktree summaries into summaries/{worktreeId}.json', () => {
    createLegacyMultiRepoWorkspace(tempDir, {
      id: 'legacy-multi',
      name: 'Legacy Multi',
      color: '#333333',
    });

    const legacySummary = {
      version: 1,
      summary: {
        title: 'Legacy multi summary',
        description: 'Migrated from the old path',
      },
    };
    addLegacyWorktreeSummary(
      path.join(tempDir, 'multi-repo-workspaces', 'legacy-multi'),
      'wt-1',
      legacySummary,
    );

    runMigrationScript(tempDir);

    expect(
      readJsonFile<Record<string, unknown>>(
        path.join(
          tempDir,
          'workspaces',
          'legacy-multi',
          'summaries',
          'wt-1.json',
        ),
      ),
    ).toEqual(legacySummary);
    expect(
      existsSync(
        path.join(
          tempDir,
          'workspaces',
          'legacy-multi',
          'worktrees',
          'wt-1',
          'summary.json',
        ),
      ),
    ).toBe(false);
  });
});
