import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CursorCapabilityProjection } from '../../../lib/cursor-capabilities';
import { materializeCursorCapabilityRoot } from '../capability-root';

async function skillSource(
  root: string,
  name: string,
  files: Record<string, string> = {},
): Promise<string> {
  const dir = join(root, 'sources', name);
  await mkdir(join(dir, 'scripts'), { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n---\nUse ${name}.\n`,
  );
  for (const [relative, content] of Object.entries(files))
    await writeFile(join(dir, relative), content);
  return dir;
}

function projection(
  skills: CursorCapabilityProjection['skills'],
  commands: CursorCapabilityProjection['commands'] = [],
): CursorCapabilityProjection {
  return { skills, commands };
}

describe('materializeCursorCapabilityRoot', () => {
  let root = '';
  let home = '';
  beforeEach(async () => {
    // Source directories are handed over as canonical paths (the resolver
    // realpath-checks them), and macOS tmp dirs are symlinked.
    root = await realpath(await mkdtemp(join(tmpdir(), 'canopy-cursor-caps-')));
    home = join(root, 'home');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('keeps the generation stable across ordering and changes it when command content changes', async () => {
    const first = {
      id: 'first',
      markdown: 'One',
      description: '',
      label: 'First',
    };
    const second = {
      id: 'second',
      markdown: 'Two',
      description: '',
      label: 'Second',
    };
    const initial = await materializeCursorCapabilityRoot(
      home,
      projection([], [first, second]),
    );
    const reordered = await materializeCursorCapabilityRoot(
      home,
      projection([], [second, first]),
    );
    const changed = await materializeCursorCapabilityRoot(
      home,
      projection([], [{ ...first, markdown: 'Changed' }, second]),
    );
    expect(initial.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(initial.fingerprint).toBe(reordered.fingerprint);
    expect(changed.fingerprint).not.toBe(initial.fingerprint);
  });

  const verifiedContent = { maxSkillFiles: 2000, verifyContent: true };

  it('verifies a private root reached through a trusted home ancestor alias', async () => {
    const source = await skillSource(root, 'review');
    const realHome = join(root, 'homes');
    const alias = join(root, 'home-alias');
    await mkdir(realHome);
    await symlink(realHome, alias, 'junction');
    const aliasedHome = join(alias, 'private-chat');
    const caps = projection([
      { id: 'review', sourceDir: source, description: '', label: 'review' },
    ]);
    const first = await materializeCursorCapabilityRoot(
      aliasedHome,
      caps,
      verifiedContent,
    );
    expect(first.warnings).toEqual([]);
    expect(first.skillIds).toEqual(['review']);
    const copied = join(aliasedHome, '.cursor/skills/review/SKILL.md');
    await writeFile(copied, 'tampered private copy');
    const next = await materializeCursorCapabilityRoot(
      aliasedHome,
      caps,
      verifiedContent,
    );
    expect(next.skillIds).toEqual(['review']);
    expect(next.fingerprint).toBe(first.fingerprint);
    expect(await readFile(copied, 'utf8')).toBe(
      await readFile(join(source, 'SKILL.md'), 'utf8'),
    );
  });

  it.each(['.cursor', '.cursor/skills', '.cursor/commands'])(
    'rejects a private %s directory replaced with a symlink',
    async (entry) => {
      const outside = join(root, 'outside');
      await mkdir(outside);
      const linked = join(home, entry);
      await mkdir(join(linked, '..'), { recursive: true });
      await symlink(outside, linked, 'junction');
      await expect(
        materializeCursorCapabilityRoot(home, projection([]), verifiedContent),
      ).rejects.toThrow('private environment is invalid');
      expect(await readdir(outside)).toEqual([]);
    },
  );

  it('stops a cancelled content verification before creating a private root', async () => {
    const abort = new AbortController();
    abort.abort(new Error('Turn cancelled'));
    const options = { ...verifiedContent, signal: abort.signal };
    await expect(
      materializeCursorCapabilityRoot(home, projection([]), options),
    ).rejects.toThrow('Turn cancelled');
    await expect(lstat(home)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refreshes verified content after a same-size source rewrite with preserved mtime', async () => {
    const source = await skillSource(root, 'review', {
      'scripts/run.sh': 'echo hi\n',
    });
    const caps = projection([
      { id: 'review', sourceDir: source, description: '', label: 'review' },
    ]);
    const file = join(source, 'scripts', 'run.sh');
    await utimes(file, new Date('2020-01-01'), new Date('2020-01-01'));
    const initial = await materializeCursorCapabilityRoot(
      home,
      caps,
      verifiedContent,
    );
    const info = await stat(file);
    await writeFile(file, 'echo ok\n');
    await utimes(file, info.atime, info.mtime);
    const next = await materializeCursorCapabilityRoot(
      home,
      caps,
      verifiedContent,
    );
    expect(
      await readFile(
        join(home, '.cursor/skills/review/scripts/run.sh'),
        'utf8',
      ),
    ).toBe('echo ok\n');
    expect(next.fingerprint).not.toBe(initial.fingerprint);
  });

  it('keeps a verified content fingerprint stable when only source metadata changes', async () => {
    const source = await skillSource(root, 'review');
    const caps = projection([
      { id: 'review', sourceDir: source, description: '', label: 'review' },
    ]);
    const initial = await materializeCursorCapabilityRoot(
      home,
      caps,
      verifiedContent,
    );
    const file = join(source, 'SKILL.md');
    await utimes(file, new Date('2020-01-01'), new Date('2020-01-01'));
    const next = await materializeCursorCapabilityRoot(
      home,
      caps,
      verifiedContent,
    );
    expect(next.fingerprint).toBe(initial.fingerprint);
  });

  it.each(['modified', 'removed', 'symbolic link'])(
    'repairs a %s private copy before reporting verified content',
    async (kind) => {
      const source = await skillSource(root, 'review');
      const caps = projection([
        { id: 'review', sourceDir: source, description: '', label: 'review' },
      ]);
      const initial = await materializeCursorCapabilityRoot(
        home,
        caps,
        verifiedContent,
      );
      const copied = join(home, '.cursor/skills/review/SKILL.md');
      if (kind === 'modified')
        await writeFile(copied, 'stale private instructions');
      else {
        await rm(copied);
        if (kind === 'symbolic link')
          await symlink(join(source, 'SKILL.md'), copied);
      }
      const next = await materializeCursorCapabilityRoot(
        home,
        caps,
        verifiedContent,
      );
      expect((await lstat(copied)).isSymbolicLink()).toBe(false);
      expect(await readFile(copied, 'utf8')).toBe(
        await readFile(join(source, 'SKILL.md'), 'utf8'),
      );
      expect(next.fingerprint).toBe(initial.fingerprint);
    },
  );

  (process.platform === 'win32' ? it.skip : it)(
    'preserves executable scripts in verified copies',
    async () => {
      const source = await skillSource(root, 'review', {
        'scripts/run.sh': '#!/bin/sh\necho ok\n',
      });
      await chmod(join(source, 'scripts/run.sh'), 0o755);
      const result = await materializeCursorCapabilityRoot(
        home,
        projection([
          { id: 'review', sourceDir: source, description: '', label: 'review' },
        ]),
        verifiedContent,
      );
      expect(result.skillIds).toEqual(['review']);
      expect(
        (await stat(join(home, '.cursor/skills/review/scripts/run.sh'))).mode &
          0o111,
      ).toBe(0o111);
    },
  );

  (process.platform === 'win32' ? it.skip : it).each([0o027, 0o077])(
    'preserves verified executable content under umask %s',
    async (mask) => {
      const source = await skillSource(root, 'review', {
        'scripts/run.sh': '#!/bin/sh\necho ok\n',
      });
      await chmod(join(source, 'scripts/run.sh'), 0o755);
      const caps = projection([
        { id: 'review', sourceDir: source, description: '', label: 'review' },
      ]);
      const previousMask = process.umask(mask);
      try {
        const first = await materializeCursorCapabilityRoot(
          home,
          caps,
          verifiedContent,
        );
        expect(first.warnings).toEqual([]);
        expect(first.skillIds).toEqual(['review']);
        const copied = join(home, '.cursor/skills/review/scripts/run.sh');
        expect((await stat(copied)).mode & 0o777).toBe(0o755);
        const next = await materializeCursorCapabilityRoot(
          home,
          caps,
          verifiedContent,
        );
        expect(next.warnings).toEqual([]);
        expect(next.fingerprint).toBe(first.fingerprint);
      } finally {
        process.umask(previousMask);
      }
    },
  );

  (process.platform === 'win32' ? it.skip : it)(
    'refreshes verified identity and copied mode when a script becomes executable',
    async () => {
      const source = await skillSource(root, 'review', {
        'scripts/run.sh': '#!/bin/sh\necho ok\n',
      });
      const caps = projection([
        { id: 'review', sourceDir: source, description: '', label: 'review' },
      ]);
      const first = await materializeCursorCapabilityRoot(
        home,
        caps,
        verifiedContent,
      );
      await chmod(join(source, 'scripts/run.sh'), 0o755);
      const next = await materializeCursorCapabilityRoot(
        home,
        caps,
        verifiedContent,
      );
      expect(next.fingerprint).not.toBe(first.fingerprint);
      expect(
        (await stat(join(home, '.cursor/skills/review/scripts/run.sh'))).mode &
          0o111,
      ).toBe(0o111);
    },
  );

  it('copies selected skills and writes commands under the private .cursor root', async () => {
    const review = await skillSource(root, 'review', {
      'scripts/run.sh': 'echo hi\n',
    });
    const result = await materializeCursorCapabilityRoot(
      home,
      projection(
        [
          {
            id: 'review',
            sourceDir: review,
            description: 'r',
            label: 'review',
          },
        ],
        [
          {
            id: 'ship',
            markdown: '# Ship\n\nGo.\n',
            description: 'Ship',
            label: 'ship',
          },
        ],
      ),
    );
    expect(result).toMatchObject({
      skillIds: ['review'],
      commandIds: ['ship'],
      warnings: [],
    });
    expect(
      await readFile(
        join(home, '.cursor', 'skills', 'review', 'SKILL.md'),
        'utf8',
      ),
    ).toContain('Use review.');
    expect(
      await readFile(
        join(home, '.cursor', 'skills', 'review', 'scripts', 'run.sh'),
        'utf8',
      ),
    ).toBe('echo hi\n');
    expect(
      await readFile(join(home, '.cursor', 'commands', 'ship.md'), 'utf8'),
    ).toBe('# Ship\n\nGo.\n');
    // A real directory, not a link: the CLI realpath-checks skill roots.
    expect(
      (await lstat(join(home, '.cursor', 'skills', 'review'))).isSymbolicLink(),
    ).toBe(false);
  });

  it('prunes ids that are no longer selected, down to an empty root', async () => {
    const review = await skillSource(root, 'review');
    const caps = projection(
      [{ id: 'review', sourceDir: review, description: '', label: 'review' }],
      [{ id: 'ship', markdown: '# Ship\n', description: '', label: 'ship' }],
    );
    await materializeCursorCapabilityRoot(home, caps);
    // Something the CLI or a stale run left behind is removed too.
    await writeFile(join(home, '.cursor', 'commands', 'stray.md'), '# stray\n');
    const result = await materializeCursorCapabilityRoot(
      home,
      projection([], []),
    );
    expect(result).toMatchObject({
      skillIds: [],
      commandIds: [],
      warnings: [],
    });
    expect(await readdir(join(home, '.cursor', 'skills'))).toEqual([]);
    expect(await readdir(join(home, '.cursor', 'commands'))).toEqual([]);
  });

  it('skips symlinks inside a skill with a warning and copies the rest', async () => {
    const review = await skillSource(root, 'review');
    await writeFile(join(root, 'outside.txt'), 'secret');
    await symlink(join(root, 'outside.txt'), join(review, 'link.txt'));
    const result = await materializeCursorCapabilityRoot(
      home,
      projection([
        { id: 'review', sourceDir: review, description: '', label: 'review' },
      ]),
    );
    expect(result.skillIds).toEqual(['review']);
    expect(result.warnings).toEqual([expect.stringContaining('"review"')]);
    expect(result.warnings[0]).toContain('link.txt');
    await expect(
      lstat(join(home, '.cursor', 'skills', 'review', 'link.txt')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      await readFile(
        join(home, '.cursor', 'skills', 'review', 'SKILL.md'),
        'utf8',
      ),
    ).toContain('Use review.');
  });

  it('refuses a skill whose source directory is itself a symbolic link', async () => {
    const real = await skillSource(root, 'review');
    const link = join(root, 'sources', 'linked');
    await symlink(real, link);
    const result = await materializeCursorCapabilityRoot(
      home,
      projection([
        { id: 'review', sourceDir: link, description: '', label: 'review' },
      ]),
    );
    expect(result.skillIds).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining('"review"')]);
    await expect(
      lstat(join(home, '.cursor', 'skills', 'review')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a skill reached through an interior symbolic link', async () => {
    await skillSource(root, 'review');
    await mkdir(join(root, 'via'));
    await symlink(join(root, 'sources'), join(root, 'via', 'link'));
    // The last segment is a real directory; the link sits above it.
    const viaLink = join(root, 'via', 'link', 'review');
    const result = await materializeCursorCapabilityRoot(
      home,
      projection([
        { id: 'review', sourceDir: viaLink, description: '', label: 'review' },
      ]),
    );
    expect(result.skillIds).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining('"review"')]);
    await expect(
      lstat(join(home, '.cursor', 'skills', 'review')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not read skill files again when their sizes and mtimes are unchanged', async () => {
    const review = await skillSource(root, 'review', {
      'scripts/run.sh': 'echo hi\n',
    });
    const caps = projection([
      { id: 'review', sourceDir: review, description: '', label: 'review' },
    ]);
    await materializeCursorCapabilityRoot(home, caps);
    // Reading either file now fails; an unchanged tree must not need to.
    await chmod(join(review, 'SKILL.md'), 0o000);
    await chmod(join(review, 'scripts', 'run.sh'), 0o000);
    try {
      expect(await materializeCursorCapabilityRoot(home, caps)).toMatchObject({
        skillIds: ['review'],
        commandIds: [],
        warnings: [],
      });
    } finally {
      await chmod(join(review, 'SKILL.md'), 0o600);
      await chmod(join(review, 'scripts', 'run.sh'), 0o600);
    }
    // A changed file is copied again on the next turn.
    await writeFile(join(review, 'SKILL.md'), '# review v2\n');
    const future = new Date(Date.now() + 5_000);
    await utimes(join(review, 'SKILL.md'), future, future);
    await materializeCursorCapabilityRoot(home, caps);
    expect(
      await readFile(
        join(home, '.cursor', 'skills', 'review', 'SKILL.md'),
        'utf8',
      ),
    ).toBe('# review v2\n');
  });

  it('accepts ids that collide with Object.prototype names', async () => {
    const source = await skillSource(root, 'constructor');
    const result = await materializeCursorCapabilityRoot(
      home,
      projection(
        [{ id: 'constructor', sourceDir: source, description: '', label: 'c' }],
        [
          {
            id: 'hasownproperty',
            markdown: '# h\n',
            description: '',
            label: 'h',
          },
        ],
      ),
    );
    expect(result).toMatchObject({
      skillIds: ['constructor'],
      commandIds: ['hasownproperty'],
      warnings: [],
    });
    // And a stale entry with such a name is pruned like any other.
    await materializeCursorCapabilityRoot(home, projection([], []));
    expect(await readdir(join(home, '.cursor', 'skills'))).toEqual([]);
    expect(await readdir(join(home, '.cursor', 'commands'))).toEqual([]);
  });

  it('omits an oversized skill with a warning instead of copying part of it', async () => {
    const big = await skillSource(root, 'big', { 'data.bin': 'x'.repeat(64) });
    const result = await materializeCursorCapabilityRoot(
      home,
      projection([
        { id: 'big', sourceDir: big, description: '', label: 'big' },
      ]),
      { maxSkillBytes: 32 },
    );
    expect(result.skillIds).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining('"big"')]);
    await expect(
      lstat(join(home, '.cursor', 'skills', 'big')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses an id that is not a valid invocation id and never writes outside .cursor', async () => {
    const review = await skillSource(root, 'review');
    const result = await materializeCursorCapabilityRoot(
      home,
      projection(
        [{ id: '../evil', sourceDir: review, description: '', label: 'evil' }],
        [{ id: 'Bad Name', markdown: '# x\n', description: '', label: 'bad' }],
      ),
    );
    expect(result.skillIds).toEqual([]);
    expect(result.commandIds).toEqual([]);
    expect(result.warnings).toHaveLength(2);
    await expect(lstat(join(home, 'evil'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readdir(join(home, '.cursor', 'commands'))).toEqual([]);
  });

  it('leaves an unchanged skill alone on the next turn and rewrites a changed command', async () => {
    const review = await skillSource(root, 'review');
    const caps = (markdown: string): CursorCapabilityProjection =>
      projection(
        [{ id: 'review', sourceDir: review, description: '', label: 'review' }],
        [{ id: 'ship', markdown, description: '', label: 'ship' }],
      );
    await materializeCursorCapabilityRoot(home, caps('# v1\n'));
    const skillMd = join(home, '.cursor', 'skills', 'review', 'SKILL.md');
    const past = new Date(Date.now() - 60_000);
    await utimes(skillMd, past, past);
    await materializeCursorCapabilityRoot(home, caps('# v2\n'));
    expect((await stat(skillMd)).mtimeMs).toBeCloseTo(past.getTime(), -3);
    expect(
      await readFile(join(home, '.cursor', 'commands', 'ship.md'), 'utf8'),
    ).toBe('# v2\n');
  });
});
