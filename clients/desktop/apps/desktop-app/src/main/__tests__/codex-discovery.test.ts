import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const listSkillsMock = jest.fn<unknown, [unknown?]>();
const adminRequestMock = jest.fn<unknown, [string, unknown?]>(
  (method, params) => {
    if (method !== 'skills/list') {
      throw new Error(`Unexpected Codex admin request: ${method}`);
    }
    return listSkillsMock(params);
  },
);

jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: jest.fn(() => ({
    admin: (): { request: typeof adminRequestMock } => ({
      request: adminRequestMock,
    }),
  })),
}));

import { discoverCodexWorktreeEnvironment } from '../agents/codex-discovery';

describe('codex-discovery', () => {
  const temporaryRoots: string[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function createCapabilityRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'codex-discovery-root-'));
    temporaryRoots.push(root);
    mkdirSync(join(root, '.codex-plugin'), { recursive: true });
    mkdirSync(join(root, 'skills', 'visible-skill'), { recursive: true });
    mkdirSync(join(root, 'skills', 'hidden-skill'), { recursive: true });
    writeFileSync(
      join(root, '.codex-plugin', 'plugin.json'),
      JSON.stringify({ name: 'builtin-app-plugin' }),
    );
    writeFileSync(
      join(root, 'skills', 'visible-skill', 'SKILL.md'),
      [
        '---',
        'name: visible-skill',
        'description: Selected capability skill',
        'user-invocable: true',
        '---',
      ].join('\n'),
    );
    writeFileSync(
      join(root, 'skills', 'hidden-skill', 'SKILL.md'),
      [
        '---',
        'name: hidden-skill',
        'description: Internal capability skill',
        'user-invocable: false',
        '---',
      ].join('\n'),
    );
    return root;
  }

  it('uses the Codex app-server skill catalog for discovery', async () => {
    listSkillsMock.mockResolvedValue({
      data: [
        {
          skills: [
            {
              name: 'ud-git:branch-naming',
              description: 'Create a branch name',
              enabled: true,
            },
          ],
        },
      ],
    });

    const result = await discoverCodexWorktreeEnvironment({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      extraEnv: {
        CANOPY_TEST_PROFILE: 'capability-fixture',
      },
    });

    expect(adminRequestMock).toHaveBeenCalledWith(
      'skills/list',
      {
        cwds: ['/tmp/repo'],
        forceReload: true,
      },
      expect.objectContaining({
        environment: {
          CANOPY_TEST_PROFILE: 'capability-fixture',
        },
      }),
    );
    expect(listSkillsMock).toHaveBeenCalledWith({
      cwds: ['/tmp/repo'],
      forceReload: true,
    });
    expect(result).toEqual({
      slashCommands: [
        {
          name: 'ud-git:branch-naming',
          description: 'Create a branch name',
          displayName: '$ud-git:branch-naming',
          insertText: '$ud-git:branch-naming ',
        },
      ],
      mcpServers: [],
    });
  });

  it('merges selected capability-root skills without installing them globally', async () => {
    listSkillsMock.mockResolvedValue({ data: [] });
    const root = createCapabilityRoot();

    const result = await discoverCodexWorktreeEnvironment({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      selectedCapabilityRoots: [
        {
          id: 'content-id',
          location: {
            type: 'environment',
            environmentId: 'local',
            path: pathToFileURL(root).href,
          },
        },
      ],
    });

    expect(result.slashCommands).toEqual([
      {
        name: 'builtin-app-plugin:visible-skill',
        description: 'Selected capability skill',
        displayName: '$builtin-app-plugin:visible-skill',
        insertText: '$builtin-app-plugin:visible-skill ',
      },
    ]);
  });

  it('keeps selected capability-root discovery when global skills/list fails', async () => {
    listSkillsMock.mockRejectedValue(new Error('skills/list unavailable'));
    const root = createCapabilityRoot();

    await expect(
      discoverCodexWorktreeEnvironment({
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        selectedCapabilityRoots: [
          {
            id: 'content-id',
            location: {
              type: 'environment',
              environmentId: 'local',
              path: pathToFileURL(root).href,
            },
          },
        ],
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        slashCommands: [
          expect.objectContaining({
            name: 'builtin-app-plugin:visible-skill',
          }),
        ],
      }),
    );
  });

  it('isolates safe project discovery from managed secrets and plugin bootstrap', async () => {
    listSkillsMock.mockResolvedValue({ data: [] });

    await discoverCodexWorktreeEnvironment({
      cwd: '/tmp/repo-shadow',
      projectId: 'project',
      worktreeId: '__home__',
      chatId: '__home_discovery__',
      strictEmptyMcpConfig: true,
      safeProjectDiscovery: true,
    });

    expect(adminRequestMock).toHaveBeenCalledWith(
      'skills/list',
      {
        cwds: ['/tmp/repo-shadow'],
        forceReload: true,
      },
      expect.objectContaining({
        configArgs: ['-c', 'mcp_servers={}'],
        includeCanopySecrets: false,
      }),
    );
  });
});
