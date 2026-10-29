import {
  delegationCommandEnvironment,
  delegationOutermostRoots,
  delegationToolchainReadRoots,
} from '../command-environment';

describe('delegationCommandEnvironment', () => {
  it('keeps the POSIX environment on macOS and Linux', () => {
    const environment = delegationCommandEnvironment(['/opt/git/bin'], {
      platform: 'darwin',
    });
    expect(environment.PATH).toBe('/opt/git/bin:/usr/bin:/bin:/usr/sbin:/sbin');
    expect(environment.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(environment.GIT_CONFIG_VALUE_1).toBe('/dev/null');
    expect(environment).not.toHaveProperty('SystemRoot');
  });

  it('builds a closed Windows environment with system tools and the NUL device', () => {
    const environment = delegationCommandEnvironment(
      ['C:\\Program Files\\Git\\cmd'],
      { platform: 'win32', systemRoot: 'C:\\Windows' },
    );
    expect(environment.PATH).toBe(
      [
        'C:\\Program Files\\Git\\cmd',
        'C:\\Windows\\System32',
        'C:\\Windows',
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
      ].join(';'),
    );
    expect(environment).toMatchObject({
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      GIT_CONFIG_GLOBAL: 'NUL',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_VALUE_1: 'NUL',
      GIT_CONFIG_VALUE_2: 'NUL',
      GIT_CONFIG_VALUE_3: 'NUL',
    });
    expect(environment.PATH).not.toContain('/usr/bin');
  });

  it('rejects relative, delimiter-bearing or missing Windows directories', () => {
    for (const directory of ['Git\\cmd', 'C:\\a;C:\\b', 'C:\\a\0b'])
      expect(() =>
        delegationCommandEnvironment([directory], {
          platform: 'win32',
          systemRoot: 'C:\\Windows',
        }),
      ).toThrow('Invalid delegated command directory');
    for (const systemRoot of [undefined, 'Windows', 'C:\\Windows;C:\\x'])
      expect(() =>
        delegationCommandEnvironment([], { platform: 'win32', systemRoot }),
      ).toThrow('Windows system directory is unavailable');
  });

  it('adds the captured login-shell PATH after the host-selected directories', () => {
    const environment = delegationCommandEnvironment(['/opt/git/bin'], {
      platform: 'darwin',
      commandPath: [
        '/Users/me/.nvm/versions/node/v24.21.0/bin',
        '/opt/homebrew/bin',
        'relative/bin',
        '',
        '/usr/bin',
        '/opt/git/bin',
      ].join(':'),
      temporaryDirectory: '/private/var/folders/run/delegated-runtime-1',
    });
    expect(environment.PATH).toBe(
      [
        '/opt/git/bin',
        '/Users/me/.nvm/versions/node/v24.21.0/bin',
        '/opt/homebrew/bin',
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
      ].join(':'),
    );
    expect(environment).toMatchObject({
      TMPDIR: '/private/var/folders/run/delegated-runtime-1',
      TMP: '/private/var/folders/run/delegated-runtime-1',
      TEMP: '/private/var/folders/run/delegated-runtime-1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    });
  });

  it('keeps the Windows system tools after the captured PATH', () => {
    const environment = delegationCommandEnvironment(
      ['C:\\Program Files\\Git\\cmd'],
      {
        platform: 'win32',
        systemRoot: 'C:\\Windows',
        commandPath: 'C:\\nvm4w\\nodejs;C:\\Windows\\System32',
      },
    );
    expect(environment.PATH).toBe(
      [
        'C:\\Program Files\\Git\\cmd',
        'C:\\nvm4w\\nodejs',
        'C:\\Windows\\System32',
        'C:\\Windows',
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
      ].join(';'),
    );
  });
});

describe('delegationToolchainReadRoots', () => {
  it('grants each PATH directory and the prefix of its bin directory', () => {
    const roots = delegationToolchainReadRoots(
      [
        '/Users/me/.nvm/versions/node/v24.21.0/bin',
        '/opt/homebrew/bin',
        '/Users/me/bin',
        '/Users/bin',
        '/bin',
        '/usr/bin',
        'relative/bin',
      ],
      { home: '/Users/me', platform: 'darwin' },
    );
    expect(roots).toEqual(
      expect.arrayContaining([
        '/Users/me/.nvm/versions/node/v24.21.0/bin',
        '/Users/me/.nvm/versions/node/v24.21.0/lib',
        '/opt/homebrew/bin',
        '/opt/homebrew',
        '/Users/me/bin',
        '/usr/bin',
        '/usr',
        '/System/Library',
      ]),
    );
    // A prefix inside home is never granted whole.
    expect(roots).not.toContain('/Users/me/.nvm/versions/node/v24.21.0');
    // Never the home directory, an ancestor of it, or the filesystem root.
    expect(roots).not.toContain('/Users/me');
    expect(roots).not.toContain('/Users');
    expect(roots).not.toContain('/');
    expect(roots).not.toContain('relative/bin');
    expect(new Set(roots).size).toBe(roots.length);
  });

  it('never grants the home directory, an ancestor of it or the filesystem root itself', () => {
    expect(
      delegationToolchainReadRoots(['/Users/me', '/Users/me/', '/Users', '/'], {
        home: '/Users/me',
        platform: 'linux',
      }),
    ).toEqual([]);
  });

  it('skips PATH entries inside private directories or overlapping excluded roots', () => {
    expect(
      delegationToolchainReadRoots(
        [
          '/Users/me/.config/tool/bin',
          '/Users/me/.docker/bin',
          '/Users/me/.ssh/bin',
          '/Users/me/.canopy/chat-plugins/review/bin',
          '/Users/me/.canopy-dev/bin',
          '/Users/me/tools/bin',
          '/opt/tool/bin',
        ],
        {
          home: '/Users/me',
          platform: 'linux',
          // The app's data directories: one holds a PATH entry, and one sits
          // beneath another entry, which is then not granted either.
          excludedRoots: ['/Users/me/.canopy-dev', '/Users/me/tools/bin/data'],
        },
      ),
    ).toEqual(['/opt/tool/bin', '/opt/tool']);
  });

  it('grants only the runtime directories beside a bin directory inside home, never the tool folder that keeps its credentials', () => {
    const roots = delegationToolchainReadRoots(
      ['/Users/me/.pulumi/bin', '/Users/me/.fly/bin', '/opt/tool/bin'],
      { home: '/Users/me', platform: 'linux' },
    );
    expect(roots).toEqual([
      '/Users/me/.pulumi/bin',
      '/Users/me/.pulumi/lib',
      '/Users/me/.pulumi/libexec',
      '/Users/me/.pulumi/include',
      '/Users/me/.pulumi/versions',
      '/Users/me/.fly/bin',
      '/Users/me/.fly/lib',
      '/Users/me/.fly/libexec',
      '/Users/me/.fly/include',
      '/Users/me/.fly/versions',
      '/opt/tool/bin',
      '/opt/tool',
    ]);
  });

  it('grants nothing for a PATH directory inside home unless it holds executables by convention', () => {
    const roots = delegationToolchainReadRoots(
      [
        '/Users/me/.pulumi',
        '/Users/me/.fly',
        '/Users/me/scripts',
        '/Users/me/.pyenv/shims',
        '/Users/me/.local/bin',
        '/opt/tools',
      ],
      { home: '/Users/me', platform: 'linux' },
    );
    // A tool manager's own folder keeps its tokens and keys beside its
    // binaries, so only bin, sbin and shims directories are readable.
    expect(roots).not.toContain('/Users/me/.pulumi');
    expect(roots).not.toContain('/Users/me/.fly');
    expect(roots).not.toContain('/Users/me/scripts');
    expect(roots).toEqual(
      expect.arrayContaining([
        '/Users/me/.pyenv/shims',
        '/Users/me/.local/bin',
        '/Users/me/.local/lib',
        '/opt/tools',
      ]),
    );
  });

  it('grants a bin directory but not a prefix that contains an excluded root', () => {
    expect(
      delegationToolchainReadRoots(['/Users/me/work/bin'], {
        home: '/Users/me',
        platform: 'linux',
        excludedRoots: ['/Users/me/work/app-data'],
      }),
    ).toEqual(['/Users/me/work/bin']);
  });

  it('checks the macOS runtime locations like PATH entries, so none covers an excluded root', () => {
    const excludedRoots = [
      '/usr/local/var/canopy',
      '/Library/Developer/canopy-secure',
    ];
    const roots = delegationToolchainReadRoots(['/usr/bin', '/usr/local/bin'], {
      home: '/Users/me',
      platform: 'darwin',
      excludedRoots,
    });
    // The system directories under /usr stay readable; /usr and /usr/local
    // would cover the data directory, and so would /Library/Developer.
    expect(roots).toEqual(
      expect.arrayContaining([
        '/usr/bin',
        '/usr/local/bin',
        '/usr/lib',
        '/usr/share',
        '/System/Library',
      ]),
    );
    for (const root of roots)
      for (const excluded of excludedRoots) {
        expect(`${excluded}/`.startsWith(`${root}/`)).toBe(false);
        expect(`${root}/`.startsWith(`${excluded}/`)).toBe(false);
      }
  });

  it('never grants a macOS runtime location that contains the home directory', () => {
    const roots = delegationToolchainReadRoots([], {
      home: '/Applications/Xcode.app/home/me',
      platform: 'darwin',
    });
    expect(roots).toContain('/System/Library');
    expect(roots).not.toContain('/Applications/Xcode.app');
  });

  it('adds no macOS system roots on other platforms', () => {
    expect(
      delegationToolchainReadRoots(['/usr/local/bin'], {
        home: '/home/me',
        platform: 'linux',
      }),
    ).toEqual(['/usr/local/bin', '/usr/local']);
  });
});

describe('delegationOutermostRoots', () => {
  it('keeps only the roots no other root contains, in order', () => {
    expect(
      delegationOutermostRoots(
        [
          '/usr/bin',
          '/opt/homebrew/bin',
          '/opt/homebrew',
          '/Users/me/.nvm/versions/node/v24.21.0/lib/node_modules/.bin',
          '/Users/me/.nvm/versions/node/v24.21.0/bin',
          '/Users/me/.nvm/versions/node/v24.21.0/lib',
          '/usr',
          '/usr/lib',
          '/usr',
          'relative/bin',
        ],
        { platform: 'darwin' },
      ),
    ).toEqual([
      '/opt/homebrew',
      '/Users/me/.nvm/versions/node/v24.21.0/bin',
      '/Users/me/.nvm/versions/node/v24.21.0/lib',
      '/usr',
    ]);
  });
});
