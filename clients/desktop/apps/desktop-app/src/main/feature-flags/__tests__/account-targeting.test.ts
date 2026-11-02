const mockCodexAdminRequest = jest.fn<Promise<never>, [string, unknown]>();
const mockGetAuthenticated = jest.fn<
  Promise<{
    data: { id: number; login: string | null; email: string | null };
  }>,
  [unknown?]
>();
const mockListEmailsForAuthenticatedUser = jest.fn<
  Promise<{
    data: Array<{ email: string; primary: boolean; verified: boolean }>;
  }>,
  [unknown?]
>();
const mockOctokit = {
  rest: {
    users: {
      getAuthenticated: mockGetAuthenticated,
      listEmailsForAuthenticatedUser: mockListEmailsForAuthenticatedUser,
    },
  },
};
type GitHubTask = (octokit: typeof mockOctokit) => Promise<unknown>;
const mockEnqueue = jest.fn<
  Promise<unknown>,
  [GitHubTask, ('high' | 'normal')?]
>((task: GitHubTask): Promise<unknown> => task(mockOctokit));
const mockGetGitHubClient = jest.fn<{ enqueue: typeof mockEnqueue }, []>(
  () => ({ enqueue: mockEnqueue }),
);
jest.mock(
  '../../lib/github-client',
  (): {
    getGitHubClient: typeof mockGetGitHubClient;
  } => ({
    get getGitHubClient(): typeof mockGetGitHubClient {
      return mockGetGitHubClient;
    },
  }),
);

jest.mock(
  '../../codex/app-server-client',
  (): {
    parseGetAccountResponsePayload: (value: unknown) => unknown;
  } => ({
    parseGetAccountResponsePayload: (value: unknown): unknown => value,
  }),
);
jest.mock('../../codex/runtime-service', () => ({
  getCodexRuntimeService: jest.fn(() => ({
    admin: jest.fn(() => ({
      request: mockCodexAdminRequest,
    })),
  })),
}));

import {
  readCodexTargetingInfo,
  readGitHubTargetingInfo,
} from '../account-targeting';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRequestSignal(options: unknown): unknown {
  if (!isRecord(options) || !isRecord(options.request)) {
    return null;
  }
  return options.request.signal;
}

describe('account targeting probes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reads GitHub targeting through the shared client with primary verified email fallback', async () => {
    mockGetAuthenticated.mockResolvedValue({
      data: { id: 123, login: 'alice', email: null },
    });
    mockListEmailsForAuthenticatedUser.mockResolvedValue({
      data: [
        { email: 'secondary@example.com', primary: false, verified: true },
        { email: 'alice@example.com', primary: true, verified: true },
      ],
    });

    await expect(readGitHubTargetingInfo()).resolves.toEqual({
      id: '123',
      username: 'alice',
      email: 'alice@example.com',
    });

    expect(mockGetGitHubClient).toHaveBeenCalledTimes(1);
    expect(mockEnqueue).toHaveBeenCalledTimes(2);
    expect(typeof mockEnqueue.mock.calls[0]?.[0]).toBe('function');
    expect(mockEnqueue.mock.calls[0]?.[1]).toBe('high');
    expect(typeof mockEnqueue.mock.calls[1]?.[0]).toBe('function');
    expect(mockEnqueue.mock.calls[1]?.[1]).toBe('high');
    expect(
      readRequestSignal(mockGetAuthenticated.mock.calls[0]?.[0]),
    ).toBeInstanceOf(AbortSignal);
    expect(
      readRequestSignal(mockListEmailsForAuthenticatedUser.mock.calls[0]?.[0]),
    ).toBeInstanceOf(AbortSignal);
  });

  it('returns fallback targeting when the shared Codex account probe times out', async () => {
    jest.useFakeTimers();
    mockCodexAdminRequest.mockReturnValue(new Promise<never>(() => undefined));

    const resultPromise = readCodexTargetingInfo();
    await jest.advanceTimersByTimeAsync(3_000);

    await expect(resultPromise).resolves.toEqual({
      email: null,
      accountLabel: null,
    });
    expect(mockCodexAdminRequest).toHaveBeenCalledWith('account/read', {
      refreshToken: false,
    });
  });
});
