import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  bindConfiguredPromptFilesystemDispatcher,
  resolveConfiguredPrompt,
} from '../lib/configured-prompt-resolution';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import {
  loadShareablePluginCatalog,
  resolveShareablePluginRefs,
} from '../plugins/shareable-plugin-resolution';
import { isConfiguredPromptPluginUsable } from '../plugins/plugin-resolver';

jest.mock('../plugins/shareable-plugin-resolution', () => ({
  loadShareablePluginCatalog: jest.fn(),
  resolveShareablePluginRefs: jest.fn(),
}));
jest.mock('../plugins/plugin-resolver', () => ({
  isConfiguredPromptPluginUsable: jest.fn(),
}));

jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(),
}));

import { resolveWorktreeCwd } from '../lib/resolve-worktree';

const mockedCwd = jest.mocked(resolveWorktreeCwd);
const mockedCatalog = jest.mocked(loadShareablePluginCatalog);
const mockedPortableResolution = jest.mocked(resolveShareablePluginRefs);
const mockedPluginUsable = jest.mocked(isConfiguredPromptPluginUsable);

describe('configured prompt execution references', () => {
  let root: string;
  beforeEach(async (): Promise<void> => {
    root = await mkdtemp(join(tmpdir(), 'configured-prompt-'));
    mockedCwd.mockReturnValue(root);
    mockedCatalog.mockResolvedValue({ skills: [], marketplaces: [] });
    mockedPluginUsable.mockResolvedValue(true);
    bindConfiguredPromptFilesystemDispatcher({
      queryFileTreeRootsForLegacyIpc: jest.fn().mockImplementation(
        (): Promise<unknown> =>
          Promise.resolve({
            canonicalResult: { roots: [] },
            legacyResult: {
              roots: [
                {
                  repoId: 'workspace',
                  repoName: 'Workspace',
                  absolutePath: root,
                  rootKind: 'git-repo',
                },
              ],
            },
          }),
      ),
    } satisfies Pick<
      DesktopCanopyDispatcher,
      'queryFileTreeRootsForLegacyIpc'
    >);
  });
  afterEach(async (): Promise<void> => {
    bindConfiguredPromptFilesystemDispatcher(null);
    await rm(root, { recursive: true, force: true });
  });

  it('binds the exact occurrence and shifts its offset after variable expansion', async (): Promise<void> => {
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'docs', 'a.txt'), 'hello');
    const prompt = 'Hello {{NAME}} docs/a.txt and docs/a.txt';
    const result = await resolveConfiguredPrompt({
      projectId: 'project',
      worktreeId: 'worktree',
      prompt,
      promptReferences: [
        {
          kind: 'file',
          root: { kind: 'workspace' },
          relativePath: 'docs/a.txt',
          displayText: 'docs/a.txt',
          textStart: prompt.lastIndexOf('docs/a.txt'),
        },
      ],
      interpolateText: (text): string =>
        text.replace('{{NAME}}', 'longer name'),
    });
    expect(result.prompt).toBe('Hello longer name docs/a.txt and docs/a.txt');
    expect(result.fileReferences).toEqual([
      {
        displayPath: 'docs/a.txt',
        absolutePath: join(root, 'docs', 'a.txt'),
        textStart: result.prompt.lastIndexOf('docs/a.txt'),
      },
    ]);
  });

  it('fails missing and escaping symlink targets before dispatch', async (): Promise<void> => {
    const outside = await mkdtemp(join(tmpdir(), 'configured-prompt-outside-'));
    try {
      await writeFile(join(outside, 'secret.txt'), 'secret');
      await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'));
      const reference = {
        kind: 'file' as const,
        root: { kind: 'workspace' as const },
        relativePath: 'escape.txt',
        displayText: 'escape.txt',
        textStart: 0,
      };
      await expect(
        resolveConfiguredPrompt({
          projectId: 'project',
          worktreeId: 'worktree',
          prompt: 'escape.txt',
          promptReferences: [reference],
        }),
      ).rejects.toThrow('escapes its root');
      await expect(
        resolveConfiguredPrompt({
          projectId: 'project',
          worktreeId: 'worktree',
          prompt: 'missing.txt',
          promptReferences: [
            {
              ...reference,
              relativePath: 'missing.txt',
              displayText: 'missing.txt',
            },
          ],
        }),
      ).rejects.toThrow('missing');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('fails unavailable installed and portable plugin pills before dispatch', async (): Promise<void> => {
    await expect(
      resolveConfiguredPrompt({
        projectId: 'project',
        worktreeId: 'worktree',
        prompt: 'plugin',
        promptReferences: [
          {
            kind: 'plugin',
            plugin: {
              kind: 'installed',
              marketplaceId: 'missing',
              pluginName: 'plugin',
            },
            displayText: 'plugin',
            textStart: 0,
          },
        ],
      }),
    ).rejects.toThrow('Referenced plugin is unavailable');

    const portableRef = {
      type: 'claude_plugin' as const,
      marketplace: { type: 'builtin' as const, id: 'app' },
      plugin_name: 'plugin',
    };
    mockedPortableResolution.mockReturnValueOnce([
      {
        matchState: 'unmatched',
        ref: portableRef,
        displayName: 'plugin',
        displaySource: 'Built in',
      },
    ]);
    await expect(
      resolveConfiguredPrompt({
        projectId: 'project',
        worktreeId: 'worktree',
        prompt: 'plugin',
        promptReferences: [
          {
            kind: 'plugin',
            plugin: { kind: 'portable', ref: portableRef },
            displayText: 'plugin',
            textStart: 0,
          },
        ],
      }),
    ).rejects.toThrow('Referenced plugin is unavailable');
  });

  it('rejects an installed pill whose catalog entry has no installed files', async (): Promise<void> => {
    mockedPluginUsable.mockResolvedValueOnce(false);
    mockedCatalog.mockResolvedValueOnce({
      skills: [],
      marketplaces: [
        {
          id: 'stale-market',
          name: 'Stale Market',
          description: '',
          sourceType: 'local',
          sourceUrl: '',
          installLocation: join(root, 'missing-market'),
          pluginCount: 1,
          validProviders: ['claude'],
          providerStatus: {
            claude: {
              provider: 'claude',
              state: 'valid',
              accepted: true,
              pluginCount: 1,
              lastCheckedAt: '2026-09-23T00:00:00.000Z',
            },
          },
          plugins: [
            {
              name: 'stale-plugin',
              marketplaceId: 'stale-market',
              sourcePath: join(root, 'missing-plugin'),
              providerSupport: { claude: 'native', codex: 'none' },
              facets: {
                claude: {
                  provider: 'claude',
                  mode: 'native',
                  name: 'stale-plugin',
                  installLocation: join(root, 'missing-plugin'),
                  sourcePath: join(root, 'missing-plugin'),
                },
              },
            },
          ],
        },
      ],
    });
    await expect(
      resolveConfiguredPrompt({
        projectId: 'project',
        worktreeId: 'worktree',
        providerType: 'claude',
        prompt: 'stale-plugin',
        promptReferences: [
          {
            kind: 'plugin',
            plugin: {
              kind: 'installed',
              marketplaceId: 'stale-market',
              pluginName: 'stale-plugin',
            },
            displayText: 'stale-plugin',
            textStart: 0,
          },
        ],
      }),
    ).rejects.toThrow('Referenced plugin is unavailable');
  });

  it('resolves repeated portable plugin occurrences from one catalog match', async (): Promise<void> => {
    const portableRef = {
      type: 'claude_plugin' as const,
      marketplace: { type: 'builtin' as const, id: 'app' },
      plugin_name: 'plugin',
    };
    const otherRef = { ...portableRef, plugin_name: 'other' };
    mockedPortableResolution.mockReturnValueOnce([
      {
        matchState: 'matched',
        ref: portableRef,
        displayName: 'plugin',
        displaySource: 'Built in',
        selection: {
          kind: 'plugin',
          marketplaceId: 'app',
          pluginName: 'plugin',
        },
      },
      {
        matchState: 'matched',
        ref: otherRef,
        displayName: 'other',
        displaySource: 'Built in',
        selection: {
          kind: 'plugin',
          marketplaceId: 'app',
          pluginName: 'other',
        },
      },
    ]);
    const result = await resolveConfiguredPrompt({
      projectId: 'project',
      worktreeId: 'worktree',
      providerType: 'claude',
      prompt: 'plugin and plugin and other',
      promptReferences: [0, 11]
        .map((textStart) => ({
          kind: 'plugin' as const,
          plugin: { kind: 'portable' as const, ref: portableRef },
          displayText: 'plugin',
          textStart,
        }))
        .concat([
          {
            kind: 'plugin',
            plugin: { kind: 'portable', ref: otherRef },
            displayText: 'other',
            textStart: 22,
          },
        ]),
    });
    expect(result.fileReferences).toHaveLength(3);
    expect(result.referencedPluginSelections?.pluginRefs).toEqual([
      { kind: 'plugin', marketplaceId: 'app', pluginName: 'plugin' },
      { kind: 'plugin', marketplaceId: 'app', pluginName: 'plugin' },
      { kind: 'plugin', marketplaceId: 'app', pluginName: 'other' },
    ]);
  });

  it('checks an Ollama prompt plugin against its Codex execution harness', async () => {
    const root = await mkdtemp(join(tmpdir(), 'configured-ollama-'));
    try {
      mockedCwd.mockReturnValue(root);
      bindConfiguredPromptFilesystemDispatcher({
        queryFileTreeRootsForLegacyIpc: jest.fn().mockResolvedValue({
          legacyResult: {
            roots: [{ absolutePath: root, rootKind: 'workspace-root' }],
          },
        }),
      } as unknown as DesktopCanopyDispatcher);
      mockedCatalog.mockResolvedValue({
        marketplaces: [{ id: 'market', plugins: [{ name: 'alpha' }] }],
        skills: [],
      } as never);
      mockedPluginUsable.mockResolvedValue(false);
      await expect(
        resolveConfiguredPrompt({
          projectId: 'project',
          worktreeId: 'worktree',
          providerType: 'ollama',
          executionHarness: 'codex',
          prompt: 'alpha',
          promptReferences: [
            {
              kind: 'plugin',
              textStart: 0,
              displayText: 'alpha',
              plugin: {
                kind: 'installed',
                marketplaceId: 'market',
                pluginName: 'alpha',
              },
            },
          ],
        }),
      ).rejects.toThrow('Referenced plugin is unavailable');
      expect(mockedPluginUsable).toHaveBeenCalledWith(
        { marketplaceId: 'market', pluginName: 'alpha' },
        expect.any(Array),
        'codex',
      );
      mockedPluginUsable.mockClear();
      await expect(
        resolveConfiguredPrompt({
          projectId: 'project',
          worktreeId: 'worktree',
          providerType: 'ollama',
          prompt: 'alpha',
          promptReferences: [
            {
              kind: 'plugin',
              textStart: 0,
              displayText: 'alpha',
              plugin: {
                kind: 'installed',
                marketplaceId: 'market',
                pluginName: 'alpha',
              },
            },
          ],
        }),
      ).rejects.toThrow('Referenced plugin is unavailable');
      expect(mockedPluginUsable).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
