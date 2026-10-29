import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverInheritedCursorCapabilities,
  emptyInheritedCursorCapabilities,
  type InheritedCursorRoots,
} from '../inherited-capabilities';

async function skill(
  dir: string,
  name: string,
  frontmatter = `name: ${name}\ndescription: ${name} skill`,
): Promise<string> {
  const skillDir = join(dir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, 'SKILL.md'),
    `---\n${frontmatter}\n---\nUse ${name}.\n`,
  );
  return skillDir;
}

describe('discoverInheritedCursorCapabilities', () => {
  let root = '';
  let roots: InheritedCursorRoots;
  beforeEach(async () => {
    // macOS tmp dirs are symlinked; canonical paths keep the realpath
    // assertions below honest.
    root = await realpath(
      await mkdtemp(join(tmpdir(), 'canopy-cursor-inherited-')),
    );
    roots = {
      userHome: join(root, 'home'),
      claudeConfigDir: join(root, 'claude-config'),
      codexHome: join(root, 'codex-home'),
    };
    await mkdir(roots.userHome, { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads the five skill roots in the order the CLI does, and both command roots', async () => {
    await skill(join(roots.userHome, '.cursor', 'skills'), 'alpha');
    await skill(
      join(roots.claudeConfigDir, 'skills'),
      'bravo',
      'description: Claude bravo\nuser-invocable: false',
    );
    await skill(join(roots.codexHome, 'skills'), 'charlie');
    await skill(join(roots.userHome, '.grok', 'skills'), 'delta');
    await skill(join(roots.userHome, '.agents', 'skills'), 'echo');
    await mkdir(join(roots.userHome, '.cursor', 'commands'), {
      recursive: true,
    });
    await writeFile(
      join(roots.userHome, '.cursor', 'commands', 'ship.md'),
      '# Ship it\n\nShip $ARGUMENTS.\n',
    );
    await mkdir(join(roots.claudeConfigDir, 'commands'), { recursive: true });
    await writeFile(
      join(roots.claudeConfigDir, 'commands', 'release.md'),
      '---\ndescription: Release\n---\nCut a release.\n',
    );

    const result = await discoverInheritedCursorCapabilities(roots);

    expect(
      result.skills.map((entry) => `${entry.origin}:${entry.name}`),
    ).toEqual([
      'cursor:alpha',
      'claude:bravo',
      'codex:charlie',
      'grok:delta',
      'agents:echo',
    ]);
    expect(result.skills[0]).toEqual({
      origin: 'cursor',
      name: 'alpha',
      sourceDir: join(roots.userHome, '.cursor', 'skills', 'alpha'),
      description: 'alpha skill',
      userInvocable: true,
    });
    expect(result.skills[1]).toMatchObject({
      description: 'Claude bravo',
      userInvocable: false,
    });
    // Command content is copied as-is: the CLI parses no frontmatter and
    // takes the first heading as the description, else the file stem.
    expect(result.commands).toEqual([
      {
        origin: 'cursor',
        name: 'ship',
        markdown: '# Ship it\n\nShip $ARGUMENTS.\n',
        description: 'Ship it',
      },
      {
        origin: 'claude',
        name: 'release',
        markdown: '---\ndescription: Release\n---\nCut a release.\n',
        description: 'release',
      },
    ]);
    expect(result.skipped).toEqual([]);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns nothing, and no complaints, when no root exists', async () => {
    const result = await discoverInheritedCursorCapabilities(roots);
    expect(result).toMatchObject({ skills: [], commands: [], skipped: [] });
    expect(result.fingerprint).toBe(
      emptyInheritedCursorCapabilities().fingerprint,
    );
  });

  it('follows a linked skill to its canonical directory and reports one entry per directory', async () => {
    const real = await skill(join(root, 'elsewhere'), 'linked');
    await mkdir(join(roots.userHome, '.cursor', 'skills'), { recursive: true });
    await symlink(real, join(roots.userHome, '.cursor', 'skills', 'linked'));
    await mkdir(join(roots.claudeConfigDir, 'skills'), { recursive: true });
    await symlink(
      real,
      join(roots.claudeConfigDir, 'skills', 'same-skill-again'),
    );

    const result = await discoverInheritedCursorCapabilities(roots);

    expect(result.skills).toEqual([
      {
        origin: 'cursor',
        name: 'linked',
        sourceDir: real,
        description: 'linked skill',
        userInvocable: true,
      },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it('hides the Codex built-in skill names under the Codex root only', async () => {
    await skill(join(roots.codexHome, 'skills'), 'skill-creator');
    await skill(join(roots.userHome, '.cursor', 'skills'), 'skill-creator');

    const result = await discoverInheritedCursorCapabilities(roots);

    expect(result.skills.map((entry) => entry.origin)).toEqual(['cursor']);
  });

  it('skips folders without a regular SKILL.md, dot-folders, loose files, and names that cannot become an id', async () => {
    const skillsDir = join(roots.userHome, '.cursor', 'skills');
    await mkdir(join(skillsDir, 'no-skill-md'), { recursive: true });
    await mkdir(join(skillsDir, '.hidden'), { recursive: true });
    await writeFile(join(skillsDir, '.hidden', 'SKILL.md'), '# hidden\n');
    await writeFile(join(skillsDir, 'loose-file.md'), '# not a skill\n');
    await skill(skillsDir, '___');

    const result = await discoverInheritedCursorCapabilities(roots);

    expect(result.skills).toEqual([]);
    expect(result.skipped).toEqual([
      {
        label: '~/.cursor/skills/___',
        reason: 'its name cannot be used as a Cursor skill id',
      },
    ]);
  });

  async function cachedPlugin(
    marketplace: string,
    plugin: string,
    sha: string,
    options: {
      complete?: boolean;
      manifest?: Record<string, unknown> | null;
      manifestDir?: '.cursor-plugin' | '.claude-plugin';
      skills?: string[];
      commands?: Record<string, string>;
      skillsDir?: string;
    } = {},
  ): Promise<string> {
    const dir = join(
      roots.userHome,
      '.cursor',
      'plugins',
      'cache',
      marketplace,
      plugin,
      sha,
    );
    await mkdir(dir, { recursive: true });
    if (options.complete !== false)
      await writeFile(join(dir, '.cache-complete'), '');
    if (options.manifest !== null) {
      const manifestDir = join(dir, options.manifestDir ?? '.cursor-plugin');
      await mkdir(manifestDir, { recursive: true });
      await writeFile(
        join(manifestDir, 'plugin.json'),
        JSON.stringify({ name: plugin, ...(options.manifest ?? {}) }),
      );
    }
    for (const name of options.skills ?? [])
      await skill(join(dir, options.skillsDir ?? 'skills'), name);
    for (const [name, markdown] of Object.entries(options.commands ?? {})) {
      await mkdir(join(dir, 'commands'), { recursive: true });
      await writeFile(join(dir, 'commands', `${name}.md`), markdown);
    }
    return dir;
  }

  it('reads skills and commands from complete cached Cursor plugins, after the home roots', async () => {
    await skill(join(roots.userHome, '.cursor', 'skills'), 'alpha');
    const superpowers = await cachedPlugin(
      'cursor-public',
      'superpowers',
      'aaaa',
      {
        manifest: { skills: './skills/' },
        skills: ['brainstorming'],
        commands: { ship: '# Ship it\n\nShip $ARGUMENTS.\n' },
      },
    );
    // A Claude-format manifest and no `skills` key: the default folder.
    const airtable = await cachedPlugin('cursor-public', 'airtable', 'bbbb', {
      manifestDir: '.claude-plugin',
      skills: ['airtable-schema'],
    });
    // A download that never completed is not installed.
    await cachedPlugin('cursor-public', 'tabnine', 'cccc', {
      complete: false,
      skills: ['tabnine-chat'],
    });

    const result = await discoverInheritedCursorCapabilities(roots);

    expect(
      result.skills.map(
        (entry) => `${entry.origin}:${entry.plugin ?? '-'}:${entry.name}`,
      ),
    ).toEqual([
      'cursor:-:alpha',
      'cursor-plugin:cursor-public/airtable:airtable-schema',
      'cursor-plugin:cursor-public/superpowers:brainstorming',
    ]);
    expect(result.skills[2]).toEqual({
      origin: 'cursor-plugin',
      plugin: 'cursor-public/superpowers',
      name: 'brainstorming',
      sourceDir: join(superpowers, 'skills', 'brainstorming'),
      description: 'brainstorming skill',
      userInvocable: true,
    });
    expect(result.skills[1].sourceDir).toBe(
      join(airtable, 'skills', 'airtable-schema'),
    );
    expect(result.commands).toEqual([
      {
        origin: 'cursor-plugin',
        plugin: 'cursor-public/superpowers',
        name: 'ship',
        markdown: '# Ship it\n\nShip $ARGUMENTS.\n',
        description: 'Ship it',
      },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it('uses only the most recently completed version of a cached plugin', async () => {
    const older = await cachedPlugin('cursor-public', 'parallel', 'old1', {
      skills: ['old-skill'],
    });
    const later = new Date(Date.now() + 60_000);
    const newer = await cachedPlugin('cursor-public', 'parallel', 'new1', {
      skills: ['new-skill'],
    });
    await utimes(join(newer, '.cache-complete'), later, later);
    await utimes(
      join(older, '.cache-complete'),
      new Date(2020, 0, 1),
      new Date(2020, 0, 1),
    );

    const result = await discoverInheritedCursorCapabilities(roots);

    expect(result.skills.map((entry) => entry.name)).toEqual(['new-skill']);
  });

  it('reads the command files and single skill folders a manifest lists, once each, alongside the conventional folders', async () => {
    // The parallel plugin, as published: `commands` is a list of files that
    // also live in the conventional folder. Manifest paths add to the
    // conventional folders rather than replacing them, and a listed folder
    // that is itself a skill is one skill.
    const dir = await cachedPlugin('cursor-public', 'parallel', 'p1', {
      manifest: {
        skills: ['./skills/', './extra/solo-skill'],
        commands: ['commands/ship.md', './more/deploy.md'],
      },
      skills: ['alpha'],
      commands: {
        ship: '# Ship\n\nShip.\n',
        other: '# Other\n\nOther.\n',
      },
    });
    await skill(join(dir, 'extra'), 'solo-skill');
    await mkdir(join(dir, 'more'), { recursive: true });
    await writeFile(join(dir, 'more', 'deploy.md'), '# Deploy\n\nDeploy.\n');

    const result = await discoverInheritedCursorCapabilities(roots);

    expect(result.skills.map((entry) => entry.name)).toEqual([
      'alpha',
      'solo-skill',
    ]);
    expect(result.commands.map((entry) => entry.name)).toEqual([
      'other',
      'ship',
      'deploy',
    ]);
    expect(result.skipped).toEqual([]);
  });

  it('keeps cached plugin members inside their plugin: escaping manifest paths and links to outside files are skipped and reported', async () => {
    // Plugin content is third-party. A manifest path or a link that leaves
    // the plugin would otherwise put any local file into the chat.
    const outside = join(root, 'outside');
    await skill(join(outside, 'skills'), 'evil');
    await mkdir(join(outside, 'cmds'), { recursive: true });
    await writeFile(join(outside, 'cmds', 'leak.md'), '# Leak\n\nsecret\n');
    await writeFile(join(outside, 'auth.json'), '{"token":"secret"}\n');
    const dir = await cachedPlugin('cursor-public', 'sneaky', 's1', {
      manifest: {
        skills: ['./skills/', '../../../../../outside/skills'],
        commands: ['commands', join(outside, 'cmds')],
      },
      skills: ['good'],
      commands: { fine: '# Fine\n\nOk.\n' },
    });
    await symlink(
      join(outside, 'auth.json'),
      join(dir, 'commands', 'creds.md'),
    );
    await symlink(
      join(outside, 'skills', 'evil'),
      join(dir, 'skills', 'linked'),
    );

    const result = await discoverInheritedCursorCapabilities(roots);

    expect(result.skills.map((entry) => entry.name)).toEqual(['good']);
    expect(result.commands.map((entry) => entry.name)).toEqual(['fine']);
    expect(result.skipped.map((entry) => entry.label).sort()).toEqual([
      '~/.cursor/plugins/cursor-public/sneaky',
      '~/.cursor/plugins/cursor-public/sneaky',
      '~/.cursor/plugins/cursor-public/sneaky/creds',
      '~/.cursor/plugins/cursor-public/sneaky/linked',
    ]);
    for (const entry of result.skipped)
      expect(entry.reason).toContain('outside');
  });

  it('changes the fingerprint when a skill is added or its SKILL.md changes, and not otherwise', async () => {
    const dir = join(roots.userHome, '.cursor', 'skills');
    const alpha = await skill(dir, 'alpha');
    const first = (await discoverInheritedCursorCapabilities(roots))
      .fingerprint;
    expect((await discoverInheritedCursorCapabilities(roots)).fingerprint).toBe(
      first,
    );
    const later = new Date(2030, 0, 1);
    await utimes(join(alpha, 'SKILL.md'), later, later);
    const second = (await discoverInheritedCursorCapabilities(roots))
      .fingerprint;
    expect(second).not.toBe(first);
    await skill(dir, 'beta');
    expect(
      (await discoverInheritedCursorCapabilities(roots)).fingerprint,
    ).not.toBe(second);
  });
});
