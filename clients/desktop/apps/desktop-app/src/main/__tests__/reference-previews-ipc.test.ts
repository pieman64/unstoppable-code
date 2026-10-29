import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { registerReferencePreviewHandlers } from '../ipc/reference-previews';

const mockHandlers = new Map<string, (...args: unknown[]) => unknown>();
const mockGitHubReadScope = jest.fn(() => Promise.resolve({ scope: 's' }));
const mockGitHubReadOrigin = jest.fn(() =>
  Promise.resolve({ repository: null }),
);
const mockGitHubRead = jest.fn(() => Promise.resolve({ status: 'failed' }));

jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (...args: unknown[]) => unknown,
  ): void => {
    mockHandlers.set(channel, handler);
  },
}));

jest.mock('../lib/linear-reference-preview', () => ({
  createLinearReferencePreviewReader: (): Record<string, jest.Mock> => ({
    readScope: jest.fn(),
    readTeamKeys: jest.fn(),
    readIssue: jest.fn(),
  }),
}));

jest.mock('../lib/github-reference-preview', () => ({
  createGitHubReferencePreviewReader: (): Record<string, jest.Mock> => ({
    readScope: mockGitHubReadScope,
    readOrigin: mockGitHubReadOrigin,
    read: mockGitHubRead,
  }),
}));

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = mockHandlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return Promise.resolve(handler({}, ...args));
}

describe('GitHub reference preview IPC', () => {
  beforeAll(() => {
    registerReferencePreviewHandlers();
  });

  beforeEach(() => {
    mockGitHubReadScope.mockClear();
    mockGitHubReadOrigin.mockClear();
    mockGitHubRead.mockClear();
  });

  it('reads the scope without arguments', async () => {
    expect(await invoke(IPC_CHANNELS.referencePreviewGitHubScope)).toEqual({
      scope: 's',
    });
    expect(mockGitHubReadScope).toHaveBeenCalledWith();
  });

  it('passes only known origin fields', async () => {
    await invoke(IPC_CHANNELS.referencePreviewGitHubOrigin, {
      kind: 'worktree',
      projectId: 'p1',
      worktreeId: 'w1',
      cwd: '/tmp/elsewhere',
    });
    await invoke(IPC_CHANNELS.referencePreviewGitHubOrigin, {
      kind: 'cowork',
      projectId: 'p1',
    });
    expect(mockGitHubReadOrigin.mock.calls).toEqual([
      [{ kind: 'worktree', projectId: 'p1', worktreeId: 'w1' }],
      [{ kind: 'cowork' }],
    ]);
  });

  it.each([
    [undefined],
    [null],
    [{ kind: 'worktree', projectId: 'p1' }],
    [{ kind: 'worktree', projectId: '', worktreeId: 'w1' }],
    [{ kind: 'project' }],
  ])('rejects an invalid origin %j', async (origin) => {
    await expect(
      invoke(IPC_CHANNELS.referencePreviewGitHubOrigin, origin),
    ).rejects.toThrow('Invalid GitHub reference origin.');
    expect(mockGitHubReadOrigin).not.toHaveBeenCalled();
  });

  it('passes only known target fields', async () => {
    await invoke(IPC_CHANNELS.referencePreviewGitHub, {
      kind: 'item',
      owner: 'acme',
      repository: 'widgets',
      number: 7,
      token: 'leak',
    });
    await invoke(IPC_CHANNELS.referencePreviewGitHub, {
      kind: 'repository',
      owner: 'acme',
      repository: 'widgets',
      number: 7,
    });
    expect(mockGitHubRead.mock.calls).toEqual([
      [{ kind: 'item', owner: 'acme', repository: 'widgets', number: 7 }],
      [{ kind: 'repository', owner: 'acme', repository: 'widgets' }],
    ]);
  });

  it.each([
    [undefined],
    [{ kind: 'item', owner: 'acme', repository: 'widgets' }],
    [{ kind: 'item', owner: 'acme', repository: 'widgets', number: 0 }],
    [{ kind: 'item', owner: 'Acme', repository: 'widgets', number: 1 }],
    [{ kind: 'repository', owner: 'acme', repository: '..' }],
    [{ kind: 'pull', owner: 'acme', repository: 'widgets', number: 1 }],
  ])('rejects an invalid target %j', async (target) => {
    await expect(
      invoke(IPC_CHANNELS.referencePreviewGitHub, target),
    ).rejects.toThrow('Invalid GitHub preview request.');
    expect(mockGitHubRead).not.toHaveBeenCalled();
  });
});
