jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({ recordAppDiagnostic: jest.fn() })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { WorktreeData } from '@canopy/desktop-shared/types';
import { getWorkspaceWorktreesFilePath } from '../paths';
import { applyReservedWorktreeRecord } from '../worktree-creation-decision-port';
import { __setDesktopW5FileStoreForTests } from '../w5-commit-log-file-store';
import {
  nodeW5FileStore,
  W5AuthorityUnreachableError,
  W5RecordUnservedError,
} from '../w5-file-store';

describe('reserved setup failure records (real W5 persistence)', () => {
  const target = {
    workspaceId: 'workspace',
    worktreeId: 'reserved',
    createdAt: '2026-11-02T00:00:00.000Z',
  };
  const decision = {
    kind: 'worktree.create.phase',
    phase: undefined,
    recoveryRequired: true,
  } as const;
  let root: string;
  let listPath: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    originalDataDir = process.env.CANOPY_DATA_DIR;
    root = await mkdtemp(join(tmpdir(), 'reserved-setup-record-'));
    process.env.CANOPY_DATA_DIR = root;
    listPath = getWorkspaceWorktreesFilePath(target.workspaceId);
    await mkdir(dirname(listPath), { recursive: true });
  });
  afterEach(async () => {
    __setDesktopW5FileStoreForTests(nodeW5FileStore);
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    ['unreadable', '{broken'],
    [
      'partial',
      JSON.stringify({ version: 1, worktrees: [{ id: target.worktreeId }] }),
    ],
    ['absent', undefined],
  ] as const)(
    'throws rather than proving staleness from %s storage',
    async (_authority, contents) => {
      if (contents !== undefined) await writeFile(listPath, contents);

      await expect(
        applyReservedWorktreeRecord(target, decision),
      ).rejects.toMatchObject({
        name: 'WorktreeRegistryUnreadableError',
      });
      if (contents === undefined) {
        await expect(readFile(listPath, 'utf8')).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } else {
        expect(await readFile(listPath, 'utf8')).toBe(contents);
      }
    },
  );

  it.each([
    new W5RecordUnservedError('limit-exceeded', 'worktrees'),
    new W5AuthorityUnreachableError('refused', 'connect'),
  ])(
    'preserves the storage reason when the failure write cannot read W5: %s',
    async (error) => {
      const replace = jest.fn();
      __setDesktopW5FileStoreForTests({
        read: () => Promise.resolve({ state: 'unreadable', error }),
        replace,
        remove: () => Promise.reject(new Error('Read must not write')),
      });
      await expect(
        applyReservedWorktreeRecord(target, decision),
      ).rejects.toMatchObject({
        name: 'WorktreeRegistryUnreadableError',
        message: error.message,
        cause: error,
      });
      expect(replace).not.toHaveBeenCalled();
    },
  );

  it.each(['removed', 'replaced'] as const)(
    'returns false only for an authoritative %s reservation',
    async (change) => {
      const worktrees =
        change === 'removed'
          ? []
          : [
              {
                id: target.worktreeId,
                createdAt: '2026-11-02T01:00:00.000Z',
                branchName: 'feature/replacement',
                setupPhase: 'git-pending',
              },
            ];
      const contents = JSON.stringify({ version: 1, worktrees });
      await writeFile(listPath, contents);
      await expect(applyReservedWorktreeRecord(target, decision)).resolves.toBe(
        false,
      );
      expect(JSON.parse(await readFile(listPath, 'utf8'))).toEqual({
        version: 1,
        worktrees,
      });
    },
  );

  it('records failure for a current reservation on readable storage', async () => {
    const row: WorktreeData = {
      id: target.worktreeId,
      createdAt: target.createdAt,
      branchName: 'feature/reserved',
      creation: {
        operationId: 'create-reserved',
        state: 'pending',
        phase: 'git-setup',
        checkouts: [],
      },
    };
    await writeFile(
      listPath,
      JSON.stringify({
        version: 1,
        worktrees: [row],
      }),
    );
    await expect(applyReservedWorktreeRecord(target, decision)).resolves.toBe(
      true,
    );
    expect(JSON.parse(await readFile(listPath, 'utf8'))).toMatchObject({
      worktrees: [
        {
          id: target.worktreeId,
          createdAt: target.createdAt,
          creation: { state: 'recovery-required', phase: 'git-setup' },
        },
      ],
    });
  });
});
