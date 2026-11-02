import { CAPABILITY_BUNDLE_SKILL_NAME_PATTERN } from '@canopy/protocol/capability-bundle';
import {
  buildClaudePluginQualifiedReferenceMap,
  buildPluginMemberCodexNames,
  buildPluginMemberInventory,
  CANOPY_COMPATIBILITY_VERSION,
  invocationPrefixForHarness,
  pluginMemberInsertText,
  pluginMemberInvocation,
  projectClaudePluginForCodex,
  projectCodexPluginWithoutMcpServers,
  isPluginMemberInventory,
  standaloneSkillInsertText,
  type ClaudePluginManifest,
  type PluginFileContent,
  type ProjectClaudePluginForCodexInput,
} from '..';

function buildFiles(
  entries: Readonly<Record<string, string>>,
): ReadonlyMap<string, PluginFileContent> {
  return new Map(Object.entries(entries));
}

describe('@canopy/plugin-interop', () => {
  it.each([
    {
      harness: 'claude',
      prefix: '/',
      standalone: '/review/deep:thing ',
      pluginInvocation: '/docs-plugin:review/deep:thing',
      pluginInsertText: '/docs-plugin:review/deep:thing ',
    },
    {
      harness: 'codex',
      prefix: '$',
      standalone: '$review/deep:thing ',
      pluginInvocation: '$docs-plugin:review/deep:thing',
      pluginInsertText: '$docs-plugin:review/deep:thing ',
    },
    {
      harness: 'tool-loop',
      prefix: '',
      standalone: 'review/deep:thing ',
      pluginInvocation: 'docs-plugin:review/deep:thing',
      pluginInsertText: 'docs-plugin:review/deep:thing ',
    },
    {
      harness: 'unknown',
      prefix: '',
      standalone: 'review/deep:thing ',
      pluginInvocation: 'docs-plugin:review/deep:thing',
      pluginInsertText: 'docs-plugin:review/deep:thing ',
    },
    {
      harness: undefined,
      prefix: '',
      standalone: 'review/deep:thing ',
      pluginInvocation: 'docs-plugin:review/deep:thing',
      pluginInsertText: 'docs-plugin:review/deep:thing ',
    },
  ])(
    'formats canonical invocation strings byte-for-byte for $harness',
    ({
      harness,
      prefix,
      standalone,
      pluginInvocation,
      pluginInsertText,
    }): void => {
      expect(invocationPrefixForHarness(harness)).toBe(prefix);
      expect(standaloneSkillInsertText('review/deep:thing', harness)).toBe(
        standalone,
      );
      expect(
        pluginMemberInvocation('docs-plugin', 'review/deep:thing', harness),
      ).toBe(pluginInvocation);
      expect(
        pluginMemberInsertText('docs-plugin', 'review/deep:thing', harness),
      ).toBe(pluginInsertText);
    },
  );

  it('validates persisted member inventories and derives collision-safe Codex names without file IO', (): void => {
    const inventory = {
      skills: [{ name: 'review', description: 'Skill', path: 'skills/review' }],
      commands: [
        {
          name: 'review',
          description: 'Command',
          filePath: 'commands/review.md',
        },
      ],
      agents: [],
      hooks: [],
      mcpServers: [],
      lspServers: [],
    };
    expect(isPluginMemberInventory(inventory)).toBe(true);
    expect(
      buildPluginMemberCodexNames(inventory).commandNames.get('review'),
    ).toBe('review-2');
    expect(isPluginMemberInventory({ ...inventory, commands: [{}] })).toBe(
      false,
    );
    expect(isPluginMemberInventory({ ...inventory, apps: [{}] })).toBe(false);
  });

  it('builds a deterministic inventory from manifest and default declarations', (): void => {
    const manifest: ClaudePluginManifest = {
      skills: 'custom-skills',
      commands: 'commands',
      agents: 'agents',
      apps: 'apps',
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'check.sh' }],
          },
        ],
      },
      mcpServers: {
        inline: { command: 'node', args: ['server.js'] },
      },
      lspServers: '.lsp.json',
    };
    const inventory = buildPluginMemberInventory({
      manifest,
      files: buildFiles({
        'custom-skills/review/SKILL.md': [
          '---',
          'name: review',
          'description: Review code',
          'user-invocable: false',
          'disable-model-invocation: true',
          '---',
          '# Review',
        ].join('\n'),
        'custom-skills/review/reference.md': '# Reference',
        'commands/run.md': [
          '---',
          'name: run',
          'description: Run it',
          '---',
          '# Run',
        ].join('\n'),
        'agents/audit.md': '# Audit',
        'apps/dashboard.md': [
          '---',
          'name: dashboard',
          'description: Opens the dashboard',
          '---',
          '# Dashboard',
        ].join('\n'),
        '.mcp.json': JSON.stringify({
          mcpServers: { ignoredDefault: { command: 'ignored' } },
        }),
        '.lsp.json': JSON.stringify({
          typescript: {
            command: 'typescript-language-server',
            args: ['--stdio'],
            extensionToLanguage: {
              '.ts': 'typescript',
              '.tsx': 'typescript',
            },
          },
        }),
      }),
    });

    expect(inventory).toEqual({
      skills: [
        {
          name: 'review',
          description: 'Review code',
          path: 'custom-skills/review',
          userInvocable: false,
          disableModelInvocation: true,
        },
      ],
      commands: [
        {
          name: 'run',
          description: 'Run it',
          filePath: 'commands/run.md',
        },
      ],
      agents: [
        {
          name: 'audit',
          description: '',
          filePath: 'agents/audit.md',
        },
      ],
      apps: [
        {
          name: 'dashboard',
          description: 'Opens the dashboard',
          filePath: 'apps/dashboard.md',
        },
      ],
      hooks: [
        {
          event: 'PreToolUse',
          matcher: 'Bash',
          hookType: 'command',
          command: 'check.sh',
        },
      ],
      mcpServers: [
        {
          name: 'inline',
          type: 'command',
          command: 'node',
          args: ['server.js'],
        },
      ],
      lspServers: [
        {
          name: 'typescript',
          command: 'typescript-language-server',
          args: ['--stdio'],
          languages: ['typescript'],
        },
      ],
    });
  });

  it('uses .mcp.json when the manifest has no MCP override', (): void => {
    const inventory = buildPluginMemberInventory({
      manifest: {},
      files: buildFiles({
        '.mcp.json': JSON.stringify({
          mcpServers: {
            hosted: { type: 'http', url: 'https://example.test/mcp' },
          },
        }),
      }),
    });
    expect(inventory.mcpServers).toEqual([
      {
        name: 'hosted',
        type: 'http',
        url: 'https://example.test/mcp',
      },
    ]);
  });

  it('resolves a plugin-root skills override without leading slashes', (): void => {
    const inventory = buildPluginMemberInventory({
      manifest: { skills: './' },
      files: buildFiles({
        'root-skill/SKILL.md': [
          '---',
          'name: root-skill',
          'description: Root skill',
          '---',
          '# Root skill',
        ].join('\n'),
      }),
    });

    expect(inventory.skills).toEqual([
      {
        name: 'root-skill',
        description: 'Root skill',
        path: 'root-skill',
      },
    ]);
  });

  it('discovers explicitly listed skill directories and deduplicates overlapping roots', (): void => {
    const inventory = buildPluginMemberInventory({
      manifest: {
        skills: [
          './skills/engineering/tdd',
          './skills/productivity/grill-me',
          './skills/engineering',
        ],
      },
      files: buildFiles({
        'skills/engineering/tdd/SKILL.md':
          '---\nname: tdd\ndescription: Test first\n---\n# TDD',
        'skills/engineering/tdd/references/SKILL.md':
          '---\nname: reference-only\n---\n# Supporting example',
        'skills/productivity/grill-me/SKILL.md':
          '---\nname: grill-me\ndescription: Clarify requirements\n---\n# Grill',
        'skills/other/unselected/SKILL.md': '# Unselected',
      }),
    });

    expect(inventory.skills).toEqual([
      {
        name: 'grill-me',
        description: 'Clarify requirements',
        path: 'skills/productivity/grill-me',
      },
      {
        name: 'tdd',
        description: 'Test first',
        path: 'skills/engineering/tdd',
      },
    ]);
  });

  it('projects files deterministically and flattens generated names', (): void => {
    const manifest = {
      name: 'demo',
      version: '1.0.0',
      description: 'Demo plugin',
      commands: 'commands',
      agents: 'agents',
    } satisfies ClaudePluginManifest;
    const input: ProjectClaudePluginForCodexInput = {
      pluginName: 'demo',
      category: 'development',
      manifest,
      rawManifest: manifest,
      pluginRoot: '/projected/demo',
      files: buildFiles({
        'skills/native/SKILL.md': [
          '---',
          'name: native',
          'description: Native',
          '---',
          '# Native',
        ].join('\n'),
        'skills/native/guide.txt': 'support',
        'commands/deep.md': [
          '---',
          'name: review/deep:thing',
          'description: Review',
          '---',
          'Use demo:native.',
        ].join('\n'),
        'agents/reviewer.md': [
          '---',
          'name: reviewer',
          'description: Reviewer',
          '---',
          '# Reviewer',
        ].join('\n'),
      }),
    };
    const qualifiedReferenceMap = buildClaudePluginQualifiedReferenceMap([
      input,
    ]);
    const first = projectClaudePluginForCodex({
      ...input,
      qualifiedReferenceMap,
    });
    const second = projectClaudePluginForCodex({
      ...input,
      qualifiedReferenceMap,
    });

    expect(Array.from(first.files.entries())).toEqual(
      Array.from(second.files.entries()),
    );
    expect(first.generatedSkillNames.get('command:review/deep:thing')).toBe(
      'review-deep-thing',
    );
    for (const generatedName of Array.from(
      first.generatedSkillNames.values(),
    )) {
      expect(CAPABILITY_BUNDLE_SKILL_NAME_PATTERN.test(generatedName)).toBe(
        true,
      );
      expect(generatedName).not.toMatch(/[/:]/);
    }
    expect(first.files.get('skills/native/guide.txt')).toBe('support');
    expect(first.files.get('README.md')).not.toContain('Canopy');
    expect(first.files.get('skills/review-deep-thing/SKILL.md')).toContain(
      '$demo:native',
    );
    expect(CANOPY_COMPATIBILITY_VERSION).toBe(5);
  });

  it('assigns deterministic collision suffixes by code-unit file order', (): void => {
    const input: ProjectClaudePluginForCodexInput = {
      pluginName: 'case-collision',
      category: 'development',
      manifest: { commands: 'commands' },
      files: buildFiles({
        'commands/a.md': '# Lowercase',
        'commands/A.md': '# Uppercase',
      }),
    };

    const projected = projectClaudePluginForCodex(input);

    expect(projected.generatedSkillNames.get('command:A')).toBe('a');
    expect(projected.generatedSkillNames.get('command:a')).toBe('a-2');
  });

  it('keeps adversarial inventories and generated names stable across insertion order', (): void => {
    const entries: ReadonlyArray<readonly [string, string]> = [
      [
        'skills/ä-skill/SKILL.md',
        '---\nname: ä-skill\ndescription: Unicode skill\n---\n# Unicode\n',
      ],
      [
        'skills/_skill/SKILL.md',
        '---\nname: _skill\ndescription: Punctuation skill\n---\n# Punctuation\n',
      ],
      [
        'commands/ä!.md',
        '---\nname: deploy/ä!\ndescription: Unicode command\n---\n# Deploy\n',
      ],
      [
        'commands/_-.md',
        '---\nname: deploy--\ndescription: Punctuation command\n---\n# Deploy\n',
      ],
      [
        'agents/ß!.md',
        '---\nname: reviewer/ß!\ndescription: Unicode agent\n---\n# Review\n',
      ],
      [
        'agents/_-.md',
        '---\nname: reviewer--\ndescription: Punctuation agent\n---\n# Review\n',
      ],
    ];
    const manifest: ClaudePluginManifest = {
      skills: 'skills',
      commands: 'commands',
      agents: 'agents',
    };
    const input = (
      ordered: typeof entries,
    ): ProjectClaudePluginForCodexInput => ({
      pluginName: 'adversarial-order',
      category: 'development',
      manifest,
      files: new Map(ordered),
    });
    const forward = input(entries);
    const reversed = input([...entries].reverse());

    const forwardInventory = buildPluginMemberInventory(forward);
    const reversedInventory = buildPluginMemberInventory(reversed);
    const forwardProjection = projectClaudePluginForCodex(forward);
    const reversedProjection = projectClaudePluginForCodex(reversed);

    expect(forwardInventory).toEqual(reversedInventory);
    expect(forwardInventory.skills.map((skill) => skill.name)).toEqual([
      '_skill',
      'ä-skill',
    ]);
    expect([...forwardProjection.generatedSkillNames]).toEqual([
      ...reversedProjection.generatedSkillNames,
    ]);
    expect(new Set(forwardProjection.generatedSkillNames.values()).size).toBe(
      forwardProjection.generatedSkillNames.size,
    );
    for (const generatedName of forwardProjection.generatedSkillNames.values()) {
      expect(
        CAPABILITY_BUNDLE_SKILL_NAME_PATTERN.test(String(generatedName)),
      ).toBe(true);
    }
  });

  it('keeps persisted-inventory and file-map collision allocation deterministic', (): void => {
    const input: ProjectClaudePluginForCodexInput = {
      pluginName: 'separator-collision',
      category: 'development',
      manifest: { commands: 'commands' },
      files: buildFiles({
        'commands/a_b.md': '# Underscore',
        'commands/a-b.md': '# Hyphen',
      }),
    };
    const inventory = buildPluginMemberInventory(input);
    const reversedInventory = {
      ...inventory,
      commands: [...inventory.commands].reverse(),
    };

    const projected = projectClaudePluginForCodex(input);
    const persistedNames = buildPluginMemberCodexNames(reversedInventory);

    expect(projected.generatedSkillNames.get('command:a-b')).toBe('a-b');
    expect(projected.generatedSkillNames.get('command:a_b')).toBe('a-b-2');
    expect(persistedNames.commandNames.get('a-b')).toBe('a-b');
    expect(persistedNames.commandNames.get('a_b')).toBe('a-b-2');
  });

  it('removes MCP declarations from an in-memory native Codex plugin', (): void => {
    const projected = projectCodexPluginWithoutMcpServers({
      manifest: { name: 'native', mcpServers: ['config/mcp.json'] },
      files: buildFiles({
        '.codex-plugin/plugin.json': '{}',
        '.mcp.json': '{}',
        'config/mcp.json': '{}',
        'skills/keep/SKILL.md': '# Keep',
      }),
    });
    expect(projected.has('.mcp.json')).toBe(false);
    expect(projected.has('config/mcp.json')).toBe(false);
    expect(projected.get('skills/keep/SKILL.md')).toBe('# Keep');
    expect(projected.get('.codex-plugin/plugin.json')).toBe(
      '{\n  "name": "native"\n}\n',
    );
  });
});
