// CAN-3329: a degraded read of the workspace index must never turn into a
// destructive rewrite. Runs the real sidebar-items and cowork CRUD modules
// against a temporary data dir; only `readFile` is wrapped so a test can
// hand the index loader one mid-write (truncated) read.
import type * as FsPromises from 'node:fs/promises';

let mockTruncateNextIndexRead = false;
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  return {
    ...actual,
    readFile: jest.fn(
      async (...args: Parameters<typeof actual.readFile>): Promise<unknown> => {
        const [target] = args;
        if (
          mockTruncateNextIndexRead &&
          typeof target === 'string' &&
          target.endsWith('index.json')
        ) {
          mockTruncateNextIndexRead = false;
          return '{"version": 1, "workspa';
        }
        return actual.readFile(...args);
      },
    ),
  };
});

const mockRecordAppDiagnostic = jest.fn();
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: mockRecordAppDiagnostic,
  })),
}));
jest.mock('../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_COWORK_WORKSPACE_ID,
  type CoworkSidebarItem,
  type SidebarItem,
} from '@canopy/desktop-shared/types';
import { listCoworkWorkspacesAsChatProjects } from '../lib/cowork-workspace-crud';
import { getWorkspaceIndexFilePath } from '../lib/paths';
import {
  __resetSidebarItemsStateForTests,
  readAllSidebarItems,
  setWorkspaceActivitySectionOrder,
  writeAllSidebarItems,
} from '../lib/sidebar-items';
import { reorderWorkspaces } from '../lib/workspace-metadata';

function coworkItem(id: string, order: number): CoworkSidebarItem {
  return {
    id,
    name: `Project ${id}`,
    type: 'cowork',
    color: '#7C3AED',
    collapsed: false,
    order,
    cowork: { createdAt: '2026-09-01T00:00:00.000Z' },
  };
}

async function readIndexIdsAt(filePath: string): Promise<string[]> {
  const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('workspaces' in parsed) ||
    !Array.isArray(parsed.workspaces)
  ) {
    throw new Error(`Expected a workspace index at ${filePath}`);
  }
  return parsed.workspaces.map((entry: { id: string }) => entry.id);
}

async function readIndexIds(): Promise<string[]> {
  return readIndexIdsAt(getWorkspaceIndexFilePath());
}

interface IndexDocument {
  [key: string]: unknown;
  workspaces: Array<Record<string, unknown>>;
}

async function readIndexDocument(): Promise<IndexDocument> {
  const parsed: unknown = JSON.parse(
    await readFile(getWorkspaceIndexFilePath(), 'utf8'),
  );
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('workspaces' in parsed) ||
    !Array.isArray(parsed.workspaces)
  ) {
    throw new Error('Expected a workspace index');
  }
  const workspaces: Array<Record<string, unknown>> = parsed.workspaces.filter(
    (entry: unknown): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null,
  );
  return { ...parsed, workspaces };
}

/** An entry this version cannot read, as a newer app could write. */
const FUTURE_ENTRY = {
  id: 'future',
  name: 'Future',
  type: 'notebook',
  color: '#000000',
  collapsed: false,
  order: 3,
};

/** Adds fields and an entry this version does not know (CAN-3800). */
async function addUnknownIndexData(): Promise<void> {
  const index = await readIndexDocument();
  await writeFile(
    getWorkspaceIndexFilePath(),
    JSON.stringify(
      {
        ...index,
        futureTopLevel: { enabled: true },
        workspaces: [
          ...index.workspaces.map((entry) =>
            entry.id === 'alpha'
              ? { ...entry, futureField: 'kept', pinned: true }
              : entry,
          ),
          FUTURE_ENTRY,
        ],
      },
      null,
      2,
    ),
  );
}

// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(15_000);

describe('workspace index integrity (real fs)', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;
  const projects: SidebarItem[] = ['alpha', 'beta', 'gamma'].map((id, order) =>
    coworkItem(id, order),
  );

  beforeEach(async () => {
    jest.clearAllMocks();
    __resetSidebarItemsStateForTests();
    mockTruncateNextIndexRead = false;
    originalDataDir = process.env.CANOPY_DATA_DIR;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-index-integrity-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    await writeAllSidebarItems(projects);
  });

  afterEach(async () => {
    if (originalDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalDataDir;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  it('does not provision the default project from a mid-write index read', async () => {
    mockTruncateNextIndexRead = true;

    await listCoworkWorkspacesAsChatProjects();

    expect(await readIndexIds()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('provisions the default project without dropping existing projects', async () => {
    const projectsList = await listCoworkWorkspacesAsChatProjects();

    expect(projectsList.map((project) => project.id)).toContain(
      DEFAULT_COWORK_WORKSPACE_ID,
    );
    expect(await readIndexIds()).toEqual([
      'alpha',
      'beta',
      'gamma',
      DEFAULT_COWORK_WORKSPACE_ID,
    ]);
  });

  it('refuses a partial rewrite over an unreadable index and logs it', async () => {
    await writeFile(getWorkspaceIndexFilePath(), '{"version": 1, "work');

    await expect(
      writeAllSidebarItems([coworkItem('delta', 0)]),
    ).rejects.toThrow(/workspace index/i);

    expect(await readFile(getWorkspaceIndexFilePath(), 'utf8')).toBe(
      '{"version": 1, "work',
    );
    expect(mockRecordAppDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'workspace_index_write_refused' }),
    );
  });

  it('keeps a backup of the previous index before each rewrite', async () => {
    await writeAllSidebarItems([...projects, coworkItem('delta', 3)]);

    expect(await readIndexIdsAt(`${getWorkspaceIndexFilePath()}.bak`)).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });

  it('never drops entries when a full save races the default-project listing', async () => {
    const saved = (await readAllSidebarItems()).items;

    for (let round = 0; round < 25; round += 1) {
      await Promise.all([
        writeAllSidebarItems(saved, { preserveUnmentionedWorkspaceIds: true }),
        listCoworkWorkspacesAsChatProjects(),
        writeAllSidebarItems(saved, { preserveUnmentionedWorkspaceIds: true }),
      ]);
      expect(await readIndexIds()).toEqual(
        expect.arrayContaining(['alpha', 'beta', 'gamma']),
      );
    }
  }, 120_000);

  describe('unknown index data (CAN-3800)', () => {
    beforeEach(addUnknownIndexData);

    it('keeps unknown fields and unreadable entries through a full save', async () => {
      await writeAllSidebarItems(
        projects.map((project) =>
          project.id === 'alpha' ? { ...project, collapsed: true } : project,
        ),
      );

      const index = await readIndexDocument();
      expect(index.futureTopLevel).toEqual({ enabled: true });
      const alpha = index.workspaces.find((entry) => entry.id === 'alpha');
      expect(alpha).toMatchObject({ collapsed: true, futureField: 'kept' });
      // The save carried no pin: a deliberate clear of a known field.
      expect(alpha).not.toHaveProperty('pinned');
      expect(index.workspaces).toContainEqual(FUTURE_ENTRY);
    });

    it('keeps an unreadable entry when setting the activity order', async () => {
      expect(
        await setWorkspaceActivitySectionOrder('beta', ['plans', 'summary']),
      ).toBe(true);

      const index = await readIndexDocument();
      expect(
        index.workspaces.find((entry) => entry.id === 'beta'),
      ).toMatchObject({ activitySectionOrder: ['plans', 'summary'] });
      expect(index.workspaces).toContainEqual(FUTURE_ENTRY);
      expect(
        index.workspaces.find((entry) => entry.id === 'alpha'),
      ).toMatchObject({ futureField: 'kept', pinned: true });
    });

    it('keeps an unreadable entry when reordering visible projects', async () => {
      expect(
        await reorderWorkspaces({
          visibleWorkspaceIds: ['alpha', 'beta', 'gamma'],
          activeWorkspaceId: 'gamma',
          overWorkspaceId: 'alpha',
        }),
      ).toEqual({ workspaceIds: ['gamma', 'alpha', 'beta'] });

      expect(await readIndexIds()).toEqual([
        'gamma',
        'alpha',
        'beta',
        'future',
      ]);
      expect(
        (await readIndexDocument()).workspaces.find(
          (entry) => entry.id === 'alpha',
        ),
      ).toMatchObject({ futureField: 'kept' });
    });
  });
});
