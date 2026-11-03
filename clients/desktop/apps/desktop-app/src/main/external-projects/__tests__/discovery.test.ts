import type * as FsPromises from 'node:fs/promises';
const mockDiscoverClaudeProjects = jest.fn();
const mockDiscoverCodexProjects = jest.fn();
const mockRequestChatHistoryProfileRefresh = jest.fn();
const mockFindNestedRepositories = jest.fn();
const mockDiscoverHandlers = new Map<
  string,
  (event: unknown, request: unknown) => Promise<ExternalProjectDiscoverResponse>
>();

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  return {
    ...actual,
    realpath: jest.fn((candidate: string) => Promise.resolve(candidate)),
    stat: jest.fn(() => Promise.resolve({ isDirectory: (): boolean => true })),
  };
});
jest.mock('../../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (
      event: unknown,
      request: unknown,
    ) => Promise<ExternalProjectDiscoverResponse>,
  ): void => {
    if (channel === 'external-projects:discover')
      mockDiscoverHandlers.set(channel, handler);
  },
}));
jest.mock('../import', () => ({ importExternalProjects: jest.fn() }));
jest.mock('../invite', () => ({
  hasAnyProviderStore: jest.fn(),
  readExternalProjectImportInvite: jest.fn(),
}));
jest.mock('../../lib/dialog-window', () => ({
  chooseDirectoryForEvent: jest.fn(),
}));
jest.mock('../nested-repositories', () => ({
  findNestedRepositories: (directory: string): unknown =>
    mockFindNestedRepositories(directory),
}));

jest.mock('electron', () => ({}));
jest.mock('../claude-discovery', () => ({
  discoverClaudeProjects: (options: unknown): unknown =>
    mockDiscoverClaudeProjects(options),
}));
jest.mock('../codex-discovery', () => ({
  discoverCodexProjects: (options: unknown): unknown =>
    mockDiscoverCodexProjects(options),
}));
jest.mock('../provider-paths', () => ({
  resolveClaudeDesktopDataDir: (): null => null,
  resolveClaudeDesktopCoworkSessionsDir: (dir: string): string => dir,
}));
jest.mock('../../memory/local/chat-history-profile-refresh', () => ({
  requestChatHistoryProfileRefresh: (input: unknown): Promise<void> => {
    mockRequestChatHistoryProfileRefresh(input);
    return Promise.resolve();
  },
}));
jest.mock('../../lib/git', () => ({
  getGitCommonDir: jest.fn(),
  getWorktreeTopLevel: jest.fn(),
}));
jest.mock('../../lib/paths', () => ({
  getDataDir: (): string => '/tmp/canopy-data',
}));
jest.mock('../../lib/preferences-store', () => ({
  readPreferencesFile: (): Promise<unknown> => Promise.resolve({}),
}));
jest.mock('../../lib/sidebar-items', () => ({
  readAllSidebarItems: (): Promise<unknown> => Promise.resolve({ items: [] }),
}));
jest.mock('../../plugins/plugin-service', () => ({
  loadMarketplacesCacheOnly: (): Promise<null> => Promise.resolve(null),
}));
jest.mock('../ledger', () => ({
  markExternalProjectScan: (): Promise<void> => Promise.resolve(),
  readExternalProjectImportLedger: (): Promise<unknown> =>
    Promise.resolve({ version: 1, imports: {} }),
}));

import {
  collectSessionsForCandidate,
  discoverExternalProjects,
  getCachedExternalProjectScan,
} from '../discovery';
import { getGitCommonDir, getWorktreeTopLevel } from '../../lib/git';
import { registerExternalProjectHandlers } from '../../ipc/external-projects';
import {
  IPC_CHANNELS,
  type ExternalProjectDiscoverResponse,
} from '@canopy/desktop-shared/types';
import type { DiscoveredRoot, DiscoveredSession } from '../types';

function session(id: string): DiscoveredSession {
  return {
    id,
    provider: 'claude',
    surface: 'claude-code',
    kind: 'claude-jsonl',
    cwd: '/x',
    sourcePath: `/x/${id}.jsonl`,
    title: null,
    startedAt: null,
    lastActivityAt: null,
    sizeBytes: 1,
    native: true,
  };
}

function root(sessions: DiscoveredSession[]): DiscoveredRoot {
  return {
    provider: 'claude',
    surface: 'claude-code',
    rootPath: '/x',
    lastActivityAt: null,
    sessions,
  };
}

describe('collectSessionsForCandidate', () => {
  it('matches every requested id across roots without duplicates', () => {
    const shared = session('b');
    const collected = collectSessionsForCandidate(
      ['a', 'b', 'missing'],
      [root([session('a'), shared]), root([shared, session('c')])],
    );
    expect(collected.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('is not limited by a display-capped session list', () => {
    const ids = Array.from({ length: 120 }, (_value, index) => `s${index}`);
    const collected = collectSessionsForCandidate(ids, [
      root(ids.map(session)),
    ]);
    expect(collected).toHaveLength(120);
  });
});

describe('discoverExternalProjects memory profile refresh', () => {
  const emptyAdapter = (): Promise<unknown> =>
    Promise.resolve({ roots: [], diagnostics: [], detected: true });

  beforeEach(() => {
    mockDiscoverClaudeProjects.mockReset().mockImplementation(emptyAdapter);
    mockDiscoverCodexProjects.mockReset().mockImplementation(emptyAdapter);
    mockRequestChatHistoryProfileRefresh.mockReset();
    mockFindNestedRepositories
      .mockReset()
      .mockResolvedValue({ repositories: [], complete: true });
    jest
      .mocked(getWorktreeTopLevel)
      .mockReset()
      .mockRejectedValue(
        new Error(
          'fatal: not a git repository (or any of the parent directories): .git',
        ),
      );
    jest
      .mocked(getGitCommonDir)
      .mockReset()
      .mockImplementation((directory) => Promise.resolve(`${directory}/.git`));
  });

  it('refreshes the profile after a scan of both providers', async () => {
    await discoverExternalProjects({});
    expect(mockRequestChatHistoryProfileRefresh).toHaveBeenCalledTimes(1);
  });

  it('leaves the profile alone when one provider could not be scanned', async () => {
    mockDiscoverClaudeProjects.mockRejectedValue(new Error('EACCES'));

    const response = await discoverExternalProjects({});

    expect(response.diagnostics.map((entry) => entry.source)).toContain(
      'claude',
    );
    expect(mockRequestChatHistoryProfileRefresh).not.toHaveBeenCalled();
  });

  it('leaves the profile alone when the scan covered one provider', async () => {
    await discoverExternalProjects({ providers: ['codex'] });
    expect(mockRequestChatHistoryProfileRefresh).not.toHaveBeenCalled();
  });

  it('orchestrates nested discovery, preserves real evidence and caches the full additive response', async () => {
    const parent = '/projects';
    const repo = `${parent}/repo`;
    mockFindNestedRepositories.mockResolvedValue({
      repositories: [repo],
      complete: true,
    });
    jest.mocked(getWorktreeTopLevel).mockImplementation((directory) => {
      if (directory === repo) return Promise.resolve(repo);
      return Promise.reject(
        new Error(
          'fatal: not a git repository (or any of the parent directories): .git',
        ),
      );
    });
    mockDiscoverCodexProjects.mockResolvedValue({
      roots: [
        {
          ...root([]),
          provider: 'codex',
          surface: 'codex-cli',
          rootPath: repo,
        },
      ],
      diagnostics: [],
      detected: true,
    });
    registerExternalProjectHandlers();
    const handler = mockDiscoverHandlers.get(
      IPC_CHANNELS.externalProjectsDiscover,
    );
    if (!handler) throw new Error('Discovery handler was not registered');
    const response = await handler(null, {
      customRoots: [parent, parent, repo],
    });
    expect(response.candidates).toHaveLength(2);
    expect(
      response.candidates.find((candidate) => candidate.rootPath === parent),
    ).toMatchObject({
      providers: [],
      nestedRepositories: { count: 1, complete: true },
    });
    expect(
      response.candidates.find((candidate) => candidate.rootPath === repo),
    ).toMatchObject({
      providers: ['codex'],
      surfaces: ['codex-cli', 'custom-folder', 'nested-repository'],
    });
    expect(mockFindNestedRepositories).toHaveBeenCalledTimes(1);
    expect(getCachedExternalProjectScan(response.scanId)?.candidates).toEqual(
      response.candidates,
    );
  });

  it('strips picker-only providers and reports an identity timeout as incomplete', async () => {
    const parent = '/projects';
    const repo = `${parent}/repo`;
    mockFindNestedRepositories.mockResolvedValue({
      repositories: [repo],
      complete: true,
    });
    jest
      .mocked(getWorktreeTopLevel)
      .mockImplementation((directory) =>
        Promise.reject(
          new Error(
            directory === repo
              ? 'Git timed out'
              : 'fatal: not a git repository (or any of the parent directories): .git',
          ),
        ),
      );
    const response = await discoverExternalProjects({ customRoots: [parent] });
    expect(response.candidates).toHaveLength(1);
    expect(response.candidates[0]).toMatchObject({
      providers: [],
      nestedRepositories: { count: 0, complete: false },
    });
  });
});
