import { constants } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  getLoginShellPath,
  prewarmLoginShellPath,
} from '@canopy/desktop-shared/pipelines/config-paths';
import {
  detectInstalledApps,
  getDetectedAppLaunchSpec,
  refreshDetectedApps,
} from '../lib/app-detection';

jest.mock('@canopy/core-platform/host-platform', () => ({
  hostOperatingSystem: (): 'linux' => 'linux',
}));
jest.mock('@canopy/desktop-shared/pipelines/config-paths', () => ({
  getLoginShellPath: jest.fn(),
  prewarmLoginShellPath: jest.fn(),
}));
jest.mock('electron', () => ({
  app: { getFileIcon: jest.fn() },
  nativeImage: { createFromBuffer: jest.fn(), createFromPath: jest.fn() },
}));

// Real filesystem fixtures use Linux/POSIX paths; Windows keeps the portable
// parser, launch, cache, and unchanged Windows application suites.
const testPosix =
  jest
    .requireActual<{
      hostOperatingSystem: () => 'darwin' | 'linux' | 'win32' | null;
    }>('@canopy/core-platform/host-platform')
    .hostOperatingSystem() === 'win32'
    ? test.skip
    : test;

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalEnv = { ...process.env };
let root: string;
let executable: string;
let user: string;
let system: string;

async function entry(
  base: string,
  id: string,
  extra = '',
  exec?: string,
): Promise<void> {
  const file = join(base, 'applications', id);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(
    file,
    `[Desktop Entry]\nType=Application\nName=Editor\nCategories=TextEditor;\nExec=${exec ?? `"${executable}" %F`}\n${extra}`,
  );
}

beforeEach(async () => {
  jest
    .mocked(getLoginShellPath)
    .mockReset()
    .mockImplementation(() => process.env.PATH ?? '');
  jest.mocked(prewarmLoginShellPath).mockReset().mockResolvedValue();
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: 'linux',
  });
  root = await mkdtemp(join(tmpdir(), 'linux-apps-'));
  user = join(root, 'user');
  system = join(root, 'system');
  executable = join(root, 'editor with spaces');
  await writeFile(executable, '#!/bin/true\n');
  await chmod(
    executable,
    constants.S_IRUSR | constants.S_IWUSR | constants.S_IXUSR,
  );
  process.env.XDG_DATA_HOME = user;
  process.env.XDG_DATA_DIRS = system;
  process.env.XDG_CURRENT_DESKTOP = 'GNOME:Unity';
  process.env.PATH = root;
  await refreshDetectedApps();
});
afterEach(async () => {
  process.env = { ...originalEnv };
  if (originalPlatform)
    Object.defineProperty(process, 'platform', originalPlatform);
  await rm(root, { recursive: true, force: true });
});

testPosix(
  'discovers nested desktop IDs and constructs shell-free argv with spaces',
  async () => {
    await entry(system, 'vendor/code.desktop');
    expect(await refreshDetectedApps()).toEqual([
      {
        id: 'linux:vendor-code.desktop',
        name: 'Editor',
        category: 'editor',
        icon: '',
      },
    ]);
    expect(
      await getDetectedAppLaunchSpec(
        'linux:vendor-code.desktop',
        '/repo with spaces',
      ),
    ).toEqual({
      id: 'linux:vendor-code.desktop',
      name: 'Editor',
      command: executable,
      args: ['/repo with spaces'],
      cwd: '/repo with spaces',
    });
  },
);

testPosix.each([
  'Hidden=true',
  'NoDisplay=true',
  'OnlyShowIn=KDE;',
  'NotShowIn=GNOME;',
  'TryExec=missing',
  'Type=Link',
  'Exec=sh -c "touch /tmp/not-run"',
])('user override %s suppresses lower precedence ID', async (extra) => {
  await entry(system, 'code.desktop');
  await entry(user, 'code.desktop', extra);
  expect(await refreshDetectedApps()).toEqual([]);
});

testPosix(
  'malformed and unreadable overrides are tombstones, not system fallback',
  async () => {
    await entry(system, 'code.desktop');
    await mkdir(join(user, 'applications'), { recursive: true });
    await writeFile(
      join(user, 'applications/code.desktop'),
      'not a desktop file',
    );
    expect(await refreshDetectedApps()).toEqual([]);
  },
);

testPosix(
  'launch re-reads precedence, visibility and executable; refresh removes stale entries',
  async () => {
    await entry(system, 'code.desktop');
    expect(await refreshDetectedApps()).toHaveLength(1);
    await entry(user, 'code.desktop', 'Hidden=true');
    expect(
      await getDetectedAppLaunchSpec('linux:code.desktop', root),
    ).toBeUndefined();
    expect(await refreshDetectedApps()).toEqual([]);
    await rm(join(user, 'applications/code.desktop'));
    expect(await refreshDetectedApps()).toHaveLength(1);
    await chmod(executable, 0o600);
    expect(
      await getDetectedAppLaunchSpec('linux:code.desktop', root),
    ).toBeUndefined();
    expect(await refreshDetectedApps()).toEqual([]);
  },
);

testPosix(
  'expands fields exactly once, including URI, icon, name and desktop location',
  async () => {
    await entry(
      user,
      'code.desktop',
      'Icon=editor-icon',
      `"${executable}" %U %i %c %k %%`,
    );
    const cwd = '/repo %f with spaces';
    expect(
      (await getDetectedAppLaunchSpec('linux:code.desktop', cwd))?.args,
    ).toEqual([
      pathToFileURL(cwd).href,
      '--icon',
      'editor-icon',
      'Editor',
      join(user, 'applications/code.desktop'),
      '%',
    ]);
  },
);

testPosix.each([
  '%Z',
  '%',
  '%Ftail',
  '"%F"',
  '%f %U',
  '--no-sandbox',
  '--no-sandbox=true',
  '"unterminated',
  '$(touch /tmp/not-run)',
])('rejects unsafe or malformed Exec %s', async (args) => {
  await entry(user, 'code.desktop', '', `"${executable}" ${args}`);
  expect(await refreshDetectedApps()).toEqual([]);
});

testPosix.each(['sh', 'bash', 'env', 'python3', 'node', 'flatpak', 'sudo'])(
  'refuses evaluating/wrapper command %s',
  async (command) => {
    await writeFile(join(root, command), '#!/bin/true\n', { mode: 0o700 });
    await entry(user, 'code.desktop', '', `${command} -c "hostile"`);
    expect(await refreshDetectedApps()).toEqual([]);
  },
);

// Main Desktop Entry Exec lines, checked against upstream sources:
// https://github.com/GNOME/gnome-terminal/blob/master/data/org.gnome.Terminal.desktop.in
// https://github.com/KDE/konsole/blob/master/desktop/org.kde.konsole.desktop
// https://github.com/xfce-mirror/xfce4-terminal/blob/master/xfce4-terminal.desktop.in
// https://github.com/alacritty/alacritty/blob/master/extra/linux/Alacritty.desktop
// https://github.com/kovidgoyal/kitty/blob/master/setup.py (generated kitty.desktop)
// https://github.com/wez/wezterm/blob/main/assets/wezterm.desktop
// https://github.com/gnunn1/tilix/blob/master/data/pkg/desktop/com.gexperts.Tilix.desktop.in
// https://codeberg.org/dnkl/foot/src/branch/master/foot.desktop
// https://gitlab.gnome.org/GNOME/ptyxis/-/blob/main/data/org.gnome.Ptyxis.desktop.in.in
// https://github.com/GNOME/console/blob/main/data/org.gnome.Console.desktop.in.in
// Console's @BIN_NAME@ resolves to kgx in release builds. Ptyxis includes the
// bare primary entry and upstream new-window/tab desktop actions.
testPosix.each([
  [
    'gnome-terminal',
    'gnome-terminal',
    ['--working-directory', '/repo with spaces'],
  ],
  ['konsole', 'konsole', ['--workdir', '/repo with spaces']],
  [
    'xfce4-terminal',
    'xfce4-terminal',
    ['--working-directory', '/repo with spaces'],
  ],
  ['alacritty', 'alacritty', ['--working-directory', '/repo with spaces']],
  ['kitty', 'kitty', ['--directory', '/repo with spaces']],
  ['wezterm', 'wezterm start --cwd .', ['start', '--cwd', '/repo with spaces']],
  ['tilix', 'tilix', ['--working-directory', '/repo with spaces']],
  ['foot', 'foot', ['--working-directory', '/repo with spaces']],
  ['ptyxis', 'ptyxis', ['--working-directory', '/repo with spaces']],
  [
    'ptyxis',
    'ptyxis --new-window',
    ['--new-window', '--working-directory', '/repo with spaces'],
  ],
  [
    'ptyxis',
    'ptyxis --tab',
    ['--tab', '--working-directory', '/repo with spaces'],
  ],
  ['kgx', 'kgx', ['--working-directory', '/repo with spaces']],
  ['kgx', 'kgx --tab', ['--tab', '--working-directory', '/repo with spaces']],
])(
  'discovers and launches upstream %s Exec with worktree cwd',
  async (name, exec, args) => {
    await writeFile(join(root, name), '#!/bin/true\n', { mode: 0o700 });
    await entry(user, 'terminal.desktop', 'Categories=TerminalEmulator;', exec);
    expect(await refreshDetectedApps()).toEqual([
      {
        id: 'linux:terminal.desktop',
        name: 'Editor',
        category: 'terminal',
        icon: '',
      },
    ]);
    expect(
      (
        await getDetectedAppLaunchSpec(
          'linux:terminal.desktop',
          '/repo with spaces',
        )
      )?.args,
    ).toEqual(args);
  },
);

testPosix.each(['Exec', 'TryExec', 'Exec and TryExec'])(
  'resolves bare %s from the warmed login-shell PATH and launches its absolute executable',
  async (field) => {
    const bin = join(root, 'login bin with spaces');
    const zed = join(bin, 'zed');
    await mkdir(bin);
    await writeFile(zed, '#!/bin/true\n', { mode: 0o700 });
    process.env.PATH = join(root, 'limited-desktop-path');
    let warm = false;
    jest.mocked(prewarmLoginShellPath).mockImplementation(async () => {
      await Promise.resolve();
      warm = true;
    });
    jest
      .mocked(getLoginShellPath)
      .mockImplementation(() => (warm ? bin : (process.env.PATH ?? '')));
    await entry(
      user,
      'zed.desktop',
      field === 'Exec' ? '' : 'TryExec=zed',
      field === 'TryExec' ? `"${zed}" %F` : 'zed %F',
    );
    expect(await refreshDetectedApps()).toEqual([
      { id: 'linux:zed.desktop', name: 'Editor', category: 'editor', icon: '' },
    ]);
    expect(
      await getDetectedAppLaunchSpec('linux:zed.desktop', '/repo with spaces'),
    ).toEqual({
      id: 'linux:zed.desktop',
      name: 'Editor',
      command: zed,
      args: ['/repo with spaces'],
      cwd: '/repo with spaces',
    });
    expect(prewarmLoginShellPath).toHaveBeenCalled();
    expect(getLoginShellPath).toHaveBeenCalled();
    await rm(zed);
    expect(
      await getDetectedAppLaunchSpec('linux:zed.desktop', '/repo with spaces'),
    ).toBeUndefined();
    expect(await refreshDetectedApps()).toEqual([]);
  },
);

testPosix.each(['', ' --execute="hostile"'])(
  'unknown terminals require an explicit argv/cwd adapter (%s)',
  async (args) => {
    await writeFile(join(root, 'unknown-terminal'), '#!/bin/true\n', {
      mode: 0o700,
    });
    await entry(
      user,
      'unknown.desktop',
      'Categories=TerminalEmulator;',
      `unknown-terminal${args}`,
    );
    expect(await refreshDetectedApps()).toEqual([]);
  },
);

testPosix('cached discovery stays cached until explicit refresh', async () => {
  await entry(user, 'code.desktop');
  expect(await refreshDetectedApps()).toHaveLength(1);
  await rm(join(user, 'applications/code.desktop'));
  expect(await detectInstalledApps()).toHaveLength(1);
  expect(await refreshDetectedApps()).toEqual([]);
});

testPosix.each([
  ['gnome-terminal', '-- sh -c "touch hostile"'],
  ['xfce4-terminal', '-e "touch hostile"'],
  ['xfce4-terminal', '-etouch'],
  ['kitty', 'bash -c "touch hostile"'],
  ['foot', 'python3 -c "hostile"'],
  ['wezterm', 'start -- bash -c hostile'],
])('rejects terminal command evaluation: %s %s', async (name, args) => {
  await writeFile(join(root, name), '#!/bin/true\n', { mode: 0o700 });
  await entry(
    user,
    'terminal.desktop',
    'Categories=TerminalEmulator;',
    `${name} ${args}`,
  );
  expect(await refreshDetectedApps()).toEqual([]);
});

testPosix(
  'supports standard WezTerm start exactly once and harmless static display flags',
  async () => {
    await writeFile(join(root, 'wezterm'), '#!/bin/true\n', { mode: 0o700 });
    await entry(
      user,
      'terminal.desktop',
      'Categories=TerminalEmulator;',
      'wezterm start --always-new-process',
    );
    expect(
      (await getDetectedAppLaunchSpec('linux:terminal.desktop', root))?.args,
    ).toEqual(['start', '--always-new-process', '--cwd', root]);
  },
);

testPosix.each(['TextEditor', 'FileManager', 'RevisionControl'])(
  'terminal identity rejects execution payload despite spoofed %s category',
  async (category) => {
    await writeFile(join(root, 'kitty'), '#!/bin/true\n', { mode: 0o700 });
    await entry(
      user,
      'spoof.desktop',
      `Categories=${category};`,
      'kitty bash -c "hostile"',
    );
    expect(await refreshDetectedApps()).toEqual([]);
  },
);

testPosix(
  'symlink aliases do not bypass canonical terminal execution policy',
  async () => {
    await writeFile(join(root, 'kitty'), '#!/bin/true\n', { mode: 0o700 });
    await symlink(join(root, 'kitty'), join(root, 'innocent-editor'));
    await entry(user, 'spoof.desktop', '', 'innocent-editor bash -c "hostile"');
    expect(await refreshDetectedApps()).toEqual([]);
  },
);
