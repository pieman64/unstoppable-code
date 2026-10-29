import * as fs from 'fs';
import * as path from 'path';
import { scanPluginDetails } from '../plugins/plugin-scanner';
import type { PluginManifest } from '@canopy/desktop-shared/types/plugins';

jest.mock('fs');

const PLUGIN_DIR = '/fake/plugins/my-plugin';

const mockFiles: Record<string, string> = {};
const mockDirs = new Set<string>();
/** Directory symlinks: link path → target directory. */
const mockLinks: Record<string, string> = {};

/** The path with every link segment replaced by its target, like realpath. */
function resolveLinks(p: string): string {
  let resolved = p;
  for (let guard = 0; guard < 8; guard += 1) {
    const hit = Object.keys(mockLinks).find(
      (link) => resolved === link || resolved.startsWith(link + path.sep),
    );
    if (!hit) return resolved;
    resolved = mockLinks[hit] + resolved.slice(hit.length);
  }
  return resolved;
}

function addLink(linkPath: string, target: string): void {
  mockLinks[linkPath] = target;
  addDir(path.dirname(linkPath));
}

function addDir(...paths: string[]): void {
  for (const p of paths) {
    mockDirs.add(p);
    const parent = path.dirname(p);
    if (parent !== p) {
      mockDirs.add(parent);
    }
  }
}

function addFile(filePath: string, content: string): void {
  mockFiles[filePath] = content;
  addDir(path.dirname(filePath));
}

function resetVirtualFs(): void {
  for (const key of Object.keys(mockFiles)) delete mockFiles[key];
  for (const key of Object.keys(mockLinks)) delete mockLinks[key];
  mockDirs.clear();
}

function setupMocks(): void {
  (fs.existsSync as jest.Mock).mockImplementation((raw: string) => {
    const p = resolveLinks(raw);
    return p in mockFiles || mockDirs.has(p);
  });

  (fs.readFileSync as jest.Mock).mockImplementation((raw: string) => {
    const p = resolveLinks(raw);
    if (p in mockFiles) return mockFiles[p];
    const err = new Error(`ENOENT: no such file or directory, open '${p}'`);
    (err as NodeJS.ErrnoException).code = 'ENOENT';
    throw err;
  });

  (fs.statSync as jest.Mock).mockImplementation((raw: string) => {
    const p = resolveLinks(raw);
    return {
      isDirectory: (): boolean => mockDirs.has(p),
      isFile: (): boolean => p in mockFiles,
    };
  });

  (fs.realpathSync as jest.Mock).mockImplementation((raw: string) => {
    const p = resolveLinks(raw);
    if (p in mockFiles || mockDirs.has(p)) return p;
    const err = new Error(`ENOENT: no such file or directory, lstat '${raw}'`);
    (err as NodeJS.ErrnoException).code = 'ENOENT';
    throw err;
  });

  (fs.readdirSync as jest.Mock).mockImplementation((rawDir: string) => {
    const dirPath = resolveLinks(rawDir);
    const entries: string[] = [];
    const prefix = dirPath.endsWith(path.sep) ? dirPath : dirPath + path.sep;
    for (const filePath of Object.keys(mockFiles)) {
      if (filePath.startsWith(prefix)) {
        const rest = filePath.slice(prefix.length);
        const topLevel = rest.split(path.sep)[0];
        if (topLevel && !entries.includes(topLevel)) {
          entries.push(topLevel);
        }
      }
    }
    for (const dirEntry of Array.from(mockDirs)) {
      if (dirEntry.startsWith(prefix)) {
        const rest = dirEntry.slice(prefix.length);
        const topLevel = rest.split(path.sep)[0];
        if (topLevel && !entries.includes(topLevel)) {
          entries.push(topLevel);
        }
      }
    }
    return entries;
  });
}

function skillMd(name: string, description?: string): string {
  const lines = ['---', `name: ${name}`];
  if (description) lines.push(`description: ${description}`);
  lines.push('---', '', 'Body content here.');
  return lines.join('\n');
}

function agentMd(name: string, description?: string): string {
  return skillMd(name, description);
}

beforeEach(() => {
  resetVirtualFs();
  jest.clearAllMocks();
  setupMocks();
});

describe('scanPluginDetails', () => {
  it('returns empty details when pluginDir does not exist', () => {
    const result = scanPluginDetails('/nonexistent/dir', null);
    expect(result).toEqual({
      skills: [],
      agents: [],
      commands: [],
      apps: [],
      hooks: [],
      mcpServers: [],
      lspServers: [],
      hasReadme: false,
    });
  });

  describe('skills scanning', () => {
    it('discovers skills from default skills/ directory with SKILL.md frontmatter', () => {
      addDir(PLUGIN_DIR);
      addDir(path.join(PLUGIN_DIR, 'skills'));
      addDir(path.join(PLUGIN_DIR, 'skills', 'my-skill'));
      addFile(
        path.join(PLUGIN_DIR, 'skills', 'my-skill', 'SKILL.md'),
        skillMd('My Skill', 'A cool skill'),
      );

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.skills).toHaveLength(1);
      expect(result.skills[0]).toEqual({
        name: 'My Skill',
        description: 'A cool skill',
        path: path.join('skills', 'my-skill'),
      });
    });

    it('discovers multiple skills', () => {
      addDir(PLUGIN_DIR);
      addDir(path.join(PLUGIN_DIR, 'skills'));
      addDir(path.join(PLUGIN_DIR, 'skills', 'skill-a'));
      addDir(path.join(PLUGIN_DIR, 'skills', 'skill-b'));
      addFile(
        path.join(PLUGIN_DIR, 'skills', 'skill-a', 'SKILL.md'),
        skillMd('Skill A', 'First'),
      );
      addFile(
        path.join(PLUGIN_DIR, 'skills', 'skill-b', 'SKILL.md'),
        skillMd('Skill B', 'Second'),
      );

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.skills).toHaveLength(2);
      expect(result.skills.map((s) => s.name).sort()).toEqual([
        'Skill A',
        'Skill B',
      ]);
    });

    it('falls back to directory name when no frontmatter', () => {
      addDir(PLUGIN_DIR);
      addDir(path.join(PLUGIN_DIR, 'skills'));
      addDir(path.join(PLUGIN_DIR, 'skills', 'bad-skill'));
      addFile(
        path.join(PLUGIN_DIR, 'skills', 'bad-skill', 'SKILL.md'),
        'No frontmatter here, just plain text.',
      );

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].name).toBe('bad-skill');
      expect(result.skills[0].description).toBe('');
    });

    it('falls back to directory name when frontmatter has no name', () => {
      addDir(PLUGIN_DIR);
      addDir(path.join(PLUGIN_DIR, 'skills'));
      addDir(path.join(PLUGIN_DIR, 'skills', 'unnamed'));
      addFile(
        path.join(PLUGIN_DIR, 'skills', 'unnamed', 'SKILL.md'),
        '---\ndescription: No name field\n---\nBody.',
      );

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].name).toBe('unnamed');
      expect(result.skills[0].description).toBe('No name field');
    });

    it('uses empty string for description when not provided', () => {
      addDir(PLUGIN_DIR);
      addDir(path.join(PLUGIN_DIR, 'skills'));
      addDir(path.join(PLUGIN_DIR, 'skills', 'no-desc'));
      addFile(
        path.join(PLUGIN_DIR, 'skills', 'no-desc', 'SKILL.md'),
        '---\nname: No Desc\n---\nBody.',
      );

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].description).toBe('');
    });

    it('skips non-directory entries in skills dir', () => {
      addDir(PLUGIN_DIR);
      addDir(path.join(PLUGIN_DIR, 'skills'));
      addFile(
        path.join(PLUGIN_DIR, 'skills', 'README.md'),
        skillMd('Not A Skill'),
      );

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.skills).toHaveLength(0);
    });

    it('skips skill dirs that have no SKILL.md', () => {
      addDir(PLUGIN_DIR);
      addDir(path.join(PLUGIN_DIR, 'skills'));
      addDir(path.join(PLUGIN_DIR, 'skills', 'empty-skill'));
      addFile(
        path.join(PLUGIN_DIR, 'skills', 'empty-skill', 'other.txt'),
        'not a skill',
      );

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.skills).toHaveLength(0);
    });

    it('uses manifest-specified skills paths', () => {
      addDir(PLUGIN_DIR);
      addDir(path.join(PLUGIN_DIR, 'custom-skills'));
      addDir(path.join(PLUGIN_DIR, 'custom-skills', 'sk'));
      addFile(
        path.join(PLUGIN_DIR, 'custom-skills', 'sk', 'SKILL.md'),
        skillMd('Custom Skill'),
      );

      const manifest: PluginManifest = { skills: 'custom-skills' };
      const result = scanPluginDetails(PLUGIN_DIR, manifest);

      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].name).toBe('Custom Skill');
    });

    it('ignores a manifest skills path that reaches outside the plugin through an interior symlink', () => {
      // `isPathInside` is lexical: `nested/link/skills` spells "inside" while
      // the link in the middle points elsewhere. Realpath containment is
      // what the resolver applies, so the picker must not list what a
      // session will refuse.
      addDir(PLUGIN_DIR);
      addDir('/fake/outside/skills', '/fake/outside/skills/leaked');
      addFile('/fake/outside/skills/leaked/SKILL.md', skillMd('Leaked'));
      addLink(path.join(PLUGIN_DIR, 'nested', 'link'), '/fake/outside');

      const manifest: PluginManifest = { skills: 'nested/link/skills' };
      expect(scanPluginDetails(PLUGIN_DIR, manifest).skills).toEqual([]);
    });

    it('keeps member paths plugin-relative when the plugin itself sits behind a symlink', () => {
      // Roots are enumerated from their canonical path; the plugin-relative
      // `path` must still be measured from the canonical plugin dir, not
      // from the linked spelling the caller used.
      addDir(PLUGIN_DIR, path.join(PLUGIN_DIR, 'skills', 'sk'));
      addFile(path.join(PLUGIN_DIR, 'skills', 'sk', 'SKILL.md'), skillMd('Sk'));
      addFile(path.join(PLUGIN_DIR, 'commands', 'go.md'), agentMd('Go'));
      addLink('/fake/alias', '/fake/plugins');

      const result = scanPluginDetails('/fake/alias/my-plugin', null);
      expect(result.skills.map((skill) => skill.path)).toEqual([
        path.join('skills', 'sk'),
      ]);
      expect(result.commands.map((command) => command.filePath)).toEqual([
        path.join('commands', 'go.md'),
      ]);
    });

    it('ignores a manifest commands path that reaches outside the plugin through an interior symlink', () => {
      addDir(PLUGIN_DIR);
      addDir('/fake/outside/commands');
      addFile('/fake/outside/commands/leak.md', agentMd('Leak'));
      addLink(path.join(PLUGIN_DIR, 'nested', 'link'), '/fake/outside');

      const manifest: PluginManifest = { commands: 'nested/link/commands' };
      expect(scanPluginDetails(PLUGIN_DIR, manifest).commands).toEqual([]);
    });

    it('uses manifest with array of skill paths', () => {
      addDir(PLUGIN_DIR);
      addDir(path.join(PLUGIN_DIR, 'dir-a'));
      addDir(path.join(PLUGIN_DIR, 'dir-a', 'sk1'));
      addFile(
        path.join(PLUGIN_DIR, 'dir-a', 'sk1', 'SKILL.md'),
        skillMd('From A'),
      );
      addDir(path.join(PLUGIN_DIR, 'dir-b'));
      addDir(path.join(PLUGIN_DIR, 'dir-b', 'sk2'));
      addFile(
        path.join(PLUGIN_DIR, 'dir-b', 'sk2', 'SKILL.md'),
        skillMd('From B'),
      );

      const manifest: PluginManifest = { skills: ['dir-a', 'dir-b'] };
      const result = scanPluginDetails(PLUGIN_DIR, manifest);

      expect(result.skills).toHaveLength(2);
      expect(result.skills.map((s) => s.name).sort()).toEqual([
        'From A',
        'From B',
      ]);
    });
  });

  describe('apps scanning', () => {
    it('discovers Codex apps from manifest app paths', () => {
      addDir(PLUGIN_DIR);
      addFile(
        path.join(PLUGIN_DIR, 'ui', 'reviewer.md'),
        skillMd('Reviewer App', 'Reviews code changes'),
      );

      const result = scanPluginDetails(
        PLUGIN_DIR,
        { apps: ['ui/reviewer.md'] },
        { manifestKind: 'codex' },
      );

      expect(result.apps).toEqual([
        {
          name: 'Reviewer App',
          description: 'Reviews code changes',
          filePath: 'ui/reviewer.md',
        },
      ]);
    });

    it('does not treat manifest kind fields as scanner options', () => {
      addDir(PLUGIN_DIR);
      addFile(
        path.join(PLUGIN_DIR, 'skills', 'hello', 'SKILL.md'),
        skillMd('Test Skill', 'A test skill'),
      );

      const result = scanPluginDetails(PLUGIN_DIR, {
        kind: 'future-manifest-kind',
      } as never);

      expect(result.skills).toEqual([
        {
          name: 'Test Skill',
          description: 'A test skill',
          path: 'skills/hello',
        },
      ]);
    });
  });

  describe('agents scanning', () => {
    it('discovers agents from default agents/ directory', () => {
      addDir(PLUGIN_DIR);
      addDir(path.join(PLUGIN_DIR, 'agents'));
      addFile(
        path.join(PLUGIN_DIR, 'agents', 'researcher.md'),
        agentMd('Researcher', 'Does research'),
      );

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0]).toEqual({
        name: 'Researcher',
        description: 'Does research',
        filePath: path.join('agents', 'researcher.md'),
      });
    });

    it('skips non-.md files in agents directory', () => {
      addDir(PLUGIN_DIR);
      addDir(path.join(PLUGIN_DIR, 'agents'));
      addFile(
        path.join(PLUGIN_DIR, 'agents', 'agent.txt'),
        agentMd('TextAgent'),
      );
      addFile(
        path.join(PLUGIN_DIR, 'agents', 'valid.md'),
        agentMd('ValidAgent'),
      );

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].name).toBe('ValidAgent');
    });

    it('falls back to filename for agents with no frontmatter or missing name', () => {
      addDir(PLUGIN_DIR);
      addDir(path.join(PLUGIN_DIR, 'agents'));
      addFile(path.join(PLUGIN_DIR, 'agents', 'no-fm.md'), 'Just plain text.');
      addFile(
        path.join(PLUGIN_DIR, 'agents', 'no-name.md'),
        '---\ndescription: No name\n---\nBody.',
      );

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.agents).toHaveLength(2);
      expect(result.agents.map((a) => a.name).sort()).toEqual([
        'no-fm',
        'no-name',
      ]);
    });

    it('uses manifest agents paths (single file)', () => {
      addDir(PLUGIN_DIR);
      addFile(path.join(PLUGIN_DIR, 'my-agent.md'), agentMd('Custom Agent'));

      const manifest: PluginManifest = { agents: 'my-agent.md' };
      const result = scanPluginDetails(PLUGIN_DIR, manifest);

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].name).toBe('Custom Agent');
    });

    it('uses manifest agents paths (array with directory and file)', () => {
      addDir(PLUGIN_DIR);
      addDir(path.join(PLUGIN_DIR, 'agents-custom'));
      addFile(
        path.join(PLUGIN_DIR, 'agents-custom', 'a.md'),
        agentMd('Agent A'),
      );
      addFile(path.join(PLUGIN_DIR, 'extra-agent.md'), agentMd('Agent B'));

      const manifest: PluginManifest = {
        agents: ['agents-custom', 'extra-agent.md'],
      };
      const result = scanPluginDetails(PLUGIN_DIR, manifest);

      expect(result.agents).toHaveLength(2);
      expect(result.agents.map((a) => a.name).sort()).toEqual([
        'Agent A',
        'Agent B',
      ]);
    });
  });

  describe('commands scanning', () => {
    it('discovers commands from default commands/ directory', () => {
      addDir(PLUGIN_DIR);
      addDir(path.join(PLUGIN_DIR, 'commands'));
      addFile(
        path.join(PLUGIN_DIR, 'commands', 'deploy.md'),
        agentMd('Deploy', 'Deploy to prod'),
      );

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]).toEqual({
        name: 'Deploy',
        description: 'Deploy to prod',
        filePath: path.join('commands', 'deploy.md'),
      });
    });

    it('uses manifest commands paths', () => {
      addDir(PLUGIN_DIR);
      addDir(path.join(PLUGIN_DIR, 'custom-cmds'));
      addFile(
        path.join(PLUGIN_DIR, 'custom-cmds', 'build.md'),
        agentMd('Build'),
      );

      const manifest: PluginManifest = { commands: 'custom-cmds' };
      const result = scanPluginDetails(PLUGIN_DIR, manifest);

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].name).toBe('Build');
    });
  });

  describe('hooks scanning', () => {
    it('discovers hooks from default hooks/hooks.json', () => {
      addDir(PLUGIN_DIR);
      addDir(path.join(PLUGIN_DIR, 'hooks'));
      addFile(
        path.join(PLUGIN_DIR, 'hooks', 'hooks.json'),
        JSON.stringify({
          PreToolUse: [
            { matcher: '*.ts', type: 'command', command: 'lint-check' },
          ],
        }),
      );

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.hooks).toHaveLength(1);
      expect(result.hooks[0]).toEqual({
        event: 'PreToolUse',
        matcher: '*.ts',
        hookType: 'command',
        command: 'lint-check',
      });
    });

    it('handles hooks config wrapped in a hooks property', () => {
      addDir(PLUGIN_DIR);
      addDir(path.join(PLUGIN_DIR, 'hooks'));
      addFile(
        path.join(PLUGIN_DIR, 'hooks', 'hooks.json'),
        JSON.stringify({
          hooks: {
            PostToolUse: [
              { matcher: '*.py', type: 'command', command: 'format' },
            ],
          },
        }),
      );

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.hooks).toHaveLength(1);
      expect(result.hooks[0]).toEqual({
        event: 'PostToolUse',
        matcher: '*.py',
        hookType: 'command',
        command: 'format',
      });
    });

    it('handles hooks with nested hooks array in an entry', () => {
      addDir(PLUGIN_DIR);
      addDir(path.join(PLUGIN_DIR, 'hooks'));
      addFile(
        path.join(PLUGIN_DIR, 'hooks', 'hooks.json'),
        JSON.stringify({
          PreToolUse: [
            {
              matcher: '*.js',
              hooks: [
                { type: 'command', command: 'first-hook' },
                { type: 'command', command: 'second-hook' },
              ],
            },
          ],
        }),
      );

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.hooks).toHaveLength(2);
      expect(result.hooks[0]).toEqual({
        event: 'PreToolUse',
        matcher: '*.js',
        hookType: 'command',
        command: 'first-hook',
      });
      expect(result.hooks[1]).toEqual({
        event: 'PreToolUse',
        matcher: '*.js',
        hookType: 'command',
        command: 'second-hook',
      });
    });

    it('defaults hookType to command when type is missing', () => {
      addDir(PLUGIN_DIR);
      addDir(path.join(PLUGIN_DIR, 'hooks'));
      addFile(
        path.join(PLUGIN_DIR, 'hooks', 'hooks.json'),
        JSON.stringify({
          PreToolUse: [{ command: 'run-me' }],
        }),
      );

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.hooks).toHaveLength(1);
      expect(result.hooks[0].hookType).toBe('command');
      expect(result.hooks[0].matcher).toBeUndefined();
    });

    it('skips non-array entries in hooks config', () => {
      addDir(PLUGIN_DIR);
      addDir(path.join(PLUGIN_DIR, 'hooks'));
      addFile(
        path.join(PLUGIN_DIR, 'hooks', 'hooks.json'),
        JSON.stringify({
          PreToolUse: 'not-an-array',
          PostToolUse: [{ type: 'command', command: 'valid' }],
        }),
      );

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.hooks).toHaveLength(1);
      expect(result.hooks[0].event).toBe('PostToolUse');
    });

    it('skips null and non-object entries in a hooks array', () => {
      addDir(PLUGIN_DIR);
      addDir(path.join(PLUGIN_DIR, 'hooks'));
      addFile(
        path.join(PLUGIN_DIR, 'hooks', 'hooks.json'),
        JSON.stringify({
          PreToolUse: [
            null,
            'string-entry',
            { type: 'command', command: 'ok' },
          ],
        }),
      );

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.hooks).toHaveLength(1);
      expect(result.hooks[0].command).toBe('ok');
    });

    it('skips null entries in nested hooks array', () => {
      addDir(PLUGIN_DIR);
      addDir(path.join(PLUGIN_DIR, 'hooks'));
      addFile(
        path.join(PLUGIN_DIR, 'hooks', 'hooks.json'),
        JSON.stringify({
          PreToolUse: [
            {
              matcher: '*.ts',
              hooks: [null, { type: 'command', command: 'valid' }],
            },
          ],
        }),
      );

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.hooks).toHaveLength(1);
      expect(result.hooks[0].command).toBe('valid');
    });

    it('uses manifest hooks as string path', () => {
      addDir(PLUGIN_DIR);
      addFile(
        path.join(PLUGIN_DIR, 'custom-hooks.json'),
        JSON.stringify({
          PreToolUse: [{ type: 'command', command: 'custom' }],
        }),
      );

      const manifest: PluginManifest = { hooks: 'custom-hooks.json' };
      const result = scanPluginDetails(PLUGIN_DIR, manifest);

      expect(result.hooks).toHaveLength(1);
      expect(result.hooks[0].command).toBe('custom');
    });

    it('ignores a manifest hooks path that reaches outside the plugin through an interior symlink', () => {
      addDir(PLUGIN_DIR);
      addFile(
        '/fake/outside/custom-hooks.json',
        JSON.stringify({
          PreToolUse: [{ type: 'command', command: 'leaked' }],
        }),
      );
      addLink(path.join(PLUGIN_DIR, 'nested', 'link'), '/fake/outside');

      const manifest: PluginManifest = {
        hooks: 'nested/link/custom-hooks.json',
      };
      expect(scanPluginDetails(PLUGIN_DIR, manifest).hooks).toEqual([]);
    });

    it('uses manifest hooks as array of paths', () => {
      addDir(PLUGIN_DIR);
      addFile(
        path.join(PLUGIN_DIR, 'hooks-a.json'),
        JSON.stringify({
          PreToolUse: [{ type: 'command', command: 'from-a' }],
        }),
      );
      addFile(
        path.join(PLUGIN_DIR, 'hooks-b.json'),
        JSON.stringify({
          PostToolUse: [{ type: 'command', command: 'from-b' }],
        }),
      );

      const manifest: PluginManifest = {
        hooks: ['hooks-a.json', 'hooks-b.json'],
      };
      const result = scanPluginDetails(PLUGIN_DIR, manifest);

      expect(result.hooks).toHaveLength(2);
      expect(result.hooks.map((h) => h.command).sort()).toEqual([
        'from-a',
        'from-b',
      ]);
    });

    it('uses manifest hooks as inline object', () => {
      addDir(PLUGIN_DIR);

      const manifest: PluginManifest = {
        hooks: {
          PreToolUse: [{ type: 'command', command: 'inline-hook' }],
        },
      };
      const result = scanPluginDetails(PLUGIN_DIR, manifest);

      expect(result.hooks).toHaveLength(1);
      expect(result.hooks[0].command).toBe('inline-hook');
    });

    it('skips non-string entries in manifest hooks array', () => {
      addDir(PLUGIN_DIR);
      addFile(
        path.join(PLUGIN_DIR, 'valid.json'),
        JSON.stringify({
          PreToolUse: [{ type: 'command', command: 'ok' }],
        }),
      );

      const manifest: PluginManifest = {
        hooks: [42 as unknown as string, 'valid.json'],
      };
      const result = scanPluginDetails(PLUGIN_DIR, manifest);

      expect(result.hooks).toHaveLength(1);
      expect(result.hooks[0].command).toBe('ok');
    });

    it('sets command to undefined when hook has non-string command', () => {
      addDir(PLUGIN_DIR);
      addDir(path.join(PLUGIN_DIR, 'hooks'));
      addFile(
        path.join(PLUGIN_DIR, 'hooks', 'hooks.json'),
        JSON.stringify({
          PreToolUse: [{ type: 'command', command: 123 }],
        }),
      );

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.hooks).toHaveLength(1);
      expect(result.hooks[0].command).toBeUndefined();
      expect(result.hooks[0].hookType).toBe('command');
    });

    it('handles invalid JSON in manifest hooks array path', () => {
      addDir(PLUGIN_DIR);
      addFile(path.join(PLUGIN_DIR, 'bad.json'), '{broken json');
      addFile(
        path.join(PLUGIN_DIR, 'good.json'),
        JSON.stringify({
          PostToolUse: [{ type: 'command', command: 'good-cmd' }],
        }),
      );

      const manifest: PluginManifest = {
        hooks: ['bad.json', 'good.json'],
      };
      const result = scanPluginDetails(PLUGIN_DIR, manifest);

      expect(result.hooks).toHaveLength(1);
      expect(result.hooks[0].command).toBe('good-cmd');
    });
  });

  describe('MCP servers scanning', () => {
    it('discovers MCP servers from default .mcp.json', () => {
      addDir(PLUGIN_DIR);
      addFile(
        path.join(PLUGIN_DIR, '.mcp.json'),
        JSON.stringify({
          myServer: { command: 'node', args: ['server.js'] },
        }),
      );

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.mcpServers).toHaveLength(1);
      expect(result.mcpServers[0]).toEqual({
        name: 'myServer',
        type: 'command',
        command: 'node',
        args: ['server.js'],
      });
    });

    it('handles .mcp.json with mcpServers wrapper property', () => {
      addDir(PLUGIN_DIR);
      addFile(
        path.join(PLUGIN_DIR, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            wrapped: { command: 'python', args: ['-m', 'server'] },
          },
        }),
      );

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.mcpServers).toHaveLength(1);
      expect(result.mcpServers[0]).toEqual({
        name: 'wrapped',
        type: 'command',
        command: 'python',
        args: ['-m', 'server'],
      });
    });

    it('discovers HTTP-type MCP servers', () => {
      addDir(PLUGIN_DIR);
      addFile(
        path.join(PLUGIN_DIR, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            slack: {
              type: 'http',
              url: 'https://mcp.slack.com/mcp',
              oauth: { clientId: '123', callbackPort: 3118 },
            },
          },
        }),
      );

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.mcpServers).toHaveLength(1);
      expect(result.mcpServers[0]).toEqual({
        name: 'slack',
        type: 'http',
        url: 'https://mcp.slack.com/mcp',
      });
    });

    it('skips entries without command or url property', () => {
      addDir(PLUGIN_DIR);
      addFile(
        path.join(PLUGIN_DIR, '.mcp.json'),
        JSON.stringify({
          noCmd: { args: ['some-arg'] },
          hasCmd: { command: 'node' },
        }),
      );

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.mcpServers).toHaveLength(1);
      expect(result.mcpServers[0].name).toBe('hasCmd');
    });

    it('omits args when not an array', () => {
      addDir(PLUGIN_DIR);
      addFile(
        path.join(PLUGIN_DIR, '.mcp.json'),
        JSON.stringify({
          srv: { command: 'node', args: 'not-array' },
        }),
      );

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.mcpServers).toHaveLength(1);
      expect(result.mcpServers[0].args).toBeUndefined();
    });

    it('skips null and non-object entries', () => {
      addDir(PLUGIN_DIR);
      addFile(
        path.join(PLUGIN_DIR, '.mcp.json'),
        JSON.stringify({
          nullEntry: null,
          stringEntry: 'just a string',
          valid: { command: 'node' },
        }),
      );

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.mcpServers).toHaveLength(1);
      expect(result.mcpServers[0].name).toBe('valid');
    });

    it('uses manifest mcpServers as string path', () => {
      addDir(PLUGIN_DIR);
      addFile(
        path.join(PLUGIN_DIR, 'custom-mcp.json'),
        JSON.stringify({
          custom: { command: 'deno', args: ['run', 'server.ts'] },
        }),
      );

      const manifest: PluginManifest = { mcpServers: 'custom-mcp.json' };
      const result = scanPluginDetails(PLUGIN_DIR, manifest);

      expect(result.mcpServers).toHaveLength(1);
      expect(result.mcpServers[0].command).toBe('deno');
    });

    it('keeps in-tree manifest mcpServers paths while ignoring one that escapes through an interior symlink', () => {
      addDir(PLUGIN_DIR);
      addFile(
        path.join(PLUGIN_DIR, 'inside-mcp.json'),
        JSON.stringify({ inside: { command: 'inside-server' } }),
      );
      addFile(
        '/fake/outside/leaked-mcp.json',
        JSON.stringify({ leaked: { command: 'leaked-server' } }),
      );
      addLink(path.join(PLUGIN_DIR, 'nested', 'link'), '/fake/outside');

      const manifest: PluginManifest = {
        mcpServers: ['inside-mcp.json', 'nested/link/leaked-mcp.json'],
      };
      const result = scanPluginDetails(PLUGIN_DIR, manifest);

      expect(result.mcpServers.map((server) => server.command)).toEqual([
        'inside-server',
      ]);
    });

    it('uses manifest mcpServers as array of paths', () => {
      addDir(PLUGIN_DIR);
      addFile(
        path.join(PLUGIN_DIR, 'mcp-a.json'),
        JSON.stringify({
          serverA: { command: 'node', args: ['a.js'] },
        }),
      );
      addFile(
        path.join(PLUGIN_DIR, 'mcp-b.json'),
        JSON.stringify({
          serverB: { command: 'node', args: ['b.js'] },
        }),
      );

      const manifest: PluginManifest = {
        mcpServers: ['mcp-a.json', 'mcp-b.json'],
      };
      const result = scanPluginDetails(PLUGIN_DIR, manifest);

      expect(result.mcpServers).toHaveLength(2);
      expect(result.mcpServers.map((s) => s.name).sort()).toEqual([
        'serverA',
        'serverB',
      ]);
    });

    it('uses manifest mcpServers as inline object', () => {
      addDir(PLUGIN_DIR);

      const manifest: PluginManifest = {
        mcpServers: {
          inlineSrv: { command: 'npx', args: ['@mcp/server'] },
        },
      };
      const result = scanPluginDetails(PLUGIN_DIR, manifest);

      expect(result.mcpServers).toHaveLength(1);
      expect(result.mcpServers[0]).toEqual({
        name: 'inlineSrv',
        type: 'command',
        command: 'npx',
        args: ['@mcp/server'],
      });
    });

    it('skips non-string entries in manifest mcpServers array', () => {
      addDir(PLUGIN_DIR);
      addFile(
        path.join(PLUGIN_DIR, 'valid-mcp.json'),
        JSON.stringify({
          srv: { command: 'node' },
        }),
      );

      const manifest: PluginManifest = {
        mcpServers: [123 as unknown as string, 'valid-mcp.json'],
      };
      const result = scanPluginDetails(PLUGIN_DIR, manifest);

      expect(result.mcpServers).toHaveLength(1);
      expect(result.mcpServers[0].name).toBe('srv');
    });

    it('handles invalid JSON in manifest mcpServers array path', () => {
      addDir(PLUGIN_DIR);
      addFile(path.join(PLUGIN_DIR, 'bad-mcp.json'), 'not-json');
      addFile(
        path.join(PLUGIN_DIR, 'good-mcp.json'),
        JSON.stringify({
          ok: { command: 'node', args: ['ok.js'] },
        }),
      );

      const manifest: PluginManifest = {
        mcpServers: ['bad-mcp.json', 'good-mcp.json'],
      };
      const result = scanPluginDetails(PLUGIN_DIR, manifest);

      expect(result.mcpServers).toHaveLength(1);
      expect(result.mcpServers[0].name).toBe('ok');
    });
  });

  describe('LSP servers scanning', () => {
    it('discovers LSP servers from default .lsp.json', () => {
      addDir(PLUGIN_DIR);
      addFile(
        path.join(PLUGIN_DIR, '.lsp.json'),
        JSON.stringify({
          tsServer: {
            command: 'typescript-language-server',
            args: ['--stdio'],
          },
        }),
      );

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.lspServers).toHaveLength(1);
      expect(result.lspServers[0]).toEqual({
        name: 'tsServer',
        command: 'typescript-language-server',
        args: ['--stdio'],
        languages: undefined,
      });
    });

    it('extracts languages from extensionToLanguage mapping', () => {
      addDir(PLUGIN_DIR);
      addFile(
        path.join(PLUGIN_DIR, '.lsp.json'),
        JSON.stringify({
          pyright: {
            command: 'pyright-langserver',
            args: ['--stdio'],
            extensionToLanguage: {
              '.py': 'python',
              '.pyi': 'python',
              '.pyw': 'python',
            },
          },
        }),
      );

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.lspServers).toHaveLength(1);
      expect(result.lspServers[0].languages).toEqual(['python']);
    });

    it('deduplicates languages from extensionToLanguage', () => {
      addDir(PLUGIN_DIR);
      addFile(
        path.join(PLUGIN_DIR, '.lsp.json'),
        JSON.stringify({
          webLsp: {
            command: 'web-ls',
            extensionToLanguage: {
              '.ts': 'typescript',
              '.tsx': 'typescript',
              '.js': 'javascript',
              '.jsx': 'javascript',
            },
          },
        }),
      );

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.lspServers).toHaveLength(1);
      expect(result.lspServers[0].languages?.sort()).toEqual([
        'javascript',
        'typescript',
      ]);
    });

    it('omits languages when extensionToLanguage is not present', () => {
      addDir(PLUGIN_DIR);
      addFile(
        path.join(PLUGIN_DIR, '.lsp.json'),
        JSON.stringify({
          basic: { command: 'basic-ls' },
        }),
      );

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.lspServers).toHaveLength(1);
      expect(result.lspServers[0].languages).toBeUndefined();
    });

    it('omits languages when extensionToLanguage is not an object', () => {
      addDir(PLUGIN_DIR);
      addFile(
        path.join(PLUGIN_DIR, '.lsp.json'),
        JSON.stringify({
          basic: { command: 'basic-ls', extensionToLanguage: 'not-object' },
        }),
      );

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.lspServers).toHaveLength(1);
      expect(result.lspServers[0].languages).toBeUndefined();
    });

    it('skips entries without command', () => {
      addDir(PLUGIN_DIR);
      addFile(
        path.join(PLUGIN_DIR, '.lsp.json'),
        JSON.stringify({
          noCmd: { args: ['--stdio'] },
          hasCmd: { command: 'real-ls' },
        }),
      );

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.lspServers).toHaveLength(1);
      expect(result.lspServers[0].name).toBe('hasCmd');
    });

    it('skips null and non-object entries', () => {
      addDir(PLUGIN_DIR);
      addFile(
        path.join(PLUGIN_DIR, '.lsp.json'),
        JSON.stringify({
          nullEntry: null,
          numEntry: 42,
          valid: { command: 'ls-server' },
        }),
      );

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.lspServers).toHaveLength(1);
      expect(result.lspServers[0].name).toBe('valid');
    });

    it('uses manifest lspServers as string path', () => {
      addDir(PLUGIN_DIR);
      addFile(
        path.join(PLUGIN_DIR, 'custom-lsp.json'),
        JSON.stringify({
          myLsp: { command: 'my-ls', args: ['--stdio'] },
        }),
      );

      const manifest: PluginManifest = { lspServers: 'custom-lsp.json' };
      const result = scanPluginDetails(PLUGIN_DIR, manifest);

      expect(result.lspServers).toHaveLength(1);
      expect(result.lspServers[0].command).toBe('my-ls');
    });

    it('ignores a manifest lspServers path that reaches outside the plugin through an interior symlink', () => {
      addDir(PLUGIN_DIR);
      addFile(
        '/fake/outside/custom-lsp.json',
        JSON.stringify({ leaked: { command: 'leaked-ls', args: ['--stdio'] } }),
      );
      addLink(path.join(PLUGIN_DIR, 'nested', 'link'), '/fake/outside');

      const manifest: PluginManifest = {
        lspServers: 'nested/link/custom-lsp.json',
      };
      expect(scanPluginDetails(PLUGIN_DIR, manifest).lspServers).toEqual([]);
    });

    it('uses manifest lspServers as array of paths', () => {
      addDir(PLUGIN_DIR);
      addFile(
        path.join(PLUGIN_DIR, 'lsp-a.json'),
        JSON.stringify({
          lspA: { command: 'ls-a' },
        }),
      );
      addFile(
        path.join(PLUGIN_DIR, 'lsp-b.json'),
        JSON.stringify({
          lspB: { command: 'ls-b' },
        }),
      );

      const manifest: PluginManifest = {
        lspServers: ['lsp-a.json', 'lsp-b.json'],
      };
      const result = scanPluginDetails(PLUGIN_DIR, manifest);

      expect(result.lspServers).toHaveLength(2);
      expect(result.lspServers.map((s) => s.name).sort()).toEqual([
        'lspA',
        'lspB',
      ]);
    });

    it('uses manifest lspServers as inline object', () => {
      addDir(PLUGIN_DIR);

      const manifest: PluginManifest = {
        lspServers: {
          inlineLsp: { command: 'inline-ls', args: ['--flag'] },
        },
      };
      const result = scanPluginDetails(PLUGIN_DIR, manifest);

      expect(result.lspServers).toHaveLength(1);
      expect(result.lspServers[0]).toEqual({
        name: 'inlineLsp',
        command: 'inline-ls',
        args: ['--flag'],
        languages: undefined,
      });
    });

    it('skips non-string entries in manifest lspServers array', () => {
      addDir(PLUGIN_DIR);
      addFile(
        path.join(PLUGIN_DIR, 'valid-lsp.json'),
        JSON.stringify({
          srv: { command: 'ls-srv' },
        }),
      );

      const manifest: PluginManifest = {
        lspServers: [null as unknown as string, 'valid-lsp.json'],
      };
      const result = scanPluginDetails(PLUGIN_DIR, manifest);

      expect(result.lspServers).toHaveLength(1);
      expect(result.lspServers[0].name).toBe('srv');
    });

    it('handles invalid JSON in manifest lspServers array path', () => {
      addDir(PLUGIN_DIR);
      addFile(path.join(PLUGIN_DIR, 'bad-lsp.json'), '%%%invalid');
      addFile(
        path.join(PLUGIN_DIR, 'good-lsp.json'),
        JSON.stringify({
          ok: { command: 'ls-ok', args: ['--stdio'] },
        }),
      );

      const manifest: PluginManifest = {
        lspServers: ['bad-lsp.json', 'good-lsp.json'],
      };
      const result = scanPluginDetails(PLUGIN_DIR, manifest);

      expect(result.lspServers).toHaveLength(1);
      expect(result.lspServers[0].name).toBe('ok');
    });
  });

  describe('path traversal protection', () => {
    it('rejects skill paths outside pluginDir via manifest', () => {
      addDir(PLUGIN_DIR);
      addDir('/fake/plugins/evil-skills');
      addDir('/fake/plugins/evil-skills/sk');
      addFile('/fake/plugins/evil-skills/sk/SKILL.md', skillMd('Evil Skill'));

      const manifest: PluginManifest = { skills: '../evil-skills' };
      const result = scanPluginDetails(PLUGIN_DIR, manifest);

      expect(result.skills).toHaveLength(0);
    });

    it('rejects agent paths outside pluginDir', () => {
      addDir(PLUGIN_DIR);
      addFile('/fake/plugins/evil-agent.md', agentMd('Evil Agent'));

      const manifest: PluginManifest = { agents: '../evil-agent.md' };
      const result = scanPluginDetails(PLUGIN_DIR, manifest);

      expect(result.agents).toHaveLength(0);
    });

    it('rejects command paths outside pluginDir', () => {
      addDir(PLUGIN_DIR);
      addFile('/fake/plugins/evil-cmd.md', agentMd('Evil Cmd'));

      const manifest: PluginManifest = { commands: '../evil-cmd.md' };
      const result = scanPluginDetails(PLUGIN_DIR, manifest);

      expect(result.commands).toHaveLength(0);
    });

    it('rejects hook file paths outside pluginDir', () => {
      addDir(PLUGIN_DIR);
      addFile(
        '/fake/plugins/evil-hooks.json',
        JSON.stringify({
          PreToolUse: [{ type: 'command', command: 'evil' }],
        }),
      );

      const manifest: PluginManifest = { hooks: '../evil-hooks.json' };
      const result = scanPluginDetails(PLUGIN_DIR, manifest);

      expect(result.hooks).toHaveLength(0);
    });

    it('rejects MCP server file paths outside pluginDir', () => {
      addDir(PLUGIN_DIR);
      addFile(
        '/fake/plugins/evil-mcp.json',
        JSON.stringify({
          evil: { command: 'rm', args: ['-rf', '/'] },
        }),
      );

      const manifest: PluginManifest = { mcpServers: '../evil-mcp.json' };
      const result = scanPluginDetails(PLUGIN_DIR, manifest);

      expect(result.mcpServers).toHaveLength(0);
    });

    it('rejects LSP server file paths outside pluginDir', () => {
      addDir(PLUGIN_DIR);
      addFile(
        '/fake/plugins/evil-lsp.json',
        JSON.stringify({
          evil: { command: 'evil-ls' },
        }),
      );

      const manifest: PluginManifest = { lspServers: '../evil-lsp.json' };
      const result = scanPluginDetails(PLUGIN_DIR, manifest);

      expect(result.lspServers).toHaveLength(0);
    });

    it('rejects traversal in array of hook paths', () => {
      addDir(PLUGIN_DIR);
      addFile(
        '/fake/plugins/evil.json',
        JSON.stringify({
          PreToolUse: [{ type: 'command', command: 'evil' }],
        }),
      );
      addFile(
        path.join(PLUGIN_DIR, 'good.json'),
        JSON.stringify({
          PostToolUse: [{ type: 'command', command: 'good' }],
        }),
      );

      const manifest: PluginManifest = {
        hooks: ['../evil.json', 'good.json'],
      };
      const result = scanPluginDetails(PLUGIN_DIR, manifest);

      expect(result.hooks).toHaveLength(1);
      expect(result.hooks[0].command).toBe('good');
    });

    it('rejects traversal in array of MCP paths', () => {
      addDir(PLUGIN_DIR);
      addFile(
        path.join(PLUGIN_DIR, 'valid-mcp.json'),
        JSON.stringify({
          ok: { command: 'node' },
        }),
      );

      const manifest: PluginManifest = {
        mcpServers: ['../../etc/passwd', 'valid-mcp.json'],
      };
      const result = scanPluginDetails(PLUGIN_DIR, manifest);

      expect(result.mcpServers).toHaveLength(1);
      expect(result.mcpServers[0].name).toBe('ok');
    });

    it('rejects traversal in array of LSP paths', () => {
      addDir(PLUGIN_DIR);
      addFile(
        path.join(PLUGIN_DIR, 'valid-lsp.json'),
        JSON.stringify({
          ok: { command: 'ls-ok' },
        }),
      );

      const manifest: PluginManifest = {
        lspServers: ['../../etc/shadow', 'valid-lsp.json'],
      };
      const result = scanPluginDetails(PLUGIN_DIR, manifest);

      expect(result.lspServers).toHaveLength(1);
      expect(result.lspServers[0].name).toBe('ok');
    });
  });

  describe('error resilience', () => {
    it('catches errors from individual scanners and returns partial results', () => {
      addDir(PLUGIN_DIR);

      addDir(path.join(PLUGIN_DIR, 'agents'));
      addFile(
        path.join(PLUGIN_DIR, 'agents', 'valid.md'),
        agentMd('Good Agent'),
      );

      addFile(
        path.join(PLUGIN_DIR, '.mcp.json'),
        JSON.stringify({
          srv: { command: 'node' },
        }),
      );

      (fs.readdirSync as jest.Mock).mockImplementation((dirPath: string) => {
        if (dirPath === path.join(PLUGIN_DIR, 'skills')) {
          throw new Error('Permission denied');
        }
        const entries: string[] = [];
        const prefix = dirPath.endsWith(path.sep)
          ? dirPath
          : dirPath + path.sep;
        for (const filePath of Object.keys(mockFiles)) {
          if (filePath.startsWith(prefix)) {
            const rest = filePath.slice(prefix.length);
            const topLevel = rest.split(path.sep)[0];
            if (topLevel && !entries.includes(topLevel)) {
              entries.push(topLevel);
            }
          }
        }
        for (const dirEntry of Array.from(mockDirs)) {
          if (dirEntry.startsWith(prefix)) {
            const rest = dirEntry.slice(prefix.length);
            const topLevel = rest.split(path.sep)[0];
            if (topLevel && !entries.includes(topLevel)) {
              entries.push(topLevel);
            }
          }
        }
        return entries;
      });

      addDir(path.join(PLUGIN_DIR, 'skills'));

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.skills).toEqual([]);
      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].name).toBe('Good Agent');
      expect(result.mcpServers).toHaveLength(1);
    });

    it('returns empty when hooks.json has invalid JSON', () => {
      addDir(PLUGIN_DIR);
      addDir(path.join(PLUGIN_DIR, 'hooks'));
      addFile(path.join(PLUGIN_DIR, 'hooks', 'hooks.json'), '{invalid json');

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.hooks).toHaveLength(0);
    });

    it('returns empty when .mcp.json has invalid JSON', () => {
      addDir(PLUGIN_DIR);
      addFile(path.join(PLUGIN_DIR, '.mcp.json'), 'not json');

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.mcpServers).toHaveLength(0);
    });

    it('returns empty when .lsp.json has invalid JSON', () => {
      addDir(PLUGIN_DIR);
      addFile(path.join(PLUGIN_DIR, '.lsp.json'), '%%%');

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.lspServers).toHaveLength(0);
    });

    it('returns empty when readFileSync throws for text files', () => {
      addDir(PLUGIN_DIR);
      addDir(path.join(PLUGIN_DIR, 'skills'));
      addDir(path.join(PLUGIN_DIR, 'skills', 'broken'));

      (fs.readFileSync as jest.Mock).mockImplementation((p: string) => {
        if (p.endsWith('SKILL.md')) throw new Error('Disk error');
        if (p in mockFiles) return mockFiles[p];
        throw new Error('ENOENT');
      });

      (fs.existsSync as jest.Mock).mockImplementation((p: string) => {
        if (p.endsWith('SKILL.md')) return true;
        return p in mockFiles || mockDirs.has(p);
      });

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.skills).toHaveLength(0);
    });
  });

  describe('combined plugin with all components', () => {
    it('scans a plugin with skills, agents, commands, hooks, MCP, and LSP', () => {
      addDir(PLUGIN_DIR);

      addDir(path.join(PLUGIN_DIR, 'skills'));
      addDir(path.join(PLUGIN_DIR, 'skills', 'formatter'));
      addFile(
        path.join(PLUGIN_DIR, 'skills', 'formatter', 'SKILL.md'),
        skillMd('Formatter', 'Auto-format code'),
      );

      addDir(path.join(PLUGIN_DIR, 'agents'));
      addFile(
        path.join(PLUGIN_DIR, 'agents', 'reviewer.md'),
        agentMd('Reviewer', 'Code review agent'),
      );

      addDir(path.join(PLUGIN_DIR, 'commands'));
      addFile(
        path.join(PLUGIN_DIR, 'commands', 'deploy.md'),
        agentMd('Deploy', 'Deploy command'),
      );

      addDir(path.join(PLUGIN_DIR, 'hooks'));
      addFile(
        path.join(PLUGIN_DIR, 'hooks', 'hooks.json'),
        JSON.stringify({
          PreToolUse: [
            { matcher: '*.ts', type: 'command', command: 'tsc --noEmit' },
          ],
        }),
      );

      addFile(
        path.join(PLUGIN_DIR, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            codeServer: { command: 'node', args: ['mcp.js'] },
          },
        }),
      );

      addFile(
        path.join(PLUGIN_DIR, '.lsp.json'),
        JSON.stringify({
          tsLsp: {
            command: 'typescript-language-server',
            args: ['--stdio'],
            extensionToLanguage: { '.ts': 'typescript', '.js': 'javascript' },
          },
        }),
      );

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].name).toBe('Formatter');

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].name).toBe('Reviewer');

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].name).toBe('Deploy');

      expect(result.hooks).toHaveLength(1);
      expect(result.hooks[0].event).toBe('PreToolUse');

      expect(result.mcpServers).toHaveLength(1);
      expect(result.mcpServers[0].name).toBe('codeServer');

      expect(result.lspServers).toHaveLength(1);
      expect(result.lspServers[0].languages?.sort()).toEqual([
        'javascript',
        'typescript',
      ]);
    });
  });

  describe('edge cases', () => {
    it('returns empty when skills dir exists but is empty', () => {
      addDir(PLUGIN_DIR);
      addDir(path.join(PLUGIN_DIR, 'skills'));

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.skills).toHaveLength(0);
    });

    it('returns empty when default dirs do not exist', () => {
      addDir(PLUGIN_DIR);

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result).toEqual({
        skills: [],
        agents: [],
        commands: [],
        apps: [],
        hooks: [],
        mcpServers: [],
        lspServers: [],
        hasReadme: false,
      });
    });

    it('handles manifest with empty path arrays', () => {
      addDir(PLUGIN_DIR);

      const manifest: PluginManifest = {
        skills: [],
        agents: [],
        commands: [],
        hooks: [],
        mcpServers: [],
        lspServers: [],
      };

      const result = scanPluginDetails(PLUGIN_DIR, manifest);

      expect(result.skills).toHaveLength(0);
      expect(result.agents).toHaveLength(0);
      expect(result.commands).toHaveLength(0);
      expect(result.hooks).toHaveLength(0);
      expect(result.mcpServers).toHaveLength(0);
      expect(result.lspServers).toHaveLength(0);
    });

    it('handles frontmatter with invalid YAML gracefully', () => {
      addDir(PLUGIN_DIR);
      addDir(path.join(PLUGIN_DIR, 'skills'));
      addDir(path.join(PLUGIN_DIR, 'skills', 'bad-yaml'));
      addFile(
        path.join(PLUGIN_DIR, 'skills', 'bad-yaml', 'SKILL.md'),
        '---\n: : : invalid yaml [[\n---\nBody.',
      );

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].name).toBe('bad-yaml');
      expect(result.skills[0].description).toBe('');
    });

    it('handles manifest pointing to nonexistent file paths', () => {
      addDir(PLUGIN_DIR);

      const manifest: PluginManifest = {
        hooks: 'nonexistent-hooks.json',
        mcpServers: 'nonexistent-mcp.json',
        lspServers: 'nonexistent-lsp.json',
      };

      const result = scanPluginDetails(PLUGIN_DIR, manifest);

      expect(result.hooks).toHaveLength(0);
      expect(result.mcpServers).toHaveLength(0);
      expect(result.lspServers).toHaveLength(0);
    });

    it('handles skills directory that is a file instead of directory', () => {
      addDir(PLUGIN_DIR);
      addFile(path.join(PLUGIN_DIR, 'skills'), 'not a directory');

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.skills).toHaveLength(0);
    });

    it('handles agents dir with .md file that has empty content', () => {
      addDir(PLUGIN_DIR);
      addDir(path.join(PLUGIN_DIR, 'agents'));
      addFile(path.join(PLUGIN_DIR, 'agents', 'empty.md'), '');

      (fs.readFileSync as jest.Mock).mockImplementation((p: string) => {
        if (p in mockFiles) return mockFiles[p];
        throw new Error('ENOENT');
      });

      (fs.existsSync as jest.Mock).mockImplementation((p: string) => {
        if (p === path.join(PLUGIN_DIR, 'agents', 'empty.md')) return true;
        return p in mockFiles || mockDirs.has(p);
      });

      const result = scanPluginDetails(PLUGIN_DIR, null);

      expect(result.agents).toHaveLength(0);
    });

    it('handles command manifest pointing to a single .md file', () => {
      addDir(PLUGIN_DIR);
      addFile(
        path.join(PLUGIN_DIR, 'single-cmd.md'),
        agentMd('Single Command', 'A standalone command'),
      );

      const manifest: PluginManifest = { commands: 'single-cmd.md' };
      const result = scanPluginDetails(PLUGIN_DIR, manifest);

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].name).toBe('Single Command');
    });

    it('ignores non-.md files when manifest points to a single non-.md file', () => {
      addDir(PLUGIN_DIR);
      addFile(path.join(PLUGIN_DIR, 'cmd.txt'), agentMd('Text Cmd'));

      const manifest: PluginManifest = { commands: 'cmd.txt' };
      const result = scanPluginDetails(PLUGIN_DIR, manifest);

      expect(result.commands).toHaveLength(0);
    });
  });
});
