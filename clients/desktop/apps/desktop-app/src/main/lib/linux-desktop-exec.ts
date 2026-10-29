import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

interface ExecToken {
  value: string;
  quotedCode: boolean;
}

// Desktop entries are data, not shell programs. Deliberately do not support
// launchers that can reinterpret their remaining argv as code or another command.
const WRAPPER =
  /^(?:(?:ba|da|a|k|z|fi|tc|c)?sh|busybox|env|sudo|doas|pkexec|su|xargs|nohup|setsid|nice|ionice|chrt|timeout|bwrap|firejail|systemd-run|flatpak|snap|gtk-launch|gio|xdg-open|(?:python|perl|ruby|node|nodejs|php|lua|tclsh|wish|deno|bun|java|js|qjs|gjs|pwsh|powershell|elvish|nu)(?:[\d.]+)?)$/i;

export function isSafeDesktopCommand(command: string): boolean {
  return (
    !!command &&
    !WRAPPER.test(basename(command)) &&
    !command.includes('\0') &&
    !command.includes('--no-sandbox')
  );
}

export function hasUnsafeDesktopArgument(value: string): boolean {
  return value.includes('\0') || /--no-sandbox(?:\b|=)/i.test(value);
}

export function hasDesktopControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function decodeDesktopString(raw: string): string | undefined {
  let decoded = '';
  const escapes: Readonly<Record<string, string>> = {
    s: ' ',
    n: '\n',
    t: '\t',
    r: '\r',
    '\\': '\\',
  };
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (c !== '\\') {
      decoded += c;
      continue;
    }
    const replacement = escapes[raw[++i]];
    if (replacement === undefined) return undefined;
    decoded += replacement;
  }
  return decoded;
}

/** First unescape the desktop string, then tokenize Exec (never shell-parse). */
function tokenize(raw: string): ExecToken[] | undefined {
  if (raw.length > 16_384 || /[\0\r\n]/.test(raw)) return undefined;
  const decoded = decodeDesktopString(raw);
  if (decoded === undefined) return undefined;
  if (/[\0\r\n]/.test(decoded)) return undefined;
  const tokens: ExecToken[] = [];
  let value = '';
  let quoted = false;
  let started = false;
  let quotedCode = false;
  const flush = (): void => {
    if (started) tokens.push({ value, quotedCode });
    value = '';
    started = false;
    quotedCode = false;
  };
  for (let i = 0; i < decoded.length; i += 1) {
    const c = decoded[i];
    if (c === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (c === '\\') {
      const next = decoded[++i];
      if (!next || (quoted && !['"', '`', '$', '\\'].includes(next)))
        return undefined;
      value += next;
      started = true;
      continue;
    }
    if (!quoted && /\s/.test(c)) {
      flush();
      continue;
    }
    // Unquoted shell syntax is invalid Exec syntax, not an invitation to evaluate.
    if ((!quoted && /['><~|&;$*?#()`]/.test(c)) || (quoted && /[$`]/.test(c)))
      return undefined;
    if (c === '%' && decoded[i + 1] === '%') {
      value += '%%';
      i += 1;
      started = true;
      continue;
    }
    if (quoted && c === '%') quotedCode = true;
    value += c;
    started = true;
  }
  if (quoted) return undefined;
  flush();
  return tokens.length <= 256 ? tokens : undefined;
}

interface DesktopExecContext {
  readonly name: string;
  readonly icon: string;
  readonly file: string;
  readonly target?: string;
}

interface DesktopExec {
  readonly command: string;
  readonly args: string[];
  readonly hasTarget: boolean;
}

export function parseDesktopExec(
  raw: string,
  context: DesktopExecContext,
): DesktopExec | undefined {
  const tokens = tokenize(raw);
  const first = tokens?.shift();
  if (!tokens || !first || first.value.replace(/%%/g, '').includes('%'))
    return undefined;
  const command = first.value.replace(/%%/g, '%');
  if (!isSafeDesktopCommand(command)) return undefined;
  const args: string[] = [];
  let targets = 0;
  for (const token of tokens) {
    if (token.quotedCode || hasUnsafeDesktopArgument(token.value))
      return undefined;
    if (token.value === '%i') {
      if (context.icon) args.push('--icon', context.icon);
      continue;
    }
    let expanded = '';
    let omit = false;
    for (let i = 0; i < token.value.length; i += 1) {
      const c = token.value[i];
      if (c !== '%') {
        expanded += c;
        continue;
      }
      const code = token.value[++i];
      if (code === '%') expanded += '%';
      else if (code === 'c') expanded += context.name;
      else if (code === 'k') expanded += context.file;
      else if (['f', 'F', 'u', 'U'].includes(code)) {
        targets += 1;
        if (
          targets > 1 ||
          (['F', 'U'].includes(code) && token.value !== `%${code}`)
        )
          return undefined;
        if (context.target === undefined) omit = true;
        else
          expanded += ['u', 'U'].includes(code)
            ? pathToFileURL(context.target).href
            : context.target;
      } else return undefined;
    }
    if (!omit) args.push(expanded);
  }
  if (args.some(hasUnsafeDesktopArgument)) return undefined;
  return { command, args, hasTarget: targets > 0 };
}

/** Known terminal interfaces only; never feed an entry-supplied command to -e. */
export function terminalDirectoryArgs(
  command: string,
  cwd: string,
): string[] | undefined {
  switch (basename(command)) {
    case 'gnome-terminal':
    case 'xfce4-terminal':
    case 'alacritty':
    case 'tilix':
    case 'foot':
    case 'ptyxis':
    case 'kgx':
      return ['--working-directory', cwd];
    case 'konsole':
      return ['--workdir', cwd];
    case 'kitty':
      return ['--directory', cwd];
    case 'wezterm':
      return ['start', '--cwd', cwd];
    default:
      return undefined;
  }
}

const TERMINAL_FLAGS: Readonly<Record<string, readonly string[]>> = {
  'gnome-terminal': [
    '--window',
    '--tab',
    '--maximize',
    '--full-screen',
    '--hide-menubar',
    '--show-menubar',
  ],
  konsole: [
    '--new-tab',
    '--separate',
    '--fullscreen',
    '--show-menubar',
    '--hide-menubar',
  ],
  'xfce4-terminal': [
    '--window',
    '--tab',
    '--maximize',
    '--fullscreen',
    '--hide-menubar',
    '--show-menubar',
    '--disable-server',
  ],
  alacritty: ['--hold'],
  kitty: ['--single-instance', '--detach'],
  wezterm: ['--always-new-process', '--new-tab'],
  tilix: ['--maximize', '--full-screen', '--new-process'],
  foot: ['--hold', '--maximized', '--fullscreen'],
  ptyxis: [
    '--new-window',
    '--tab',
    '--standalone',
    '--maximize',
    '--fullscreen',
  ],
  kgx: ['--tab'],
};
const TERMINAL_VALUE_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  'gnome-terminal': ['--profile', '--title', '--geometry', '--role'],
  konsole: ['--profile'],
  'xfce4-terminal': ['--title', '--geometry', '--role'],
  alacritty: ['--title', '--class'],
  kitty: ['--class', '--name', '--title'],
  wezterm: ['--class'],
  tilix: ['--profile', '--title', '--geometry'],
  foot: ['--title', '--app-id'],
  ptyxis: ['--title', '--tab-with-profile'],
  kgx: ['--title'],
};

/** Terminal command modes are deny-by-default, including positional commands,
 * attached short flags and --. Only display/profile switches are accepted.
 * Unknown terminals need an explicit adapter: their command execution switches
 * and cwd semantics cannot safely be inferred from category metadata. */
export function terminalLaunchArgs(
  command: string,
  entryArgs: readonly string[],
  cwd: string,
): string[] | undefined {
  const terminal = basename(command);
  const directory = terminalDirectoryArgs(command, cwd);
  if (!directory) return undefined;
  const args = [...entryArgs];
  if (terminal === 'wezterm' && args[0] === 'start') args.shift();
  const launchArgs: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (TERMINAL_FLAGS[terminal]?.includes(arg)) {
      launchArgs.push(arg);
      continue;
    }
    const equal = arg.indexOf('=');
    const key = equal < 0 ? arg : arg.slice(0, equal);
    // Upstream WezTerm uses `start --cwd .`. Replace its directory with the
    // selected worktree, while still validating every other entry argument.
    const replaceCwd = terminal === 'wezterm' && key === '--cwd';
    if (!replaceCwd && !TERMINAL_VALUE_OPTIONS[terminal]?.includes(key))
      return undefined;
    const value = equal < 0 ? args[++i] : arg.slice(equal + 1);
    if (!value || (equal < 0 && value.startsWith('-'))) return undefined;
    if (!replaceCwd) {
      launchArgs.push(arg);
      if (equal < 0) launchArgs.push(value);
    }
  }
  return terminal === 'wezterm'
    ? ['start', ...launchArgs, '--cwd', cwd]
    : [...launchArgs, ...directory];
}
