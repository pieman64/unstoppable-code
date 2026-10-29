import '../../../__tests__/worktree-replica-compatibility';
// CAN-3822: the W5 worktree health, discovery and launch reconciliation
// records. Runs the real workspace persistence module against a temporary
// data dir, so each record is checked through the persisted `worktrees.json`.
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn(),
  })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
// The next list write waits for `mockGate`, so a test can start another
// writer while a record holds its read; `mockFailNextWrite` fails it instead.
let mockGate: Promise<void> | null = null;
let mockFailNextWrite = false;
jest.mock('../atomic-file', () => {
  const actual = jest.requireActual<typeof AtomicFile>('../atomic-file');
  return {
    ...actual,
    writeFileAtomically: async (
      ...args: Parameters<typeof actual.writeFileAtomically>
    ): Promise<void> => {
      const gate = mockGate;
      mockGate = null;
      if (gate) await gate;
      if (mockFailNextWrite) {
        mockFailNextWrite = false;
        throw new Error('disk full');
      }
      return actual.writeFileAtomically(...args);
    },
  };
});

import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  WorktreeData,
  WorktreeDiscovery,
  WorktreeHealthIssue,
} from '@canopy/desktop-shared/types';
import type * as AtomicFile from '../atomic-file';
import { getWorkspaceWorktreesFilePath } from '../paths';
import {
  clearWorktreesSelfWriteTracking,
  readWorkspaceWorktrees,
  removeWorkspaceWorktrees,
  updateWorkspaceWorktrees,
} from '../workspace-persistence';
import {
  reconcileWorktreeRecovery,
  recordWorktreeDiscovery,
  recordWorktreeHealth,
  WorktreeRecordRefusedError,
  type WorktreeRecordOutcome,
} from '../worktree-repair';
import { updateWorktree } from '../worktree-update';

// Each test gets its own workspace: removals are remembered per process.
let WORKSPACE_ID = 'project';
let workspaceCount = 0;
const CREATED_AT = '2026-10-01T00:00:00.000Z';

function row(id: string, extra: Partial<WorktreeData> = {}): WorktreeData {
  return {
    id,
    branchName: `branch-${id}`,
    createdAt: CREATED_AT,
    ...extra,
  };
}

const DISCOVERY: WorktreeDiscovery = {
  slashCommands: [{ name: 'review', description: 'Review' }],
  mcpServers: [],
  discoveredAt: '2026-10-02T00:00:00.000Z',
  providerType: 'claude',
};

function issue(extra: Partial<WorktreeHealthIssue> = {}): WorktreeHealthIssue {
  return {
    status: 'broken',
    code: 'missing-worktree-path',
    message: 'Worktree directory does not exist.',
    checkedAt: '2026-10-03T00:00:00.000Z',
    worktreePath: '/worktrees/wt-1',
    ...extra,
  };
}

/** One record of each operation, all on `wt-1`. */
const RECORDS: [string, () => Promise<WorktreeRecordOutcome>][] = [
  [
    'discovery',
    (): Promise<WorktreeRecordOutcome> =>
      recordWorktreeDiscovery({
        kind: 'environment',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'wt-1',
        discovery: DISCOVERY,
      }),
  ],
  [
    'branch prompt',
    (): Promise<WorktreeRecordOutcome> =>
      recordWorktreeDiscovery({
        kind: 'branch-prompt',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'wt-1',
        sent: true,
      }),
  ],
  [
    'health',
    (): Promise<WorktreeRecordOutcome> =>
      recordWorktreeHealth({
        source: 'diff-stats',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'wt-1',
        issue: issue(),
      }),
  ],
  [
    'recovery',
    (): Promise<WorktreeRecordOutcome> =>
      reconcileWorktreeRecovery({
        kind: 'promote-pending',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'wt-1',
        createdAt: CREATED_AT,
        branchName: 'feature/checked-out',
      }),
  ],
];

describe('worktree repair records (real fs)', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;
  let listPath: string;

  async function writeList(worktrees: unknown[], extra = {}): Promise<string> {
    await mkdir(path.dirname(listPath), { recursive: true });
    const contents = JSON.stringify(
      { version: 1, worktrees, ...extra },
      null,
      2,
    );
    await writeFile(listPath, contents);
    return contents;
  }

  async function readRow(id: string): Promise<WorktreeData | undefined> {
    const worktrees = await readWorkspaceWorktrees(WORKSPACE_ID);
    return worktrees.find((worktree) => worktree.id === id);
  }

  async function readDocument(): Promise<unknown> {
    return JSON.parse(await readFile(listPath, 'utf8'));
  }

  function holdNextWrite(): () => void {
    let release = (): void => {};
    mockGate = new Promise((resolve) => {
      release = resolve;
    });
    return release;
  }

  /** Lets queued filesystem work run, so a held writer reaches its gate. */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    mockGate = null;
    mockFailNextWrite = false;
    workspaceCount += 1;
    WORKSPACE_ID = `project-${workspaceCount}`;
    clearWorktreesSelfWriteTracking(WORKSPACE_ID);
    originalDataDir = process.env.CANOPY_DATA_DIR;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-worktree-repair-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    listPath = getWorkspaceWorktreesFilePath(WORKSPACE_ID);
  });

  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
    await rm(dataDir, { recursive: true, force: true });
  });

  describe('every record', () => {
    it.each(RECORDS)(
      '%s keeps a row another writer creates while it holds its read',
      async (_label, record) => {
        await writeList([row('wt-1', { setupPhase: 'git-pending' })]);
        const release = holdNextWrite();

        const recording = record();
        await settle();
        const creating = updateWorkspaceWorktrees(WORKSPACE_ID, (rows) => [
          row('wt-new'),
          ...rows,
        ]);
        await settle();
        release();
        await Promise.all([recording, creating]);

        const ids = (await readWorkspaceWorktrees(WORKSPACE_ID)).map(
          (worktree) => worktree.id,
        );
        expect(ids).toEqual(['wt-new', 'wt-1']);
      },
    );

    it.each(RECORDS)(
      '%s keeps a field another writer sets on the same row meanwhile',
      async (_label, record) => {
        await writeList([row('wt-1', { setupPhase: 'git-pending' })]);
        const release = holdNextWrite();

        const recording = record();
        await settle();
        const labelling = updateWorktree({
          workspaceId: WORKSPACE_ID,
          worktreeId: 'wt-1',
          patch: { label: 'Renamed', pinned: true },
        });
        await settle();
        release();
        const [outcome] = await Promise.all([recording, labelling]);

        expect(outcome.status).toBe('recorded');
        expect(await readRow('wt-1')).toMatchObject({
          ...outcome.worktree,
          label: 'Renamed',
          pinned: true,
        });
      },
    );

    it.each(RECORDS)(
      '%s never writes an unreadable list',
      async (_label, record) => {
        await mkdir(path.dirname(listPath), { recursive: true });
        await writeFile(listPath, '{"version": 1, "worktrees": [');

        await expect(record()).resolves.toEqual({
          status: 'not-found',
          worktree: null,
        });

        expect(await readFile(listPath, 'utf8')).toBe(
          '{"version": 1, "worktrees": [',
        );
      },
    );

    it.each(RECORDS)(
      '%s creates no list for a workspace without one',
      async (_label, record) => {
        await expect(record()).resolves.toEqual({
          status: 'not-found',
          worktree: null,
        });

        await expect(readdir(dataDir)).resolves.toEqual([]);
      },
    );

    it.each(RECORDS)(
      '%s leaves the list unchanged for a row it does not have',
      async (_label, record) => {
        const contents = await writeList([row('wt-2')]);

        await expect(record()).resolves.toEqual({
          status: 'not-found',
          worktree: null,
        });

        expect(await readFile(listPath, 'utf8')).toBe(contents);
      },
    );

    it.each(RECORDS)(
      '%s does not bring back a row archived in this process',
      async (_label, record) => {
        await writeList([row('wt-1', { setupPhase: 'git-pending' })]);
        await removeWorkspaceWorktrees(
          WORKSPACE_ID,
          (worktree) => worktree.id === 'wt-1',
        );

        await expect(record()).resolves.toMatchObject({ status: 'not-found' });

        expect(await readDocument()).toEqual({ version: 1, worktrees: [] });
      },
    );

    it.each(RECORDS)(
      '%s keeps every row and field when its write fails, and applies on retry',
      async (_label, record) => {
        const contents = await writeList(
          [
            {
              ...row('wt-1', { setupPhase: 'git-pending', label: 'One' }),
              future: 1,
            },
            row('wt-2', { discovery: DISCOVERY, branchPromptSent: true }),
            { id: 'wt-unreadable' },
          ],
          { futureFileKey: true },
        );
        mockFailNextWrite = true;

        await expect(record()).rejects.toThrow('disk full');
        expect(await readFile(listPath, 'utf8')).toBe(contents);

        // A restart reads the file the failed write left.
        clearWorktreesSelfWriteTracking(WORKSPACE_ID);
        const outcome = await record();
        expect(outcome.status).toBe('recorded');
        expect(await readDocument()).toEqual({
          version: 1,
          futureFileKey: true,
          worktrees: [
            { ...outcome.worktree, future: 1 },
            row('wt-2', { discovery: DISCOVERY, branchPromptSent: true }),
            { id: 'wt-unreadable' },
          ],
        });
        expect(outcome.worktree).toMatchObject({ label: 'One' });
      },
    );

    it.each([
      ['an invalid workspace id', 'Not A Workspace', 'wt-1'],
      ['an invalid worktree id', WORKSPACE_ID, '../wt-1'],
    ])('refuses %s before reading the list', async (_label, ws, wt) => {
      const contents = await writeList([row('wt-1')]);
      const records = [
        recordWorktreeDiscovery({
          kind: 'branch-prompt',
          workspaceId: ws,
          worktreeId: wt,
          sent: true,
        }),
        recordWorktreeHealth({
          source: 'health-check',
          workspaceId: ws,
          worktreeId: wt,
          issue: null,
        }),
        reconcileWorktreeRecovery({
          kind: 'promote-pending',
          workspaceId: ws,
          worktreeId: wt,
          createdAt: CREATED_AT,
          branchName: 'feature',
        }),
      ];

      for (const recording of records) {
        await expect(recording).rejects.toMatchObject({
          name: 'WorktreeRecordRefusedError',
          reason: 'invalid-request',
        });
      }
      expect(await readFile(listPath, 'utf8')).toBe(contents);
    });
  });

  describe('internal.worktree.discovery.record', () => {
    it('stores the discovery on its row only', async () => {
      await writeList([row('wt-1'), row('wt-2')]);

      const outcome = await recordWorktreeDiscovery({
        kind: 'environment',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'wt-1',
        discovery: DISCOVERY,
      });

      expect(outcome).toEqual({
        status: 'recorded',
        worktree: row('wt-1', { discovery: DISCOVERY }),
      });
      expect(await readDocument()).toEqual({
        version: 1,
        worktrees: [row('wt-1', { discovery: DISCOVERY }), row('wt-2')],
      });
    });

    it('sets and clears the branch prompt flag, writing only on change', async () => {
      await writeList([row('wt-1'), row('wt-2')]);
      const record = (sent: boolean): Promise<WorktreeRecordOutcome> =>
        recordWorktreeDiscovery({
          kind: 'branch-prompt',
          workspaceId: WORKSPACE_ID,
          worktreeId: 'wt-1',
          sent,
        });

      await expect(record(true)).resolves.toMatchObject({
        status: 'recorded',
      });
      const marked = await readFile(listPath, 'utf8');
      await expect(record(true)).resolves.toMatchObject({
        status: 'unchanged',
      });
      expect(await readFile(listPath, 'utf8')).toBe(marked);
      expect(marked).toBe(
        JSON.stringify(
          {
            version: 1,
            worktrees: [row('wt-1', { branchPromptSent: true }), row('wt-2')],
          },
          null,
          2,
        ),
      );

      await expect(record(false)).resolves.toMatchObject({
        status: 'recorded',
      });
      expect(await readDocument()).toEqual({
        version: 1,
        worktrees: [row('wt-1', { branchPromptSent: false }), row('wt-2')],
      });
    });
  });

  describe('internal.worktree.health.record', () => {
    it('keeps the stored check time for an unchanged background result', async () => {
      const stored = issue({ checkedAt: '2026-10-01T00:00:00.000Z' });
      await writeList([row('wt-1', { healthIssue: stored })]);

      const outcome = await recordWorktreeHealth({
        source: 'diff-stats',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'wt-1',
        issue: issue(),
      });

      expect(outcome.status).toBe('unchanged');
      expect((await readRow('wt-1'))?.healthIssue).toEqual(stored);
    });

    it('refreshes the stored issue for an explicit retry', async () => {
      await writeList([
        row('wt-1', {
          healthIssue: issue({ checkedAt: '2026-10-01T00:00:00.000Z' }),
        }),
      ]);

      const outcome = await recordWorktreeHealth({
        source: 'health-check',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'wt-1',
        issue: issue(),
      });

      expect(outcome.status).toBe('recorded');
      expect((await readRow('wt-1'))?.healthIssue).toEqual(issue());
    });

    it('stores a changed background result', async () => {
      await writeList([row('wt-1', { healthIssue: issue() })]);
      const changed = issue({ code: 'git-error', message: 'Git failed.' });

      await expect(
        recordWorktreeHealth({
          source: 'diff-stats',
          workspaceId: WORKSPACE_ID,
          worktreeId: 'wt-1',
          issue: changed,
        }),
      ).resolves.toMatchObject({ status: 'recorded' });

      expect((await readRow('wt-1'))?.healthIssue).toEqual(changed);
    });

    it('clears the issue and the split recovery flag when healthy', async () => {
      await writeList([
        row('wt-1', {
          healthIssue: issue(),
          splitRecoveryRequired: true,
          label: 'Kept',
        }),
        row('wt-2'),
      ]);
      const healthy = (): Promise<WorktreeRecordOutcome> =>
        recordWorktreeHealth({
          source: 'health-check',
          workspaceId: WORKSPACE_ID,
          worktreeId: 'wt-1',
          issue: null,
        });

      await expect(healthy()).resolves.toEqual({
        status: 'recorded',
        worktree: row('wt-1', { label: 'Kept' }),
      });
      await expect(healthy()).resolves.toMatchObject({ status: 'unchanged' });
      expect(await readDocument()).toEqual({
        version: 1,
        worktrees: [row('wt-1', { label: 'Kept' }), row('wt-2')],
      });
    });

    it('refuses an unknown source', async () => {
      await writeList([row('wt-1')]);

      await expect(
        recordWorktreeHealth({
          source: untypedSource('portal'),
          workspaceId: WORKSPACE_ID,
          worktreeId: 'wt-1',
          issue: null,
        }),
      ).rejects.toBeInstanceOf(WorktreeRecordRefusedError);
    });
  });

  describe('internal.worktree.recovery.reconcile', () => {
    it('promotes the pending incarnation launch observed', async () => {
      await writeList([
        row('wt-1', { setupPhase: 'git-pending', label: 'Kept' }),
        row('wt-2', { setupPhase: 'git-pending' }),
      ]);

      const outcome = await reconcileWorktreeRecovery({
        kind: 'promote-pending',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'wt-1',
        createdAt: CREATED_AT,
        branchName: 'feature/checked-out',
      });

      const promoted = row('wt-1', {
        branchName: 'feature/checked-out',
        setupPhase: 'git-ready',
        label: 'Kept',
      });
      expect(outcome).toEqual({ status: 'recorded', worktree: promoted });
      expect(await readDocument()).toEqual({
        version: 1,
        worktrees: [promoted, row('wt-2', { setupPhase: 'git-pending' })],
      });
    });

    it('does not promote a row recreated since launch read it', async () => {
      const contents = await writeList([
        row('wt-1', {
          setupPhase: 'git-pending',
          createdAt: '2026-10-05T00:00:00.000Z',
        }),
      ]);

      await expect(
        reconcileWorktreeRecovery({
          kind: 'promote-pending',
          workspaceId: WORKSPACE_ID,
          worktreeId: 'wt-1',
          createdAt: CREATED_AT,
          branchName: 'feature/checked-out',
        }),
      ).resolves.toEqual({ status: 'not-found', worktree: null });

      expect(await readFile(listPath, 'utf8')).toBe(contents);
    });

    it('leaves a row that is no longer pending', async () => {
      const ready = row('wt-1', { setupPhase: 'git-ready' });
      const contents = await writeList([ready]);

      await expect(
        reconcileWorktreeRecovery({
          kind: 'promote-pending',
          workspaceId: WORKSPACE_ID,
          worktreeId: 'wt-1',
          createdAt: CREATED_AT,
          branchName: 'feature/other',
        }),
      ).resolves.toEqual({ status: 'unchanged', worktree: ready });

      expect(await readFile(listPath, 'utf8')).toBe(contents);
    });

    it('refuses a promotion without a branch name', async () => {
      const contents = await writeList([
        row('wt-1', { setupPhase: 'git-pending' }),
      ]);

      await expect(
        reconcileWorktreeRecovery({
          kind: 'promote-pending',
          workspaceId: WORKSPACE_ID,
          worktreeId: 'wt-1',
          createdAt: CREATED_AT,
          branchName: ' ',
        }),
      ).rejects.toMatchObject({ reason: 'invalid-request' });

      expect(await readFile(listPath, 'utf8')).toBe(contents);
    });

    it('exposes an interrupted split reservation for explicit recovery', async () => {
      await writeList([
        row('wt-1', {
          hidden: true,
          setupPhase: 'git-pending',
          splitRecoveryRequired: true,
        }),
      ]);

      const outcome = await reconcileWorktreeRecovery({
        kind: 'expose-split-reservation',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'wt-1',
        createdAt: CREATED_AT,
        worktreePath: '/worktrees/wt-1',
      });

      expect(outcome.status).toBe('recorded');
      const exposed = await readRow('wt-1');
      expect(exposed).toEqual({
        ...row('wt-1'),
        splitRecoveryRequired: true,
        healthIssue: {
          status: 'broken',
          code: 'git-error',
          message:
            'A split was interrupted after destination data was reserved. This worktree was retained for explicit recovery.',
          checkedAt: exposed?.healthIssue?.checkedAt,
          worktreePath: '/worktrees/wt-1',
          gitError: 'Split transaction did not reach background completion.',
        },
      });
      expect(
        Number.isNaN(Date.parse(exposed?.healthIssue?.checkedAt ?? '')),
      ).toBe(false);
    });
  });
});

/** Internal callers are typed; a test sends an unknown source the same way. */
function untypedSource(value: string): 'health-check' {
  return Reflect.apply(String, undefined, [value]);
}
