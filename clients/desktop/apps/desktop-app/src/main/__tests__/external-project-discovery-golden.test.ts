import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  IPC_CHANNELS,
  type ExternalProjectDiscoverResponse,
} from '@canopy/desktop-shared/types';
const mockHandlers = new Map<
  string,
  (event: unknown, request: unknown) => Promise<ExternalProjectDiscoverResponse>
>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (
      event: unknown,
      request: unknown,
    ) => Promise<ExternalProjectDiscoverResponse>,
  ): void => {
    mockHandlers.set(channel, handler);
  },
}));
jest.mock('../external-projects/claude-discovery', () => ({
  discoverClaudeProjects: (): Promise<{
    roots: never[];
    diagnostics: never[];
    detected: boolean;
  }> =>
    Promise.resolve({
      roots: [],
      diagnostics: [],
      detected: false,
    }),
}));
jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: (): Promise<{ items: never[] }> =>
    Promise.resolve({ items: [] }),
}));
jest.mock('../plugins/plugin-service', () => ({
  loadMarketplacesCacheOnly: (): Promise<null> => Promise.resolve(null),
}));
import { registerExternalProjectHandlers } from '../ipc/external-projects';
import {
  getCachedExternalProjectScan,
  resetExternalProjectScanCacheForTests,
} from '../external-projects/discovery';

// Chosen folders live outside excluded OS-temp/app-data roots; every file is
// inside this exclusively created directory and is removed in finally.
test('external-projects:discover keeps Git and folder candidates selectable and refreshes source state', async () => {
  const fixture = realpathSync(
    mkdtempSync(join(homedir(), '.canopy-import-golden-')),
  );
  try {
    const repo = join(fixture, 'repo');
    const folder = join(fixture, 'folder');
    mkdirSync(folder);
    mkdirSync(repo);
    const git = (...args: string[]): string =>
      execFileSync('git', ['-C', repo, ...args], {
        stdio: 'pipe',
        encoding: 'utf8',
      });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), 'untracked project\n');
    registerExternalProjectHandlers();
    const discover = mockHandlers.get(IPC_CHANNELS.externalProjectsDiscover);
    if (!discover) throw new Error('discovery IPC was not registered');
    const request = { providers: ['claude'], customRoots: [repo, folder] };
    const first = await discover({}, request);
    const candidate = first.candidates.find((entry) => entry.rootPath === repo);
    expect(candidate).toMatchObject({
      kind: 'git',
      status: 'available',
      headUnborn: true,
    });
    expect(
      first.candidates.find((entry) => entry.rootPath === folder),
    ).toMatchObject({ kind: 'folder', status: 'available' });
    expect(
      first.candidates.find((entry) => entry.rootPath === folder),
    ).not.toHaveProperty('headUnborn');
    expect(getCachedExternalProjectScan(first.scanId)?.candidates).toEqual(
      first.candidates,
    );
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-qm',
      'initial',
    );
    const refreshed = await discover({}, request);
    expect(
      refreshed.candidates.find((entry) => entry.id === candidate?.id),
    ).toMatchObject({ kind: 'git', status: 'available' });
    expect(
      refreshed.candidates.find((entry) => entry.id === candidate?.id),
    ).not.toHaveProperty('headUnborn');
  } finally {
    resetExternalProjectScanCacheForTests();
    rmSync(fixture, { recursive: true, force: true });
  }
});
