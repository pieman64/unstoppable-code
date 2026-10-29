const mockDiscoverClaudeProjects = jest.fn();
const mockDiscoverCodexProjects = jest.fn();
const mockRequestChatHistoryProfileRefresh = jest.fn();

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
} from '../discovery';
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
});
