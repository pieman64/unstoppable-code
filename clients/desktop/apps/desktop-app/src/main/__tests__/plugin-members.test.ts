import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  discoverPluginCommandSources,
  discoverPluginMarkdownMembers,
  discoverPluginSkills,
} from '../plugins/plugin-members';

describe('plugin member discovery', () => {
  let tempDir = '';
  let pluginDir = '';
  beforeEach(() => {
    tempDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-plugin-members-')),
    );
    pluginDir = path.join(tempDir, 'plugin');
    fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeSkill(root: string, name: string): void {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(
      path.join(root, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name} skill\n---\n`,
    );
  }

  it('ignores a skills root that is a symbolic link, even when it lexically stays inside the plugin', () => {
    const outside = path.join(tempDir, 'outside-skills');
    writeSkill(outside, 'leaked');
    fs.symlinkSync(outside, path.join(pluginDir, 'skills'));
    expect(discoverPluginSkills(pluginDir, null)).toEqual([]);
    expect(
      discoverPluginSkills(pluginDir, { name: 'plugin', skills: './skills' }),
    ).toEqual([]);
  });

  it('ignores a commands root that is a symbolic link', () => {
    const outside = path.join(tempDir, 'outside-commands');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(
      path.join(outside, 'leak.md'),
      '---\ndescription: x\n---\nRun.\n',
    );
    fs.symlinkSync(outside, path.join(pluginDir, 'commands'));
    expect(discoverPluginMarkdownMembers(pluginDir, null, 'commands')).toEqual(
      [],
    );
    expect(discoverPluginCommandSources(pluginDir, null)).toEqual([]);
  });

  it('ignores a member root reached through an interior symbolic link, and says so', () => {
    // `isPathInside` is lexical and `lstat` inspects only the last segment,
    // so a link in the middle of a declared root would otherwise escape.
    const outside = path.join(tempDir, 'outside');
    writeSkill(path.join(outside, 'skills'), 'leaked');
    fs.mkdirSync(path.join(outside, 'commands'), { recursive: true });
    fs.writeFileSync(
      path.join(outside, 'commands', 'leak.md'),
      '---\ndescription: x\n---\nRun.\n',
    );
    fs.mkdirSync(path.join(pluginDir, 'nested'));
    fs.symlinkSync(outside, path.join(pluginDir, 'nested', 'link'));
    const manifest = {
      name: 'plugin',
      skills: './nested/link/skills',
      commands: './nested/link/commands',
    };
    const warnings: string[] = [];
    expect(discoverPluginSkills(pluginDir, manifest, warnings)).toEqual([]);
    expect(discoverPluginCommandSources(pluginDir, manifest, warnings)).toEqual(
      [],
    );
    expect(
      discoverPluginMarkdownMembers(pluginDir, manifest, 'commands', warnings),
    ).toEqual([]);
    expect(warnings).toEqual([
      expect.stringContaining(path.join('nested', 'link', 'skills')),
      expect.stringContaining(path.join('nested', 'link', 'commands')),
      expect.stringContaining(path.join('nested', 'link', 'commands')),
    ]);
    // A root that simply does not exist is ordinary and not reported.
    const quiet: string[] = [];
    expect(discoverPluginSkills(pluginDir, null, quiet)).toEqual([]);
    expect(quiet).toEqual([]);
  });

  it('reads each command once and returns its content with the parsed name and description', () => {
    fs.mkdirSync(path.join(pluginDir, 'commands'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'commands', 'ship.md'),
      '---\ndescription: Ship it\n---\nRelease $ARGUMENTS.\n',
    );
    expect(discoverPluginCommandSources(pluginDir, null)).toEqual([
      {
        name: 'ship',
        description: 'Ship it',
        filePath: path.join(pluginDir, 'commands', 'ship.md'),
        content: '---\ndescription: Ship it\n---\nRelease $ARGUMENTS.\n',
      },
    ]);
  });
});
