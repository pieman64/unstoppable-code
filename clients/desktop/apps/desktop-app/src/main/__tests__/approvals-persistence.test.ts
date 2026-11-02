import type * as FsPromises from 'node:fs/promises';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type * as Path from 'node:path';
import { dirname, join } from 'node:path';
import type * as DirectoryFlush from '@canopy/core-platform/directory-flush';
import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  type ApprovalRule,
} from '@canopy/desktop-shared/types';
import {
  readWorkspaceApprovals,
  readWorkspaceApprovalsResult,
  writeWorkspaceApprovals,
  addWorkspaceApprovalRule,
  removeWorkspaceApprovalRule,
  getWorkspaceApprovalsFilePath,
} from '../lib/approvals-persistence';
import { createDirectoryDurably } from '../lib/atomic-file';
import { getWorkspaceApprovalRulesRevision } from '../approvals/rule-revisions';

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  return { ...actual, readFile: jest.fn(actual.readFile) };
});
const mockFlushDirectory = jest.fn<Promise<'flushed'>, [string]>();
jest.mock('@canopy/core-platform/directory-flush', () => {
  const actual = jest.requireActual<typeof DirectoryFlush>(
    '@canopy/core-platform/directory-flush',
  );
  return {
    ...actual,
    flushDirectory: (path: string): Promise<'flushed'> =>
      mockFlushDirectory(path),
  };
});
const mockRoot = { path: '' };
jest.mock('../lib/paths', () => ({
  getChatWorkspaceRootDir: (id: string): string =>
    [
      'app-advisor',
      'code-review-chat',
      'pipeline-editor',
      'plan-explore-chat',
    ].includes(id)
      ? jest
          .requireActual<typeof Path>('node:path')
          .join(mockRoot.path, 'app-workspaces', id)
      : jest
          .requireActual<typeof Path>('node:path')
          .join(mockRoot.path, 'workspaces', id),
}));

const mockedReadFile = jest.mocked(readFile);
const originalDataDir = process.env.CANOPY_DATA_DIR;
const approvalsPath = (workspaceId = 'ws1'): string =>
  join(mockRoot.path, 'workspaces', workspaceId, 'approvals.json');
const stored = async (workspaceId = 'ws1'): Promise<unknown> =>
  JSON.parse(await readFile(approvalsPath(workspaceId), 'utf8'));
// Node's own errors fail `instanceof Error` inside Jest's realm.
const missingOnce = (): void => {
  mockedReadFile.mockRejectedValueOnce(
    Object.assign(new Error('missing'), { code: 'ENOENT' }),
  );
};
/** As an earlier confirmed write left it: its folders already durable. */
const store = async (value: unknown, workspaceId = 'ws1'): Promise<void> => {
  await createDirectoryDurably(join(mockRoot.path, 'workspaces', workspaceId), {
    dataRoot: mockRoot.path,
  });
  mockFlushDirectory.mockClear();
  await writeFile(approvalsPath(workspaceId), JSON.stringify(value));
};

const { flushDirectory: realFlushDirectory } = jest.requireActual<
  typeof DirectoryFlush
>('@canopy/core-platform/directory-flush');

beforeEach(async () => {
  jest.clearAllMocks();
  mockFlushDirectory.mockReset().mockImplementation(realFlushDirectory);
  mockRoot.path = await mkdtemp(join(tmpdir(), 'approvals-persistence-'));
  process.env.CANOPY_DATA_DIR = mockRoot.path;
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  await rm(mockRoot.path, { recursive: true, force: true });
});

describe('getWorkspaceApprovalsFilePath', () => {
  it('resolves to approvals.json under the project dir', () => {
    expect(getWorkspaceApprovalsFilePath('ws1')).toBe(
      join(mockRoot.path, 'workspaces', 'ws1', 'approvals.json'),
    );
  });

  it('keeps app-managed approvals under the app-workspaces root', () => {
    for (const workspaceId of [
      APP_ADVISOR_PROJECT_ID,
      PLAN_EXPLORE_CHAT_PROJECT_ID,
      CODE_REVIEW_CHAT_PROJECT_ID,
      PIPELINE_EDITOR_PROJECT_ID,
    ]) {
      expect(getWorkspaceApprovalsFilePath(workspaceId)).toBe(
        join(mockRoot.path, 'app-workspaces', workspaceId, 'approvals.json'),
      );
    }
  });
});

describe('readWorkspaceApprovals', () => {
  it('falls back to empty file on missing content', async () => {
    missingOnce();
    expect(await readWorkspaceApprovals('ws1')).toEqual({
      version: 1,
      rules: [],
    });
  });

  it('falls back to an explicit Ask default for corrupt JSON content', async () => {
    await mkdir(join(mockRoot.path, 'workspaces', 'ws1'), { recursive: true });
    await writeFile(approvalsPath(), 'not json');
    expect(await readWorkspaceApprovals('ws1')).toEqual({
      version: 1,
      rules: [],
      defaultMode: 'ask',
    });
  });

  it('falls back to empty defaults for non-missing read failures', async () => {
    mockedReadFile.mockRejectedValueOnce(
      Object.assign(new Error('permission denied'), { code: 'EACCES' }),
    );
    expect(await readWorkspaceApprovals('ws1')).toEqual({
      version: 1,
      rules: [],
      defaultMode: 'ask',
    });
  });

  it('falls back to empty defaults for invalid rules', async () => {
    await store({
      version: 1,
      rules: [
        {
          id: 'r1',
          behavior: 'allow',
          target: { kind: 'command', pattern: 'npm test *' },
          createdAt: '2026-07-20T00:00:00.000Z',
          origin: 'prompt',
        },
        { id: 'bad', behavior: 'not-a-behavior', target: {} },
      ],
    });
    expect(await readWorkspaceApprovals('ws1')).toEqual({
      version: 1,
      rules: [],
      defaultMode: 'ask',
    });
  });

  it('falls back to empty defaults for an invalid defaultMode', async () => {
    await store({ version: 1, rules: [], defaultMode: 'bogus' });
    expect(await readWorkspaceApprovals('ws1')).toEqual({
      version: 1,
      rules: [],
      defaultMode: 'ask',
    });
  });

  it('falls back to empty defaults for unsupported persisted versions', async () => {
    await store({ version: 2, rules: [] });
    expect(await readWorkspaceApprovals('ws1')).toEqual({
      version: 1,
      rules: [],
      defaultMode: 'ask',
    });
  });

  it('preserves a valid defaultMode', async () => {
    await store({ version: 1, rules: [], defaultMode: 'auto' });
    const file = await readWorkspaceApprovals('ws1');
    expect(file.defaultMode).toBe('auto');
  });

  it('distinguishes an unreadable policy from a missing policy', async () => {
    mockedReadFile.mockRejectedValueOnce(
      Object.assign(new Error('denied'), { code: 'EACCES' }),
    );
    missingOnce();

    await expect(readWorkspaceApprovalsResult('ws1')).resolves.toMatchObject({
      status: 'unreadable',
      file: { defaultMode: 'ask' },
    });
    await expect(readWorkspaceApprovalsResult('ws1')).resolves.toEqual({
      status: 'missing',
      file: { version: 1, rules: [] },
    });
  });
});

const promptRule: ApprovalRule = {
  id: 'r1',
  behavior: 'allow',
  target: { kind: 'command', pattern: 'npm test *' },
  createdAt: '2026-07-20T00:00:00.000Z',
  origin: 'prompt',
};

describe('writeWorkspaceApprovals', () => {
  it('creates the project dir and stamps version 1', async () => {
    const revisionBefore = getWorkspaceApprovalRulesRevision('ws1');
    const ok = await writeWorkspaceApprovals('ws1', {
      version: 1,
      rules: [promptRule],
    });
    expect(ok).toBe(true);
    expect(getWorkspaceApprovalRulesRevision('ws1')).toBe(revisionBefore + 1);
    expect(await readFile(approvalsPath(), 'utf8')).toBe(
      JSON.stringify({ version: 1, rules: [promptRule] }, null, 2),
    );
    expect(await readdir(join(mockRoot.path, 'workspaces', 'ws1'))).toEqual([
      'approvals.json',
    ]);
  });

  // CAN-5153: folders something else created are flushed up to the data
  // root's parent before the file is installed.
  it('acknowledges a write only after flushing its folder', async () => {
    const workspaces = join(mockRoot.path, 'workspaces');
    const folder = join(workspaces, 'ws1');
    await mkdir(folder, { recursive: true });
    mockFlushDirectory.mockImplementation(async (path) => {
      if (path === folder) {
        expect(await stored()).toEqual({ version: 1, rules: [promptRule] });
      }
      return 'flushed';
    });
    await expect(
      writeWorkspaceApprovals('ws1', { version: 1, rules: [promptRule] }),
    ).resolves.toBe(true);
    expect(mockFlushDirectory.mock.calls).toEqual([
      [workspaces],
      [mockRoot.path],
      [dirname(mockRoot.path)],
      [folder],
    ]);
  });

  it('flushes the holder of each folder the first write creates before acknowledging it', async () => {
    const workspaces = join(mockRoot.path, 'workspaces');
    const folder = join(workspaces, 'ws1');
    mockFlushDirectory.mockImplementation(async (path) => {
      if (path !== folder) {
        // Each new folder's entry is flushed before the file is installed.
        await expect(readdir(folder)).resolves.toEqual([]);
      }
      return 'flushed';
    });
    await expect(
      writeWorkspaceApprovals('ws1', { version: 1, rules: [promptRule] }),
    ).resolves.toBe(true);
    expect(mockFlushDirectory.mock.calls.map(([path]) => path).sort()).toEqual(
      [dirname(mockRoot.path), mockRoot.path, workspaces, folder].sort(),
    );
    expect(mockFlushDirectory.mock.calls.at(-1)).toEqual([folder]);
  });

  it('installs nothing and latches nothing when a new folder cannot be flushed', async () => {
    const workspaces = join(mockRoot.path, 'workspaces');
    const revisionBefore = getWorkspaceApprovalRulesRevision('ws-new');
    mockFlushDirectory.mockImplementation((path) =>
      path === workspaces
        ? Promise.reject(
            Object.assign(new Error('flush failed'), { code: 'EIO' }),
          )
        : Promise.resolve('flushed'),
    );
    await expect(
      writeWorkspaceApprovals('ws-new', { version: 1, rules: [promptRule] }),
    ).resolves.toBe(false);
    await expect(readdir(join(workspaces, 'ws-new'))).resolves.toEqual([]);
    expect(getWorkspaceApprovalRulesRevision('ws-new')).toBe(revisionBefore);
    mockFlushDirectory.mockImplementation(realFlushDirectory);
    await store({ version: 1, rules: [promptRule] }, 'ws-new');
    await expect(readWorkspaceApprovalsResult('ws-new')).resolves.toEqual({
      status: 'ok',
      file: { version: 1, rules: [promptRule] },
    });
  });

  // CAN-4469 D-release: an installed write whose folder flush failed is not
  // live policy in this process until a later write to it is confirmed.
  describe('after a write whose folder flush failed', () => {
    const failInstalledFlush = (workspaceId: string): void => {
      const folder = join(mockRoot.path, 'workspaces', workspaceId);
      mockFlushDirectory.mockImplementation(async (path) => {
        if (path === folder) {
          mockFlushDirectory.mockImplementation(realFlushDirectory);
          throw Object.assign(new Error('flush failed'), { code: 'EIO' });
        }
        return realFlushDirectory(path);
      });
    };

    it('projects the unreadable Ask policy, not the unconfirmed rule', async () => {
      const revisionBefore = getWorkspaceApprovalRulesRevision('ws-unknown');
      failInstalledFlush('ws-unknown');
      await expect(
        writeWorkspaceApprovals('ws-unknown', {
          version: 1,
          rules: [promptRule],
        }),
      ).resolves.toBe(false);
      expect(await stored('ws-unknown')).toEqual({
        version: 1,
        rules: [promptRule],
      });
      // Cached rules are dropped; the reload sees the fail-closed projection.
      expect(getWorkspaceApprovalRulesRevision('ws-unknown')).toBe(
        revisionBefore + 1,
      );
      await expect(readWorkspaceApprovalsResult('ws-unknown')).resolves.toEqual(
        {
          status: 'unreadable',
          file: { version: 1, rules: [], defaultMode: 'ask' },
        },
      );
      await expect(
        readWorkspaceApprovalsResult('ws-unknown'),
      ).resolves.toMatchObject({ status: 'unreadable' });
      // Other workspaces are unaffected.
      missingOnce();
      await expect(
        addWorkspaceApprovalRule('ws-other', { ...promptRule, id: 'r2' }),
      ).resolves.toMatchObject({ rules: [{ id: 'r2' }] });
      await expect(
        readWorkspaceApprovalsResult('ws-other'),
      ).resolves.toMatchObject({ status: 'ok' });
    });

    it('applies the saved rules again once a later write is confirmed', async () => {
      await store({ version: 1, rules: [] }, 'ws-retry');
      failInstalledFlush('ws-retry');
      await expect(
        addWorkspaceApprovalRule('ws-retry', promptRule),
      ).rejects.toThrow('Failed to persist project approval rule');
      const revision = getWorkspaceApprovalRulesRevision('ws-retry');
      const second: ApprovalRule = { ...promptRule, id: 'r2' };
      await expect(
        addWorkspaceApprovalRule('ws-retry', second),
      ).resolves.toEqual({ version: 1, rules: [promptRule, second] });
      expect(getWorkspaceApprovalRulesRevision('ws-retry')).toBe(revision + 1);
      await expect(readWorkspaceApprovalsResult('ws-retry')).resolves.toEqual({
        status: 'ok',
        file: { version: 1, rules: [promptRule, second] },
      });
    });

    it('stays fail-closed when the later write is not confirmed either', async () => {
      failInstalledFlush('ws-twice');
      await writeWorkspaceApprovals('ws-twice', {
        version: 1,
        rules: [promptRule],
      });
      failInstalledFlush('ws-twice');
      await expect(
        removeWorkspaceApprovalRule('ws-twice', promptRule.id),
      ).rejects.toThrow('Failed to persist project approval rule removal');
      expect(await stored('ws-twice')).toEqual({ version: 1, rules: [] });
      await expect(
        readWorkspaceApprovalsResult('ws-twice'),
      ).resolves.toMatchObject({ status: 'unreadable' });
    });

    const denyRule = (id: string): ApprovalRule => ({
      id,
      behavior: 'deny',
      target: { kind: 'command', pattern: `${id} *` },
      createdAt: '2026-07-20T00:00:00.000Z',
      origin: 'settings',
    });

    it('keeps enforcing a deny both file versions hold', async () => {
      await store({ version: 1, rules: [denyRule('d1')] }, 'ws-deny');
      failInstalledFlush('ws-deny');
      await expect(
        addWorkspaceApprovalRule('ws-deny', promptRule),
      ).rejects.toThrow('Failed to persist project approval rule');
      await expect(readWorkspaceApprovalsResult('ws-deny')).resolves.toEqual({
        status: 'unreadable',
        file: { version: 1, rules: [denyRule('d1')], defaultMode: 'ask' },
      });
    });

    it('keeps enforcing a confirmed deny the unconfirmed write removed', async () => {
      await store({ version: 1, rules: [denyRule('d1')] }, 'ws-deny-removed');
      failInstalledFlush('ws-deny-removed');
      await expect(
        removeWorkspaceApprovalRule('ws-deny-removed', 'd1'),
      ).rejects.toThrow('Failed to persist project approval rule removal');
      expect(await stored('ws-deny-removed')).toEqual({
        version: 1,
        rules: [],
      });
      await expect(
        readWorkspaceApprovalsResult('ws-deny-removed'),
      ).resolves.toEqual({
        status: 'unreadable',
        file: { version: 1, rules: [denyRule('d1')], defaultMode: 'ask' },
      });
    });

    it('keeps the confirmed deny when a direct write removes it unconfirmed', async () => {
      await store({ version: 1, rules: [denyRule('d1')] }, 'ws-deny-direct');
      failInstalledFlush('ws-deny-direct');
      await expect(
        writeWorkspaceApprovals('ws-deny-direct', {
          version: 1,
          rules: [promptRule],
        }),
      ).resolves.toBe(false);
      await expect(
        readWorkspaceApprovalsResult('ws-deny-direct'),
      ).resolves.toEqual({
        status: 'unreadable',
        file: { version: 1, rules: [denyRule('d1')], defaultMode: 'ask' },
      });
    });

    it('keeps every deny any possible version holds across unconfirmed writes', async () => {
      await store({ version: 1, rules: [denyRule('d1')] }, 'ws-deny-chain');
      failInstalledFlush('ws-deny-chain');
      await expect(
        addWorkspaceApprovalRule('ws-deny-chain', denyRule('d2')),
      ).rejects.toThrow('Failed to persist project approval rule');
      failInstalledFlush('ws-deny-chain');
      await expect(
        removeWorkspaceApprovalRule('ws-deny-chain', 'd1'),
      ).rejects.toThrow('Failed to persist project approval rule removal');
      failInstalledFlush('ws-deny-chain');
      await expect(
        removeWorkspaceApprovalRule('ws-deny-chain', 'd2'),
      ).rejects.toThrow('Failed to persist project approval rule removal');
      expect(await stored('ws-deny-chain')).toEqual({ version: 1, rules: [] });
      const result = await readWorkspaceApprovalsResult('ws-deny-chain');
      expect(result.status).toBe('unreadable');
      expect(result.file.rules).toHaveLength(2);
      expect(result.file.rules).toEqual(
        expect.arrayContaining([denyRule('d1'), denyRule('d2')]),
      );
    });

    it('drops the retained denies once a later write is confirmed', async () => {
      await store({ version: 1, rules: [denyRule('d1')] }, 'ws-deny-clear');
      failInstalledFlush('ws-deny-clear');
      await expect(
        removeWorkspaceApprovalRule('ws-deny-clear', 'd1'),
      ).rejects.toThrow('Failed to persist project approval rule removal');
      await expect(
        addWorkspaceApprovalRule('ws-deny-clear', promptRule),
      ).resolves.toEqual({ version: 1, rules: [promptRule] });
      await expect(
        readWorkspaceApprovalsResult('ws-deny-clear'),
      ).resolves.toEqual({
        status: 'ok',
        file: { version: 1, rules: [promptRule] },
      });
    });

    it('starts a later direct write only once the earlier outcome is known', async () => {
      await store({ version: 1, rules: [denyRule('d1')] }, 'ws-queued');
      const folder = join(mockRoot.path, 'workspaces', 'ws-queued');
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      mockFlushDirectory.mockImplementationOnce(async (path) => {
        expect(path).toBe(folder);
        reached.resolve();
        await release.promise;
        throw Object.assign(new Error('flush failed'), { code: 'EIO' });
      });
      const first = writeWorkspaceApprovals('ws-queued', {
        version: 1,
        rules: [],
      });
      await reached.promise;
      const second = writeWorkspaceApprovals('ws-queued', {
        version: 1,
        rules: [promptRule],
      });
      const secondSettledFirst = await Promise.race([
        second.then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 250),
        ),
      ]);
      expect(secondSettledFirst).toBe(false);
      expect(await stored('ws-queued')).toEqual({ version: 1, rules: [] });
      release.resolve();
      await expect(first).resolves.toBe(false);
      await expect(second).resolves.toBe(true);
      await expect(readWorkspaceApprovalsResult('ws-queued')).resolves.toEqual({
        status: 'ok',
        file: { version: 1, rules: [promptRule] },
      });
    });

    it('holds a read that overlaps the write until its outcome is known', async () => {
      await store({ version: 1, rules: [] }, 'ws-overlap');
      const folder = join(mockRoot.path, 'workspaces', 'ws-overlap');
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      mockFlushDirectory.mockImplementationOnce(async (path) => {
        expect(path).toBe(folder);
        reached.resolve();
        await release.promise;
        throw Object.assign(new Error('flush failed'), { code: 'EIO' });
      });
      const write = writeWorkspaceApprovals('ws-overlap', {
        version: 1,
        rules: [promptRule],
      });
      await reached.promise;
      // The unconfirmed rule is already on disk.
      expect(await stored('ws-overlap')).toEqual({
        version: 1,
        rules: [promptRule],
      });
      let settled = false;
      const read = readWorkspaceApprovalsResult('ws-overlap').then((result) => {
        settled = true;
        return result;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false);
      release.resolve();
      await expect(write).resolves.toBe(false);
      await expect(read).resolves.toMatchObject({
        status: 'unreadable',
        file: { rules: [] },
      });
    });
  });

  it('returns false, keeping the previous file, when the write fails', async () => {
    await store({ version: 1, rules: [] });
    const folder = join(mockRoot.path, 'workspaces', 'ws1');
    await rm(folder, { recursive: true });
    await writeFile(folder, 'a file where the project folder belongs');
    const revisionBefore = getWorkspaceApprovalRulesRevision('ws1');
    const ok = await writeWorkspaceApprovals('ws1', {
      version: 1,
      rules: [],
    });
    expect(ok).toBe(false);
    expect(await readFile(folder, 'utf8')).toBe(
      'a file where the project folder belongs',
    );
    // Nothing was installed, so cached rules still match disk.
    expect(getWorkspaceApprovalRulesRevision('ws1')).toBe(revisionBefore);
  });

  it('normalizes rules and defaults before writing', async () => {
    const ok = await writeWorkspaceApprovals('ws1', {
      version: 99,
      defaultMode: 'invalid',
      rules: [
        {
          id: 'valid',
          behavior: 'deny',
          target: { kind: 'tool', toolName: 'WebSearch' },
          createdAt: '2026-07-20T00:00:00.000Z',
          origin: 'settings',
        },
        {
          id: 'invalid',
          behavior: 'sometimes',
          target: {},
        },
      ],
    });

    expect(ok).toBe(true);
    expect(await readFile(approvalsPath(), 'utf8')).toBe(
      JSON.stringify(
        {
          version: 1,
          rules: [
            {
              id: 'valid',
              behavior: 'deny',
              target: { kind: 'tool', toolName: 'WebSearch' },
              createdAt: '2026-07-20T00:00:00.000Z',
              origin: 'settings',
            },
          ],
        },
        null,
        2,
      ),
    );
  });
});

describe('addWorkspaceApprovalRule', () => {
  it('appends and writes with version stamp', async () => {
    await store({ version: 1, rules: [] });
    const file = await addWorkspaceApprovalRule('ws1', promptRule);
    expect(file.rules).toEqual([promptRule]);
    expect(await stored()).toEqual({ version: 1, rules: [promptRule] });
  });

  it('creates the project dir for the first rule', async () => {
    missingOnce();
    await addWorkspaceApprovalRule('ws1', promptRule);
    expect(await stored()).toEqual({ version: 1, rules: [promptRule] });
  });

  it('throws when the updated file cannot be persisted', async () => {
    await store({ version: 1, rules: [] }, 'ws-add-unknown');
    mockFlushDirectory.mockRejectedValueOnce(new Error('flush failed'));
    const revisionBefore = getWorkspaceApprovalRulesRevision('ws-add-unknown');

    await expect(
      addWorkspaceApprovalRule('ws-add-unknown', promptRule),
    ).rejects.toThrow('Failed to persist project approval rule');
    expect(getWorkspaceApprovalRulesRevision('ws-add-unknown')).toBe(
      revisionBefore + 1,
    );
  });

  it('refuses to replace an unreadable policy while adding a rule', async () => {
    await store({ version: 1, rules: [] });
    mockedReadFile.mockRejectedValueOnce(
      Object.assign(new Error('temporarily unreadable'), { code: 'EACCES' }),
    );

    await expect(addWorkspaceApprovalRule('ws1', promptRule)).rejects.toThrow(
      'Refusing to overwrite unreadable approvals.json',
    );
    expect(await stored()).toEqual({ version: 1, rules: [] });
  });

  it('serializes concurrent mutations for the same project', async () => {
    await store({ version: 1, rules: [] });
    let releaseFirstFlush = (): void => {
      throw new Error('First flush was not initialized');
    };
    const firstFlushBlocked = new Promise<void>((resolve) => {
      releaseFirstFlush = resolve;
    });
    let markFirstFlushReached = (): void => undefined;
    const firstFlushReached = new Promise<void>((resolve) => {
      markFirstFlushReached = resolve;
    });
    mockFlushDirectory.mockImplementationOnce(async () => {
      markFirstFlushReached();
      await firstFlushBlocked;
      return 'flushed';
    });
    const makeRule = (id: string): ApprovalRule => ({
      ...promptRule,
      id,
      target: { kind: 'command', pattern: `${id} *` },
    });

    const first = addWorkspaceApprovalRule('ws1', makeRule('r1'));
    try {
      await firstFlushReached;
      const second = addWorkspaceApprovalRule('ws1', makeRule('r2'));
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(mockFlushDirectory).toHaveBeenCalledTimes(1);
      expect(await stored()).toEqual({ version: 1, rules: [makeRule('r1')] });
      releaseFirstFlush();
      await Promise.all([first, second]);
    } finally {
      // A failed expectation must not leave ws1's mutation queue blocked.
      releaseFirstFlush();
      await first.catch(() => undefined);
    }

    const parsed = (await stored()) as { rules: Array<{ id: string }> };
    expect(parsed.rules.map((rule) => rule.id)).toEqual(['r1', 'r2']);
  });
});

describe('removeWorkspaceApprovalRule', () => {
  it('filters by id', async () => {
    await store({
      version: 1,
      rules: [
        {
          id: 'r1',
          behavior: 'deny',
          target: { kind: 'tool', toolName: 'X' },
          createdAt: '',
          origin: 'settings',
        },
      ],
    });
    const file = await removeWorkspaceApprovalRule('ws1', 'r1');
    expect(file.rules).toEqual([]);
    expect(await stored()).toEqual({ version: 1, rules: [] });
  });

  it('refuses to replace an unreadable policy while removing a rule', async () => {
    await store({ version: 1, rules: [promptRule] });
    mockedReadFile.mockRejectedValueOnce(
      Object.assign(new Error('temporarily unreadable'), { code: 'EACCES' }),
    );

    await expect(removeWorkspaceApprovalRule('ws1', 'r1')).rejects.toThrow(
      'Refusing to overwrite unreadable approvals.json',
    );
    expect(await stored()).toEqual({ version: 1, rules: [promptRule] });
  });
});
