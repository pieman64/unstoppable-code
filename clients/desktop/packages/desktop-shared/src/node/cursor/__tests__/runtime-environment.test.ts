import {
  withheldCursorEnvironmentNames,
  prepareCursorRuntimeEnvironment,
} from '../runtime-environment';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Direct coverage for the REAL module.
 *
 * Every existing exercise of this logic went through a mock that reimplemented
 * it — including the refused-name list, character for character. That kind of
 * mock cannot fail when the real implementation changes, which is the one thing
 * coverage here is for. These tests call the real functions.
 */
describe('withheldCursorEnvironmentNames', () => {
  it('withholds every prefixed family and every individually refused name', () => {
    expect(
      withheldCursorEnvironmentNames({
        CURSOR_API_KEY: 'x',
        AGENT_CLI_THING: 'x',
        GIT_CONFIG_COUNT: '1',
        NODE_OPTIONS: '--x',
        NODE_PATH: '/x',
        BASH_ENV: '/x',
        ENV: '/x',
        GH_TOKEN: 'x',
        GITHUB_TOKEN: 'x',
        PATH: '/usr/bin',
        HARMLESS: 'x',
      }),
    ).toEqual([
      'AGENT_CLI_THING',
      'BASH_ENV',
      'CURSOR_API_KEY',
      'ENV',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'GIT_CONFIG_COUNT',
      'NODE_OPTIONS',
      'NODE_PATH',
    ]);
  });

  it('matches case-insensitively and reports the upper-cased name', () => {
    // A child's environment is case-sensitive on POSIX, so a lower-cased
    // `gh_token` is a different variable that must still be refused.
    expect(withheldCursorEnvironmentNames({ gh_token: 'x' })).toEqual([
      'GH_TOKEN',
    ]);
    expect(withheldCursorEnvironmentNames({ cursor_api_key: 'x' })).toEqual([
      'CURSOR_API_KEY',
    ]);
  });

  it('withholds nothing for an ordinary environment, and tolerates undefined', () => {
    expect(
      withheldCursorEnvironmentNames({ PATH: '/usr/bin', HOME: '/home/x' }),
    ).toEqual([]);
    expect(withheldCursorEnvironmentNames(undefined)).toEqual([]);
  });

  it('reports each name once and in sorted order', () => {
    const names = withheldCursorEnvironmentNames({
      GH_TOKEN: 'a',
      gh_token: 'b',
      CURSOR_B: 'c',
      CURSOR_A: 'd',
    });
    expect(names).toEqual(['CURSOR_A', 'CURSOR_B', 'GH_TOKEN']);
    expect(new Set(names).size).toBe(names.length);
  });

  it('reports SHELL and MSYSTEM on Windows, where the runtime drops them', () => {
    // prepareCursorRuntimeEnvironment removes both on Windows so the pinned
    // CLI falls back to PowerShell. A pipeline that declares either must be
    // told, the same as for the names refused on every platform.
    expect(
      withheldCursorEnvironmentNames(
        { SHELL: '/usr/bin/bash', msystem: 'MINGW64', PATH: 'C:\\Windows' },
        'win32',
      ),
    ).toEqual(['MSYSTEM', 'SHELL']);
  });

  it('does not report SHELL or MSYSTEM outside Windows, where they are forwarded', () => {
    expect(
      withheldCursorEnvironmentNames(
        { SHELL: '/bin/zsh', MSYSTEM: 'unrelated', PATH: '/usr/bin' },
        'linux',
      ),
    ).toEqual([]);
    expect(
      withheldCursorEnvironmentNames(
        { SHELL: '/bin/zsh', MSYSTEM: 'unrelated' },
        'darwin',
      ),
    ).toEqual([]);
  });
});

describe('prepareCursorRuntimeEnvironment', () => {
  let root = '';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'canopy-cursor-env-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('strips every CURSOR_-prefixed key from the merged environment', async () => {
    const env = await prepareCursorRuntimeEnvironment(join(root, 'private'), {
      PATH: '/usr/bin',
      CURSOR_API_KEY: 'leak',
      cursor_api_key: 'leak-lower',
      KEEP: 'yes',
    });
    expect(env.KEEP).toBe('yes');
    expect(env.PATH).toBe('/usr/bin');
    // The caller's values are gone...
    expect(Object.values(env)).not.toContain('leak');
    expect(Object.values(env)).not.toContain('leak-lower');
    // ...but the runtime sets its OWN canonical CURSOR_* pair, which is the
    // part a "strip everything CURSOR_*" mock does not model.
    expect(env.CURSOR_CONFIG_DIR).toBeDefined();
    expect(env.CURSOR_DATA_DIR).toBeDefined();
    expect(env.CURSOR_API_KEY).toBeUndefined();
    expect(env.cursor_api_key).toBeUndefined();
  });

  it('is idempotent, so a second step on the same profile still succeeds', async () => {
    // The private overlay creates its own directories; a pre-existing one is an
    // EEXIST race, not a failure.
    const dir = join(root, 'private');
    await prepareCursorRuntimeEnvironment(dir, { PATH: '/usr/bin' });
    await expect(
      prepareCursorRuntimeEnvironment(dir, { PATH: '/usr/bin' }),
    ).resolves.toBeDefined();
  });

  it('drops an inherited Git Bash shell selection on Windows', async () => {
    // The pinned CLI writes hook commands in PowerShell syntax on Windows but
    // runs them in Git Bash when it inherits SHELL or MSYSTEM, as it does when
    // the app is started from a Git Bash terminal. Bash cannot parse them, so
    // the fail-closed approval hook denied every tool call and the session
    // stopped for running a tool the hook never saw.
    const env = await prepareCursorRuntimeEnvironment(
      join(root, 'private'),
      {
        PATH: 'C:\\Windows\\System32',
        SHELL: '/usr/bin/bash',
        MSYSTEM: 'MINGW64',
        Msystem: 'MINGW64',
        KEEP: 'yes',
      },
      'win32',
    );
    expect(env.SHELL).toBeUndefined();
    expect(env.MSYSTEM).toBeUndefined();
    expect(env.Msystem).toBeUndefined();
    expect(env.KEEP).toBe('yes');
    expect(env.PATH).toBe('C:\\Windows\\System32');
  });

  it('keeps SHELL outside Windows, where the CLI runs hooks in that shell', async () => {
    const env = await prepareCursorRuntimeEnvironment(
      join(root, 'private'),
      { PATH: '/usr/bin', SHELL: '/bin/zsh', MSYSTEM: 'unrelated' },
      'linux',
    );
    expect(env.SHELL).toBe('/bin/zsh');
    expect(env.MSYSTEM).toBe('unrelated');
  });
});

describe('prepareCursorRuntimeEnvironment with a per-chat home overlay', () => {
  let root = '';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'canopy-cursor-overlay-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('points HOME at the overlay while config, XDG and caches stay shared', async () => {
    const shared = join(root, 'private');
    const overlay = join(root, 'chat', 'home');
    const env = await prepareCursorRuntimeEnvironment(
      shared,
      { PATH: '/usr/bin' },
      'linux',
      { homeOverlay: overlay },
    );
    expect(env.HOME).toBe(overlay);
    expect(env.ZDOTDIR).toBe(overlay);
    expect(env.XDG_CONFIG_HOME).toBe(join(shared, 'home', '.config'));
    expect(env.XDG_DATA_HOME).toBe(join(shared, 'home', '.local', 'share'));
    expect(env.XDG_CACHE_HOME).toBe(join(shared, 'home', '.cache'));
    expect(env.CURSOR_CONFIG_DIR).toBe(join(shared, 'config'));
    expect(env.NODE_COMPILE_CACHE).toBe(join(shared, 'compile-cache'));
    expect(env.npm_config_cache).toBe(join(shared, 'home', '.npm'));
    const info = await lstat(join(overlay, '.cursor'));
    expect(info.isDirectory()).toBe(true);
    expect(info.isSymbolicLink()).toBe(false);
  });

  it("links the vendor's built-in skills from the shared home into the overlay", async () => {
    const shared = join(root, 'private');
    const overlay = join(root, 'chat', 'home');
    await prepareCursorRuntimeEnvironment(shared, {}, 'linux');
    const builtins = join(shared, 'home', '.cursor', 'skills-cursor');
    await mkdir(builtins, { recursive: true });
    await prepareCursorRuntimeEnvironment(shared, {}, 'linux', {
      homeOverlay: overlay,
    });
    const link = join(overlay, '.cursor', 'skills-cursor');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(builtins);
    // Idempotent on the next turn.
    await expect(
      prepareCursorRuntimeEnvironment(shared, {}, 'linux', {
        homeOverlay: overlay,
      }),
    ).resolves.toBeDefined();
  });

  it('accepts an existing built-ins link that names the same directory by another path', async () => {
    // Link text can differ from the path the next turn asks for (a Windows
    // junction reads back with a `\\?\` prefix, a realpath'd tmp dir); what
    // matters is that both resolve to the same directory.
    const shared = join(root, 'private');
    const overlay = join(root, 'chat', 'home');
    await prepareCursorRuntimeEnvironment(shared, {}, 'linux');
    const builtins = join(shared, 'home', '.cursor', 'skills-cursor');
    await mkdir(builtins, { recursive: true });
    await symlink(join(shared, 'home'), join(root, 'alias'));
    await mkdir(join(overlay, '.cursor'), { recursive: true, mode: 0o700 });
    await symlink(
      join(root, 'alias', '.cursor', 'skills-cursor'),
      join(overlay, '.cursor', 'skills-cursor'),
    );
    await expect(
      prepareCursorRuntimeEnvironment(shared, {}, 'linux', {
        homeOverlay: overlay,
      }),
    ).resolves.toBeDefined();
    // A link to somewhere else is still refused.
    await rm(join(overlay, '.cursor', 'skills-cursor'));
    await mkdir(join(root, 'elsewhere-skills'));
    await symlink(
      join(root, 'elsewhere-skills'),
      join(overlay, '.cursor', 'skills-cursor'),
    );
    await expect(
      prepareCursorRuntimeEnvironment(shared, {}, 'linux', {
        homeOverlay: overlay,
      }),
    ).rejects.toThrow('Cursor built-in skills link is invalid.');
  });

  it('keeps Windows profile storage shared while USERPROFILE follows the overlay', async () => {
    const shared = join(root, 'private');
    const overlay = join(root, 'chat', 'home');
    const env = await prepareCursorRuntimeEnvironment(shared, {}, 'win32', {
      homeOverlay: overlay,
    });
    expect(env.USERPROFILE).toBe(overlay);
    expect(env.HOME).toBe(overlay);
    expect(env.APPDATA).toBe(join(shared, 'home', 'AppData', 'Roaming'));
    expect(env.LOCALAPPDATA).toBe(join(shared, 'home', 'AppData', 'Local'));
  });

  it('refuses an overlay that is a symlink', async () => {
    const shared = join(root, 'private');
    await mkdir(join(root, 'elsewhere'));
    await symlink(join(root, 'elsewhere'), join(root, 'overlay-link'));
    await expect(
      prepareCursorRuntimeEnvironment(shared, {}, 'linux', {
        homeOverlay: join(root, 'overlay-link'),
      }),
    ).rejects.toThrow('Cursor private environment is invalid.');
  });
});

describe('prepareCursorRuntimeEnvironment with a throwaway state overlay', () => {
  let root = '';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'canopy-cursor-state-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('keeps the CLI config and data private while sign-in, XDG and caches stay shared', async () => {
    const shared = join(root, 'private');
    const state = join(root, 'discovery', 'state');
    const env = await prepareCursorRuntimeEnvironment(
      shared,
      { PATH: '/usr/bin' },
      'linux',
      { homeOverlay: join(root, 'discovery', 'home'), stateOverlay: state },
    );
    // Session records (`acp-sessions/`) and per-project worker state
    // (`projects/<slug>`) follow these two, so a launch that must leave
    // nothing behind points them at a directory it deletes afterwards.
    expect(env.CURSOR_CONFIG_DIR).toBe(join(state, 'config'));
    expect(env.CURSOR_DATA_DIR).toBe(join(state, 'data'));
    expect(env.XDG_CONFIG_HOME).toBe(join(shared, 'home', '.config'));
    expect(env.XDG_DATA_HOME).toBe(join(shared, 'home', '.local', 'share'));
    expect(env.NODE_COMPILE_CACHE).toBe(join(shared, 'compile-cache'));
    // The app-owned CLI config lands in the overlay; the shared profile's
    // config is not created or rewritten by this launch.
    const config: unknown = JSON.parse(
      await readFile(join(state, 'config', 'cli-config.json'), 'utf8'),
    );
    expect(config).toMatchObject({
      channel: 'static',
      permissions: { allow: [], deny: [] },
    });
    await expect(
      lstat(join(shared, 'config', 'cli-config.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps Windows sign-in storage at the shared home with a state overlay', async () => {
    const shared = join(root, 'private');
    const state = join(root, 'discovery', 'state');
    const env = await prepareCursorRuntimeEnvironment(shared, {}, 'win32', {
      homeOverlay: join(root, 'discovery', 'home'),
      stateOverlay: state,
    });
    // The pinned CLI reads `%APPDATA%\Cursor\auth.json`, so this is what
    // keeps a throwaway launch signed in on Windows.
    expect(env.APPDATA).toBe(join(shared, 'home', 'AppData', 'Roaming'));
    expect(env.LOCALAPPDATA).toBe(join(shared, 'home', 'AppData', 'Local'));
    expect(env.CURSOR_CONFIG_DIR).toBe(join(state, 'config'));
    expect(env.CURSOR_DATA_DIR).toBe(join(state, 'data'));
  });

  it('refuses a state overlay that is a symlink', async () => {
    const shared = join(root, 'private');
    await mkdir(join(root, 'elsewhere'));
    await symlink(join(root, 'elsewhere'), join(root, 'state-link'));
    await expect(
      prepareCursorRuntimeEnvironment(shared, {}, 'linux', {
        stateOverlay: join(root, 'state-link'),
      }),
    ).rejects.toThrow('Cursor private environment is invalid.');
  });
});
