import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { buildSync } from 'esbuild';
import { parseRepoRule, isDuplicate } from '../parsing';
import { discoverRules, readSessionRules } from '../discovery';
import { renderRepoRules } from '../rendering';
import { RepoRulesStateStore } from '../state';
import { RepoRulesService } from '../service';
import { stat, readdir } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { editorSetupPresence } from '../presence';
import { parseGitIndex } from '../eligibility';
import { readBounded, validRelativePath } from '../safety';
import * as safety from '../safety';
import * as sharedReader from '@canopy/desktop-shared/node/lib/bounded-file-reader';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'repo-rules-'));
  execFileSync('git', ['init', '-q', root]);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function file(path: string, text: string): Promise<void> {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), text);
}
const repo = (): { repoId: string; root: string; prefix: string } => ({
  repoId: 'single',
  root,
  prefix: '',
});

describe('parsing', () => {
  it.each(['src/**/*.{ts,tsx', 'src/[ab.ts', '!(test)/**', 'src/{a,b]/**'])(
    'flags unsupported glob syntax without automatic activation: %s',
    (glob) => {
      const rule = parseRepoRule(
        'single',
        '.cursor/rules/a.mdc',
        `---\nglobs: '${glob}'\n---\nbody`,
      );
      expect(rule.flags).toContain('unsupported-glob');
      expect(renderRepoRules([rule], [repo()], 0)).toContain(
        'only on an explicit user mention',
      );
    },
  );
  it.each([
    ['---\nalwaysApply: true\nglobs: "*.ts"\n---\nbody', 'always'],
    [
      '---\nglobs: "src/**/*.{ts,tsx}, test/**"\ndescription: hello\n---\nbody',
      'auto',
    ],
    ['---\ndescription: hello\n---\nbody', 'agent-requested'],
    ['---\n---\nbody', 'manual'],
    ['plain', 'manual'],
  ])('classifies %s', (text, kind) => {
    expect(parseRepoRule('single', '.cursor/rules/a.mdc', text).kind).toBe(
      kind,
    );
  });
  it('rejects an explicit scalar null while allowing an empty YAML header', () => {
    expect(
      parseRepoRule('r', '.cursor/rules/a.mdc', '---\nnull\n---\nbody').flags,
    ).toContain('malformed-frontmatter');
    expect(
      parseRepoRule('r', '.cursor/rules/a.mdc', '---\n# comment\n---\nbody')
        .flags,
    ).not.toContain('malformed-frontmatter');
  });
  it('keeps brace commas and array globs', () => {
    expect(
      parseRepoRule(
        'r',
        '.cursor/rules/a.mdc',
        '---\nglobs: "**/*.{ts,tsx}, !test/**"\n---\na',
      ).globs,
    ).toEqual(['**/*.{ts,tsx}', '!test/**']);
    expect(
      parseRepoRule(
        'r',
        '.cursor/rules/a.mdc',
        '---\nglobs: [" *.ts ", ""]\n---\na',
      ).globs,
    ).toEqual(['*.ts']);
  });
  it.each([
    'alwaysApply: "true"',
    'globs: 5',
    'description: []',
    '[bad',
    '- hello',
  ])('flags invalid headers without losing text', (header) => {
    const result = parseRepoRule(
      'r',
      '.cursor/rules/a.mdc',
      `---\n${header}\n---\nbody`,
    );
    expect(result.kind).toBe('manual');
    expect(result.flags).toContain('malformed-frontmatter');
    expect(result.body).toContain('body');
  });
  it('handles BOM, CRLF, unknown fields and nested scope', () => {
    const result = parseRepoRule(
      'r',
      'sub/.cursor/rules/group/a.mdc',
      '\ufeff---\r\nalwaysApply: true\r\nextra: yes\r\n---\r\nbody',
    );
    expect(result.scope).toBe('sub/');
    expect(result.kind).toBe('always');
    expect(result.flags).toContain('unsupported-frontmatter');
    expect(result.body).toBe('body');
  });
  it('handles the duplicate threshold and empty text', () => {
    expect(isDuplicate('- A\n\nB\n\nC\n\nD\n\nE', ['a\n\nb\n\nc\n\nd'])).toBe(
      true,
    );
    expect(isDuplicate('A\n\nB\n\nC', ['a\n\nb'])).toBe(false);
    expect(isDuplicate('', [''])).toBe(false);
  });
});

describe('worker discovery', () => {
  it.each(['filename', 'directory'])(
    'preserves selections across %s case aliases and distinct case-sensitive files',
    async (kind) => {
      const physical = '.cursor/rules/group/lower.mdc';
      const tracked =
        kind === 'filename'
          ? '.cursor/rules/group/LOWER.mdc'
          : '.cursor/rules/GROUP/lower.mdc';
      await file(physical, '---\nalwaysApply: true\n---\nPHYSICAL_RULE');
      const physicalStat = await stat(join(root, physical));
      const trackedStat = await stat(join(root, tracked)).catch(() => null);
      const alias = trackedStat?.ino === physicalStat.ino;
      execFileSync('git', [
        '-C',
        root,
        'config',
        'core.ignorecase',
        alias ? 'true' : 'false',
      ]);
      if (!alias)
        await file(tracked, '---\nalwaysApply: true\n---\nTRACKED_RULE');
      const hash = execFileSync(
        'git',
        ['-C', root, 'hash-object', '-w', tracked],
        { encoding: 'utf8' },
      ).trim();
      execFileSync('git', [
        '-C',
        root,
        'update-index',
        '--add',
        '--cacheinfo',
        '100644',
        hash,
        tracked,
      ]);
      const store = new RepoRulesStateStore(() => join(root, 'policy.json'));
      const service = new RepoRulesService(store, () =>
        Promise.resolve([repo()]),
      );
      const scan = await service.scan('a', { workspaceId: 'w' });
      expect(scan.proposals.map((r) => r.id).sort()).toEqual(
        (alias
          ? [`single:${tracked}`]
          : [`single:${tracked}`, `single:${physical}`]
        ).sort(),
      );
      await service.apply('a', {
        workspaceId: 'w',
        enabled: true,
        scanId: scan.scanId,
        disabledRuleIds: [`single:${tracked}`],
      });
      const session = await readSessionRules([repo()], {});
      expect(session.rules.map((r) => r.id).sort()).toEqual(
        scan.proposals.map((r) => r.id).sort(),
      );
      const composed = await service.compose('w', [repo()]);
      if (alias) expect(composed).not.toContain('PHYSICAL_RULE');
      else {
        expect(composed).toContain('PHYSICAL_RULE');
        expect(composed).not.toContain('TRACKED_RULE');
      }
    },
  );
  it('offers the session spelling when the index tracks two spellings of one file', async () => {
    const lower = '.cursor/rules/a.mdc';
    const upper = '.cursor/rules/A.mdc';
    await file(lower, '---\nalwaysApply: true\n---\nALIASED_RULE');
    const upperStat = await stat(join(root, upper)).catch(() => null);
    const alias = upperStat?.ino === (await stat(join(root, lower))).ino;
    if (!alias) await file(upper, '---\nalwaysApply: true\n---\nUPPER_RULE');
    // Both spellings committed from a case-sensitive checkout.
    execFileSync('git', ['-C', root, 'config', 'core.ignorecase', 'false']);
    for (const path of [upper, lower]) {
      const hash = execFileSync(
        'git',
        ['-C', root, 'hash-object', '-w', path],
        { encoding: 'utf8' },
      ).trim();
      execFileSync('git', [
        '-C',
        root,
        'update-index',
        '--add',
        '--cacheinfo',
        '100644',
        hash,
        path,
      ]);
    }
    execFileSync('git', [
      '-C',
      root,
      'config',
      'core.ignorecase',
      alias ? 'true' : 'false',
    ]);
    const store = new RepoRulesStateStore(() => join(root, 'policy.json'));
    const service = new RepoRulesService(store, () =>
      Promise.resolve([repo()]),
    );
    const scan = await service.scan('a', { workspaceId: 'w' });
    const session = await readSessionRules([repo()], {});
    expect(scan.proposals.map((r) => r.id).sort()).toEqual(
      session.rules.map((r) => r.id).sort(),
    );
    expect(scan.proposals).toHaveLength(alias ? 1 : 2);
    await service.apply('a', {
      workspaceId: 'w',
      enabled: true,
      scanId: scan.scanId,
      disabledRuleIds: scan.proposals.map((r) => r.id),
    });
    expect(await service.compose('w', [repo()])).not.toContain('ALIASED_RULE');
  });
  it('offers the index spelling when an untracked alias names the same file', async () => {
    const lower = '.cursor/rules/a.mdc';
    const upper = '.cursor/rules/A.mdc';
    await file(lower, '---\nalwaysApply: true\n---\nALIASED_RULE');
    const upperStat = await stat(join(root, upper)).catch(() => null);
    const alias = upperStat?.ino === (await stat(join(root, lower))).ino;
    // The index spells the file differently from disk, and Git compares
    // names case-sensitively, so the disk spelling is also untracked.
    execFileSync('git', ['-C', root, 'config', 'core.ignorecase', 'false']);
    const hash = execFileSync('git', ['-C', root, 'hash-object', '-w', lower], {
      encoding: 'utf8',
    }).trim();
    execFileSync('git', [
      '-C',
      root,
      'update-index',
      '--add',
      '--cacheinfo',
      '100644',
      hash,
      upper,
    ]);
    const service = new RepoRulesService(
      new RepoRulesStateStore(() => join(root, 'policy.json')),
      () => Promise.resolve([repo()]),
    );
    const scan = await service.scan('a', { workspaceId: 'w' });
    const session = await readSessionRules([repo()], {});
    expect(scan.proposals.map((r) => r.id).sort()).toEqual(
      session.rules.map((r) => r.id).sort(),
    );
    if (alias)
      expect(scan.proposals.map((r) => r.id)).toEqual([`single:${upper}`]);
    await service.apply('a', {
      workspaceId: 'w',
      enabled: true,
      scanId: scan.scanId,
      disabledRuleIds: scan.proposals.map((r) => r.id),
    });
    expect(await service.compose('w', [repo()])).not.toContain('ALIASED_RULE');
  });
  it.each(['.CURSOR/rules', '.cursor/RULES'])(
    'keeps actual rule-directory casing consistent with scanning: %s',
    async (directory) => {
      await file(
        `${directory}/hidden.mdc`,
        '---\nalwaysApply: true\n---\nUNREVIEWED_CASE_RULE',
      );
      const scan = await discoverRules([repo()]);
      expect(scan.rules).toHaveLength(0);
      expect((await readSessionRules([repo()], {})).rules).toHaveLength(0);
    },
  );
  it.each(['true', 'false', '"true"', '"false"'])(
    'keeps scan/session ignore eligibility with core.ignorecase=%s',
    async (value) => {
      const config = await readFile(join(root, '.git/config'), 'utf8');
      await file('.git/config', `${config}\n[core]\nignorecase = ${value}\n`);
      const ignorecase =
        execFileSync(
          'git',
          ['-C', root, 'config', '--bool', 'core.ignorecase'],
          { encoding: 'utf8' },
        ).trim() === 'true';
      await file('.gitignore', '.CURSOR/\n');
      await file('.cursor/rules/a.mdc', 'body');
      const scan = await discoverRules([repo()]);
      const session = await readSessionRules([repo()], {});
      expect(session.rules.map((r) => r.id)).toEqual(
        scan.rules.map((r) => r.id),
      );
      expect(session.rules).toHaveLength(ignorecase ? 0 : 1);
    },
  );
  it.each(['ignorecase = true', 'excludesfile = exclude-patterns'])(
    'keeps scan/session eligibility with CRLF Git config %s',
    async (setting) => {
      await file('.cursorrules', 'visible root rule');
      await file('.cursor/rules/hidden.mdc', 'excluded rule');
      await file(
        '.gitignore',
        setting.startsWith('ignorecase') ? '.CURSOR/\n' : '',
      );
      await file('exclude-patterns', '*.mdc\n');
      const config = await readFile(join(root, '.git/config'), 'utf8');
      await file(
        '.git/config',
        `${config.replace(/\r?\n/g, '\r\n')}\r\n[core]\r\n${setting}\r\n`,
      );
      expect(
        execFileSync(
          'git',
          ['-C', root, 'config', '--get', `core.${setting.split(' ')[0]}`],
          { encoding: 'utf8' },
        ).trim(),
      ).toBe(setting.split(' = ')[1]);
      expect(
        (await discoverRules([repo()])).rules.map((rule) => rule.path),
      ).toEqual(['.cursorrules']);
      expect(
        (await readSessionRules([repo()], {})).rules.map((rule) => rule.path),
      ).toEqual(['.cursorrules']);
    },
  );
  it.each([
    ['#', 'unquoted'],
    [';', 'unquoted'],
    ['#', 'quoted'],
    [';', 'quoted'],
    ['#', 'mixed'],
    [';', 'mixed'],
  ])(
    'honors inline Git config %s comments with a %s excludes path',
    async (comment, style) => {
      const name =
        style === 'unquoted' ? 'exclude-patterns' : 'exclude #; patterns';
      const ignorePath = join(root, name).replaceAll('\\', '/');
      const value =
        style === 'quoted'
          ? JSON.stringify(ignorePath)
          : style === 'mixed'
            ? `${join(root, 'exclude').replaceAll('\\', '/')}" #; patterns"`
            : ignorePath;
      await file(name, '*.mdc\n');
      await file('.cursorrules', 'visible root rule');
      await file(
        '.cursor/rules/hidden.mdc',
        '---\nalwaysApply: true\n---\nexcluded rule',
      );
      const config = await readFile(join(root, '.git/config'), 'utf8');
      await file(
        '.git/config',
        `${config}\n[core]\nexcludesfile = ${value} ${comment} local rules\n`,
      );
      expect(
        execFileSync(
          'git',
          ['-C', root, 'config', '--path', 'core.excludesfile'],
          { encoding: 'utf8' },
        ).trim(),
      ).toBe(ignorePath);
      expect(
        (await discoverRules([repo()])).rules.map((rule) => rule.path),
      ).toEqual(['.cursorrules']);
      expect(
        (await readSessionRules([repo()], {})).rules.map((rule) => rule.path),
      ).toEqual(['.cursorrules']);
    },
  );
  it('keeps relative excludes paths rooted in the scanned checkout', async () => {
    await file('exclude-patterns', '*.mdc\n');
    await file('.cursorrules', 'visible root rule');
    await file(
      '.cursor/rules/hidden.mdc',
      '---\nalwaysApply: true\n---\nexcluded rule',
    );
    const config = await readFile(join(root, '.git/config'), 'utf8');
    await file(
      '.git/config',
      `${config}\n[core]\nexcludesfile = exclude-patterns\n`,
    );
    expect(
      (await discoverRules([repo()])).rules.map((rule) => rule.path),
    ).toEqual(['.cursorrules']);
    expect(
      (await readSessionRules([repo()], {})).rules.map((rule) => rule.path),
    ).toEqual(['.cursorrules']);
  });
  it('keeps repository exclude patterns when the global excludes path is empty', async () => {
    await file('.git/info/exclude', '.cursorrules\n');
    await file('.cursorrules', 'excluded root rule');
    await file('.cursor/rules/visible.mdc', 'visible rule');
    const config = await readFile(join(root, '.git/config'), 'utf8');
    await file('.git/config', `${config}\n[core]\nexcludesfile = ""\n`);
    expect(
      (await discoverRules([repo()])).rules.map((rule) => rule.path),
    ).toEqual(['.cursor/rules/visible.mdc']);
    expect(
      (await readSessionRules([repo()], {})).rules.map((rule) => rule.path),
    ).toEqual(['.cursor/rules/visible.mdc']);
  });
  it.each([
    'excludesfile = "unterminated',
    'excludesfile = "bad\\q"',
    'ignorecase = "maybe"',
    'excludesfile extra',
  ])(
    'does not widen session eligibility for unsupported config %s',
    async (setting) => {
      await file('.cursor/rules/a.mdc', '---\nalwaysApply: true\n---\nbody');
      const config = await readFile(join(root, '.git/config'), 'utf8');
      await file('.git/config', `${config}\n[core]\n${setting}\n`);
      expect((await discoverRules([repo()])).rules).toHaveLength(0);
      expect((await readSessionRules([repo()], {})).rules).toHaveLength(0);
    },
  );
  it.each(['true', 'false', '"true"', '"false"'])(
    'does not broaden eligibility for extensions.worktreeConfig=%s',
    async (value) => {
      await file('.cursorrules', 'visible root rule');
      await file(
        '.cursor/rules/hidden.mdc',
        '---\nalwaysApply: true\n---\nexcluded rule',
      );
      await file('exclude-patterns', '*.mdc\n');
      const config = await readFile(join(root, '.git/config'), 'utf8');
      await file(
        '.git/config',
        `${config}\n[extensions]\nworktreeConfig = ${value}\n`,
      );
      await file(
        '.git/config.worktree',
        '[core]\nexcludesfile = exclude-patterns\n',
      );
      const enabled =
        execFileSync(
          'git',
          ['-C', root, 'config', '--bool', 'extensions.worktreeConfig'],
          { encoding: 'utf8' },
        ).trim() === 'true';
      const scan = (await discoverRules([repo()])).rules.map(
        (rule) => rule.path,
      );
      expect(scan).toEqual(
        enabled
          ? ['.cursorrules']
          : ['.cursorrules', '.cursor/rules/hidden.mdc'],
      );
      const session = (await readSessionRules([repo()], {})).rules.map(
        (rule) => rule.path,
      );
      expect(session).toEqual(enabled ? [] : scan);
    },
  );
  it.each([
    ['core', 'excludesfile = exclude-patterns'],
    ['core', 'ignorecase = true'],
    ['extensions', 'worktreeConfig = true'],
    ['extensions', 'worktreeConfig = false'],
  ])('honors assignments after [%s] headers: %s', async (section, setting) => {
    await file('.cursorrules', 'visible root rule');
    await file(
      '.cursor/rules/hidden.mdc',
      '---\nalwaysApply: true\n---\nexcluded rule',
    );
    await file('exclude-patterns', '*.mdc\n');
    await file(
      '.gitignore',
      setting.startsWith('ignorecase') ? '.CURSOR/\n' : '',
    );
    await file(
      '.git/config.worktree',
      '[core]\nexcludesfile = exclude-patterns\n',
    );
    const config = await readFile(join(root, '.git/config'), 'utf8');
    await file(
      '.git/config',
      `${config}\n[core]\nignorecase = false\n[${section}] ${setting}\n`,
    );
    expect(
      execFileSync(
        'git',
        ['-C', root, 'config', '--get', `${section}.${setting.split(' ')[0]}`],
        { encoding: 'utf8' },
      ).trim(),
    ).toBe(setting.split(' = ')[1]);
    const disabled = setting.endsWith('false');
    const scan = (await discoverRules([repo()])).rules.map((rule) => rule.path);
    expect(scan).toEqual(
      disabled
        ? ['.cursorrules', '.cursor/rules/hidden.mdc']
        : ['.cursorrules'],
    );
    const session = (await readSessionRules([repo()], {})).rules.map(
      (rule) => rule.path,
    );
    expect(session).toEqual(section === 'extensions' && !disabled ? [] : scan);
  });
  it.each([
    ['1', 'true', ''],
    ['1', 'false', ''],
    ['0', 'true', ''],
    ['', 'true', ''],
    ['0', 'true', "'core.ignorecase=true'"],
    ['0', 'false', "'core.ignorecase=false'"],
  ])(
    'fails closed for inherited Git configuration count=%s value=%s parameters=%s',
    async (count, value, parameters) => {
      await file('.cursorrules', 'visible root rule');
      await file(
        '.cursor/rules/hidden.mdc',
        '---\nalwaysApply: true\n---\nbody',
      );
      await file('.gitignore', '.CURSOR/\n');
      const config = await readFile(join(root, '.git/config'), 'utf8');
      await file(
        '.git/config',
        `${config}\n[core]\nignorecase = ${value === 'true' ? 'false' : 'true'}\n`,
      );
      const previous = [
        'GIT_CONFIG_COUNT',
        'GIT_CONFIG_PARAMETERS',
        'GIT_CONFIG_KEY_0',
        'GIT_CONFIG_VALUE_0',
      ].map((key) => ({ key, value: process.env[key] }));
      try {
        process.env['GIT_CONFIG_COUNT'] = count;
        process.env['GIT_CONFIG_PARAMETERS'] = parameters;
        const overridden =
          (count !== '' && count !== '0') || parameters.length > 0;
        process.env['GIT_CONFIG_KEY_0'] = 'core.ignorecase';
        process.env['GIT_CONFIG_VALUE_0'] = value;
        const scan = (await discoverRules([repo()])).rules.map(
          (rule) => rule.path,
        );
        expect(scan).toEqual(
          overridden && value === 'true'
            ? ['.cursorrules']
            : ['.cursorrules', '.cursor/rules/hidden.mdc'],
        );
        const session = (await readSessionRules([repo()], {})).rules.map(
          (rule) => rule.path,
        );
        expect(session).toEqual(overridden ? [] : scan);
      } finally {
        for (const entry of previous) {
          if (entry.value === undefined) delete process.env[entry.key];
          else process.env[entry.key] = entry.value;
        }
      }
    },
  );
  it.each([
    ['false', 'eligibility'],
    ['true', 'eligibility'],
    ['false', 'credentials'],
    ['false', 'inline'],
  ])(
    'handles system Git config with NOSYSTEM=%s and %s settings',
    async (noSystem, kind) => {
      await file('.cursorrules', 'visible root rule');
      await file(
        '.cursor/rules/hidden.mdc',
        '---\nalwaysApply: true\n---\nbody',
      );
      await file('exclude-patterns', '*.mdc\n');
      await file(
        'system-config',
        kind === 'credentials'
          ? '[credential]\nhelper = unused\n'
          : kind === 'inline'
            ? '[core] excludesfile = exclude-patterns\n'
            : '[core]\nexcludesfile = exclude-patterns\n',
      );
      const previous = ['GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM'].map(
        (key) => ({ key, value: process.env[key] }),
      );
      try {
        process.env['GIT_CONFIG_SYSTEM'] = join(root, 'system-config');
        process.env['GIT_CONFIG_NOSYSTEM'] = noSystem;
        const blocked = noSystem === 'false' && kind !== 'credentials';
        const scan = (await discoverRules([repo()])).rules.map(
          (rule) => rule.path,
        );
        expect(scan).toEqual(
          blocked
            ? ['.cursorrules']
            : ['.cursorrules', '.cursor/rules/hidden.mdc'],
        );
        const session = (await readSessionRules([repo()], {})).rules.map(
          (rule) => rule.path,
        );
        expect(session).toEqual(blocked ? [] : scan);
      } finally {
        for (const entry of previous) {
          if (entry.value === undefined) delete process.env[entry.key];
          else process.env[entry.key] = entry.value;
        }
      }
    },
  );
  it.each(['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE'])(
    'does not broaden eligibility under a %s metadata redirect',
    async (variable) => {
      await file('.cursorrules', 'visible root rule');
      await file(
        '.cursor/rules/hidden.mdc',
        '---\nalwaysApply: true\n---\nbody',
      );
      const other = join(root, 'other');
      execFileSync('git', ['init', '-q', other]);
      if (variable === 'GIT_COMMON_DIR') {
        await file('other/.git/info/exclude', '*.mdc\n');
      } else {
        await file('.gitignore', '*.mdc\n');
        execFileSync('git', [
          '-C',
          root,
          'add',
          '-f',
          '.cursor/rules/hidden.mdc',
        ]);
      }
      const previous = [
        'GIT_INDEX_FILE',
        'GIT_DIR',
        'GIT_COMMON_DIR',
        'GIT_WORK_TREE',
      ].map((key) => ({ key, value: process.env[key] }));
      try {
        for (const entry of previous) delete process.env[entry.key];
        process.env[variable] =
          variable === 'GIT_INDEX_FILE'
            ? join(other, 'missing-index')
            : variable === 'GIT_WORK_TREE'
              ? other
              : join(other, '.git');
        const scan = (await discoverRules([repo()])).rules.map(
          (rule) => rule.path,
        );
        expect(scan).toEqual(
          variable === 'GIT_WORK_TREE'
            ? ['.cursor/rules/hidden.mdc']
            : ['.cursorrules'],
        );
        expect((await readSessionRules([repo()], {})).rules).toHaveLength(0);
      } finally {
        for (const entry of previous) {
          if (entry.value === undefined) delete process.env[entry.key];
          else process.env[entry.key] = entry.value;
        }
      }
    },
  );
  it.each([
    'absolute-global',
    'empty-global',
    'relative-global',
    'empty-xdg',
    'default-xdg',
    'relative-xdg',
  ])('matches native Git global source selection for %s', async (mode) => {
    await file('.cursorrules', 'visible root rule');
    await file('.cursor/rules/hidden.mdc', '---\nalwaysApply: true\n---\nbody');
    const taskHomeDirectory = join(root, 'fixture-home');
    const taskXdgDirectory = join(root, 'fixture-xdg');
    await mkdir(taskHomeDirectory, { recursive: true });
    if (mode === 'relative-xdg') {
      await file('fixture-xdg/git/ignore', '*.mdc\n');
    } else if (mode.endsWith('xdg')) {
      await file('fixture-home/.config/git/ignore', '*.mdc\n');
    } else if (mode === 'relative-global') {
      await file('exclude-patterns', '*.mdc\n');
      await file(
        'global-config',
        `[core]\nexcludesfile = ${join(root, 'exclude-patterns')}\n`,
      );
    } else {
      await file('fixture-xdg/git/ignore', '*.mdc\n');
      await file('fixture-xdg/git/config', '[core]\nexcludesfile = ""\n');
      await file('global-config', '');
    }
    const previous = [
      'HOME',
      'XDG_CONFIG_HOME',
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_NOSYSTEM',
    ].map((key) => ({ key, value: process.env[key] }));
    const homedirMock = jest
      .spyOn((await import('node:os')).default, 'homedir')
      .mockReturnValue(taskHomeDirectory);
    try {
      process.env['HOME'] = taskHomeDirectory;
      process.env['GIT_CONFIG_NOSYSTEM'] = '1';
      process.env['XDG_CONFIG_HOME'] = taskXdgDirectory;
      if (mode === 'relative-xdg')
        process.env['XDG_CONFIG_HOME'] = 'fixture-xdg';
      else if (mode === 'empty-xdg') process.env['XDG_CONFIG_HOME'] = '';
      else if (mode === 'default-xdg') delete process.env['XDG_CONFIG_HOME'];
      if (mode.endsWith('xdg')) delete process.env['GIT_CONFIG_GLOBAL'];
      else
        process.env['GIT_CONFIG_GLOBAL'] =
          mode === 'empty-global'
            ? ''
            : mode === 'relative-global'
              ? 'global-config'
              : join(root, 'global-config');
      const scan = (await discoverRules([repo()])).rules.map(
        (rule) => rule.path,
      );
      expect(scan).toEqual(['.cursorrules']);
      const session = (await readSessionRules([repo()], {})).rules.map(
        (rule) => rule.path,
      );
      expect(session).toEqual(scan);
    } finally {
      homedirMock.mockRestore();
      for (const entry of previous) {
        if (entry.value === undefined) delete process.env[entry.key];
        else process.env[entry.key] = entry.value;
      }
    }
  });
  it.each([
    'named-home',
    'quoted-named-home',
    'prefix',
    'quoted-prefix',
    'absolute',
    'home',
  ])(
    'keeps excluded rules out of sessions for %s path expansion',
    async (mode) => {
      await file('.cursorrules', 'visible root rule');
      await file(
        '.cursor/rules/hidden.mdc',
        '---\nalwaysApply: true\n---\nbody',
      );
      await file('exclude-patterns', '*.mdc\n');
      await file('isolated-global', '');
      const previous = [
        'GIT_CONFIG_GLOBAL',
        'GIT_CONFIG_NOSYSTEM',
        'XDG_CONFIG_HOME',
      ].map((key) => ({ key, value: process.env[key] }));
      try {
        process.env['GIT_CONFIG_GLOBAL'] = join(root, 'isolated-global');
        process.env['GIT_CONFIG_NOSYSTEM'] = '1';
        process.env['XDG_CONFIG_HOME'] = join(root, 'isolated-xdg');
        await discoverRules([repo()]);
        const gitCommand =
          process.env['CANOPY_GIT_EXECUTABLE']?.trim() || 'git';
        const token = mode.includes('named-home')
          ? `~${(await import('node:os')).userInfo().username}`
          : mode.includes('prefix')
            ? '%(prefix)'
            : '~';
        const base = execFileSync(
          gitCommand,
          ['config', '--file', '-', '--path', '--get', 'core.excludesfile'],
          { encoding: 'utf8', input: `[core]\nexcludesfile = ${token}/.\n` },
        ).trim();
        const target = join(root, 'exclude-patterns');
        const value =
          mode === 'absolute'
            ? target.replaceAll('\\', '/')
            : `${token}/${(await import('node:path')).relative(base, target).replaceAll('\\', '/')}`;
        const encoded = mode.startsWith('quoted-')
          ? JSON.stringify(value)
          : value;
        const config = await readFile(join(root, '.git/config'), 'utf8');
        await file(
          '.git/config',
          `${config}\n[core]\nexcludesfile = ${encoded}\n`,
        );
        const expanded = execFileSync(
          gitCommand,
          ['-C', root, 'config', '--path', 'core.excludesfile'],
          { encoding: 'utf8' },
        ).trim();
        expect((await import('node:path')).resolve(expanded)).toBe(target);
        expect(
          (await discoverRules([repo()])).rules.map((rule) => rule.path),
        ).toEqual(['.cursorrules']);
        const session = (await readSessionRules([repo()], {})).rules.map(
          (rule) => rule.path,
        );
        expect(session).toEqual(
          mode === 'absolute' || mode === 'home' ? ['.cursorrules'] : [],
        );
      } finally {
        for (const entry of previous) {
          if (entry.value === undefined) delete process.env[entry.key];
          else process.env[entry.key] = entry.value;
        }
      }
    },
  );
  it.each(['repo-quoted', 'repo-unquoted', 'global', 'system', 'plain'])(
    'does not admit ignored rules through %s metadata filenames',
    async (mode) => {
      await file('.cursorrules', 'visible root rule');
      await file(
        '.cursor/rules/hidden.mdc',
        '---\nalwaysApply: true\n---\nbody',
      );
      await file('patterns', '*.mdc\n');
      await file('isolated-global', '');
      const previous = [
        'GIT_CONFIG_GLOBAL',
        'GIT_CONFIG_SYSTEM',
        'GIT_CONFIG_NOSYSTEM',
        'XDG_CONFIG_HOME',
      ].map((key) => ({ key, value: process.env[key] }));
      try {
        process.env['GIT_CONFIG_GLOBAL'] = join(root, 'isolated-global');
        process.env['GIT_CONFIG_NOSYSTEM'] = '1';
        process.env['XDG_CONFIG_HOME'] = join(root, 'isolated-xdg');
        if (mode === 'global' || mode === 'system') {
          const name = `${mode}\\config`;
          await file(name, '[core]\nexcludesfile = patterns\n');
          if (mode === 'global')
            process.env['GIT_CONFIG_GLOBAL'] = join(root, name);
          else {
            process.env['GIT_CONFIG_SYSTEM'] = join(root, name);
            process.env['GIT_CONFIG_NOSYSTEM'] = 'false';
          }
        } else {
          const name = mode === 'plain' ? 'patterns' : 'exclude\\patterns';
          await file(name, '*.mdc\n');
          const config = await readFile(join(root, '.git/config'), 'utf8');
          const encoded = JSON.stringify(name);
          await file(
            '.git/config',
            `${config}\n[core]\nexcludesfile = ${mode === 'repo-unquoted' ? encoded.slice(1, -1) : encoded}\n`,
          );
        }
        expect(
          (await discoverRules([repo()])).rules.map((rule) => rule.path),
        ).toEqual(['.cursorrules']);
        const session = (await readSessionRules([repo()], {})).rules.map(
          (rule) => rule.path,
        );
        const unsupported =
          mode === 'system' ||
          (process.platform !== 'win32' && mode !== 'plain');
        expect(session).toEqual(unsupported ? [] : ['.cursorrules']);
      } finally {
        for (const entry of previous) {
          if (entry.value === undefined) delete process.env[entry.key];
          else process.env[entry.key] = entry.value;
        }
      }
    },
  );
  it('leaves unrelated core keys outside the interpreted settings', async () => {
    await file('.cursorrules', 'visible root rule');
    const config = await readFile(join(root, '.git/config'), 'utf8');
    await file(
      '.git/config',
      `${config}\n[core]\nexcludesfile-backup = unused\n`,
    );
    expect(
      (await discoverRules([repo()])).rules.map((rule) => rule.path),
    ).toEqual(['.cursorrules']);
    expect(
      (await readSessionRules([repo()], {})).rules.map((rule) => rule.path),
    ).toEqual(['.cursorrules']);
  });
  it('preserves leading whitespace in Git paths and stable ids', async () => {
    await file(' leading/.cursor/rules/a.mdc', 'body');
    const scan = await discoverRules([repo()]);
    expect(scan.rules[0]?.path).toBe(' leading/.cursor/rules/a.mdc');
    expect(
      (await readSessionRules([repo()], scan.nestedDirectories)).rules[0]?.id,
    ).toBe(scan.rules[0]?.id);
  });
  it('keeps the shared reader exports available through repo-rules', () => {
    expect(safety).toMatchObject(sharedReader);
  });
  it.each(['', 'é', 'a'.repeat(64)])(
    'reads all bytes at the exact limit: %j',
    async (body) => {
      await file('bounded.mdc', body);
      const limit = Buffer.byteLength(body);
      expect(await readBounded(root, 'bounded.mdc', limit)).toBe(body);
      if (limit)
        await expect(
          readBounded(root, 'bounded.mdc', limit - 1),
        ).rejects.toThrow('too-large');
    },
  );
  it('honors cancellation before reading', async () => {
    await file('cancelled.mdc', 'body');
    const signal = AbortSignal.abort(new Error('cancelled'));
    await expect(
      sharedReader.readBoundedBytes(root, 'cancelled.mdc', 64, signal),
    ).rejects.toThrow('cancelled');
  });
  it.each(['stat', 'close'])(
    'honors cancellation during final %s and closes the file once',
    async (stage) => {
      await file('cancelled.mdc', 'body');
      const controller = new AbortController();
      const handle = await fs.open(join(root, 'cancelled.mdc'), 'r');
      const metadata = await handle.stat();
      const close = handle.close.bind(handle);
      const closed = jest.spyOn(handle, 'close');
      closed.mockImplementation(async () => {
        await close();
        if (stage === 'close') controller.abort(new Error('cancelled'));
      });
      jest
        .spyOn(handle, 'stat')
        .mockResolvedValueOnce(metadata)
        .mockImplementationOnce(() => {
          if (stage === 'stat') controller.abort(new Error('cancelled'));
          return Promise.resolve(metadata);
        });
      const opened = jest.spyOn(fs, 'open').mockResolvedValueOnce(handle);
      try {
        await expect(
          sharedReader.readBoundedBytes(
            root,
            'cancelled.mdc',
            64,
            controller.signal,
          ),
        ).rejects.toThrow('cancelled');
        expect(closed).toHaveBeenCalledTimes(1);
      } finally {
        opened.mockRestore();
      }
    },
  );
  it('bounds reads when a file grows after the observed stat', async () => {
    await file('race.mdc', 'a');
    const handle = await fs.open(join(root, 'race.mdc'), 'r');
    const before = await handle.stat();
    await fs.appendFile(join(root, 'race.mdc'), 'x'.repeat(100000));
    const opened = jest.spyOn(fs, 'open').mockResolvedValueOnce(handle);
    jest.spyOn(handle, 'stat').mockResolvedValueOnce(before);
    const read = jest.spyOn(handle, 'read');
    try {
      await expect(readBounded(root, 'race.mdc', 64)).rejects.toThrow(
        'changed',
      );
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      opened.mockRestore();
    }
  });
  it('does not return content when a file is deleted during opening', async () => {
    await file('race.mdc', 'body');
    const handle = await fs.open(join(root, 'race.mdc'), 'r');
    const opened = jest.spyOn(fs, 'open').mockImplementationOnce(async () => {
      await fs.rm(join(root, 'race.mdc'));
      return handle;
    });
    try {
      await expect(readBounded(root, 'race.mdc')).rejects.toThrow('changed');
    } finally {
      opened.mockRestore();
    }
  });
  it('selects the same deterministic 200 candidates for scan and session reads', async () => {
    await Promise.all(
      Array.from({ length: 205 }, (_, i) =>
        file(`.cursor/rules/${String(i).padStart(3, '0')}.mdc`, 'body'),
      ),
    );
    const scan = await discoverRules([repo()]);
    const session = await readSessionRules([repo()], scan.nestedDirectories);
    expect(scan.rules).toHaveLength(200);
    expect(session.rules.map((r) => r.id)).toEqual(scan.rules.map((r) => r.id));
    expect(scan.skipped).toHaveLength(5);
    expect(session.skipped).toHaveLength(5);
  });
  it('does not modify rule bytes or the repository index', async () => {
    await file('.cursorrules', 'source bytes\r\n');
    execFileSync('git', ['-C', root, 'add', '.']);
    const source = await readFile(join(root, '.cursorrules'));
    const index = await readFile(join(root, '.git/index'));
    const service = new RepoRulesService(
      new RepoRulesStateStore(() => join(root, 'policy.json')),
      () => Promise.resolve([repo()]),
    );
    const scan = await service.scan('a', { workspaceId: 'w' });
    await service.apply('a', {
      workspaceId: 'w',
      enabled: true,
      scanId: scan.scanId,
      disabledRuleIds: [],
    });
    await service.compose('w', [repo()]);
    expect(await readFile(join(root, '.cursorrules'))).toEqual(source);
    expect(await readFile(join(root, '.git/index'))).toEqual(index);
  });
  it.each([
    ['.cursor/rules/other.mdc', '.cursor/rules/界.mdc'],
    ['.cursor/rules/中.mdc', '.cursor/rules/丰.mdc'],
    ['.cursor/rules/é.mdc', '.cursor/rules/ê.mdc'],
  ])(
    'keeps v4 index compression eligibility for %s and %s',
    async (first, second) => {
      await file('.gitignore', '*.mdc\n');
      await file(first, 'first Unicode rule');
      await file(second, 'second Unicode rule');
      execFileSync('git', ['-C', root, 'add', '.gitignore']);
      execFileSync('git', ['-C', root, 'add', '-f', '--', first, second]);
      execFileSync('git', ['-C', root, 'update-index', '--index-version=4']);
      expect(parseGitIndex(await readFile(join(root, '.git/index')))).toEqual(
        new Set(['.gitignore', first, second]),
      );
      const expected = new Set([first, second]);
      expect(
        new Set((await discoverRules([repo()])).rules.map((rule) => rule.path)),
      ).toEqual(expected);
      expect(
        new Set(
          (await readSessionRules([repo()], {})).rules.map((rule) => rule.path),
        ),
      ).toEqual(expected);
    },
  );
  it.each(['links', 'sdir-test'])(
    'accepts TREE extension payloads containing %s',
    (directory) => {
      const header = Buffer.alloc(12);
      header.write('DIRC');
      header.writeUInt32BE(2, 4);
      const payload = Buffer.from(`\0-1 1\n${directory}\0-1 0\n`);
      const extension = Buffer.alloc(8);
      extension.write('TREE');
      extension.writeUInt32BE(payload.length, 4);
      expect(
        parseGitIndex(
          Buffer.concat([header, extension, payload, Buffer.alloc(20)]),
        ),
      ).toEqual(new Set());
    },
  );
  it.each(['link', 'sdir'])(
    'rejects an actual %s index extension',
    (signature) => {
      const header = Buffer.alloc(12);
      header.write('DIRC');
      header.writeUInt32BE(2, 4);
      const extension = Buffer.alloc(8);
      extension.write(signature);
      expect(() =>
        parseGitIndex(Buffer.concat([header, extension, Buffer.alloc(20)])),
      ).toThrow('unsupported-git');
    },
  );
  it('rejects truncated extension headers and payloads', () => {
    const header = Buffer.alloc(12);
    header.write('DIRC');
    header.writeUInt32BE(2, 4);
    const extension = Buffer.alloc(8);
    extension.write('TREE');
    extension.writeUInt32BE(100, 4);
    for (const tail of [extension.subarray(0, 4), extension])
      expect(() =>
        parseGitIndex(Buffer.concat([header, tail, Buffer.alloc(20)])),
      ).toThrow('unsupported-git');
  });
  it('does not permit a child ignore file to reopen an ignored ancestor', async () => {
    await file('.gitignore', '.cursor/\n');
    await file('.cursor/rules/.gitignore', '!a.mdc\n');
    await file('.cursor/rules/a.mdc', 'ignored');
    expect((await discoverRules([repo()])).rules).toHaveLength(0);
    expect((await readSessionRules([repo()], {})).rules).toHaveLength(0);
  });
  it('bounds metadata presence and never treats an empty directory as present', async () => {
    await mkdir(join(root, '.cursor/rules/group'), { recursive: true });
    expect(await editorSetupPresence([repo()])).toEqual({
      cursorRulesPresent: false,
    });
    await file('.cursor/rules/group/a.mdc', 'hello');
    expect(await editorSetupPresence([repo()])).toEqual({
      cursorRulesPresent: true,
    });
  });
  it('fails closed for invalid portable paths, nonregular files and a missing file', async () => {
    for (const path of [
      '../escape',
      '/etc/passwd',
      'C:/escape',
      '//host/share',
      'a\\b',
      'a/./b',
      'a\n.mdc',
    ])
      expect(validRelativePath(path)).toBe(false);
    await mkdir(join(root, 'directory'));
    await expect(readBounded(root, 'directory')).rejects.toThrow('unsafe-path');
    await expect(readBounded(root, 'missing')).rejects.toThrow();
  });
  it('discovers recursion and nested scope, and keeps session eligibility', async () => {
    await file('.cursorrules', 'legacy');
    await file(
      '.cursor/rules/group/a.mdc',
      '---\nalwaysApply: true\n---\nroot',
    );
    await file('sub/.cursor/rules/a.mdc', 'nested');
    await file('.gitignore', 'ignored/\n.cursor/rules/ignored.mdc\n');
    await file('ignored/.cursor/rules/a.mdc', 'ignored');
    await file('.cursor/rules/ignored.mdc', 'tracked');
    execFileSync('git', ['-C', root, 'add', '-f', '.cursor/rules/ignored.mdc']);
    const scan = await discoverRules([repo()]);
    expect(scan.rules.map((r) => r.path)).toEqual([
      '.cursorrules',
      '.cursor/rules/group/a.mdc',
      '.cursor/rules/ignored.mdc',
      'sub/.cursor/rules/a.mdc',
    ]);
    await file('.cursor/rules/new.mdc', 'new');
    await file('new-sub/.cursor/rules/a.mdc', 'not consented');
    const session = await readSessionRules([repo()], scan.nestedDirectories);
    expect(session.rules.map((r) => r.path)).toContain('.cursor/rules/new.mdc');
    expect(session.rules.map((r) => r.path)).not.toContain(
      'new-sub/.cursor/rules/a.mdc',
    );
    expect(session.rules.map((r) => r.path)).toContain(
      '.cursor/rules/ignored.mdc',
    );
  });
  it('rejects ancestor symlinks, outside targets and oversized files', async () => {
    await file('elsewhere/a.mdc', 'hidden');
    await mkdir(join(root, '.cursor/rules'), { recursive: true });
    await symlink(join(root, 'elsewhere'), join(root, '.cursor/rules/link'));
    await symlink('/etc/passwd', join(root, '.cursor/rules/out.mdc'));
    await file('.cursor/rules/big.mdc', 'x'.repeat(65537));
    const scan = await discoverRules([repo()]);
    expect(scan.rules).toHaveLength(0);
    expect(scan.skipped.some((s) => s.reason === 'too-large')).toBe(true);
    expect(scan.skipped.some((s) => s.reason === 'unsafe-path')).toBe(true);
  });
  it('defaults duplicates and malformed rules off, diagnoses references without reading them', async () => {
    await file('AGENTS.md', 'Use tests.');
    await file('.cursor/rules/a.mdc', 'Use tests.');
    await file(
      '.cursor/rules/b.mdc',
      '---\nalwaysApply: nope\n---\nbody @missing.ts',
    );
    const scan = await discoverRules([repo()]);
    expect(scan.rules.every((r) => !r.selected)).toBe(true);
    expect(scan.rules[1]?.flags).toContain('missing-file-reference');
  });
});

describe('rendering and policy', () => {
  it('includes the header and rule label in the inline UTF-8 budget', () => {
    const body = 'x'.repeat(12 * 1024);
    const rule = parseRepoRule('single', '.cursorrules', body);
    const text = renderRepoRules([rule], [repo()], 0);
    expect(text).not.toContain(body);
    expect(text).toContain('before starting work');
  });
  it('hashes actual bytes and detects edits that decode to the same UTF-8 text', async () => {
    await writeFile(join(root, '.cursorrules'), Buffer.from([0xff]));
    const store = new RepoRulesStateStore(() => join(root, 'policy.json'));
    const service = new RepoRulesService(store, () =>
      Promise.resolve([repo()]),
    );
    const scan = await service.scan('a', { workspaceId: 'w' });
    await writeFile(join(root, '.cursorrules'), Buffer.from([0xfe]));
    await expect(
      service.apply('a', {
        workspaceId: 'w',
        enabled: true,
        scanId: scan.scanId,
        disabledRuleIds: [],
      }),
    ).rejects.toThrow('changed');
  });
  it('uses owner-only atomic writes and leaves a failed review reusable', async () => {
    await file('.cursorrules', 'body');
    const statePath = join(root, 'policy.json');
    await mkdir(statePath);
    const store = new RepoRulesStateStore(() => statePath);
    const service = new RepoRulesService(store, () =>
      Promise.resolve([repo()]),
    );
    const scan = await service.scan('a', { workspaceId: 'w' });
    const request = {
      workspaceId: 'w',
      enabled: true,
      scanId: scan.scanId,
      disabledRuleIds: [],
    };
    await expect(service.apply('a', request)).rejects.toThrow(
      'Unable to save workspace rule policy',
    );
    expect((await stat(statePath)).isDirectory()).toBe(true);
    expect((await readdir(root)).some((n) => n.endsWith('.tmp'))).toBe(false);
    await rm(statePath, { recursive: true });
    await service.apply('a', request);
    if (process.platform !== 'win32')
      expect((await stat(statePath)).mode & 0o777).toBe(0o600);
    expect((await store.read('w')).enabled).toBe(true);
  });
  it('keeps saving reviews after review history from other checkouts grows large', async () => {
    await file('.cursorrules', 'body');
    const statePath = join(root, 'policy.json');
    const hash = 'a'.repeat(64);
    const reviewed = Object.fromEntries(
      Array.from({ length: 1500 }, (_, index) => [
        `single:.cursor/rules/old-${index}.mdc`,
        {
          hash,
          reviewedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        },
      ]),
    );
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        enabled: false,
        revision: 0,
        disabledRuleIds: [],
        reviewed,
        nestedDirectories: {},
      }),
    );
    const store = new RepoRulesStateStore(() => statePath);
    const service = new RepoRulesService(store, () =>
      Promise.resolve([repo()]),
    );
    const scan = await service.scan('a', { workspaceId: 'w' });
    await service.apply('a', {
      workspaceId: 'w',
      enabled: true,
      scanId: scan.scanId,
      disabledRuleIds: [],
    });
    const saved = await store.read('w');
    const ids = Object.keys(saved.reviewed);
    expect(saved.enabled).toBe(true);
    expect(ids.length).toBeLessThanOrEqual(1000);
    expect(ids).toEqual(
      expect.arrayContaining(scan.proposals.map((rule) => rule.id)),
    );
    expect(ids).toContain('single:.cursor/rules/old-1499.mdc');
    expect(ids).not.toContain('single:.cursor/rules/old-0.mdc');
  });
  it('shows a saved disable in review after its history record is gone', async () => {
    await file('.cursorrules', 'body');
    const statePath = join(root, 'policy.json');
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        enabled: true,
        revision: 1,
        disabledRuleIds: ['single:.cursorrules'],
        reviewed: {},
        nestedDirectories: {},
      }),
    );
    const service = new RepoRulesService(
      new RepoRulesStateStore(() => statePath),
      () => Promise.resolve([repo()]),
    );
    const scan = await service.scan('a', { workspaceId: 'w' });
    expect(
      scan.proposals.find((rule) => rule.id === 'single:.cursorrules')
        ?.selected,
    ).toBe(false);
  });
  it('keeps policy under the size limit when long review history is retained', async () => {
    await file('.cursorrules', 'body');
    const statePath = join(root, 'policy.json');
    const state = {
      version: 1,
      enabled: false,
      revision: 0,
      disabledRuleIds: [],
      reviewed: {} as Record<string, { hash: string; reviewedAt: string }>,
      nestedDirectories: {},
    };
    const deep = 'nested/'.repeat(40);
    for (let index = 0; ; index += 1) {
      const id = `single:${deep}.cursor/rules/old-${index}.mdc`;
      state.reviewed[id] = {
        hash: 'b'.repeat(64),
        reviewedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      };
      if (Buffer.byteLength(JSON.stringify(state)) > 256 * 1024 - 40) {
        delete state.reviewed[id];
        break;
      }
    }
    await writeFile(statePath, JSON.stringify(state));
    const store = new RepoRulesStateStore(() => statePath);
    const service = new RepoRulesService(store, () =>
      Promise.resolve([repo()]),
    );
    const scan = await service.scan('a', { workspaceId: 'w' });
    await service.apply('a', {
      workspaceId: 'w',
      enabled: true,
      scanId: scan.scanId,
      disabledRuleIds: [],
    });
    const saved = await store.read('w');
    expect(saved.enabled).toBe(true);
    expect(saved.reviewed['single:.cursorrules']).toBeDefined();
    expect((await stat(statePath)).size).toBeLessThanOrEqual(256 * 1024);
  });
  it('reports a non-limit schema failure as a save failure', async () => {
    const store = new RepoRulesStateStore(() => join(root, 'policy.json'));
    await expect(
      store.update('w', () =>
        Promise.resolve({
          version: 1,
          enabled: true,
          revision: 1,
          disabledRuleIds: [],
          reviewed: {
            'single:.cursorrules': { hash: 'c'.repeat(64), reviewedAt: 'now' },
          },
          nestedDirectories: {},
        }),
      ),
    ).rejects.toThrow('Unable to save workspace rule policy');
  });
  it('reports an oversized disabled selection without schema details', async () => {
    const store = new RepoRulesStateStore(() => join(root, 'policy.json'));
    await expect(
      store.update('w', () =>
        Promise.resolve({
          version: 1,
          enabled: true,
          revision: 1,
          reviewed: {},
          nestedDirectories: {},
          disabledRuleIds: Array.from(
            { length: 2001 },
            (_, index) => `single:.cursor/rules/r-${index}.mdc`,
          ),
        }),
      ),
    ).rejects.toThrow(
      'Workspace rule policy is too large to save. Reduce the selection and scan again.',
    );
  });
  it('saves policy from the compiled main context without a dynamic import callback', async () => {
    const build = buildSync({
      entryPoints: [join(__dirname, '../state.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
      write: false,
    });
    const source = build.outputFiles[0]?.text;
    if (!source) throw new Error('Missing compiled state module');
    const compiled = { exports: { RepoRulesStateStore } };
    new Script(source).runInNewContext({
      require: createRequire(__filename),
      module: compiled,
      exports: compiled.exports,
      Buffer,
    });
    const store = new compiled.exports.RepoRulesStateStore(() =>
      join(root, 'compiled-policy.json'),
    );
    await expect(
      store.update('w', () =>
        Promise.resolve({
          version: 1,
          enabled: true,
          revision: 1,
          disabledRuleIds: [],
          reviewed: {},
          nestedDirectories: {},
        }),
      ),
    ).resolves.toMatchObject({ enabled: true, revision: 1 });
    expect((await store.read('w')).enabled).toBe(true);
  });
  it.each([
    { version: 2, enabled: true },
    { version: 1, enabled: true },
    [],
    null,
  ])(
    'disables invalid persisted schema without overwriting it: %j',
    async (input) => {
      const path = join(root, 'policy.json');
      const original = JSON.stringify(input);
      await writeFile(path, original);
      expect(
        (await new RepoRulesStateStore(() => path).read('w')).enabled,
      ).toBe(false);
      expect(await readFile(path, 'utf8')).toBe(original);
    },
  );
  it('isolates repo identities, escapes metadata and reserves an omission notice', () => {
    const rules = Array.from({ length: 200 }, (_, i) =>
      parseRepoRule(
        `repo-${i}`,
        '.cursor/rules/a.mdc',
        `---\ndescription: "${'界'.repeat(500)}"\n---\nbody`,
      ),
    );
    const repos = rules.map((r) => ({
      repoId: r.repoId,
      root,
      prefix: `repos/${r.repoId}`,
    }));
    const rendered = renderRepoRules(rules, repos, 1);
    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(16384);
    expect(rendered).toContain('omitted');
    expect(rendered).toContain('repos/repo-0/.cursor/rules/a.mdc');
    const malicious = parseRepoRule(
      'a\n# Fake',
      '.cursor/rules/a.mdc',
      'manual',
    );
    expect(
      renderRepoRules(
        [malicious],
        [{ repoId: malicious.repoId, root, prefix: '' }],
        0,
      ),
    ).not.toContain('\na\n# Fake');
  });
  it('records no writes for scan/preview and rejects expired, cross-workspace, unknown and concurrent reviews', async () => {
    await file('.cursorrules', 'hello');
    const path = join(root, 'policy.json');
    const store = new RepoRulesStateStore(() => path);
    let time = Date.now();
    const service = new RepoRulesService(
      store,
      () => Promise.resolve([repo()]),
      () => time,
    );
    const scan = await service.scan('alice', { workspaceId: 'w' });
    expect(
      service.preview('alice', {
        workspaceId: 'w',
        scanId: scan.scanId,
        ruleId: scan.proposals[0]?.id ?? '',
      }).body,
    ).toBe('hello');
    await expect(readFile(path)).rejects.toThrow();
    await expect(
      service.apply('alice', {
        workspaceId: 'other',
        enabled: true,
        scanId: scan.scanId,
        disabledRuleIds: [],
      }),
    ).rejects.toThrow('review');
    await expect(
      service.apply('alice', {
        workspaceId: 'w',
        enabled: true,
        scanId: scan.scanId,
        disabledRuleIds: ['unknown'],
      }),
    ).rejects.toThrow('Selections');
    time += 600001;
    await expect(
      service.apply('alice', {
        workspaceId: 'w',
        enabled: true,
        scanId: scan.scanId,
        disabledRuleIds: [],
      }),
    ).rejects.toThrow('review');
    const first = await service.scan('alice', { workspaceId: 'w' });
    const second = await service.scan('alice', { workspaceId: 'w' });
    const outcomes = await Promise.allSettled(
      [first, second].map((s) =>
        service.apply('alice', {
          workspaceId: 'w',
          enabled: true,
          scanId: s.scanId,
          disabledRuleIds: [],
        }),
      ),
    );
    expect(outcomes.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect((await store.read('w')).revision).toBe(1);
  });
  it('retains disabled choices for rules absent from a later worktree review', async () => {
    await file('.cursorrules', 'hello');
    const store = new RepoRulesStateStore(() => join(root, 'policy.json'));
    const service = new RepoRulesService(store, () =>
      Promise.resolve([repo()]),
    );
    const first = await service.scan('a', { workspaceId: 'w' });
    const id = first.proposals[0]?.id ?? '';
    await service.apply('a', {
      workspaceId: 'w',
      enabled: true,
      scanId: first.scanId,
      disabledRuleIds: [id],
    });
    await rm(join(root, '.cursorrules'));
    const second = await service.scan('a', { workspaceId: 'w' });
    await service.apply('a', {
      workspaceId: 'w',
      enabled: true,
      scanId: second.scanId,
      disabledRuleIds: [],
    });
    await file('.cursorrules', 'returned');
    expect(
      (await service.scan('a', { workspaceId: 'w' })).proposals[0]?.selected,
    ).toBe(false);
    expect(await service.compose('w', [repo()])).toBe('');
  });
  it('keeps disabled composition free of repository resolution', async () => {
    const resolve = jest.fn(() =>
      Promise.reject(new Error('repository must not be read')),
    );
    const service = new RepoRulesService(
      new RepoRulesStateStore(() => join(root, 'policy.json')),
      resolve,
    );
    expect(await service.compose('w')).toBe('');
    expect(resolve).not.toHaveBeenCalled();
    await service.apply('a', { workspaceId: 'w', enabled: false });
    expect(resolve).not.toHaveBeenCalled();
  });
  it('keeps disabled core policy from invoking the worker port', async () => {
    const worker = {
      scan: jest.fn(),
      readSession: jest.fn(),
      presence: jest.fn(),
    };
    const service = new RepoRulesService(
      new RepoRulesStateStore(() => join(root, 'policy.json')),
      () => Promise.resolve([repo()]),
      Date.now,
      worker,
    );
    expect(await service.compose('w', [repo()])).toBe('');
    await service.apply('a', { workspaceId: 'w', enabled: false });
    expect(worker.readSession).not.toHaveBeenCalled();
    expect(worker.scan).not.toHaveBeenCalled();
  });
  it('uses whole unconditional read entries on inline overflow and respects UTF-8 budgets', async () => {
    await file('.cursorrules', '界'.repeat(10000));
    const scan = await discoverRules([repo()]);
    const text = renderRepoRules(scan.rules, [repo()], 0);
    expect(text).toContain('before starting work');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16384);
    expect(text).not.toContain('界');
    expect(renderRepoRules([], [repo()], 0)).toBe('');
  });
  it('preserves damaged state until explicit apply and serializes revisions', async () => {
    const statePath = join(root, 'state.json');
    const store = new RepoRulesStateStore(() => statePath);
    await writeFile(statePath, '{bad');
    expect((await store.read('w')).enabled).toBe(false);
    expect(await readFile(statePath, 'utf8')).toBe('{bad');
    const service = new RepoRulesService(store, () =>
      Promise.resolve([repo()]),
    );
    await service.apply('caller', { workspaceId: 'w', enabled: false });
    expect((await store.read('w')).revision).toBe(1);
  });
  it('binds scans to caller/workspace/revision, validates content and consumes successful scans', async () => {
    await file('.cursorrules', 'first');
    const store = new RepoRulesStateStore(() => join(root, 'state.json'));
    const service = new RepoRulesService(store, () =>
      Promise.resolve([repo()]),
    );
    const scan = await service.scan('alice', { workspaceId: 'w' });
    await expect(
      service.apply('bob', {
        workspaceId: 'w',
        enabled: true,
        scanId: scan.scanId,
        disabledRuleIds: [],
      }),
    ).rejects.toThrow('review');
    await file('.cursorrules', 'changed');
    await expect(
      service.apply('alice', {
        workspaceId: 'w',
        enabled: true,
        scanId: scan.scanId,
        disabledRuleIds: [],
      }),
    ).rejects.toThrow('changed');
    const fresh = await service.scan('alice', { workspaceId: 'w' });
    await service.apply('alice', {
      workspaceId: 'w',
      enabled: true,
      scanId: fresh.scanId,
      disabledRuleIds: [],
    });
    await expect(
      service.apply('alice', {
        workspaceId: 'w',
        enabled: true,
        scanId: fresh.scanId,
        disabledRuleIds: [],
      }),
    ).rejects.toThrow('review');
    expect((await service.compose('w', [repo()])).length).toBeGreaterThan(0);
    await service.apply('alice', { workspaceId: 'w', enabled: false });
    expect(await service.compose('w', [repo()])).toBe('');
  });
});
