import { pathToFileURL } from 'node:url';
import {
  parseDesktopExec,
  terminalLaunchArgs,
} from '../lib/linux-desktop-exec';

const context = {
  name: 'Name %f with spaces',
  icon: 'icon %U',
  file: '/apps/editor with spaces.desktop',
  target: '/repo %c with spaces',
};

test.each(['f', 'F', 'u', 'U'])('safely expands one %%%s target', (code) => {
  const result = parseDesktopExec(`code %${code}`, context);
  expect(result?.args).toEqual([
    code.toLowerCase() === 'u'
      ? pathToFileURL(context.target).href
      : context.target,
  ]);
});

test('expands metadata once and removes absent target codes', () => {
  expect(parseDesktopExec('code %i %c %k %%', context)?.args).toEqual([
    '--icon',
    context.icon,
    context.name,
    context.file,
    '%',
  ]);
  expect(
    parseDesktopExec('code %F %i', { ...context, icon: '', target: undefined })
      ?.args,
  ).toEqual([]);
});

test('performs desktop escaping then Exec quoting without shell expansion', () => {
  const parsed = parseDesktopExec(
    String.raw`code "a\\"b" "literal\\$HOME" "two\\\\slashes" empty\\ value ""`,
    context,
  );
  expect(parsed?.args).toEqual([
    'a"b',
    'literal$HOME',
    'two\\slashes',
    'empty value',
    '',
  ]);
});

test.each([
  '%d',
  '%D',
  '%n',
  '%N',
  '%v',
  '%m',
  '%x',
  'trailing%',
  '%Ftail',
  '%Utail',
  '%itail',
  '%f %u',
  '"%c"',
  '"%f"',
  String.raw`bad\q`,
  String.raw`trailing\\`,
  'a;b',
  '$(evil)',
  '`evil`',
  "'single quotes'",
  '"$HOME"',
  '"`evil`"',
])('fails closed on unsupported Exec syntax %s', (args) => {
  expect(parseDesktopExec(`code ${args}`, context)).toBeUndefined();
});

test.each([
  'env',
  '/bin/sh',
  '/bin/bash',
  'python3.12',
  'node',
  'flatpak',
  'snap',
  'sudo',
  'bwrap',
  'systemd-run',
  'pwsh',
])('rejects wrapper %s', (command) => {
  expect(parseDesktopExec(`${command} app`, context)).toBeUndefined();
});

test.each([
  '--no-sandbox',
  '--no-sandbox=true',
  '"--no-sandbox"',
  '--args=--no-sandbox',
  '%c',
])('refuses sandbox-disabling argv %s', (arg) => {
  expect(
    parseDesktopExec(`code ${arg}`, { ...context, name: '--no-sandbox' }),
  ).toBeUndefined();
});

test('does not allow positional or attached execution switches in terminal entries', () => {
  for (const terminal of [
    'gnome-terminal',
    'konsole',
    'xfce4-terminal',
    'alacritty',
    'kitty',
    'wezterm',
    'tilix',
    'foot',
    'ptyxis',
    'kgx',
  ]) {
    for (const args of [
      ['sh', '-c', 'payload'],
      ['-eTEXT'],
      ['--', 'bash'],
      ['--command=TEXT'],
    ]) {
      expect(terminalLaunchArgs(terminal, args, '/repo')).toBeUndefined();
    }
  }
});

test.each([
  ['ptyxis', ['--new-window', '--maximize', '--title', 'A title with spaces']],
  ['ptyxis', ['--tab', '--tab-with-profile=profile-id', '--fullscreen']],
  ['kgx', ['--tab', '--title=A title with spaces']],
])('preserves harmless GNOME terminal options for %s', (command, args) => {
  expect(terminalLaunchArgs(command, args, '/repo with spaces')).toEqual([
    ...args,
    '--working-directory',
    '/repo with spaces',
  ]);
});

test.each([
  ['ptyxis', ['--execute', 'hostile']],
  ['ptyxis', ['-xhostile']],
  ['ptyxis', ['--title']],
  ['ptyxis', ['--tab-with-profile=']],
  ['kgx', ['--command', 'hostile']],
  ['kgx', ['--set-shell', 'hostile']],
  ['kgx', ['--title', '--command=hostile']],
])(
  'rejects executable or malformed GNOME terminal options for %s',
  (command, args) => {
    expect(terminalLaunchArgs(command, args, '/repo')).toBeUndefined();
  },
);

test('allows escaped literal percent in quoted arguments and executable names', () => {
  expect(
    parseDesktopExec('"/bin/editor%%name" "100%% literal"', context),
  ).toEqual({
    command: '/bin/editor%name',
    args: ['100% literal'],
    hasTarget: false,
  });
  expect(parseDesktopExec('"/bin/editor%f"', context)).toBeUndefined();
});

test.each([
  ['start', '--cwd', '.'],
  ['start', '--cwd=.'],
  ['start', '--cwd', '/entry with spaces', '--always-new-process'],
  ['start', '--always-new-process', '--cwd=/entry with spaces'],
])('replaces WezTerm entry cwd in %j with the selected worktree', (...args) => {
  expect(terminalLaunchArgs('wezterm', args, '/repo with spaces')).toEqual([
    'start',
    ...(args.includes('--always-new-process') ? ['--always-new-process'] : []),
    '--cwd',
    '/repo with spaces',
  ]);
});

test.each([
  ['start', '--cwd'],
  ['start', '--cwd='],
  ['start', '--cwd', '--always-new-process'],
  ['start', '--cwd', '.', '--', 'bash'],
  ['start', '--cwd=.', '--command=hostile'],
])('rejects malformed or executable WezTerm arguments %j', (...args) => {
  expect(terminalLaunchArgs('wezterm', args, '/repo')).toBeUndefined();
});
