jest.mock('../lib/canopy-json', () => ({
  readCanopyJson: jest.fn(),
  getProjectConfigFileCandidates: jest.fn(() => [
    '/repo/unstoppable-code.json',
    '/repo/canopy.json',
  ]),
  validateCanopyJson: jest.fn((value: unknown) => value),
  getManifestRepoById: jest.fn(
    (manifest: { repos?: Array<{ id: string }> }, repoId: string) =>
      manifest.repos?.find((repo) => repo.id === repoId),
  ),
}));
jest.mock('node:fs/promises', () => ({
  readFile: jest.fn(),
}));
jest.mock('../lib/conductor-json', () => ({
  readConductorJson: jest.fn(),
}));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfig: jest.fn(),
}));

import type {
  CanopyJsonFile,
  WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import { readFile } from 'node:fs/promises';
import {
  getProjectConfigFileCandidates,
  readCanopyJson,
  validateCanopyJson,
} from '../lib/canopy-json';
import { readConductorJson } from '../lib/conductor-json';
import {
  collectProjectScriptLayers,
  getResolvedScriptDefinition,
  getResolvedScriptTimeoutSeconds,
  resolveProjectScripts,
  resolveWorkspaceRepoScripts,
  resolveWorkspaceRootScripts,
  toScriptOverrides,
} from '../lib/script-resolver';
import { readWorkspaceConfig } from '../lib/workspace-persistence';

const mockedReadFile = jest.mocked(readFile);
const mockedGetProjectConfigFileCandidates = jest.mocked(
  getProjectConfigFileCandidates,
);
const mockedValidateCanopyJson = jest.mocked(validateCanopyJson);
const mockedReadCanopyJson = jest.mocked(readCanopyJson);
const mockedReadConductorJson = jest.mocked(readConductorJson);
const mockedReadWorkspaceConfig = jest.mocked(readWorkspaceConfig);

function missingFile(path: string): Error & { code: string } {
  return Object.assign(
    new Error(`ENOENT: no such file or directory, open '${path}'`),
    { code: 'ENOENT' },
  );
}

function buildWorkspaceConfigFile(
  overrides: Partial<WorkspaceConfigFile> = {},
): WorkspaceConfigFile {
  return {
    version: 1,
    type: 'multi-repo',
    repos: [
      {
        id: 'repo-a',
        name: 'Repo A',
        repoPath: '/repos/repo-a',
      },
    ],
    sourceRepoPath: '/repos/workspace-root',
    ...overrides,
  };
}

function buildWorkspaceManifest(
  overrides: Partial<CanopyJsonFile> = {},
): CanopyJsonFile {
  return {
    version: 1,
    repos: [
      {
        id: 'repo-a',
        name: 'Repo A',
        url: 'https://example.com/repo-a.git',
      },
    ],
    ...overrides,
  };
}

describe('script resolver conductor fallbacks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetProjectConfigFileCandidates.mockReturnValue([
      '/repo/unstoppable-code.json',
      '/repo/canopy.json',
    ]);
    mockedValidateCanopyJson.mockImplementation(
      (value: unknown) => value as CanopyJsonFile,
    );
    mockedReadFile.mockRejectedValue(missingFile('/missing'));
    mockedReadCanopyJson.mockResolvedValue(null);
    mockedReadConductorJson.mockResolvedValue(null);
    mockedReadWorkspaceConfig.mockResolvedValue(buildWorkspaceConfigFile());
  });

  it('fills missing single-repo lifecycle scripts from conductor.json', async () => {
    mockedReadCanopyJson.mockResolvedValue({
      version: 1,
      scripts: { setup: 'npm install' },
    });
    mockedReadConductorJson.mockResolvedValue({
      launch: 'npm run dev',
    });

    const resolved = await resolveProjectScripts({
      repoPath: '/repo',
      scripts: undefined,
    });

    expect(toScriptOverrides(resolved)).toEqual({
      setup: 'npm install',
      launch: 'npm run dev',
    });
    expect(resolved.launch).toEqual({
      definition: { command: 'npm run dev' },
      value: 'npm run dev',
      source: 'repo-conductor',
    });
  });

  it('keeps canopy values over conductor on overlapping keys', async () => {
    mockedReadCanopyJson.mockResolvedValue({
      version: 1,
      scripts: {
        launch: 'npm run app',
      },
    });
    mockedReadConductorJson.mockResolvedValue({
      launch: 'npm start',
      teardown: 'npm run clean',
    });

    const resolved = await resolveProjectScripts({
      repoPath: '/repo',
      scripts: undefined,
    });

    expect(toScriptOverrides(resolved)).toEqual({
      launch: 'npm run app',
      teardown: 'npm run clean',
    });
    expect(resolved.launch).toEqual({
      definition: { command: 'npm run app' },
      value: 'npm run app',
      source: 'repo-canopy',
    });
  });

  it('keeps local overrides above canopy and conductor', async () => {
    mockedReadCanopyJson.mockResolvedValue({
      version: 1,
      scripts: { launch: 'npm run app' },
    });
    mockedReadConductorJson.mockResolvedValue({
      launch: 'npm start',
    });

    const resolved = await resolveProjectScripts({
      repoPath: '/repo',
      scripts: { launch: 'pnpm dev' },
    });

    expect(toScriptOverrides(resolved)).toEqual({
      launch: 'pnpm dev',
    });
    expect(resolved.launch).toEqual({
      definition: { command: 'pnpm dev' },
      value: 'pnpm dev',
      source: 'local-override',
    });
  });

  it('can resolve single-repo scripts from a worktree checkout path', async () => {
    mockedReadCanopyJson.mockImplementation((repoPath: string) => {
      if (repoPath === '/repo/worktrees/wt-1') {
        return Promise.resolve({
          version: 1,
          scripts: { setup: 'pnpm install' },
        });
      }

      return Promise.resolve(null);
    });
    mockedReadConductorJson.mockImplementation((repoPath: string) => {
      if (repoPath === '/repo/worktrees/wt-1') {
        return Promise.resolve({
          launch: 'pnpm dev',
        });
      }

      return Promise.resolve(null);
    });

    const resolved = await resolveProjectScripts(
      {
        repoPath: '/repo',
        scripts: undefined,
      },
      '/repo/worktrees/wt-1',
    );

    expect(toScriptOverrides(resolved)).toEqual({
      setup: 'pnpm install',
      launch: 'pnpm dev',
    });
    expect(resolved.setup).toEqual({
      definition: { command: 'pnpm install' },
      value: 'pnpm install',
      source: 'repo-canopy',
    });
    expect(resolved.launch).toEqual({
      definition: { command: 'pnpm dev' },
      value: 'pnpm dev',
      source: 'repo-conductor',
    });
  });

  it('keeps project manifest null overrides above conductor for project repos', async () => {
    mockedReadCanopyJson.mockImplementation((repoPath: string) => {
      if (repoPath === '/repos/workspace-root') {
        return Promise.resolve(
          buildWorkspaceManifest({
            repos: [
              {
                id: 'repo-a',
                name: 'Repo A',
                url: 'https://example.com/repo-a.git',
                scripts: { launch: null },
              },
            ],
          }),
        );
      }

      return Promise.resolve(null);
    });
    mockedReadConductorJson.mockResolvedValue({
      launch: 'npm run dev',
    });

    const resolved = await resolveWorkspaceRepoScripts('ws-1', 'repo-a');

    expect(toScriptOverrides(resolved)).toEqual({
      launch: null,
    });
    expect(resolved.launch).toEqual({
      source: 'workspace-manifest-disabled',
    });
  });

  it('supports partial overlap across project repo sources', async () => {
    mockedReadCanopyJson.mockImplementation((repoPath: string) => {
      if (repoPath === '/repos/workspace-root') {
        return Promise.resolve(
          buildWorkspaceManifest({
            repos: [
              {
                id: 'repo-a',
                name: 'Repo A',
                url: 'https://example.com/repo-a.git',
                scripts: { launch: 'npm run project' },
              },
            ],
          }),
        );
      }

      if (repoPath === '/repos/repo-a') {
        return Promise.resolve({
          version: 1,
          scripts: { setup: 'npm install' },
        });
      }

      return Promise.resolve(null);
    });
    mockedReadConductorJson.mockResolvedValue({
      launch: 'npm run dev',
      teardown: 'npm run clean',
    });

    const resolved = await resolveWorkspaceRepoScripts('ws-1', 'repo-a');

    expect(toScriptOverrides(resolved)).toEqual({
      setup: 'npm install',
      launch: 'npm run project',
      teardown: 'npm run clean',
    });
  });

  it('uses a supplied project config snapshot instead of rereading it', async () => {
    const configSnapshot = buildWorkspaceConfigFile({
      repos: [
        {
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/repos/repo-a',
          scripts: { setup: 'pnpm install' },
        },
      ],
    });
    mockedReadWorkspaceConfig.mockRejectedValue(
      new Error('project config changed during load'),
    );

    const resolved = await resolveWorkspaceRepoScripts('ws-1', 'repo-a', {
      localConfig: configSnapshot,
    });

    expect(toScriptOverrides(resolved)).toEqual({
      setup: 'pnpm install',
    });
    expect(mockedReadWorkspaceConfig).not.toHaveBeenCalled();
  });

  it('fills workspace-root lifecycle scripts from conductor without affecting before/after hooks', async () => {
    mockedReadCanopyJson.mockImplementation((repoPath: string) => {
      if (repoPath === '/repos/workspace-root') {
        return Promise.resolve(
          buildWorkspaceManifest({
            scripts: {
              'before-launch': 'npm run prepare',
            },
          }),
        );
      }

      return Promise.resolve(null);
    });
    mockedReadConductorJson.mockResolvedValue({
      launch: 'npm run dev',
      teardown: 'npm run clean',
    });

    const resolved = await resolveWorkspaceRootScripts('ws-1');

    expect(toScriptOverrides(resolved)).toEqual({
      'before-launch': 'npm run prepare',
      launch: 'npm run dev',
      teardown: 'npm run clean',
    });
    expect(resolved.launch).toEqual({
      definition: { command: 'npm run dev' },
      value: 'npm run dev',
      source: 'workspace-conductor',
    });
  });

  it('preserves script definitions and timeout metadata across resolution', async () => {
    mockedReadCanopyJson.mockResolvedValue({
      version: 1,
      scripts: {
        setup: {
          command: 'npm install',
          timeoutSeconds: 1200,
        },
      },
    });

    const resolved = await resolveProjectScripts({
      repoPath: '/repo',
      scripts: {
        setup: {
          command: 'pnpm install',
          timeoutSeconds: null,
        },
      },
    });

    expect(getResolvedScriptDefinition(resolved, 'setup')).toEqual({
      command: 'pnpm install',
      timeoutSeconds: null,
    });
    expect(getResolvedScriptTimeoutSeconds(resolved, 'setup')).toBeNull();
    expect(toScriptOverrides(resolved)).toEqual({
      setup: {
        command: 'pnpm install',
        timeoutSeconds: null,
      },
    });
  });

  it('shows the branded project config as the active source over fallback config files', async () => {
    mockedReadFile.mockImplementation((filePath: unknown) => {
      if (filePath === '/repo/unstoppable-code.json') {
        return Promise.resolve(
          JSON.stringify({
            version: 1,
            scripts: { launch: 'npm run branded' },
          }),
        );
      }
      if (filePath === '/repo/canopy.json') {
        return Promise.resolve(
          JSON.stringify({
            version: 1,
            scripts: { launch: 'npm run legacy' },
          }),
        );
      }
      return Promise.reject(missingFile(String(filePath)));
    });

    const layers = await collectProjectScriptLayers(
      { repoPath: '/repo', scripts: undefined },
      'launch',
    );

    expect(layers).toEqual([
      {
        sourceKey: 'repo-canopy:unstoppable-code.json',
        sourceLabel: 'unstoppable-code.json',
        command: 'npm run branded',
        status: 'active',
      },
      {
        sourceKey: 'repo-canopy:canopy.json',
        sourceLabel: 'canopy.json (overridden fallback)',
        command: 'npm run legacy',
        status: 'overridden',
      },
    ]);
  });

  it('shows fallback config as active when higher-priority branded config is missing', async () => {
    mockedReadFile.mockImplementation((filePath: unknown) => {
      if (filePath === '/repo/unstoppable-code.json') {
        return Promise.reject(missingFile(String(filePath)));
      }
      if (filePath === '/repo/canopy.json') {
        return Promise.resolve(
          JSON.stringify({
            version: 1,
            scripts: { launch: 'npm run legacy' },
          }),
        );
      }
      return Promise.reject(missingFile(String(filePath)));
    });

    const layers = await collectProjectScriptLayers(
      { repoPath: '/repo', scripts: undefined },
      'launch',
    );

    expect(layers).toEqual([
      {
        sourceKey: 'repo-canopy:unstoppable-code.json',
        sourceLabel: 'unstoppable-code.json (not found)',
        command: null,
        status: 'absent',
      },
      {
        sourceKey: 'repo-canopy:canopy.json',
        sourceLabel: 'canopy.json',
        command: 'npm run legacy',
        status: 'active',
      },
    ]);
  });

  it('shows fallback config scripts as overridden when the primary config exists without the script', async () => {
    mockedReadFile.mockImplementation((filePath: unknown) => {
      if (filePath === '/repo/unstoppable-code.json') {
        return Promise.resolve(
          JSON.stringify({
            version: 1,
            scripts: { setup: 'npm install' },
          }),
        );
      }
      if (filePath === '/repo/canopy.json') {
        return Promise.resolve(
          JSON.stringify({
            version: 1,
            scripts: { launch: 'npm run legacy' },
          }),
        );
      }
      return Promise.reject(missingFile(String(filePath)));
    });

    const layers = await collectProjectScriptLayers(
      { repoPath: '/repo', scripts: undefined },
      'launch',
    );

    expect(layers).toEqual([
      {
        sourceKey: 'repo-canopy:unstoppable-code.json',
        sourceLabel: 'unstoppable-code.json (used config)',
        command: null,
        status: 'absent',
      },
      {
        sourceKey: 'repo-canopy:canopy.json',
        sourceLabel: 'canopy.json (overridden fallback)',
        command: 'npm run legacy',
        status: 'overridden',
      },
    ]);
  });
});
