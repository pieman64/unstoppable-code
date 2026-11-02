import { readFileSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { z } from 'zod';
import {
  LINUX_SYSTEM_GIT_PATH,
  MAC_COMMAND_LINE_TOOLS_GIT_PATH,
  MAC_HOMEBREW_GIT_PATHS,
  type GitCandidatePaths,
  getGitExecutableDetectionMode,
  getGitExecutableProbeOrder,
  getGitExecutableRequirement,
  getLinuxGitCandidates,
  getMacGitCandidates,
  getWindowsGitCandidates,
  isMacGitShim,
  parseGitVersion,
  parseWhereExeOutput,
  selectLinuxExplicitGitChoice,
  shapeGitExecutableStatus,
  shouldJoinGitExecutableDetection,
} from '../index';

const joinFlavorSchema = z.enum(['posix', 'win32']);

const buildersSchema = z.object({
  parseGitVersion: z.array(
    z
      .object({
        output: z.string(),
        numeric: z.boolean(),
        expected: z.string().nullable(),
      })
      .strict(),
  ),
  isMacGitShim: z.array(
    z.object({ path: z.string(), expected: z.boolean() }).strict(),
  ),
  linux: z.array(
    z
      .object({
        name: z.string(),
        loginPath: z.string(),
        expected: z.array(
          z
            .object({
              path: z.string(),
              source: z.enum(['login-path', 'system']),
            })
            .strict(),
        ),
      })
      .strict(),
  ),
  mac: z.array(
    z
      .object({
        name: z.string(),
        loginPath: z.string(),
        developerDir: z.string().nullable(),
        join: joinFlavorSchema,
        expected: z.array(z.string()),
      })
      .strict(),
  ),
  windows: z.array(
    z
      .object({
        name: z.string(),
        programFiles: z.string().optional(),
        programFilesX86: z.string().optional(),
        localAppData: z.string().optional(),
        join: joinFlavorSchema,
        expected: z.array(z.string()),
      })
      .strict(),
  ),
  whereExe: z.array(
    z.object({ stdout: z.string(), expected: z.array(z.string()) }).strict(),
  ),
});

const builders = z
  .object({ builders: buildersSchema })
  .parse(
    JSON.parse(
      readFileSync(join(__dirname, 'selection-scenarios.json'), 'utf8'),
    ),
  ).builders;

function pathFlavor(flavor: typeof posix): GitCandidatePaths {
  return {
    join: (...parts) => flavor.join(...parts),
    isAbsolute: (value) => flavor.isAbsolute(value),
  };
}

const PATH_FLAVORS: Record<
  z.infer<typeof joinFlavorSchema>,
  GitCandidatePaths
> = { posix: pathFlavor(posix), win32: pathFlavor(win32) };

describe('git executable selection constants', () => {
  it('names the fixed install locations', () => {
    expect(LINUX_SYSTEM_GIT_PATH).toBe('/usr/bin/git');
    expect(MAC_COMMAND_LINE_TOOLS_GIT_PATH).toBe(
      '/Library/Developer/CommandLineTools/usr/bin/git',
    );
    expect(MAC_HOMEBREW_GIT_PATHS).toEqual([
      '/opt/homebrew/bin/git',
      '/usr/local/bin/git',
    ]);
  });
});

describe('git executable selection builder goldens', () => {
  it.each(builders.parseGitVersion)(
    'parses $output (numeric: $numeric)',
    ({ output, numeric, expected }) => {
      expect(
        parseGitVersion(output, numeric ? { numeric: true } : undefined),
      ).toBe(expected);
    },
  );

  it.each(builders.isMacGitShim)(
    'classifies $path as shim: $expected',
    ({ path, expected }) => {
      expect(isMacGitShim(path)).toBe(expected);
    },
  );

  it.each(builders.linux)('Linux: $name', ({ loginPath, expected }) => {
    expect(getLinuxGitCandidates(loginPath)).toEqual(expected);
  });

  it.each(builders.mac)(
    'macOS ($join join): $name',
    ({ loginPath, developerDir, join: flavor, expected }) => {
      expect(
        getMacGitCandidates({
          loginPath,
          developerDir,
          paths: PATH_FLAVORS[flavor],
        }),
      ).toEqual(expected);
    },
  );

  it.each(builders.windows)(
    'Windows ($join join): $name',
    ({
      programFiles,
      programFilesX86,
      localAppData,
      join: flavor,
      expected,
    }) => {
      expect(
        getWindowsGitCandidates({
          programFiles,
          programFilesX86,
          localAppData,
          join: PATH_FLAVORS[flavor].join,
        }),
      ).toEqual(expected);
    },
  );

  it.each(builders.whereExe)(
    'parses where.exe output %#',
    ({ stdout, expected }) => {
      expect(parseWhereExeOutput(stdout)).toEqual(expected);
    },
  );
});

describe('git executable selection inputs', () => {
  it('returns fresh arrays the caller may extend', () => {
    const paths = PATH_FLAVORS.posix;
    const first = getMacGitCandidates({
      loginPath: '',
      developerDir: null,
      paths,
    });
    first.push('/extra/git');
    expect(
      getMacGitCandidates({ loginPath: '', developerDir: null, paths }),
    ).not.toContain('/extra/git');
    expect(MAC_HOMEBREW_GIT_PATHS).toHaveLength(2);
  });

  it('reads only the injected path operations', () => {
    const calls: string[] = [];
    const candidates = getMacGitCandidates({
      loginPath: 'one:/two',
      developerDir: 'dev',
      paths: {
        join: (...parts: string[]): string => {
          calls.push(`join ${parts.join(',')}`);
          return parts.join('|');
        },
        isAbsolute: (value: string): boolean => {
          calls.push(`isAbsolute ${value}`);
          return value !== '/two';
        },
      },
    });
    expect(candidates).toEqual([
      'one|git',
      MAC_COMMAND_LINE_TOOLS_GIT_PATH,
      'dev|usr/bin/git',
      ...MAC_HOMEBREW_GIT_PATHS,
    ]);
    expect(calls).toEqual([
      'isAbsolute one',
      'isAbsolute /two',
      'join one,git',
      'isAbsolute dev',
      'join dev,usr/bin/git',
    ]);
  });
});

describe('git executable status and precedence policy', () => {
  it.each([
    ['linux', 'x64', 'linux', true],
    ['linux', 'arm64', 'linux', true],
    ['darwin', 'arm64', 'probe', true],
    ['darwin', 'x64', 'probe', true],
    ['win32', 'x64', 'probe', true],
    ['win32', 'arm64', 'probe', true],
    ['freebsd', 'x64', 'optional', false],
  ] as const)(
    'selects the %s/%s detection from its arguments',
    (os, arch, mode, required) => {
      expect(getGitExecutableDetectionMode(os, arch)).toBe(mode);
      expect(getGitExecutableRequirement(os, arch)).toEqual({
        platform: os,
        required,
      });
      expect(Object.keys(getGitExecutableRequirement(os, arch))).toEqual([
        'platform',
        'required',
      ]);
    },
  );

  it.each([
    ['darwin', false, true],
    ['darwin', true, true],
    ['win32', false, true],
    ['win32', true, false],
    ['linux', false, true],
    ['linux', true, false],
  ] as const)(
    'on %s joins a running detection when force is %s: %s',
    (os, force, joins) => {
      expect(shouldJoinGitExecutableDetection(os, force)).toBe(joins);
    },
  );

  it('prefers the saved Linux choice, then an override it did not discover', () => {
    expect(
      selectLinuxExplicitGitChoice({
        saved: '/saved/git',
        override: '/override/git',
        discovered: null,
      }),
    ).toBe('/saved/git');
    expect(
      selectLinuxExplicitGitChoice({
        saved: null,
        override: '/override/git',
        discovered: '/found/git',
      }),
    ).toBe('/override/git');
    for (const override of [undefined, '', '/found/git'])
      expect(
        selectLinuxExplicitGitChoice({
          saved: null,
          override,
          discovered: '/found/git',
        }),
      ).toBeNull();
  });

  it('drops macOS shims and repeats in probe order', () => {
    expect(
      getGitExecutableProbeOrder('darwin', [
        '/usr/bin/git',
        '/opt/homebrew/bin/git',
        '/usr/local/Library/Homebrew/shims/git',
        '/opt/homebrew/bin/git',
        '/Opt/Homebrew/bin/git',
        '/usr/bin/xcrun',
      ]),
    ).toEqual(['/opt/homebrew/bin/git', '/Opt/Homebrew/bin/git']);
  });

  it('drops Windows repeats case-insensitively, keeping the first spelling', () => {
    expect(
      getGitExecutableProbeOrder('win32', [
        'C:\\Git\\cmd\\git.exe',
        'c:\\git\\CMD\\GIT.EXE',
        '/usr/bin/git',
        'D:\\Git\\git.exe',
      ]),
    ).toEqual(['C:\\Git\\cmd\\git.exe', '/usr/bin/git', 'D:\\Git\\git.exe']);
  });

  it('shapes statuses in the reported key order and omits an empty error', () => {
    const requirement = getGitExecutableRequirement('win32', 'x64');
    const ready = shapeGitExecutableStatus(
      requirement,
      '2026-10-26T00:00:00.000Z',
      {
        ready: true,
        path: 'C:\\Git\\git.exe',
        version: 'git version 2.47.1',
        source: 'cache',
        wingetAvailable: true,
      },
    );
    expect(JSON.stringify(ready)).toBe(
      '{"platform":"win32","required":true,"checkedAt":"2026-10-26T00:00:00.000Z","ready":true,"path":"C:\\\\Git\\\\git.exe","version":"git version 2.47.1","source":"cache","wingetAvailable":true}',
    );
    const values = {
      ready: false,
      path: null,
      version: null,
      source: 'not-found',
      wingetAvailable: false,
    } as const;
    expect(
      shapeGitExecutableStatus(requirement, 'now', { ...values, error: '' }),
    ).not.toHaveProperty('error');
    expect(
      Object.keys(
        shapeGitExecutableStatus(requirement, 'now', {
          ...values,
          error: 'missing',
        }),
      ),
    ).toEqual([
      'platform',
      'required',
      'checkedAt',
      'ready',
      'path',
      'version',
      'source',
      'wingetAvailable',
      'error',
    ]);
  });
});
