import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
import { getWorkspaceApprovalRulesRevision } from '../approvals/rule-revisions';

jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(),
  readFile: jest.fn(),
  rename: jest.fn(),
  rm: jest.fn(),
  writeFile: jest.fn(),
}));
jest.mock('../lib/paths', () => ({
  getChatWorkspaceRootDir: (id: string): string =>
    [
      'app-advisor',
      'code-review-chat',
      'pipeline-editor',
      'plan-explore-chat',
    ].includes(id)
      ? `/data/app-workspaces/${id}`
      : `/data/workspaces/${id}`,
}));

const mockedReadFile = jest.mocked(readFile);
const mockedWriteFile = jest.mocked(writeFile);
const mockedMkdir = jest.mocked(mkdir);
const mockedRename = jest.mocked(rename);
const mockedRm = jest.mocked(rm);

beforeEach(() => jest.clearAllMocks());

describe('getWorkspaceApprovalsFilePath', () => {
  it('resolves to approvals.json under the project dir', () => {
    expect(getWorkspaceApprovalsFilePath('ws1')).toBe(
      '/data/workspaces/ws1/approvals.json',
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
        `/data/app-workspaces/${workspaceId}/approvals.json`,
      );
    }
  });
});

describe('readWorkspaceApprovals', () => {
  it('falls back to empty file on missing content', async () => {
    mockedReadFile.mockRejectedValueOnce(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );
    expect(await readWorkspaceApprovals('ws1')).toEqual({
      version: 1,
      rules: [],
    });
  });

  it('falls back to an explicit Ask default for corrupt JSON content', async () => {
    mockedReadFile.mockResolvedValueOnce('not json');
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
    mockedReadFile.mockResolvedValueOnce(
      JSON.stringify({
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
      }),
    );
    expect(await readWorkspaceApprovals('ws1')).toEqual({
      version: 1,
      rules: [],
      defaultMode: 'ask',
    });
  });

  it('falls back to empty defaults for an invalid defaultMode', async () => {
    mockedReadFile.mockResolvedValueOnce(
      JSON.stringify({ version: 1, rules: [], defaultMode: 'bogus' }),
    );
    expect(await readWorkspaceApprovals('ws1')).toEqual({
      version: 1,
      rules: [],
      defaultMode: 'ask',
    });
  });

  it('falls back to empty defaults for unsupported persisted versions', async () => {
    mockedReadFile.mockResolvedValueOnce(
      JSON.stringify({ version: 2, rules: [] }),
    );
    expect(await readWorkspaceApprovals('ws1')).toEqual({
      version: 1,
      rules: [],
      defaultMode: 'ask',
    });
  });

  it('preserves a valid defaultMode', async () => {
    mockedReadFile.mockResolvedValueOnce(
      JSON.stringify({ version: 1, rules: [], defaultMode: 'auto' }),
    );
    const file = await readWorkspaceApprovals('ws1');
    expect(file.defaultMode).toBe('auto');
  });

  it('distinguishes an unreadable policy from a missing policy', async () => {
    mockedReadFile
      .mockRejectedValueOnce(
        Object.assign(new Error('denied'), { code: 'EACCES' }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      );

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

describe('writeWorkspaceApprovals', () => {
  it('creates the project dir and stamps version 1', async () => {
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    mockedRename.mockResolvedValue(undefined);
    const rule = {
      id: 'r1',
      behavior: 'allow' as const,
      target: { kind: 'command' as const, pattern: 'npm test *' },
      createdAt: '2026-07-20T00:00:00.000Z',
      origin: 'prompt' as const,
    };
    const revisionBefore = getWorkspaceApprovalRulesRevision('ws1');
    const ok = await writeWorkspaceApprovals('ws1', {
      version: 1,
      rules: [rule],
    });
    expect(ok).toBe(true);
    expect(getWorkspaceApprovalRulesRevision('ws1')).toBe(revisionBefore + 1);
    expect(mockedMkdir).toHaveBeenCalledWith('/data/workspaces/ws1', {
      recursive: true,
    });
    expect(mockedWriteFile).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\/data\/workspaces\/ws1\/\.approvals-\d+-.+\.tmp$/,
      ),
      JSON.stringify({ version: 1, rules: [rule] }, null, 2),
      'utf8',
    );
    expect(mockedRename).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\/data\/workspaces\/ws1\/\.approvals-\d+-.+\.tmp$/,
      ),
      '/data/workspaces/ws1/approvals.json',
    );
  });

  it('returns false when the write fails', async () => {
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockRejectedValueOnce(new Error('disk full'));
    mockedRm.mockResolvedValue(undefined);
    const ok = await writeWorkspaceApprovals('ws1', {
      version: 1,
      rules: [],
    });
    expect(ok).toBe(false);
  });

  it('normalizes rules and defaults before writing', async () => {
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    mockedRename.mockResolvedValue(undefined);

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
    expect(mockedWriteFile).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\/data\/workspaces\/ws1\/\.approvals-\d+-.+\.tmp$/,
      ),
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
      'utf8',
    );
  });
});

describe('addWorkspaceApprovalRule', () => {
  it('appends and writes with version stamp', async () => {
    mockedReadFile.mockResolvedValueOnce(
      JSON.stringify({ version: 1, rules: [] }),
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    mockedRename.mockResolvedValue(undefined);
    const rule = {
      id: 'r1',
      behavior: 'allow' as const,
      target: { kind: 'command' as const, pattern: 'npm test *' },
      createdAt: '2026-07-20T00:00:00.000Z',
      origin: 'prompt' as const,
    };
    const file = await addWorkspaceApprovalRule('ws1', rule);
    expect(file.rules).toEqual([rule]);
    expect(mockedMkdir).toHaveBeenCalledWith('/data/workspaces/ws1', {
      recursive: true,
    });
    expect(mockedWriteFile).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\/data\/workspaces\/ws1\/\.approvals-\d+-.+\.tmp$/,
      ),
      JSON.stringify({ version: 1, rules: [rule] }, null, 2),
      'utf8',
    );
  });

  it('throws when the updated file cannot be persisted', async () => {
    mockedReadFile.mockResolvedValueOnce(
      JSON.stringify({ version: 1, rules: [] }),
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockRejectedValueOnce(new Error('disk full'));
    mockedRm.mockResolvedValue(undefined);

    await expect(
      addWorkspaceApprovalRule('ws1', {
        id: 'r1',
        behavior: 'allow',
        target: { kind: 'command', pattern: 'npm test *' },
        createdAt: '2026-07-20T00:00:00.000Z',
        origin: 'prompt',
      }),
    ).rejects.toThrow('Failed to persist project approval rule');
  });

  it('refuses to replace an unreadable policy while adding a rule', async () => {
    mockedReadFile.mockRejectedValueOnce(
      Object.assign(new Error('temporarily unreadable'), { code: 'EACCES' }),
    );

    await expect(
      addWorkspaceApprovalRule('ws1', {
        id: 'r1',
        behavior: 'allow',
        target: { kind: 'command', pattern: 'npm test *' },
        createdAt: '2026-07-20T00:00:00.000Z',
        origin: 'prompt',
      }),
    ).rejects.toThrow('Refusing to overwrite unreadable approvals.json');
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('serializes concurrent mutations for the same project', async () => {
    let stored = JSON.stringify({ version: 1, rules: [] });
    let releaseFirstWrite = (): void => {
      throw new Error('First write was not initialized');
    };
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let writeCount = 0;
    mockedReadFile.mockImplementation(() => Promise.resolve(stored));
    mockedMkdir.mockResolvedValue(undefined);
    mockedRename.mockResolvedValue(undefined);
    mockedWriteFile.mockImplementation(async (_path, data) => {
      writeCount++;
      if (writeCount === 1) {
        await firstWriteBlocked;
      }
      if (typeof data !== 'string') {
        throw new Error('Expected approval persistence to write text');
      }
      stored = data;
    });
    const makeRule = (id: string): ApprovalRule => ({
      id,
      behavior: 'allow' as const,
      target: { kind: 'command' as const, pattern: `${id} *` },
      createdAt: '2026-07-20T00:00:00.000Z',
      origin: 'prompt' as const,
    });

    const first = addWorkspaceApprovalRule('ws1', makeRule('r1'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = addWorkspaceApprovalRule('ws1', makeRule('r2'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockedWriteFile).toHaveBeenCalledTimes(1);

    releaseFirstWrite();
    await Promise.all([first, second]);

    const parsed = JSON.parse(stored) as { rules: Array<{ id: string }> };
    expect(parsed.rules.map((rule) => rule.id)).toEqual(['r1', 'r2']);
  });
});

describe('removeWorkspaceApprovalRule', () => {
  it('filters by id', async () => {
    mockedReadFile.mockResolvedValueOnce(
      JSON.stringify({
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
      }),
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    mockedRename.mockResolvedValue(undefined);
    const file = await removeWorkspaceApprovalRule('ws1', 'r1');
    expect(file.rules).toEqual([]);
  });

  it('refuses to replace an unreadable policy while removing a rule', async () => {
    mockedReadFile.mockRejectedValueOnce(
      Object.assign(new Error('temporarily unreadable'), { code: 'EACCES' }),
    );

    await expect(removeWorkspaceApprovalRule('ws1', 'r1')).rejects.toThrow(
      'Refusing to overwrite unreadable approvals.json',
    );
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });
});
