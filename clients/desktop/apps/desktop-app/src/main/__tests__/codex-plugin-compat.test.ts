jest.mock('../lib/paths', () => ({
  getCodexCompatibilityCacheRootDir: jest.fn(),
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildCodexQualifiedReferenceMap,
  BUILTIN_APP_PLUGIN_NAME,
  CANOPY_COMPATIBILITY_VERSION,
  ensureAggregateCodexCompatiblePlugin,
  ensureCodexCompatibleClaudePlugin,
  readClaudePluginCompatibilitySource,
} from '../plugins/codex-plugin-compat';
import { getCodexCompatibilityCacheRootDir } from '../lib/paths';

const getCodexCompatibilityCacheRootDirMock = jest.mocked(
  getCodexCompatibilityCacheRootDir,
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('codex-plugin-compat', () => {
  let tempDir = '';
  let pluginDir = '';
  let cacheRoot = '';

  beforeEach(() => {
    jest.resetAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-codex-compat-'));
    pluginDir = path.join(tempDir, 'source-plugin');
    cacheRoot = path.join(tempDir, 'cache-root');
    getCodexCompatibilityCacheRootDirMock.mockReturnValue(cacheRoot);
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('keeps bundled merge-pr scripts in native and aggregate Codex compatibility paths', () => {
    const bundled = path.resolve(
      __dirname,
      '../../../../../.cache/brand/canopy/resources/plugins/claude-plugins/builtin-gh',
    );
    const source = readClaudePluginCompatibilitySource({
      pluginName: 'builtin-gh',
      pluginPath: bundled,
      marketplaceId: 'builtin/app',
      category: 'development',
    });
    const native = ensureCodexCompatibleClaudePlugin(
      source,
      buildCodexQualifiedReferenceMap([source]),
    );
    const skill = source.skills.find((entry) => entry.name === 'merge-pr');
    expect(skill).toBeDefined();
    if (!skill) throw new Error('Bundled merge-pr skill missing');
    const aggregate = ensureAggregateCodexCompatiblePlugin({
      pluginName: BUILTIN_APP_PLUGIN_NAME,
      category: 'development',
      skills: [skill],
      mcpServers: {},
    });
    for (const result of [native, aggregate]) {
      for (const script of ['merge-status.sh', 'conflict-check.sh']) {
        expect(
          fs.readFileSync(
            path.join(result.cacheDir, 'skills/merge-pr/scripts', script),
          ),
        ).toEqual(
          fs.readFileSync(
            path.join(bundled, 'skills/merge-pr/scripts', script),
          ),
        );
      }
    }
  });

  it('allocates generated command collisions by canonical code-unit path order', () => {
    writeFile(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'collision-plugin', commands: 'commands' }),
    );
    writeFile(path.join(pluginDir, 'commands', 'a_b.md'), '# Underscore');
    writeFile(path.join(pluginDir, 'commands', 'a-b.md'), '# Hyphen');

    const source = readClaudePluginCompatibilitySource({
      pluginName: 'collision-plugin',
      pluginPath: pluginDir,
      marketplaceId: 'demo-market',
      category: 'development',
    });
    const references = buildCodexQualifiedReferenceMap([source]);

    expect(references.get('collision-plugin:a-b')).toBe(
      '$collision-plugin:a-b',
    );
    expect(references.get('collision-plugin:a_b')).toBe(
      '$collision-plugin:a-b-2',
    );
  });

  it('projects native skills, commands, agents, and plugin MCP into a cached Codex plugin', () => {
    writeFile(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify(
        {
          name: 'demo-plugin',
          version: '1.0.0',
          description: 'Demo plugin',
          skills: ['custom-skills'],
          commands: 'commands',
          agents: 'agents',
          mcpServers: '.mcp.json',
        },
        null,
        2,
      ),
    );
    writeFile(
      path.join(pluginDir, 'custom-skills', 'native-skill', 'SKILL.md'),
      [
        '---',
        'name: native-skill',
        'description: Native plugin skill',
        'disable-model-invocation: true',
        '---',
        '# Native Skill',
        '',
        'Use AskUserQuestion to ask the user how to proceed.',
        'Use demo-plugin:review-agent when you need a subagent.',
        '',
      ].join('\n'),
    );
    writeFile(
      path.join(pluginDir, 'commands', 'do-thing.md'),
      [
        '---',
        'name: do-thing',
        'description: Do the thing',
        '---',
        '# Do Thing',
        '',
        'Use demo-plugin:native-skill.',
        'Use the Bash tool.',
        '',
      ].join('\n'),
    );
    writeFile(
      path.join(pluginDir, 'agents', 'review-agent.md'),
      [
        '---',
        'name: review-agent',
        'description: Review work',
        '---',
        '# Review Agent',
        '',
        'Use Task tool with `subagent_type: "demo-plugin:review-agent"`, `description: "Inspect the diff"`.',
        '',
      ].join('\n'),
    );
    writeFile(
      path.join(pluginDir, '.mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            review: {
              command: 'node',
              args: ['${CLAUDE_PLUGIN_ROOT}/server.js'],
            },
          },
        },
        null,
        2,
      ),
    );

    const source = readClaudePluginCompatibilitySource({
      pluginName: 'demo-plugin',
      pluginPath: pluginDir,
      marketplaceId: 'demo-market',
      category: 'development',
    });
    const result = ensureCodexCompatibleClaudePlugin(
      source,
      buildCodexQualifiedReferenceMap([source]),
    );

    expect(result.pluginName).toBe('demo-plugin');
    expect(result.cacheDir).toContain(
      path.join('demo-market', 'demo-plugin', 'local'),
    );

    const pluginManifest = JSON.parse(
      fs.readFileSync(
        path.join(result.cacheDir, '.codex-plugin', 'plugin.json'),
        'utf8',
      ),
    ) as {
      name: string;
      version: string;
      skills?: string;
      mcpServers?: string;
    };
    expect(pluginManifest).toEqual(
      expect.objectContaining({
        name: 'demo-plugin',
        version: '1.0.0',
        skills: './skills/',
        mcpServers: './.mcp.json',
      }),
    );

    const copiedSkill = fs.readFileSync(
      path.join(result.cacheDir, 'skills', 'native-skill', 'SKILL.md'),
      'utf8',
    );
    expect(copiedSkill).toContain('Ask the user directly how to proceed.');
    expect(copiedSkill).toContain('$demo-plugin:review-agent');

    const copiedSkillPolicy = fs.readFileSync(
      path.join(
        result.cacheDir,
        'skills',
        'native-skill',
        'agents',
        'openai.yaml',
      ),
      'utf8',
    );
    expect(copiedSkillPolicy).toContain('allow_implicit_invocation: false');

    const commandSkill = fs.readFileSync(
      path.join(result.cacheDir, 'skills', 'do-thing', 'SKILL.md'),
      'utf8',
    );
    expect(commandSkill).toContain('$demo-plugin:do-thing');
    expect(commandSkill).toContain('Use the terminal.');
    expect(commandSkill).toContain('$demo-plugin:native-skill');

    const agentSkill = fs.readFileSync(
      path.join(result.cacheDir, 'skills', 'review-agent', 'SKILL.md'),
      'utf8',
    );
    expect(agentSkill).toContain('Claude subagent definition');
    expect(agentSkill).toContain('$demo-plugin:review-agent');

    const mcpConfig = JSON.parse(
      fs.readFileSync(path.join(result.cacheDir, '.mcp.json'), 'utf8'),
    ) as {
      mcpServers: Record<
        string,
        { command?: string; args?: string[]; cwd?: string }
      >;
    };
    expect(mcpConfig.mcpServers.review.command).toBe('node');
    expect(mcpConfig.mcpServers.review.args).toEqual([
      path.join(result.cacheDir, 'server.js'),
    ]);
    expect(mcpConfig.mcpServers.review.cwd).toBe(result.cacheDir);
  });

  it('refreshes the cached plugin when source freshness metadata changes', () => {
    writeFile(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify(
        {
          name: 'demo-plugin',
          version: '1.0.0',
          description: 'Demo plugin',
          commands: 'commands',
        },
        null,
        2,
      ),
    );
    writeFile(
      path.join(pluginDir, 'commands', 'do-thing.md'),
      [
        '---',
        'name: do-thing',
        'description: First version',
        '---',
        '# Do Thing',
        '',
        'Initial body.',
        '',
      ].join('\n'),
    );

    let source = readClaudePluginCompatibilitySource({
      pluginName: 'demo-plugin',
      pluginPath: pluginDir,
      marketplaceId: 'demo-market',
      category: 'development',
    });
    let result = ensureCodexCompatibleClaudePlugin(
      source,
      buildCodexQualifiedReferenceMap([source]),
    );

    const commandSkillPath = path.join(
      result.cacheDir,
      'skills',
      'do-thing',
      'SKILL.md',
    );
    expect(fs.readFileSync(commandSkillPath, 'utf8')).toContain(
      'Initial body.',
    );

    const sidecarPath = path.join(
      cacheRoot,
      'demo-market',
      'demo-plugin',
      'canopy-compatibility.json',
    );
    writeFile(
      sidecarPath,
      JSON.stringify(
        {
          canopyCompatibilityVersion: 0,
          sourcePluginName: 'demo-plugin',
          sourceVersion: '1.0.0',
          sourceLastUpdatedAt: source.sourceLastUpdatedAt,
        },
        null,
        2,
      ),
    );
    writeFile(
      path.join(pluginDir, 'commands', 'do-thing.md'),
      [
        '---',
        'name: do-thing',
        'description: Second version',
        '---',
        '# Do Thing',
        '',
        'Updated body.',
        '',
      ].join('\n'),
    );

    source = readClaudePluginCompatibilitySource({
      pluginName: 'demo-plugin',
      pluginPath: pluginDir,
      marketplaceId: 'demo-market',
      category: 'development',
    });
    result = ensureCodexCompatibleClaudePlugin(
      source,
      buildCodexQualifiedReferenceMap([source]),
    );

    expect(fs.readFileSync(commandSkillPath, 'utf8')).toContain(
      'Updated body.',
    );
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as {
      canopyCompatibilityVersion: number;
      sourceVersion: string;
      sourceLastUpdatedAt: string;
    };
    expect(sidecar.canopyCompatibilityVersion).toBe(
      CANOPY_COMPATIBILITY_VERSION,
    );
    expect(sidecar.sourceVersion).toBe('1.0.0:mcp-true');
    expect(sidecar.sourceLastUpdatedAt).toBe(source.sourceLastUpdatedAt);
  });

  it('does not read source file contents when the compatibility cache is fresh', () => {
    writeFile(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'cached-plugin',
        version: '1.0.0',
        commands: 'commands',
      }),
    );
    writeFile(
      path.join(pluginDir, 'commands', 'cached-command.md'),
      [
        '---',
        'name: cached-command',
        'description: Cached',
        '---',
        '# Cached',
      ].join('\n'),
    );
    writeFile(path.join(pluginDir, 'assets', 'large-payload.bin'), 'payload');

    const source = readClaudePluginCompatibilitySource({
      pluginName: 'cached-plugin',
      pluginPath: pluginDir,
      marketplaceId: 'demo-market',
      category: 'development',
    });
    const initialReferenceMap = buildCodexQualifiedReferenceMap([source]);
    ensureCodexCompatibleClaudePlugin(source, initialReferenceMap);

    const readFileSyncSpy = spyOnReadFileSync();
    try {
      const referenceMap = buildCodexQualifiedReferenceMap([source]);
      ensureCodexCompatibleClaudePlugin(source, referenceMap);

      expect(sourceFileReads(readFileSyncSpy, pluginDir)).toEqual([]);
    } finally {
      readFileSyncSpy.mockRestore();
    }
  });

  it('reads each source file once when rebuilding the compatibility cache', () => {
    writeFile(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'rebuilt-plugin',
        version: '1.0.0',
        commands: 'commands',
      }),
    );
    writeFile(
      path.join(pluginDir, 'commands', 'rebuilt-command.md'),
      [
        '---',
        'name: rebuilt-command',
        'description: Rebuilt',
        '---',
        '# Rebuilt',
      ].join('\n'),
    );
    writeFile(path.join(pluginDir, 'assets', 'large-payload.bin'), 'payload');

    const source = readClaudePluginCompatibilitySource({
      pluginName: 'rebuilt-plugin',
      pluginPath: pluginDir,
      marketplaceId: 'demo-market',
      category: 'development',
    });
    const readFileSyncSpy = spyOnReadFileSync();
    try {
      const referenceMap = buildCodexQualifiedReferenceMap([source]);
      ensureCodexCompatibleClaudePlugin(source, referenceMap);

      const reads = sourceFileReads(readFileSyncSpy, pluginDir);
      expect(reads).toHaveLength(3);
      expect(new Set(reads).size).toBe(reads.length);
    } finally {
      readFileSyncSpy.mockRestore();
    }
  });

  it('keeps publisher support skill documents out of the invocable inventory', () => {
    const skillDir = path.join(tempDir, 'publisher-skill');
    writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: selected\ndescription: Selected skill\n---\nRead .upstream/skills/selected/SKILL.md',
    );
    writeFile(
      path.join(skillDir, '.upstream/skills/sibling/SKILL.md'),
      '---\nname: sibling\ndescription: Supporting skill\n---\nSupport',
    );
    const result = ensureAggregateCodexCompatiblePlugin({
      pluginName: BUILTIN_APP_PLUGIN_NAME,
      category: 'development',
      skills: [
        {
          name: 'selected',
          description: 'Selected skill',
          sourceDir: skillDir,
          skillMdPath: path.join(skillDir, 'SKILL.md'),
        },
      ],
      mcpServers: {},
    });
    const source = readClaudePluginCompatibilitySource({
      pluginName: BUILTIN_APP_PLUGIN_NAME,
      pluginPath: result.cacheDir,
      marketplaceId: 'local',
      category: 'development',
    });
    expect(source.skills.map((skill) => skill.name)).toEqual(['selected']);
    expect(
      fs.readFileSync(
        path.join(
          result.cacheDir,
          'skills/selected/.upstream/skills/sibling/SKILL.md',
        ),
        'utf8',
      ),
    ).toContain('Supporting skill');
  });

  it('uses the universal built-in app identity for the aggregate plugin manifest', () => {
    const skillDir = path.join(tempDir, 'builtin-skill');
    writeFile(
      path.join(skillDir, 'SKILL.md'),
      ['---', 'name: builtin-skill', 'description: Built-in skill', '---'].join(
        '\n',
      ),
    );

    const result = ensureAggregateCodexCompatiblePlugin({
      pluginName: BUILTIN_APP_PLUGIN_NAME,
      category: 'development',
      skills: [
        {
          name: 'builtin-skill',
          description: 'Built-in skill',
          sourceDir: skillDir,
          skillMdPath: path.join(skillDir, 'SKILL.md'),
        },
      ],
      mcpServers: {},
    });
    const pluginManifest: unknown = JSON.parse(
      fs.readFileSync(
        path.join(result.cacheDir, '.codex-plugin', 'plugin.json'),
        'utf8',
      ),
    );
    if (
      !isRecord(pluginManifest) ||
      typeof pluginManifest.name !== 'string' ||
      !isRecord(pluginManifest.interface) ||
      typeof pluginManifest.interface.displayName !== 'string'
    ) {
      throw new Error('Expected a valid aggregate plugin manifest');
    }

    expect(result.pluginName).toBe('builtin-app-plugin');
    expect(pluginManifest.name).toBe('builtin-app-plugin');
    expect(pluginManifest.interface.displayName).toBe('Builtin App Plugin');
  });

  it('reports a member root that resolves outside the plugin instead of dropping it silently', () => {
    writeFile(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'linked-plugin',
        version: '1.0.0',
        skills: './nested/link/skills',
      }),
    );
    const outside = path.join(tempDir, 'outside');
    writeFile(
      path.join(outside, 'skills', 'leaked', 'SKILL.md'),
      '---\nname: leaked\n---\n',
    );
    fs.mkdirSync(path.join(pluginDir, 'nested'), { recursive: true });
    fs.symlinkSync(outside, path.join(pluginDir, 'nested', 'link'));

    const source = readClaudePluginCompatibilitySource({
      pluginName: 'linked-plugin',
      pluginPath: pluginDir,
      marketplaceId: 'demo-market',
      category: 'development',
    });
    expect(source.skills).toEqual([]);
    expect(source.warnings).toEqual([
      expect.stringContaining('resolves outside the plugin'),
    ]);
  });

  it('carries discovery warnings through to the projection result', () => {
    writeFile(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'warned-plugin', version: '1.0.0' }),
    );
    writeFile(
      path.join(pluginDir, 'skills', 'fine', 'SKILL.md'),
      '---\nname: fine\n---\n',
    );
    const source = readClaudePluginCompatibilitySource({
      pluginName: 'warned-plugin',
      pluginPath: pluginDir,
      marketplaceId: 'demo-market',
      category: 'development',
    });
    source.warnings.push('Plugin member root "x" was skipped.');
    const references = buildCodexQualifiedReferenceMap([source]);
    const built = ensureCodexCompatibleClaudePlugin(source, references);
    expect(built.warnings).toEqual(['Plugin member root "x" was skipped.']);
    // The fresh-cache path reports them as well.
    const cached = ensureCodexCompatibleClaudePlugin(source, references);
    expect(cached.warnings).toEqual(['Plugin member root "x" was skipped.']);
  });

  it('rejects symlinked members while rebuilding a Claude plugin projection', () => {
    writeFile(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'unsafe-plugin', version: '1.0.0' }),
    );
    const externalFile = path.join(tempDir, 'external.md');
    writeFile(externalFile, '# External');
    fs.symlinkSync(externalFile, path.join(pluginDir, 'linked.md'), 'file');

    const source = readClaudePluginCompatibilitySource({
      pluginName: 'unsafe-plugin',
      pluginPath: pluginDir,
      marketplaceId: 'demo-market',
      category: 'development',
    });
    expect(() =>
      ensureCodexCompatibleClaudePlugin(
        source,
        buildCodexQualifiedReferenceMap([source]),
      ),
    ).toThrow('symlinked source path');
  });
});

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function sourceFileReads(
  spy: jest.SpiedFunction<typeof fs.readFileSync>,
  sourceRoot: string,
): string[] {
  return spy.mock.calls.flatMap(([filePath]) => {
    if (typeof filePath !== 'string') return [];
    return path.relative(sourceRoot, filePath).startsWith('..')
      ? []
      : [filePath];
  });
}

function spyOnReadFileSync(): jest.SpiedFunction<typeof fs.readFileSync> {
  const mutableFs = jest.requireActual<typeof fs>('node:fs');
  return jest.spyOn(mutableFs, 'readFileSync');
}
