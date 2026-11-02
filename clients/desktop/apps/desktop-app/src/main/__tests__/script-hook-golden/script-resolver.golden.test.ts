jest.mock('../../lib/workspace-persistence', () => ({
  readWorkspaceConfig: jest.fn(),
}));
jest.mock('../../lib/repo-shadow', () => ({
  getBaselineReadPath: jest.fn((path: string) => Promise.resolve(path)),
}));

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { BRAND } from '@canopy/brand/current';
import type { WorkspaceConfigFile } from '@canopy/desktop-shared/types';
import { getProjectConfigFileCandidates } from '../../lib/canopy-json';
import { getBaselineReadPath } from '../../lib/repo-shadow';
import {
  collectProjectScriptLayers,
  collectWorkspaceRepoScriptLayers,
  collectWorkspaceRootScriptLayers,
  getResolvedScriptCommand,
  getResolvedScriptTimeoutSeconds,
  resolveProjectScripts,
  resolveWorkspaceRepoScripts,
  resolveWorkspaceRootScripts,
  toScriptOverrides,
  type ResolvedScriptField,
  type ResolvedScriptMap,
} from '../../lib/script-resolver';
import { readWorkspaceConfig } from '../../lib/workspace-persistence';

const mockedReadWorkspaceConfig = jest.mocked(readWorkspaceConfig);
const mockedGetBaselineReadPath = jest.mocked(getBaselineReadPath);

const [PRIMARY_CONFIG, FALLBACK_CONFIG] = getProjectConfigFileCandidates(
  '/fixture',
).map((path) => basename(path));
const LOCAL_LABEL = `${BRAND.displayName} Local Override`;

let root: string;

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function conductor(scripts: Record<string, unknown>): unknown {
  return { scripts };
}

function workspaceConfig(
  overrides: Partial<WorkspaceConfigFile> = {},
): WorkspaceConfigFile {
  return {
    version: 1,
    type: 'multi-repo',
    repos: [{ id: 'repo-a', name: 'Repo A', repoPath: join(root, 'repo-a') }],
    ...overrides,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'can-5062-resolver-'));
  jest.clearAllMocks();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('CAN-5062 golden: script source kinds', () => {
  it('names exactly ten source kinds, and toScriptOverrides keeps definitions and three disabled kinds', () => {
    const allKinds: ResolvedScriptField['source'][] = [
      'local-override',
      'local-disabled',
      'repo-conductor',
      'repo-canopy',
      'workspace-conductor',
      'workspace-manifest',
      'workspace-manifest-disabled',
      'workspace-hook',
      'workspace-hook-disabled',
      'none',
    ];
    const resolved: ResolvedScriptMap = Object.fromEntries(
      allKinds.map((source) => [
        `s-${source}`,
        source.endsWith('-disabled') || source === 'none'
          ? { source }
          : {
              definition: { command: `run ${source}` },
              value: `run ${source}`,
              source,
            },
      ]),
    );

    expect(toScriptOverrides(resolved)).toEqual({
      's-local-disabled': null,
      's-local-override': 'run local-override',
      's-repo-canopy': 'run repo-canopy',
      's-repo-conductor': 'run repo-conductor',
      's-workspace-conductor': 'run workspace-conductor',
      's-workspace-hook': 'run workspace-hook',
      's-workspace-hook-disabled': null,
      's-workspace-manifest': 'run workspace-manifest',
      's-workspace-manifest-disabled': null,
    });
    expect(toScriptOverrides({ only: { source: 'none' } })).toBeUndefined();
  });

  it('keeps a definition object with its timeout and interactive flag', () => {
    const resolved: ResolvedScriptMap = {
      launch: {
        definition: {
          command: 'pnpm dev',
          timeoutSeconds: 90,
          interactive: true,
        },
        value: 'pnpm dev',
        source: 'repo-canopy',
      },
    };
    expect(toScriptOverrides(resolved)).toEqual({
      launch: { command: 'pnpm dev', timeoutSeconds: 90, interactive: true },
    });
    expect(getResolvedScriptCommand(resolved, 'launch')).toBe('pnpm dev');
    expect(getResolvedScriptTimeoutSeconds(resolved, 'launch')).toBe(90);
    expect(getResolvedScriptCommand(resolved, 'missing')).toBeUndefined();
  });
});

describe('CAN-5062 golden: single-repo resolution', () => {
  it('layers repo config, local overrides and conductor fallbacks', async () => {
    const repo = join(root, 'repo');
    await writeJson(join(repo, PRIMARY_CONFIG), {
      version: 1,
      scripts: {
        setup: '  pnpm install  ',
        test: { command: 'pnpm test', timeoutSeconds: 120 },
        lint: 'pnpm lint',
      },
    });
    await writeJson(
      join(repo, 'conductor.json'),
      conductor({
        setup: 'conductor setup',
        run: ' conductor run ',
        archive: 'conductor archive',
        test: 'conductor test',
      }),
    );

    const resolved = await resolveProjectScripts({
      repoPath: repo,
      scripts: { lint: 'eslint .', teardown: null },
    });

    expect(resolved).toEqual({
      setup: {
        definition: { command: 'pnpm install' },
        value: 'pnpm install',
        source: 'repo-canopy',
      },
      test: {
        definition: { command: 'pnpm test', timeoutSeconds: 120 },
        value: 'pnpm test',
        source: 'repo-canopy',
      },
      lint: {
        definition: { command: 'eslint .' },
        value: 'eslint .',
        source: 'local-override',
      },
      teardown: { source: 'local-disabled' },
      launch: {
        definition: { command: 'conductor run' },
        value: 'conductor run',
        source: 'repo-conductor',
      },
    });
  });

  it('skips conductor.json when every lifecycle script is already resolved', async () => {
    const repo = join(root, 'repo');
    await writeJson(join(repo, PRIMARY_CONFIG), {
      version: 1,
      scripts: { setup: 'a', launch: 'b', teardown: 'c' },
    });
    await writeFile(join(repo, 'conductor.json'), '{ not json', 'utf8');

    const resolved = await resolveProjectScripts({ repoPath: repo });

    expect(toScriptOverrides(resolved)).toEqual({
      setup: 'a',
      launch: 'b',
      teardown: 'c',
    });
  });

  it('ignores invalid, blank and non-string conductor values', async () => {
    const repo = join(root, 'repo');
    await writeJson(
      join(repo, 'conductor.json'),
      conductor({ setup: '   ', run: 7, archive: 'cleanup' }),
    );
    expect(await resolveProjectScripts({ repoPath: repo })).toEqual({
      teardown: {
        definition: { command: 'cleanup' },
        value: 'cleanup',
        source: 'repo-conductor',
      },
    });

    await writeFile(join(repo, 'conductor.json'), '{ not json', 'utf8');
    expect(await resolveProjectScripts({ repoPath: repo })).toEqual({});

    await writeJson(join(repo, 'conductor.json'), { scripts: 'nope' });
    expect(await resolveProjectScripts({ repoPath: repo })).toEqual({});
  });

  it('reads the first existing config candidate and the override repo path', async () => {
    const repo = join(root, 'repo');
    const override = join(root, 'override');
    await writeJson(join(repo, PRIMARY_CONFIG), {
      version: 1,
      scripts: { build: 'primary' },
    });
    await writeJson(join(repo, FALLBACK_CONFIG), {
      version: 1,
      scripts: { build: 'fallback', extra: 'fallback only' },
    });
    await writeJson(join(override, FALLBACK_CONFIG), {
      version: 1,
      scripts: { build: 'override fallback' },
    });

    expect(
      toScriptOverrides(await resolveProjectScripts({ repoPath: repo })),
    ).toEqual({ build: 'primary' });
    expect(
      toScriptOverrides(
        await resolveProjectScripts({ repoPath: repo }, override),
      ),
    ).toEqual({ build: 'override fallback' });
  });

  it('refuses a null top-level manifest script, so workspace-hook-disabled is never produced', async () => {
    const repo = join(root, 'repo');
    await writeJson(join(repo, PRIMARY_CONFIG), {
      version: 1,
      scripts: { setup: null },
    });
    await expect(resolveProjectScripts({ repoPath: repo })).rejects.toThrow(
      'script "setup" must be a string or script object',
    );
    await expect(
      resolveWorkspaceRootScripts('ws-1', {
        workspaceRootPath: repo,
        localConfig: workspaceConfig(),
      }),
    ).rejects.toThrow('script "setup" must be a string or script object');
  });
});

describe('CAN-5062 golden: workspace resolution', () => {
  async function writeWorkspaceFixture(): Promise<{
    workspaceRoot: string;
    repoA: string;
  }> {
    const workspaceRoot = join(root, 'workspace-root');
    const repoA = join(root, 'repo-a');
    await writeJson(join(workspaceRoot, PRIMARY_CONFIG), {
      version: 1,
      scripts: { setup: 'root setup', 'root-only': 'root only' },
      repos: [
        {
          id: 'repo-a',
          name: 'Repo A',
          url: 'https://example.com/repo-a.git',
          scripts: {
            build: 'manifest build',
            lint: null,
            test: { command: 'manifest test', timeoutSeconds: 30 },
          },
        },
      ],
    });
    await writeJson(
      join(workspaceRoot, 'conductor.json'),
      conductor({ run: 'root run', archive: 'root archive' }),
    );
    await writeJson(join(repoA, PRIMARY_CONFIG), {
      version: 1,
      scripts: {
        build: 'repo build',
        lint: 'repo lint',
        test: 'repo test',
        format: 'repo format',
        setup: 'repo setup',
      },
    });
    await writeJson(
      join(repoA, 'conductor.json'),
      conductor({ setup: 'repo conductor setup', run: 'repo run' }),
    );
    return { workspaceRoot, repoA };
  }

  it('layers repo config, workspace manifest, local overrides and repo conductor', async () => {
    const { workspaceRoot } = await writeWorkspaceFixture();
    const localConfig = workspaceConfig({
      repos: [
        {
          id: 'repo-a',
          name: 'Repo A',
          repoPath: join(root, 'repo-a'),
          scripts: { format: null, test: 'local test' },
        },
      ],
    });

    const resolved = await resolveWorkspaceRepoScripts('ws-1', 'repo-a', {
      workspaceRootPath: workspaceRoot,
      localConfig,
    });

    expect(resolved).toEqual({
      build: {
        definition: { command: 'manifest build' },
        value: 'manifest build',
        source: 'workspace-manifest',
      },
      lint: { source: 'workspace-manifest-disabled' },
      test: {
        definition: { command: 'local test' },
        value: 'local test',
        source: 'local-override',
      },
      format: { source: 'local-disabled' },
      setup: {
        definition: { command: 'repo setup' },
        value: 'repo setup',
        source: 'repo-canopy',
      },
      launch: {
        definition: { command: 'repo run' },
        value: 'repo run',
        source: 'repo-conductor',
      },
    });
    expect(mockedReadWorkspaceConfig).not.toHaveBeenCalled();
  });

  it('uses the persisted config and a repo path override, and refuses an unknown repo', async () => {
    const { workspaceRoot } = await writeWorkspaceFixture();
    const alternate = join(root, 'alternate-checkout');
    await writeJson(join(alternate, FALLBACK_CONFIG), {
      version: 1,
      scripts: { build: 'alternate build' },
    });
    mockedReadWorkspaceConfig.mockResolvedValue(
      workspaceConfig({ sourceRepoPath: workspaceRoot }),
    );

    const resolved = await resolveWorkspaceRepoScripts('ws-1', 'repo-a', {
      repoPath: alternate,
    });

    expect(mockedReadWorkspaceConfig).toHaveBeenCalledWith('ws-1');
    expect(mockedGetBaselineReadPath).toHaveBeenCalledWith(workspaceRoot);
    expect(toScriptOverrides(resolved)).toEqual({
      build: 'manifest build',
      lint: null,
      test: { command: 'manifest test', timeoutSeconds: 30 },
    });
    await expect(
      resolveWorkspaceRepoScripts('ws-1', 'missing-repo'),
    ).rejects.toThrow('Repo missing-repo not found in project ws-1');
  });

  it('layers the workspace root manifest, local overrides and workspace conductor', async () => {
    const { workspaceRoot } = await writeWorkspaceFixture();
    const localConfig = workspaceConfig({
      scripts: { 'root-only': null, deploy: 'local deploy' },
    });

    const resolved = await resolveWorkspaceRootScripts('ws-1', {
      workspaceRootPath: workspaceRoot,
      localConfig,
    });

    expect(resolved).toEqual({
      setup: {
        definition: { command: 'root setup' },
        value: 'root setup',
        source: 'workspace-hook',
      },
      'root-only': { source: 'local-disabled' },
      deploy: {
        definition: { command: 'local deploy' },
        value: 'local deploy',
        source: 'local-override',
      },
      launch: {
        definition: { command: 'root run' },
        value: 'root run',
        source: 'workspace-conductor',
      },
      teardown: {
        definition: { command: 'root archive' },
        value: 'root archive',
        source: 'workspace-conductor',
      },
    });
  });

  it('reads the root through the baseline path, and skips conductor without a root', async () => {
    const { workspaceRoot } = await writeWorkspaceFixture();
    mockedReadWorkspaceConfig.mockResolvedValue(
      workspaceConfig({ sourceRepoPath: workspaceRoot }),
    );
    const viaBaseline = await resolveWorkspaceRootScripts('ws-1');
    expect(mockedGetBaselineReadPath).toHaveBeenCalledWith(workspaceRoot);
    expect(toScriptOverrides(viaBaseline)).toEqual({
      'root-only': 'root only',
      setup: 'root setup',
      launch: 'root run',
      teardown: 'root archive',
    });

    mockedReadWorkspaceConfig.mockResolvedValue(
      workspaceConfig({ scripts: { setup: 'local only' } }),
    );
    expect(await resolveWorkspaceRootScripts('ws-1')).toEqual({
      setup: {
        definition: { command: 'local only' },
        value: 'local only',
        source: 'local-override',
      },
    });
  });
});

describe('CAN-5062 golden: script source layers', () => {
  it('marks the effective project layer, and a fallback config never wins over conductor', async () => {
    const repo = join(root, 'repo');
    await writeJson(join(repo, PRIMARY_CONFIG), {
      version: 1,
      scripts: { setup: 'primary setup' },
    });
    await writeJson(join(repo, FALLBACK_CONFIG), {
      version: 1,
      scripts: { setup: 'fallback setup', launch: 'fallback launch' },
    });
    await writeJson(
      join(repo, 'conductor.json'),
      conductor({ setup: 'conductor setup', run: 'conductor run' }),
    );

    expect(
      await collectProjectScriptLayers(
        { repoPath: repo, scripts: { setup: null } },
        'setup',
      ),
    ).toEqual([
      {
        sourceKey: 'local-override',
        sourceLabel: LOCAL_LABEL,
        command: null,
        status: 'disabled',
      },
      {
        sourceKey: `repo-canopy:${PRIMARY_CONFIG}`,
        sourceLabel: PRIMARY_CONFIG,
        command: 'primary setup',
        status: 'overridden',
      },
      {
        sourceKey: `repo-canopy:${FALLBACK_CONFIG}`,
        sourceLabel: `${FALLBACK_CONFIG} (overridden fallback)`,
        command: 'fallback setup',
        status: 'overridden',
      },
      {
        sourceKey: 'repo-conductor',
        sourceLabel: 'conductor.json',
        command: 'conductor setup',
        status: 'overridden',
      },
    ]);

    expect(
      await collectProjectScriptLayers({ repoPath: repo }, 'launch'),
    ).toEqual([
      {
        sourceKey: `repo-canopy:${PRIMARY_CONFIG}`,
        sourceLabel: `${PRIMARY_CONFIG} (used config)`,
        command: null,
        status: 'absent',
      },
      {
        sourceKey: `repo-canopy:${FALLBACK_CONFIG}`,
        sourceLabel: `${FALLBACK_CONFIG} (overridden fallback)`,
        command: 'fallback launch',
        status: 'overridden',
      },
      {
        sourceKey: 'repo-conductor',
        sourceLabel: 'conductor.json',
        command: 'conductor run',
        status: 'active',
      },
    ]);
  });

  it('reports a missing primary candidate and reads conductor only for lifecycle scripts', async () => {
    const repo = join(root, 'repo');
    await writeJson(join(repo, FALLBACK_CONFIG), {
      version: 1,
      scripts: { lint: { command: 'pnpm lint', timeoutSeconds: 5 } },
    });
    await writeJson(join(repo, 'conductor.json'), conductor({ lint: 'x' }));

    expect(
      await collectProjectScriptLayers(
        { repoPath: join(root, 'other'), scripts: {} },
        'lint',
        repo,
      ),
    ).toEqual([
      {
        sourceKey: `repo-canopy:${PRIMARY_CONFIG}`,
        sourceLabel: `${PRIMARY_CONFIG} (not found)`,
        command: null,
        status: 'absent',
      },
      {
        sourceKey: `repo-canopy:${FALLBACK_CONFIG}`,
        sourceLabel: FALLBACK_CONFIG,
        command: 'pnpm lint',
        status: 'active',
      },
    ]);
    expect(
      await collectProjectScriptLayers({ repoPath: repo }, 'nope'),
    ).toEqual([]);
  });

  it('collects workspace root layers with and without a root path', async () => {
    const workspaceRoot = join(root, 'workspace-root');
    await writeJson(join(workspaceRoot, PRIMARY_CONFIG), {
      version: 1,
      scripts: { launch: 'root launch' },
    });
    await writeJson(
      join(workspaceRoot, 'conductor.json'),
      conductor({ run: 'conductor run' }),
    );
    mockedReadWorkspaceConfig.mockResolvedValue(
      workspaceConfig({ scripts: { launch: 'local launch' } }),
    );

    expect(
      await collectWorkspaceRootScriptLayers('ws-1', 'launch', {
        workspaceRootPath: workspaceRoot,
      }),
    ).toEqual([
      {
        sourceKey: 'local-override',
        sourceLabel: LOCAL_LABEL,
        command: 'local launch',
        status: 'active',
      },
      {
        sourceKey: `workspace-hook:${PRIMARY_CONFIG}`,
        sourceLabel: `${PRIMARY_CONFIG} (project)`,
        command: 'root launch',
        status: 'overridden',
      },
      {
        sourceKey: 'workspace-conductor',
        sourceLabel: 'conductor.json',
        command: 'conductor run',
        status: 'overridden',
      },
    ]);

    mockedReadWorkspaceConfig.mockResolvedValue(workspaceConfig());
    expect(await collectWorkspaceRootScriptLayers('ws-1', 'launch')).toEqual(
      [],
    );
  });

  it('collects workspace repo layers in precedence order', async () => {
    const workspaceRoot = join(root, 'workspace-root');
    const repoA = join(root, 'repo-a');
    await writeJson(join(workspaceRoot, FALLBACK_CONFIG), {
      version: 1,
      repos: [
        {
          id: 'repo-a',
          name: 'Repo A',
          url: 'https://example.com/repo-a.git',
          scripts: { teardown: null },
        },
      ],
    });
    await writeJson(join(repoA, PRIMARY_CONFIG), {
      version: 1,
      scripts: { teardown: 'repo teardown' },
    });
    await writeJson(
      join(repoA, 'conductor.json'),
      conductor({ archive: 'conductor archive' }),
    );
    mockedReadWorkspaceConfig.mockResolvedValue(
      workspaceConfig({ sourceRepoPath: workspaceRoot }),
    );

    expect(
      await collectWorkspaceRepoScriptLayers('ws-1', 'repo-a', 'teardown'),
    ).toEqual([
      {
        sourceKey: `workspace-manifest:${PRIMARY_CONFIG}`,
        sourceLabel: `${PRIMARY_CONFIG} (project manifest) (not found)`,
        command: null,
        status: 'absent',
      },
      {
        sourceKey: `workspace-manifest:${FALLBACK_CONFIG}`,
        sourceLabel: `${FALLBACK_CONFIG} (project manifest)`,
        command: null,
        status: 'disabled',
      },
      {
        sourceKey: `repo-canopy:${PRIMARY_CONFIG}`,
        sourceLabel: PRIMARY_CONFIG,
        command: 'repo teardown',
        status: 'overridden',
      },
      {
        sourceKey: 'repo-conductor',
        sourceLabel: 'conductor.json',
        command: 'conductor archive',
        status: 'overridden',
      },
    ]);
    expect(mockedGetBaselineReadPath).toHaveBeenCalledWith(workspaceRoot);
  });
});
