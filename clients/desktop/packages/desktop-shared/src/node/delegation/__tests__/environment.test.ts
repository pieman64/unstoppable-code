import os from 'node:os';
import {
  buildDelegationClaudeEnvironment,
  buildDelegationCommandEnvironment,
  buildDelegationCursorEnvironment,
} from '../environment';

it('keeps Cursor native sign-in paths without forwarding ambient provider credentials', () => {
  expect(
    buildDelegationCursorEnvironment({
      HOME: '/private/child',
      PATH: '/managed/bin',
      CURSOR_CONFIG_DIR: '/shared/cursor',
      CURSOR_DATA_DIR: '/private/profile',
      XDG_CONFIG_HOME: '/shared/xdg',
      ANTHROPIC_API_KEY: 'private',
      OPENAI_API_KEY: 'private',
      GITHUB_TOKEN: 'private',
      NODE_OPTIONS: '--require malicious.js',
      RANDOM_SECRET: 'private',
    }),
  ).toEqual({
    HOME: '/private/child',
    PATH: '/managed/bin',
    CURSOR_CONFIG_DIR: '/shared/cursor',
    CURSOR_DATA_DIR: '/private/profile',
    XDG_CONFIG_HOME: '/shared/xdg',
    NO_OPEN_BROWSER: '1',
    ELECTRON_RUN_AS_NODE: '1',
    LANG: 'en_US.UTF-8',
  });
});

describe('delegated Claude environment', () => {
  it('copies only explicit provider credentials and fixed runtime requirements', () => {
    const prior = process.env.DELEGATION_ENVIRONMENT_CANARY;
    process.env.DELEGATION_ENVIRONMENT_CANARY = 'not-a-child-secret';
    try {
      const environment = buildDelegationClaudeEnvironment({
        canonicalHome: os.homedir(),
        temporaryDirectory: os.tmpdir(),
        windowsDirectory: process.env.SystemRoot,
        credentials: {
          apiKey: 'selected-api-key',
          baseUrl: 'https://provider.invalid',
          customHeaders: 'test-header: selected',
        },
      });
      expect(environment).toMatchObject({
        HOME: os.homedir(),
        PATH: '',
        ANTHROPIC_API_KEY: 'selected-api-key',
        ANTHROPIC_BASE_URL: 'https://provider.invalid',
      });
      expect(environment.DELEGATION_ENVIRONMENT_CANARY).toBeUndefined();
      expect(environment.NODE_OPTIONS).toBeUndefined();
      expect(environment.CODEX_HOME).toBeUndefined();
      expect(environment.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(Object.values(environment)).not.toContain('not-a-child-secret');
    } finally {
      if (prior === undefined) delete process.env.DELEGATION_ENVIRONMENT_CANARY;
      else process.env.DELEGATION_ENVIRONMENT_CANARY = prior;
    }
  });
  it('turns off inline tool definitions only when the route asks', () => {
    const build = (disableInlineTools?: boolean): Record<string, string> =>
      buildDelegationClaudeEnvironment({
        canonicalHome: os.homedir(),
        temporaryDirectory: os.tmpdir(),
        windowsDirectory: process.env.SystemRoot,
        credentials:
          disableInlineTools === undefined ? {} : { disableInlineTools },
      });
    expect(build(true).CLAUDE_CODE_INLINE_TOOLS).toBe('false');
    expect(build(false).CLAUDE_CODE_INLINE_TOOLS).toBeUndefined();
    expect(build().CLAUDE_CODE_INLINE_TOOLS).toBeUndefined();
  });
  it('points Claude background task output at the host-selected directory', () => {
    const directory = `${os.tmpdir()}/delegated-tasks-test`;
    expect(
      buildDelegationClaudeEnvironment({
        canonicalHome: os.homedir(),
        temporaryDirectory: os.tmpdir(),
        backgroundTaskDirectory: directory,
        credentials: {},
        windowsDirectory: process.env.SystemRoot,
      }).CLAUDE_CODE_TMPDIR,
    ).toBe(directory);
    expect(
      buildDelegationClaudeEnvironment({
        canonicalHome: os.homedir(),
        temporaryDirectory: os.tmpdir(),
        credentials: {},
        windowsDirectory: process.env.SystemRoot,
      }).CLAUDE_CODE_TMPDIR,
    ).toBeUndefined();
    expect(() =>
      buildDelegationClaudeEnvironment({
        canonicalHome: os.homedir(),
        temporaryDirectory: os.tmpdir(),
        backgroundTaskDirectory: 'relative/tasks',
        credentials: {},
        windowsDirectory: process.env.SystemRoot,
      }),
    ).toThrow('Invalid delegation runtime paths');
  });
  it('passes the host Claude config directory so user settings match a parent chat', () => {
    const configDir = `${os.tmpdir()}/isolated-claude-config`;
    expect(
      buildDelegationClaudeEnvironment({
        canonicalHome: os.homedir(),
        temporaryDirectory: os.tmpdir(),
        claudeConfigDirectory: configDir,
        credentials: {},
        windowsDirectory: process.env.SystemRoot,
      }).CLAUDE_CONFIG_DIR,
    ).toBe(configDir);
    expect(
      buildDelegationClaudeEnvironment({
        canonicalHome: os.homedir(),
        temporaryDirectory: os.tmpdir(),
        credentials: {},
        windowsDirectory: process.env.SystemRoot,
      }).CLAUDE_CONFIG_DIR,
    ).toBeUndefined();
    expect(() =>
      buildDelegationClaudeEnvironment({
        canonicalHome: os.homedir(),
        temporaryDirectory: os.tmpdir(),
        claudeConfigDirectory: 'relative/claude',
        credentials: {},
        windowsDirectory: process.env.SystemRoot,
      }),
    ).toThrow('Invalid delegation runtime paths');
  });
  it('preserves the host-resolved command PATH without merging ambient secrets', () => {
    const environment = buildDelegationClaudeEnvironment({
      canonicalHome: os.homedir(),
      temporaryDirectory: os.tmpdir(),
      credentials: {},
      windowsDirectory: process.env.SystemRoot,
      commandPath: '/tools/bin:/usr/bin:/bin',
    });
    expect(environment.PATH).toBe('/tools/bin:/usr/bin:/bin');
    expect(environment.NODE_OPTIONS).toBeUndefined();
  });
  it('refuses relative homes and temporary directories', () => {
    expect(() =>
      buildDelegationClaudeEnvironment({
        canonicalHome: '.',
        temporaryDirectory: os.tmpdir(),
        credentials: {},
      }),
    ).toThrow('Invalid delegation runtime paths');
    expect(() =>
      buildDelegationClaudeEnvironment({
        canonicalHome: os.homedir(),
        temporaryDirectory: 'relative',
        credentials: {},
      }),
    ).toThrow('Invalid delegation runtime paths');
  });
  it('gives Windows children Git Bash and a fixed profile allowlist only', () => {
    const environment = buildDelegationClaudeEnvironment({
      platform: 'win32',
      canonicalHome: 'C:\\Users\\dev',
      temporaryDirectory: 'C:\\Users\\dev\\AppData\\Local\\Temp\\run',
      windowsDirectory: 'C:\\Windows',
      commandPath: 'C:\\Program Files\\Git\\cmd;C:\\Windows\\System32',
      gitBashPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
      windowsProfile: {
        APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
        LOCALAPPDATA: 'relative\\ignored',
        ProgramData: 'C:\\ProgramData',
        USERNAME: 'dev',
        PROCESSOR_ARCHITECTURE: 'AMD64',
      },
      credentials: { apiKey: 'selected-api-key' },
    });
    expect(Object.keys(environment).sort()).toEqual(
      [
        'HOME',
        'PATH',
        'TMPDIR',
        'TMP',
        'TEMP',
        'LANG',
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
        'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
        'DISABLE_AUTOUPDATER',
        'SystemRoot',
        'WINDIR',
        'USERPROFILE',
        'ComSpec',
        'PATHEXT',
        'APPDATA',
        'ProgramData',
        'USERNAME',
        'PROCESSOR_ARCHITECTURE',
        'CLAUDE_CODE_GIT_BASH_PATH',
        'ANTHROPIC_API_KEY',
      ].sort(),
    );
    expect(environment).toMatchObject({
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe',
      USERPROFILE: 'C:\\Users\\dev',
    });
    expect(
      buildDelegationClaudeEnvironment({
        platform: 'win32',
        canonicalHome: 'C:\\Users\\dev',
        temporaryDirectory: 'C:\\Temp',
        windowsDirectory: 'C:\\Windows',
        gitBashPath: 'C:\\tools\\evil.cmd',
        credentials: {},
      }).CLAUDE_CODE_GIT_BASH_PATH,
    ).toBeUndefined();
  });
  it('drops Windows profile values containing any control character', () => {
    const environment = buildDelegationClaudeEnvironment({
      platform: 'win32',
      canonicalHome: 'C:\\Users\\dev',
      temporaryDirectory: 'C:\\Temp',
      windowsDirectory: 'C:\\Windows',
      windowsProfile: {
        USERNAME: 'dev\u0001',
        PROCESSOR_ARCHITECTURE: 'AMD64\u007f',
        APPDATA: 'C:\\Users\\dev\tAppData',
        ProgramData: 'C:\\ProgramData',
      },
      credentials: {},
    });
    expect(environment.USERNAME).toBeUndefined();
    expect(environment.PROCESSOR_ARCHITECTURE).toBeUndefined();
    expect(environment.APPDATA).toBeUndefined();
    expect(environment.ProgramData).toBe('C:\\ProgramData');
  });
  it('keeps the macOS key set unchanged', () => {
    const environment = buildDelegationClaudeEnvironment({
      platform: 'darwin',
      canonicalHome: '/Users/dev',
      temporaryDirectory: '/tmp/run',
      gitBashPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
      windowsProfile: { USERNAME: 'dev' },
      credentials: {},
    });
    expect(Object.keys(environment).sort()).toEqual(
      [
        'HOME',
        'PATH',
        'TMPDIR',
        'TMP',
        'TEMP',
        'LANG',
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
        'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
        'DISABLE_AUTOUPDATER',
      ].sort(),
    );
  });

  it('gives a delegated command process basics without provider settings', () => {
    const prior = process.env.DELEGATION_ENVIRONMENT_CANARY;
    process.env.DELEGATION_ENVIRONMENT_CANARY = 'not-a-child-secret';
    try {
      const environment = buildDelegationCommandEnvironment({
        canonicalHome: '/home/user',
        temporaryDirectory: '/tmp',
        commandPath: '/usr/bin:/bin',
        platform: 'darwin',
      });
      expect(environment).toEqual({
        HOME: '/home/user',
        PATH: '/usr/bin:/bin',
        TMPDIR: '/tmp',
        TMP: '/tmp',
        TEMP: '/tmp',
        LANG: 'en_US.UTF-8',
      });
    } finally {
      if (prior === undefined) delete process.env.DELEGATION_ENVIRONMENT_CANARY;
      else process.env.DELEGATION_ENVIRONMENT_CANARY = prior;
    }
  });
});
