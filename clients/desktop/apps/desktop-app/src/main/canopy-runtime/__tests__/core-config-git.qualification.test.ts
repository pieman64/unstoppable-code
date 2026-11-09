const mockGhStatus = jest.fn<Promise<{ stdout: string; stderr: string }>, []>();
// `gh auth status` through util.promisify's custom hook; other execs run.
jest.mock('node:child_process', () => {
  const actual: Record<string, unknown> & { execFile: object } =
    jest.requireActual('node:child_process');
  const execFile = Object.assign(
    (...args: unknown[]): unknown =>
      (actual.execFile as (...inner: unknown[]) => unknown)(...args),
    {
      [Symbol.for('nodejs.util.promisify.custom')]: (): Promise<{
        stdout: string;
        stderr: string;
      }> => mockGhStatus(),
    },
  );
  return { ...actual, execFile };
});
const mockPreferences = jest.fn<Promise<object>, []>();
jest.mock('../../lib/preferences-store', () => ({
  ...jest.requireActual<object>('../../lib/preferences-store'),
  readPreferencesFile: (): Promise<object> => mockPreferences(),
}));

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONFIG_GRANTS,
  type CanopyCallerDescriptor,
  type ConfigGitValue,
} from '@canopy/protocol/canopy-core';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import { createCoreOperationAdapter } from '../core-operation-adapter';
import {
  createCoreConfigAdapter,
  projectGitPreferences,
} from '../core-config-adapter';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';

const GIT: ConfigGitValue = {
  branchName: { instructions: 'Name it.', prefixMode: 'custom', prefix: 'me/' },
  pullRequest: { instructions: 'Link it.' },
  commitMessage: { instructions: '' },
};

const caller = (
  grants: CanopyCallerDescriptor['grants'],
): CanopyCallerDescriptor => ({
  principalId: 'desktop-agent-git-preferences',
  clientInstanceId: 'desktop-main',
  authorityId: 'local',
  interfaceKind: 'mcp',
  grants,
});

let root: string;
let runtime: DesktopCanopyDispatcher;
let reads = 0;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'core-config-git-'));
  reads = 0;
  runtime = createDesktopRuntime({
    operationAdapter: createCoreOperationAdapter({
      ledgerPath: () => join(root, 'ledger.sqlite'),
    }),
    configHost: {
      readGit: () => {
        reads += 1;
        return Promise.resolve(GIT);
      },
    },
    shutdownTimeoutMs: 25,
  });
});

afterEach(async () => {
  await runtime.shutdown();
  rmSync(root, { recursive: true, force: true });
});

describe('core.config.get on the desktop dispatcher (CAN-5992)', () => {
  it('serves the git namespace to a caller holding core.config.read', async () => {
    const result = await runtime.query(
      'core.config.get',
      { namespace: 'git' },
      { caller: caller([CONFIG_GRANTS.read]) },
    );
    expect(result).toEqual({
      namespace: 'git',
      scope: {},
      revision: expect.any(Number) as unknown,
      value: GIT,
      enforcedPaths: [],
    });
    const again = await runtime.query(
      'core.config.get',
      { namespace: 'git' },
      { caller: caller([CONFIG_GRANTS.read]) },
    );
    expect(again.revision).toBe(result.revision);
  });

  it('refuses a caller without core.config.read before the host is read', async () => {
    await expect(
      runtime.query(
        'core.config.get',
        { namespace: 'git' },
        { caller: caller(['core.config.write']) },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(reads).toBe(0);
  });

  it('refuses an unserved namespace and a scoped read without reading the host', async () => {
    await expect(
      runtime.query(
        'core.config.get',
        { namespace: 'chat.defaults' },
        { caller: caller([CONFIG_GRANTS.read]) },
      ),
    ).rejects.toMatchObject({
      payload: { kind: 'not_found', code: 'core.config.notFound' },
    });
    await expect(
      runtime.query(
        'core.config.get',
        { namespace: 'git', scope: { workspaceId: 'ws' } },
        { caller: caller([CONFIG_GRANTS.read]) },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    expect(reads).toBe(0);
  });
});

describe('the git namespace projection (CAN-5992)', () => {
  const preferences = (patch: Partial<PreferencesData>): PreferencesData => ({
    ...({} as PreferencesData),
    branchNamingInstructions: '  Use the ticket.  ',
    branchNamePrefixMode: 'none',
    branchNameCustomPrefix: '',
    prInstructions: '',
    prInstructionMode: 'append',
    commitInstructions: '',
    commitInstructionMode: 'append',
    ...patch,
  });

  it('resolves the prefix the tool printed before, and asks GitHub only in github mode', async () => {
    const github = jest.fn(() => Promise.resolve<string | null>('Octo Cat/'));
    await expect(
      projectGitPreferences(preferences({}), github),
    ).resolves.toMatchObject({
      branchName: {
        instructions: 'Use the ticket.',
        prefixMode: 'none',
        prefix: null,
      },
    });
    await expect(
      projectGitPreferences(
        preferences({
          branchNamePrefixMode: 'custom',
          branchNameCustomPrefix: ' team/x// ',
        }),
        github,
      ),
    ).resolves.toMatchObject({ branchName: { prefix: 'teamx/' } });
    expect(github).not.toHaveBeenCalled();
    await expect(
      projectGitPreferences(
        preferences({ branchNamePrefixMode: 'github' }),
        github,
      ),
    ).resolves.toMatchObject({ branchName: { prefix: 'OctoCat/' } });
    await expect(
      projectGitPreferences(
        preferences({ branchNamePrefixMode: 'github' }),
        () => Promise.resolve(null),
      ),
    ).resolves.toMatchObject({ branchName: { prefix: null } });
  });
});

describe('the desktop git host (CAN-5992)', () => {
  it('reads the GitHub login only through the retained gh auth status exec (execFileAsync)', async () => {
    mockPreferences.mockResolvedValue({
      branchNamingInstructions: '',
      branchNamePrefixMode: 'github',
      branchNameCustomPrefix: '',
      prInstructions: '',
      prInstructionMode: 'append',
      commitInstructions: '',
      commitInstructionMode: 'append',
    });
    mockGhStatus.mockResolvedValue({
      stdout: JSON.stringify({
        hosts: {
          'github.com': [
            {
              active: true,
              host: 'github.com',
              login: 'octo',
              tokenSource: 'keyring',
            },
          ],
        },
      }),
      stderr: '',
    });
    const get = createCoreConfigAdapter().queries?.['core.config.get'];
    if (!get) throw new Error('core.config.get is not served');
    const result = await get({ namespace: 'git' }, {} as never);
    expect(result.value).toMatchObject({
      branchName: { prefixMode: 'github', prefix: 'octo/' },
    });
    expect(mockGhStatus).toHaveBeenCalledTimes(1);
  });

  it('answers only the allowlisted git fields: no credential from preferences or the gh status gets through', async () => {
    mockPreferences.mockResolvedValue({
      branchNamingInstructions: 'Use the ticket.',
      branchNamePrefixMode: 'github',
      branchNameCustomPrefix: '',
      prInstructions: '',
      prInstructionMode: 'append',
      commitInstructions: '',
      commitInstructionMode: 'append',
      githubPersonalAccessToken: 'ghp_SECRET_FROM_PREFERENCES',
      mcpServers: [
        { headers: { Authorization: 'Bearer SECRET_HEADER_VALUE' } },
      ],
    });
    mockGhStatus.mockResolvedValue({
      stdout: JSON.stringify({
        hosts: {
          'github.com': [
            {
              active: true,
              host: 'github.com',
              login: 'octo',
              token: 'gho_SECRET_FROM_GH',
              tokenSource: '/Users/octo/.config/gh/hosts.yml',
              scopes: 'repo, SECRET_SCOPE',
            },
          ],
        },
      }),
      stderr: 'SECRET_STDERR',
    });
    const get = createCoreConfigAdapter().queries?.['core.config.get'];
    if (!get) throw new Error('core.config.get is not served');
    const result = await get({ namespace: 'git' }, {} as never);
    expect(result.value).toEqual({
      branchName: {
        instructions: 'Use the ticket.',
        prefixMode: 'github',
        prefix: 'octo/',
      },
      pullRequest: { instructions: expect.any(String) as unknown },
      commitMessage: { instructions: expect.any(String) as unknown },
    });
    const serialized = JSON.stringify(result);
    for (const secret of ['SECRET', 'hosts.yml', 'Bearer', 'ghp_', 'gho_'])
      expect(serialized).not.toContain(secret);
  });
});
