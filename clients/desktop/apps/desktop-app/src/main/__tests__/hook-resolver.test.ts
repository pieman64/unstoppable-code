import {
  normalizeHookInputMap,
  type HookOverrides,
} from '@canopy/desktop-shared/hooks';
jest.mock('../lib/canopy-json', () => ({
  readCanopyJson: jest.fn(),
  getManifestRepoById: jest.fn(
    (manifest: { repos?: Array<{ id: string }> }, repoId: string) =>
      manifest.repos?.find((repo) => repo.id === repoId),
  ),
}));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfig: jest.fn(),
  ensureOrganizationSourceHookBindings: jest.fn(
    (args: { local?: HookOverrides; owner?: unknown }) =>
      Promise.resolve({ hooks: args.local, owner: args.owner }),
  ),
}));

import type {
  CanopyJsonFile,
  WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import { readCanopyJson } from '../lib/canopy-json';
import * as scriptResolver from '../lib/script-resolver';
import {
  resolveProjectHooks,
  resolveWorkspaceRepoDataHooks,
  resolveWorkspaceRepoHooks,
  resolveWorkspaceRootHooks,
  toHookOverrides,
} from '../lib/hook-resolver';
import {
  ensureOrganizationSourceHookBindings,
  readWorkspaceConfig,
} from '../lib/workspace-persistence';

const mockedReadCanopyJson = jest.mocked(readCanopyJson);
const mockedReadWorkspaceConfig = jest.mocked(readWorkspaceConfig);
const mockedEnsureBindings = jest.mocked(ensureOrganizationSourceHookBindings);

function buildWorkspaceConfig(
  overrides: Partial<WorkspaceConfigFile> = {},
): WorkspaceConfigFile {
  return {
    version: 1,
    type: 'multi-repo',
    sourceRepoPath: '/repos/workspace-root',
    repos: [
      {
        id: 'repo-a',
        name: 'Repo A',
        repoPath: '/repos/repo-a',
      },
    ],
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

describe('hook resolver', () => {
  it.each(['project', 'root', 'repo'] as const)(
    'keeps a new explicit binding ahead of a stale generated overlay (%s)',
    async (scope): Promise<void> => {
      const hooks = normalizeHookInputMap({
        'pr:create': [
          {
            type: 'pipeline',
            source: 'bundled',
            id: 'review',
            executionContext: 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            localExecutionContextOverlay: true,
          },
          {
            type: 'chat',
            prompt: 'Review',
            executionContext: 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            localExecutionContextOverlay: true,
          },
        ],
      });
      const owner: NonNullable<WorkspaceConfigFile['owner']> = {
        type: 'organization',
        organizationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        projectId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        instanceId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        bindingGeneration: 1,
      };
      mockedReadWorkspaceConfig.mockResolvedValue(
        buildWorkspaceConfig({
          owner,
          hooks: scope === 'root' ? hooks : undefined,
          repos: [{ id: 'repo-a', name: 'Repo A', repoPath: '/repo', hooks }],
        }),
      );
      const resolve = (): ReturnType<typeof resolveProjectHooks> =>
        scope === 'project'
          ? resolveProjectHooks({ id: 'ws-1', owner, repoPath: '/repo', hooks })
          : scope === 'root'
            ? resolveWorkspaceRootHooks('ws-1')
            : resolveWorkspaceRepoHooks('ws-1', 'repo-a');
      mockedReadCanopyJson.mockResolvedValue({
        version: 1,
        hooks: {
          'pr:create': [
            { type: 'pipeline', source: 'bundled', id: 'review' },
            { type: 'chat', prompt: 'Review' },
          ],
        },
      });
      expect(
        (await resolve())['pr:create']?.actions?.map((action) =>
          action.type === 'command' ? undefined : action.executionContext,
        ),
      ).toEqual([`org:${owner.organizationId}`, `org:${owner.organizationId}`]);
      mockedReadCanopyJson.mockResolvedValue({
        version: 1,
        hooks: {
          'pr:create': [
            {
              type: 'pipeline',
              source: 'bundled',
              id: 'review',
              executionContext: 'personal',
            },
            { type: 'chat', prompt: 'Review', executionContext: 'personal' },
          ],
        },
      });
      expect(
        (await resolve())['pr:create']?.actions?.map((action) =>
          action.type === 'command' ? undefined : action.executionContext,
        ),
      ).toEqual(['personal', 'personal']);
    },
  );

  it.each(['project', 'root', 'repo'] as const)(
    'ignores former organization overlays after ownership is cleared or changed (%s)',
    async (scope): Promise<void> => {
      const hooks = normalizeHookInputMap({
        'pr:create': [
          {
            type: 'pipeline',
            source: 'bundled',
            id: 'review',
            executionContext: 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            localExecutionContextOverlay: true,
          },
          {
            type: 'chat',
            prompt: 'Review',
            executionContext: 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            localExecutionContextOverlay: true,
          },
        ],
      });
      mockedReadCanopyJson.mockResolvedValue({
        version: 1,
        hooks: {
          'pr:create': [
            { type: 'pipeline', source: 'bundled', id: 'review' },
            { type: 'chat', prompt: 'Review' },
          ],
        },
      });
      const otherOwner: NonNullable<WorkspaceConfigFile['owner']> = {
        type: 'organization',
        organizationId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        projectId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        instanceId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        bindingGeneration: 1,
      };
      for (const owner of [undefined, otherOwner]) {
        mockedReadWorkspaceConfig.mockResolvedValue(
          buildWorkspaceConfig({
            owner,
            hooks: scope === 'root' ? hooks : undefined,
            repos: [{ id: 'repo-a', name: 'Repo A', repoPath: '/repo', hooks }],
          }),
        );
        const resolved =
          scope === 'project'
            ? await resolveProjectHooks({
                id: 'ws-1',
                owner,
                repoPath: '/repo',
                hooks,
              })
            : scope === 'root'
              ? await resolveWorkspaceRootHooks('ws-1')
              : await resolveWorkspaceRepoHooks('ws-1', 'repo-a');
        for (const action of resolved['pr:create']?.actions ?? [])
          expect(action).not.toHaveProperty('executionContext');
      }
    },
  );

  it.each(['project', 'root', 'repo'] as const)(
    'applies a repaired binding for the owner the repair read (%s)',
    async (scope): Promise<void> => {
      const staleOwner: NonNullable<WorkspaceConfigFile['owner']> = {
        type: 'organization',
        organizationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        projectId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        instanceId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        bindingGeneration: 1,
      };
      const currentOwner = {
        ...staleOwner,
        organizationId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      };
      mockedReadCanopyJson.mockResolvedValue({
        version: 1,
        hooks: {
          'pr:create': [{ type: 'pipeline', source: 'bundled', id: 'review' }],
        },
      });
      mockedReadWorkspaceConfig.mockResolvedValue(
        buildWorkspaceConfig({
          owner: staleOwner,
          repos: [{ id: 'repo-a', name: 'Repo A', repoPath: '/repo' }],
        }),
      );
      // Ownership changed after the resolver's read; the serialized repair
      // bound the hook to the owner it read.
      mockedEnsureBindings.mockResolvedValueOnce({
        hooks: normalizeHookInputMap({
          'pr:create': [
            {
              type: 'pipeline',
              source: 'bundled',
              id: 'review',
              executionContext: `org:${currentOwner.organizationId}`,
              localExecutionContextOverlay: true,
            },
          ],
        }),
        owner: currentOwner,
      });
      const resolved =
        scope === 'project'
          ? await resolveProjectHooks({
              id: 'ws-1',
              owner: staleOwner,
              repoPath: '/repo',
            })
          : scope === 'root'
            ? await resolveWorkspaceRootHooks('ws-1')
            : await resolveWorkspaceRepoHooks('ws-1', 'repo-a');
      expect(resolved['pr:create']?.actions).toEqual([
        {
          type: 'pipeline',
          source: 'bundled',
          id: 'review',
          executionContext: `org:${currentOwner.organizationId}`,
        },
      ]);
    },
  );

  beforeEach(() => {
    jest.clearAllMocks();
    mockedReadCanopyJson.mockResolvedValue(null);
    mockedReadWorkspaceConfig.mockResolvedValue(buildWorkspaceConfig());
  });

  it.each(['project', 'root', 'repo'])(
    'merges pipeline bindings by scope, trigger, source and id without shadowing source edits (%s)',
    async (scope): Promise<void> => {
      const hooks = normalizeHookInputMap({
        'pr:create': [
          {
            type: 'pipeline',
            source: 'bundled',
            id: 'review',
            executionContext: 'personal',
            localExecutionContextOverlay: true,
          },
        ],
        'pr:closed': [
          {
            type: 'pipeline',
            source: 'bundled',
            id: 'removed',
            executionContext: 'personal',
            localExecutionContextOverlay: true,
          },
        ],
      });
      mockedReadCanopyJson.mockResolvedValue({
        version: 1,
        hooks: {
          'pr:create': [
            {
              type: 'pipeline',
              source: 'bundled',
              id: 'review',
              inputs: { value: 'new' },
            },
            { type: 'pipeline', source: 'local', id: 'review' },
            { type: 'pipeline', source: 'bundled', id: 'other' },
          ],
          'pr:merged': [{ type: 'pipeline', source: 'bundled', id: 'review' }],
        },
      });
      mockedReadWorkspaceConfig.mockResolvedValue(
        buildWorkspaceConfig({
          hooks: scope === 'root' ? hooks : undefined,
          repos: [
            {
              id: 'repo-a',
              name: 'Repo A',
              repoPath: '/repos/repo-a',
              hooks: scope === 'repo' ? hooks : undefined,
            },
          ],
        }),
      );
      const resolved =
        scope === 'project'
          ? await resolveProjectHooks({ repoPath: '/repo', hooks })
          : scope === 'root'
            ? await resolveWorkspaceRootHooks('ws-1')
            : await resolveWorkspaceRepoHooks('ws-1', 'repo-a');
      expect(resolved['pr:create']?.actions).toEqual([
        {
          type: 'pipeline',
          source: 'bundled',
          id: 'review',
          inputs: { value: 'new' },
          executionContext: 'personal',
        },
        { type: 'pipeline', source: 'local', id: 'review' },
        { type: 'pipeline', source: 'bundled', id: 'other' },
      ]);
      expect(resolved['pr:closed']).toBeUndefined();
      expect(resolved['pr:merged']?.actions?.[0]).not.toHaveProperty(
        'executionContext',
      );
    },
  );

  it('merges a chat execution-context overlay without shadowing source edits', async () => {
    const hooks = normalizeHookInputMap({
      'pr:create': [
        {
          type: 'chat',
          prompt: 'Review this PR',
          executionContext: 'personal',
          localExecutionContextOverlay: true,
        },
      ],
    });
    mockedReadCanopyJson.mockResolvedValue({
      version: 1,
      hooks: {
        'pr:create': [
          {
            type: 'chat',
            prompt: 'Review this PR',
            planMode: true,
          },
        ],
      },
    });

    const resolved = await resolveProjectHooks({
      repoPath: '/repo',
      hooks,
    });

    expect(resolved['pr:create']?.actions).toEqual([
      {
        type: 'chat',
        prompt: 'Review this PR',
        planMode: true,
        executionContext: 'personal',
      },
    ]);
  });

  it('applies single-repo local overrides above canopy hooks', async () => {
    mockedReadCanopyJson.mockResolvedValue({
      version: 1,
      hooks: {
        'pr:create': [{ type: 'command', command: 'echo source' }],
      },
    });

    const resolved = await resolveProjectHooks({
      repoPath: '/repo',
      hooks: {
        'pr:create': [{ type: 'command', command: 'echo local' }],
      },
    });

    expect(toHookOverrides(resolved)).toEqual({
      'pr:create': [{ type: 'command', command: 'echo local' }],
    });
    expect(resolved['pr:create']).toEqual({
      actions: [{ type: 'command', command: 'echo local' }],
      source: 'local-override',
    });
  });

  it('supports project root local hook disables', async () => {
    mockedReadCanopyJson.mockResolvedValue({
      version: 1,
      hooks: {
        'pr:merged': [{ type: 'command', command: 'echo merged' }],
      },
      repos: [],
    });
    mockedReadWorkspaceConfig.mockResolvedValue(
      buildWorkspaceConfig({
        hooks: {
          'pr:merged': null,
        },
      }),
    );

    const resolved = await resolveWorkspaceRootHooks('ws-1');

    expect(toHookOverrides(resolved)).toEqual({
      'pr:merged': null,
    });
    expect(resolved['pr:merged']).toEqual({
      source: 'local-disabled',
    });
  });

  it('applies project manifest repo null disables above repo canopy hooks', async () => {
    mockedReadCanopyJson.mockImplementation((repoPath: string) => {
      if (repoPath === '/repos/workspace-root') {
        return Promise.resolve(
          buildWorkspaceManifest({
            repos: [
              {
                id: 'repo-a',
                name: 'Repo A',
                url: 'https://example.com/repo-a.git',
                hooks: {
                  'pr:update:comments': null,
                },
              },
            ],
          }),
        );
      }

      if (repoPath === '/repos/repo-a') {
        return Promise.resolve({
          version: 1,
          hooks: {
            'pr:update:comments': [{ type: 'command', command: 'echo repo' }],
          },
        });
      }

      return Promise.resolve(null);
    });

    const resolved = await resolveWorkspaceRepoHooks('ws-1', 'repo-a');

    expect(toHookOverrides(resolved)).toEqual({
      'pr:update:comments': null,
    });
    expect(resolved['pr:update:comments']).toEqual({
      source: 'workspace-manifest-disabled',
    });
  });

  it('applies project repo local overrides above manifest repo hooks', async () => {
    mockedReadCanopyJson.mockImplementation((repoPath: string) => {
      if (repoPath === '/repos/workspace-root') {
        return Promise.resolve(
          buildWorkspaceManifest({
            repos: [
              {
                id: 'repo-a',
                name: 'Repo A',
                url: 'https://example.com/repo-a.git',
                hooks: {
                  'pr:closed': [{ type: 'command', command: 'echo manifest' }],
                },
              },
            ],
          }),
        );
      }

      return Promise.resolve(null);
    });
    mockedReadWorkspaceConfig.mockResolvedValue(
      buildWorkspaceConfig({
        repos: [
          {
            id: 'repo-a',
            name: 'Repo A',
            repoPath: '/repos/repo-a',
            hooks: {
              'pr:closed': [{ type: 'command', command: 'echo local' }],
            },
          },
        ],
      }),
    );

    const resolved = await resolveWorkspaceRepoHooks('ws-1', 'repo-a');

    expect(toHookOverrides(resolved)).toEqual({
      'pr:closed': [{ type: 'command', command: 'echo local' }],
    });
    expect(resolved['pr:closed']).toEqual({
      actions: [{ type: 'command', command: 'echo local' }],
      source: 'local-override',
    });
  });

  it('overlays local plugin selections without shadowing updated manifest hook fields', async () => {
    mockedReadCanopyJson.mockImplementation((repoPath: string) => {
      if (repoPath === '/repos/workspace-root') {
        return Promise.resolve(
          buildWorkspaceManifest({
            repos: [
              {
                id: 'repo-a',
                name: 'Repo A',
                url: 'https://example.com/repo-a.git',
                hooks: {
                  'pr:closed': [
                    {
                      type: 'chat',
                      prompt: 'Source-controlled prompt',
                      model: 'opus',
                      'if-command': 'test -n "$CANOPY_PR_URL"',
                    },
                  ],
                },
              },
            ],
          }),
        );
      }

      return Promise.resolve(null);
    });
    mockedReadWorkspaceConfig.mockResolvedValue(
      buildWorkspaceConfig({
        repos: [
          {
            id: 'repo-a',
            name: 'Repo A',
            repoPath: '/repos/repo-a',
            hooks: {
              'pr:closed': [
                {
                  type: 'chat',
                  prompt: 'Source-controlled prompt',
                  localPluginSelectionOverlay: true,
                  localPluginSelectionOverlayKey:
                    'chat:Source-controlled prompt',
                  promptReferences: [
                    {
                      kind: 'plugin',
                      textStart: 18,
                      displayText: 'prompt',
                      plugin: {
                        kind: 'installed',
                        marketplaceId: 'market-1',
                        pluginName: 'plugin',
                      },
                    },
                  ],
                  pluginSelections: {
                    collectionIds: ['local-collection'],
                    skillRefs: [],
                    pluginRefs: [],
                  },
                },
              ],
            },
          },
        ],
      }),
    );

    const resolved = await resolveWorkspaceRepoHooks('ws-1', 'repo-a');

    expect(resolved['pr:closed']).toEqual({
      actions: [
        {
          type: 'chat',
          prompt: 'Source-controlled prompt',
          model: 'opus',
          'if-command': 'test -n "$CANOPY_PR_URL"',
          promptReferences: [
            {
              kind: 'plugin',
              textStart: 18,
              displayText: 'prompt',
              plugin: {
                kind: 'installed',
                marketplaceId: 'market-1',
                pluginName: 'plugin',
              },
            },
          ],
          pluginSelections: {
            collectionIds: ['local-collection'],
            skillRefs: [],
            pluginRefs: [],
          },
        },
      ],
      source: 'workspace-manifest',
    });
  });

  it('keeps updated source references when a matching local plugin overlay is stale', async () => {
    const sourceReference = {
      kind: 'file' as const,
      textStart: 0,
      displayText: 'README.md',
      root: { kind: 'workspace' as const },
      relativePath: 'docs/README.md',
    };
    mockedReadCanopyJson.mockImplementation((repoPath: string) =>
      Promise.resolve(
        repoPath === '/repos/workspace-root'
          ? buildWorkspaceManifest({
              repos: [
                {
                  id: 'repo-a',
                  name: 'Repo A',
                  url: 'https://example.com/repo-a.git',
                  hooks: {
                    'pr:closed': [
                      {
                        type: 'chat',
                        prompt: 'README.md',
                        promptReferences: [sourceReference],
                      },
                    ],
                  },
                },
              ],
            })
          : null,
      ),
    );
    mockedReadWorkspaceConfig.mockResolvedValue(
      buildWorkspaceConfig({
        repos: [
          {
            id: 'repo-a',
            name: 'Repo A',
            repoPath: '/repos/repo-a',
            hooks: {
              'pr:closed': [
                {
                  type: 'chat',
                  prompt: 'README.md',
                  localPluginSelectionOverlay: true,
                  localPluginSelectionOverlayKey: 'chat:README.md',
                  promptReferences: [
                    { ...sourceReference, relativePath: 'old/README.md' },
                  ],
                },
              ],
            },
          },
        ],
      }),
    );
    const resolved = await resolveWorkspaceRepoHooks('ws-1', 'repo-a');
    expect(resolved['pr:closed'].actions?.[0]).toMatchObject({
      promptReferences: [sourceReference],
    });
  });

  it('does not execute a marker-only local overlay after selections are cleared', async () => {
    mockedReadCanopyJson.mockImplementation((repoPath: string) => {
      if (repoPath === '/repos/workspace-root') {
        return Promise.resolve(
          buildWorkspaceManifest({
            repos: [
              {
                id: 'repo-a',
                name: 'Repo A',
                url: 'https://example.com/repo-a.git',
                hooks: {
                  'pr:closed': [
                    {
                      type: 'chat',
                      prompt: 'Source-controlled prompt',
                      model: 'opus',
                      'if-command': 'test -n "$CANOPY_PR_URL"',
                    },
                  ],
                },
              },
            ],
          }),
        );
      }
      return Promise.resolve(null);
    });
    mockedReadWorkspaceConfig.mockResolvedValue(
      buildWorkspaceConfig({
        repos: [
          {
            id: 'repo-a',
            name: 'Repo A',
            repoPath: '/repos/repo-a',
            hooks: {
              'pr:closed': [
                {
                  type: 'chat',
                  prompt: 'Source-controlled prompt',
                  localPluginSelectionOverlay: true,
                  localPluginSelectionOverlayKey:
                    'chat:Source-controlled prompt',
                },
              ],
            },
          },
        ],
      }),
    );

    const resolved = await resolveWorkspaceRepoHooks('ws-1', 'repo-a');

    expect(resolved['pr:closed']).toEqual({
      actions: [
        {
          type: 'chat',
          prompt: 'Source-controlled prompt',
          model: 'opus',
          'if-command': 'test -n "$CANOPY_PR_URL"',
        },
      ],
      source: 'workspace-manifest',
    });
  });

  it('matches local plugin selection overlays by their source action prompt', async () => {
    mockedReadCanopyJson.mockImplementation((repoPath: string) => {
      if (repoPath === '/repos/workspace-root') {
        return Promise.resolve(
          buildWorkspaceManifest({
            repos: [
              {
                id: 'repo-a',
                name: 'Repo A',
                url: 'https://example.com/repo-a.git',
                hooks: {
                  'pr:closed': [
                    { type: 'chat', prompt: 'New first action' },
                    {
                      type: 'chat',
                      prompt: 'Original selected action',
                      model: 'opus',
                    },
                  ],
                },
              },
            ],
          }),
        );
      }

      return Promise.resolve(null);
    });
    mockedReadWorkspaceConfig.mockResolvedValue(
      buildWorkspaceConfig({
        repos: [
          {
            id: 'repo-a',
            name: 'Repo A',
            repoPath: '/repos/repo-a',
            hooks: {
              'pr:closed': [
                {
                  type: 'chat',
                  prompt: 'Original selected action',
                  localPluginSelectionOverlay: true,
                  localPluginSelectionOverlayKey:
                    'chat:Original selected action',
                  pluginSelections: {
                    collectionIds: ['local-collection'],
                    skillRefs: [],
                    pluginRefs: [],
                  },
                },
              ],
            },
          },
        ],
      }),
    );

    const resolved = await resolveWorkspaceRepoHooks('ws-1', 'repo-a');

    expect(resolved['pr:closed']).toEqual({
      actions: [
        { type: 'chat', prompt: 'New first action' },
        {
          type: 'chat',
          prompt: 'Original selected action',
          model: 'opus',
          pluginSelections: {
            collectionIds: ['local-collection'],
            skillRefs: [],
            pluginRefs: [],
          },
        },
      ],
      source: 'workspace-manifest',
    });
  });

  it('does not resurrect a removed source-controlled hook from an overlay stub', async () => {
    mockedReadCanopyJson.mockImplementation((repoPath: string) => {
      if (repoPath === '/repos/workspace-root') {
        return Promise.resolve(buildWorkspaceManifest());
      }

      return Promise.resolve(null);
    });
    mockedReadWorkspaceConfig.mockResolvedValue(
      buildWorkspaceConfig({
        repos: [
          {
            id: 'repo-a',
            name: 'Repo A',
            repoPath: '/repos/repo-a',
            hooks: {
              'pr:closed': [
                {
                  type: 'chat',
                  prompt: 'Removed source hook',
                  localPluginSelectionOverlay: true,
                  localPluginSelectionOverlayKey: 'chat:Removed source hook',
                  pluginSelections: {
                    collectionIds: ['local-collection'],
                    skillRefs: [],
                    pluginRefs: [],
                  },
                },
              ],
            },
          },
        ],
      }),
    );

    const resolved = await resolveWorkspaceRepoHooks('ws-1', 'repo-a');

    expect(resolved['pr:closed']).toBeUndefined();
  });

  it('skips an overlay when duplicate source prompts make the match ambiguous', async () => {
    mockedReadCanopyJson.mockImplementation((repoPath: string) => {
      if (repoPath === '/repos/workspace-root') {
        return Promise.resolve(
          buildWorkspaceManifest({
            repos: [
              {
                id: 'repo-a',
                name: 'Repo A',
                url: 'https://example.com/repo-a.git',
                hooks: {
                  'pr:closed': [
                    { type: 'chat', prompt: 'Same prompt' },
                    { type: 'chat', prompt: 'Same prompt' },
                  ],
                },
              },
            ],
          }),
        );
      }

      return Promise.resolve(null);
    });
    mockedReadWorkspaceConfig.mockResolvedValue(
      buildWorkspaceConfig({
        repos: [
          {
            id: 'repo-a',
            name: 'Repo A',
            repoPath: '/repos/repo-a',
            hooks: {
              'pr:closed': [
                {
                  type: 'chat',
                  prompt: 'Same prompt',
                  localPluginSelectionOverlay: true,
                  localPluginSelectionOverlayKey: 'chat:Same prompt',
                  pluginSelections: {
                    collectionIds: ['local-collection'],
                    skillRefs: [],
                    pluginRefs: [],
                  },
                },
              ],
            },
          },
        ],
      }),
    );

    const resolved = await resolveWorkspaceRepoHooks('ws-1', 'repo-a');

    expect(resolved['pr:closed']?.actions).toEqual([
      { type: 'chat', prompt: 'Same prompt' },
      { type: 'chat', prompt: 'Same prompt' },
    ]);
  });

  it('keeps non-overridden project repo hooks when a local override exists for another trigger', async () => {
    mockedReadCanopyJson.mockImplementation((repoPath: string) => {
      if (repoPath === '/repos/workspace-root') {
        return Promise.resolve(
          buildWorkspaceManifest({
            repos: [
              {
                id: 'repo-a',
                name: 'Repo A',
                url: 'https://example.com/repo-a.git',
                hooks: {
                  'pr:create': [
                    { type: 'command', command: 'echo manifest create' },
                  ],
                  'pr:merged': [
                    { type: 'command', command: 'echo manifest merged' },
                  ],
                },
              },
            ],
          }),
        );
      }

      return Promise.resolve(null);
    });
    mockedReadWorkspaceConfig.mockResolvedValue(
      buildWorkspaceConfig({
        repos: [
          {
            id: 'repo-a',
            name: 'Repo A',
            repoPath: '/repos/repo-a',
            hooks: {
              'pr:create': [{ type: 'command', command: 'echo local create' }],
            },
          },
        ],
      }),
    );

    const resolved = await resolveWorkspaceRepoHooks('ws-1', 'repo-a');

    expect(toHookOverrides(resolved)).toEqual({
      'pr:create': [{ type: 'command', command: 'echo local create' }],
      'pr:merged': [{ type: 'command', command: 'echo manifest merged' }],
    });
  });

  it('excludes overlay stubs when a trigger also has a local override', async () => {
    mockedReadCanopyJson.mockImplementation((repoPath: string) => {
      if (repoPath === '/repos/workspace-root') {
        return Promise.resolve(
          buildWorkspaceManifest({
            repos: [
              {
                id: 'repo-a',
                name: 'Repo A',
                url: 'https://example.com/repo-a.git',
                hooks: {
                  'pr:closed': [
                    {
                      type: 'chat',
                      prompt: 'Source-controlled action',
                      'if-command': 'test -f gate',
                    },
                  ],
                },
              },
            ],
          }),
        );
      }

      return Promise.resolve(null);
    });
    mockedReadWorkspaceConfig.mockResolvedValue(
      buildWorkspaceConfig({
        repos: [
          {
            id: 'repo-a',
            name: 'Repo A',
            repoPath: '/repos/repo-a',
            hooks: {
              'pr:closed': [
                {
                  type: 'chat',
                  prompt: 'Source-controlled action',
                  localPluginSelectionOverlay: true,
                  localPluginSelectionOverlayKey:
                    'chat:Source-controlled action',
                  pluginSelections: {
                    collectionIds: ['local-collection'],
                    skillRefs: [],
                    pluginRefs: [],
                  },
                },
                { type: 'command', command: 'echo local override' },
              ],
            },
          },
        ],
      }),
    );

    const resolved = await resolveWorkspaceRepoHooks('ws-1', 'repo-a');

    expect(resolved['pr:closed']).toEqual({
      actions: [{ type: 'command', command: 'echo local override' }],
      source: 'local-override',
    });
  });

  it('waits for the repo hook-binding write before rejecting on a script failure', async () => {
    let releaseBindings: (() => void) | undefined;
    let bindingsStarted: () => void = () => undefined;
    const started = new Promise<void>((done) => {
      bindingsStarted = done;
    });
    mockedEnsureBindings.mockImplementationOnce(
      (args) =>
        new Promise((resolve) => {
          releaseBindings = (): void =>
            resolve({ hooks: args.local, owner: args.owner });
          bindingsStarted();
        }),
    );
    const scriptFailure = new Error('script read failed');
    const scripts = jest
      .spyOn(scriptResolver, 'resolveWorkspaceRepoScripts')
      .mockRejectedValueOnce(scriptFailure);
    mockedReadCanopyJson.mockResolvedValue(buildWorkspaceManifest());
    mockedReadWorkspaceConfig.mockResolvedValue(
      buildWorkspaceConfig({
        owner: {
          type: 'organization',
          organizationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          projectId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          instanceId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          bindingGeneration: 1,
        },
      }),
    );
    const settled = jest.fn();
    const result = resolveWorkspaceRepoDataHooks('ws-1', {
      id: 'repo-a',
      name: 'Repo A',
      repoPath: '/repos/repo-a',
    }).finally(settled);
    result.catch(() => undefined);
    // Wait for the binding write itself, not a tick count: on a slow runner
    // the reads before it take more ticks.
    await started;
    await new Promise((done) => setImmediate(done));
    expect(releaseBindings).toBeDefined();
    expect(settled).not.toHaveBeenCalled();
    releaseBindings?.();
    await expect(result).rejects.toBe(scriptFailure);
    scripts.mockRestore();
  });
});
