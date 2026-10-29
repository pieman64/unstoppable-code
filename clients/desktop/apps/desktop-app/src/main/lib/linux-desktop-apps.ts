import { posix } from 'node:path';
import type { AppLaunchSpec, DetectedApp } from '@canopy/desktop-shared/types';
import {
  desktopFileIndex,
  linuxDataRoots,
  linuxExecutable,
  readDesktopText,
} from './linux-desktop-files';
import {
  decodeDesktopString,
  hasDesktopControlCharacters,
  terminalLaunchArgs,
  hasUnsafeDesktopArgument,
  parseDesktopExec,
  terminalDirectoryArgs,
} from './linux-desktop-exec';
import { createLinuxIconResolver } from './linux-desktop-icons';

interface LinuxDesktopEntry {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly exec: string;
  readonly command: string;
  readonly terminalCommand?: string;
  readonly category: DetectedApp['category'];
}

function desktopValues(raw: string): Map<string, string> {
  const values = new Map<string, string>();
  let inEntry = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inEntry = trimmed === '[Desktop Entry]';
      continue;
    }
    if (!inEntry || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z0-9-]+(?:\[[A-Za-z0-9_@.-]+\])?)\s*=(.*)$/.exec(
      trimmed,
    );
    if (match) values.set(match[1], match[2].trim());
  }
  return values;
}

function localizedName(
  values: ReadonlyMap<string, string>,
): string | undefined {
  const locale = (
    process.env.LC_ALL ||
    process.env.LC_MESSAGES ||
    process.env.LANG ||
    ''
  ).replace(/\.[^@]+/, '');
  const [base, modifier] = locale.split('@');
  const language = base.split('_')[0];
  for (const candidate of [
    locale,
    base,
    ...(modifier ? [`${language}@${modifier}`] : []),
    language,
  ]) {
    const value = values.get(`Name[${candidate}]`);
    if (value !== undefined) return decodeDesktopString(value);
  }
  const name = values.get('Name');
  return name === undefined ? undefined : decodeDesktopString(name);
}

function category(
  values: ReadonlyMap<string, string>,
  command: string,
): DetectedApp['category'] | undefined {
  const categories = (values.get('Categories') ?? '').split(';');
  if (categories.includes('TerminalEmulator')) return 'terminal';
  if (categories.includes('FileManager')) return 'file-manager';
  if (categories.includes('RevisionControl')) return 'git-gui';
  if (categories.includes('TextEditor') || categories.includes('IDE'))
    return 'editor';
  const name = posix.basename(command);
  if (terminalDirectoryArgs(name, '')) return 'terminal';
  if (
    /^(code(?:-insiders)?|codium|cursor|subl(?:ime_text)?|gedit|gnome-text-editor|kate|kwrite|webstorm|idea|zed)$/.test(
      name,
    )
  )
    return 'editor';
  if (/^(nautilus|dolphin|thunar|nemo|pcmanfm(?:-qt)?)$/.test(name))
    return 'file-manager';
  if (/^(gitg|gitk|git-cola|smartgit|gitkraken)$/.test(name)) return 'git-gui';
  return undefined;
}

async function readEntry(
  id: string,
  file: string,
): Promise<LinuxDesktopEntry | undefined> {
  const raw = await readDesktopText(file);
  if (raw === undefined) return undefined;
  const values = desktopValues(raw);
  const name = localizedName(values);
  const exec = values.get('Exec');
  if (
    values.get('Type') !== 'Application' ||
    !name ||
    !exec ||
    values.get('Hidden') === 'true' ||
    values.get('NoDisplay') === 'true' ||
    values.get('Terminal') === 'true' ||
    hasDesktopControlCharacters(name)
  )
    return undefined;
  const desktops = (process.env.XDG_CURRENT_DESKTOP ?? '')
    .split(':')
    .filter(Boolean);
  const only = values.get('OnlyShowIn');
  const not = values.get('NotShowIn');
  if (
    (only !== undefined &&
      !only.split(';').some((desktop) => desktops.includes(desktop))) ||
    (not !== undefined &&
      not.split(';').some((desktop) => desktops.includes(desktop)))
  )
    return undefined;
  const icon = decodeDesktopString(values.get('Icon') ?? '');
  if (
    icon === undefined ||
    hasDesktopControlCharacters(icon) ||
    hasUnsafeDesktopArgument(icon)
  )
    return undefined;
  const parsed = parseDesktopExec(exec, { name, file, icon });
  if (!parsed) return undefined;
  const executable = await linuxExecutable(parsed.command);
  if (!executable) return undefined;
  const command = executable.command;
  const terminalCommand = terminalDirectoryArgs(command, '')
    ? command
    : terminalDirectoryArgs(executable.canonical, '')
      ? executable.canonical
      : undefined;
  const tryExec = values.get('TryExec');
  if (tryExec !== undefined) {
    const decodedTryExec = decodeDesktopString(tryExec);
    if (!decodedTryExec || !(await linuxExecutable(decodedTryExec)))
      return undefined;
  }
  // Executable identity takes precedence over untrusted category labels.
  const kind = terminalCommand ? 'terminal' : category(values, parsed.command);
  if (
    !kind ||
    (kind === 'terminal' &&
      (parsed.hasTarget ||
        !terminalLaunchArgs(terminalCommand ?? command, parsed.args, '')))
  )
    return undefined;
  return {
    id,
    name,
    icon,
    exec,
    command,
    terminalCommand,
    category: kind,
  };
}

export async function detectLinuxDesktopApps(): Promise<DetectedApp[]> {
  const roots = linuxDataRoots();
  const index = await desktopFileIndex(roots);
  const icon = createLinuxIconResolver(roots);
  const result: DetectedApp[] = [];
  // Serial async reads bound both descriptor pressure and main-thread parsing.
  for (const [id, file] of Array.from(index.entries())) {
    const entry = await readEntry(`linux:${id}`, file);
    if (entry)
      result.push({
        id: entry.id,
        name: entry.name,
        category: entry.category,
        icon: await icon(entry.icon),
      });
  }
  return result.sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}

export async function linuxDesktopLaunchSpec(
  appId: string,
  cwd: string,
): Promise<AppLaunchSpec | undefined> {
  if (
    !appId.startsWith('linux:') ||
    !posix.isAbsolute(cwd) ||
    hasUnsafeDesktopArgument(cwd)
  )
    return undefined;
  // Do not trust cached descriptors or paths: repeat precedence and availability
  // checks at launch, including newly added higher-priority tombstones.
  const file = (await desktopFileIndex(linuxDataRoots())).get(
    appId.slice('linux:'.length),
  );
  if (!file) return undefined;
  const entry = await readEntry(appId, file);
  if (!entry) return undefined;
  const parsed = parseDesktopExec(entry.exec, {
    name: entry.name,
    icon: entry.icon,
    file,
    target: cwd,
  });
  if (!parsed) return undefined;
  const args =
    entry.category === 'terminal'
      ? terminalLaunchArgs(
          entry.terminalCommand ?? entry.command,
          parsed.args,
          cwd,
        )
      : [...parsed.args, ...(parsed.hasTarget ? [] : [cwd])];
  if (!args) return undefined;
  if (args.some(hasUnsafeDesktopArgument)) return undefined;
  return { id: appId, name: entry.name, command: entry.command, args, cwd };
}
