import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import {
  detectLinuxDesktopApps,
  linuxDesktopLaunchSpec,
} from './linux-desktop-apps';
import { execFile as execFileCb } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { app, nativeImage, type NativeImage } from 'electron';
import { homedir, tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { promisify } from 'node:util';
import { findExecutableOnPath } from '@canopy/desktop-shared/node/lib/path-lookup';
import {
  quoteCmdArgument,
  wrapWindowsCommandShim,
} from '@canopy/desktop-shared/node/lib/windows-process';
import type {
  AppCandidate,
  AppLaunchSpec,
  DetectedApp,
} from '@canopy/desktop-shared/types';

const execFile = promisify(execFileCb);
const ICON_DATA_URL_PREFIX = 'data:image/png;base64,';
const ICON_SIZE_PX = 64;
const WINDOWS_TERMINAL_PROFILE_ID_PREFIX = 'windows-terminal-profile:';

let detectedAppsPromise: Promise<DetectedApp[]> | null = null;

const MACOS_APP_CANDIDATES: AppCandidate[] = [
  {
    id: 'finder',
    name: 'Finder',
    appName: 'Finder',
    appPaths: ['/System/Library/CoreServices/Finder.app'],
    category: 'file-manager',
  },
  {
    id: 'vscode',
    name: 'VS Code',
    appName: 'Visual Studio Code',
    appPaths: [
      '/Applications/Visual Studio Code.app',
      join(homedir(), 'Applications/Visual Studio Code.app'),
    ],
    category: 'editor',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    appName: 'Cursor',
    appPaths: [
      '/Applications/Cursor.app',
      join(homedir(), 'Applications/Cursor.app'),
    ],
    category: 'editor',
  },
  {
    id: 'sublime-text',
    name: 'Sublime Text',
    appName: 'Sublime Text',
    appPaths: [
      '/Applications/Sublime Text.app',
      join(homedir(), 'Applications/Sublime Text.app'),
    ],
    category: 'editor',
  },
  {
    id: 'xcode',
    name: 'Xcode',
    appName: 'Xcode',
    appPaths: ['/Applications/Xcode.app'],
    category: 'editor',
  },
  {
    id: 'webstorm',
    name: 'WebStorm',
    appName: 'WebStorm',
    appPaths: [
      '/Applications/WebStorm.app',
      join(homedir(), 'Applications/WebStorm.app'),
    ],
    category: 'editor',
  },
  {
    id: 'intellij-idea',
    name: 'IntelliJ IDEA',
    appName: 'IntelliJ IDEA',
    appPaths: [
      '/Applications/IntelliJ IDEA.app',
      join(homedir(), 'Applications/IntelliJ IDEA.app'),
    ],
    category: 'editor',
  },
  {
    id: 'terminal',
    name: 'Terminal',
    appName: 'Terminal',
    appPaths: ['/System/Applications/Utilities/Terminal.app'],
    category: 'terminal',
  },
  {
    id: 'iterm2',
    name: 'iTerm2',
    appName: 'iTerm',
    appPaths: [
      '/Applications/iTerm.app',
      join(homedir(), 'Applications/iTerm.app'),
    ],
    category: 'terminal',
  },
  {
    id: 'cmux',
    name: 'cmux',
    appName: 'cmux',
    appPaths: [
      '/Applications/cmux.app',
      join(homedir(), 'Applications/cmux.app'),
    ],
    category: 'terminal',
  },
  {
    id: 'ghostty',
    name: 'Ghostty',
    appName: 'Ghostty',
    appPaths: [
      '/Applications/Ghostty.app',
      join(homedir(), 'Applications/Ghostty.app'),
    ],
    category: 'terminal',
  },
  {
    id: 'warp',
    name: 'Warp',
    appName: 'Warp',
    appPaths: [
      '/Applications/Warp.app',
      join(homedir(), 'Applications/Warp.app'),
    ],
    category: 'terminal',
  },
  {
    id: 'alacritty',
    name: 'Alacritty',
    appName: 'Alacritty',
    appPaths: [
      '/Applications/Alacritty.app',
      join(homedir(), 'Applications/Alacritty.app'),
    ],
    category: 'terminal',
  },
  {
    id: 'kitty',
    name: 'Kitty',
    appName: 'kitty',
    appPaths: [
      '/Applications/kitty.app',
      join(homedir(), 'Applications/kitty.app'),
    ],
    category: 'terminal',
  },
  {
    id: 'sourcetree',
    name: 'Sourcetree',
    appName: 'Sourcetree',
    appPaths: [
      '/Applications/Sourcetree.app',
      join(homedir(), 'Applications/Sourcetree.app'),
    ],
    category: 'git-gui',
  },
  {
    id: 'fork',
    name: 'Fork',
    appName: 'Fork',
    appPaths: [
      '/Applications/Fork.app',
      join(homedir(), 'Applications/Fork.app'),
    ],
    category: 'git-gui',
  },
];

function envPath(name: string, ...segments: string[]): string | null {
  const value = process.env[name];
  return value ? win32.join(value, ...segments) : null;
}

function windowsSystemPath(...segments: string[]): string {
  return win32.join(process.env.SystemRoot ?? 'C:\\Windows', ...segments);
}

function windowsProgramFilesPath(...segments: string[]): string[] {
  return [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
    .filter((value): value is string => Boolean(value))
    .map((value) => win32.join(value, ...segments));
}

function compactPaths(paths: Array<string | null>): string[] {
  return paths.filter((value): value is string => Boolean(value));
}

function encodeIdComponent(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url').replace(/=+$/, '');
}

function decodeIdComponent(value: string): string | null {
  try {
    return Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

const WINDOWS_APP_CANDIDATES: AppCandidate[] = [
  {
    id: 'file-explorer',
    name: 'File Explorer',
    executableNames: ['explorer.exe'],
    appPaths: [windowsSystemPath('explorer.exe')],
    category: 'file-manager',
  },
  {
    id: 'vscode',
    name: 'VS Code',
    executableNames: ['code.cmd', 'code.exe'],
    appPaths: compactPaths([
      envPath('LOCALAPPDATA', 'Programs', 'Microsoft VS Code', 'Code.exe'),
      ...windowsProgramFilesPath('Microsoft VS Code', 'Code.exe'),
    ]),
    category: 'editor',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    executableNames: ['cursor.cmd', 'cursor.exe'],
    appPaths: compactPaths([
      envPath('LOCALAPPDATA', 'Programs', 'cursor', 'Cursor.exe'),
      ...windowsProgramFilesPath('Cursor', 'Cursor.exe'),
    ]),
    category: 'editor',
  },
  {
    id: 'windows-terminal',
    name: 'Windows Terminal',
    executableNames: ['wt.exe'],
    appPaths: compactPaths([
      envPath('LOCALAPPDATA', 'Microsoft', 'WindowsApps', 'wt.exe'),
    ]),
    category: 'terminal',
  },
  {
    id: 'powershell',
    name: 'PowerShell',
    executableNames: ['pwsh.exe', 'powershell.exe'],
    appPaths: [],
    category: 'terminal',
  },
  {
    id: 'github-desktop',
    name: 'GitHub Desktop',
    appPaths: compactPaths([
      envPath('LOCALAPPDATA', 'GitHubDesktop', 'GitHubDesktop.exe'),
    ]),
    category: 'git-gui',
  },
  {
    id: 'fork',
    name: 'Fork',
    appPaths: compactPaths([
      envPath('LOCALAPPDATA', 'Fork', 'Fork.exe'),
      ...windowsProgramFilesPath('Fork', 'Fork.exe'),
    ]),
    category: 'git-gui',
  },
];

function getWindowsTerminalSettingsPaths(): string[] {
  return compactPaths([
    envPath(
      'LOCALAPPDATA',
      'Packages',
      'Microsoft.WindowsTerminal_8wekyb3d8bbwe',
      'LocalState',
      'settings.json',
    ),
    envPath(
      'LOCALAPPDATA',
      'Packages',
      'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe',
      'LocalState',
      'settings.json',
    ),
    envPath('LOCALAPPDATA', 'Microsoft', 'Windows Terminal', 'settings.json'),
  ]);
}

function getAppCandidates(): AppCandidate[] {
  if (hostOperatingSystem() === 'darwin') {
    return MACOS_APP_CANDIDATES;
  }
  if (hostOperatingSystem() === 'win32') {
    return WINDOWS_APP_CANDIDATES;
  }
  return [];
}

function getCandidateById(appId: string): AppCandidate | undefined {
  return getAppCandidates().find((candidate) => candidate.id === appId);
}

async function findInstalledPath(
  candidate: AppCandidate,
): Promise<string | null> {
  for (const p of candidate.appPaths) {
    try {
      await access(p);
      return p;
    } catch {
      // Not found at this path
    }
  }
  for (const executableName of candidate.executableNames ?? []) {
    const executablePath = findExecutableOnPath(executableName);
    if (executablePath) {
      return executablePath;
    }
  }
  return null;
}

async function extractIconFromBundle(appPath: string): Promise<string> {
  const plistPath = join(appPath, 'Contents', 'Info.plist');
  const { stdout } = await execFile(
    '/usr/bin/defaults',
    ['read', plistPath, 'CFBundleIconFile'],
    { windowsHide: hostOperatingSystem() === 'win32' },
  );

  let iconName = stdout.trim();
  if (!iconName.endsWith('.icns')) {
    iconName += '.icns';
  }

  const icnsPath = join(appPath, 'Contents', 'Resources', iconName);
  await access(icnsPath);

  const tmpDir = await mkdtemp(join(tmpdir(), 'canopy-icon-'));
  const tmpPng = join(tmpDir, 'icon.png');

  try {
    await execFile(
      '/usr/bin/sips',
      [
        '-s',
        'format',
        'png',
        '-Z',
        String(ICON_SIZE_PX),
        icnsPath,
        '--out',
        tmpPng,
      ],
      { windowsHide: hostOperatingSystem() === 'win32' },
    );

    const iconImage = nativeImage.createFromPath(tmpPng);
    return nativeImageToPngDataUrl(iconImage);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function nativeImageToPngDataUrl(iconImage: NativeImage): string {
  if (iconImage.isEmpty()) {
    return '';
  }

  const resizedIcon = iconImage.resize({
    width: ICON_SIZE_PX,
    height: ICON_SIZE_PX,
    quality: 'best',
  });
  const outputImage = resizedIcon.isEmpty() ? iconImage : resizedIcon;
  const iconData = outputImage.toPNG();

  return iconData.length > 0
    ? `${ICON_DATA_URL_PREFIX}${iconData.toString('base64')}`
    : '';
}

async function extractIconFromExecutable(
  executablePath: string,
): Promise<string> {
  const shellIcon = await app.getFileIcon(executablePath, { size: 'normal' });
  const shellIconDataUrl = nativeImageToPngDataUrl(shellIcon);
  if (shellIconDataUrl) {
    return shellIconDataUrl;
  }

  return nativeImageToPngDataUrl(nativeImage.createFromPath(executablePath));
}

async function extractCandidateIcon(
  candidate: AppCandidate,
  installedPath: string,
): Promise<string> {
  if (hostOperatingSystem() === 'darwin') {
    return extractIconFromBundle(installedPath);
  }
  if (hostOperatingSystem() === 'win32') {
    return extractIconFromExecutable(installedPath);
  }
  return '';
}

interface WindowsTerminalProfile {
  name: string;
  icon: string;
  guid?: string;
  source?: string;
}

interface RawWindowsTerminalProfile {
  name: string;
  icon?: string;
  commandline?: string;
  guid?: string;
  source?: string;
}

interface ParsedWindowsTerminalSettings {
  defaultProfile?: string;
  profiles: RawWindowsTerminalProfile[];
}

interface WindowsTerminalSettings {
  defaultProfile?: string;
  profiles: WindowsTerminalProfile[];
}

function stripJsonComments(input: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const current = input[i];
    const next = input[i + 1];

    if (inString) {
      output += current;
      if (escaped) {
        escaped = false;
      } else if (current === '\\') {
        escaped = true;
      } else if (current === '"') {
        inString = false;
      }
      continue;
    }

    if (current === '"') {
      inString = true;
      output += current;
      continue;
    }

    if (current === '/' && next === '/') {
      while (i < input.length && input[i] !== '\n') {
        i += 1;
      }
      output += '\n';
      continue;
    }

    if (current === '/' && next === '*') {
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) {
        i += 1;
      }
      i += 1;
      continue;
    }

    output += current;
  }
  return output;
}

function stripTrailingJsonCommas(input: string): string {
  return input.replace(/,\s*([}\]])/g, '$1');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseWindowsTerminalSettings(
  raw: string,
): ParsedWindowsTerminalSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripTrailingJsonCommas(stripJsonComments(raw)));
  } catch {
    return { profiles: [] };
  }

  if (!isRecord(parsed)) {
    return { profiles: [] };
  }
  const defaultProfile =
    typeof parsed.defaultProfile === 'string'
      ? parsed.defaultProfile
      : undefined;
  const profiles = parsed.profiles;
  if (!isRecord(profiles)) {
    return { defaultProfile, profiles: [] };
  }
  const list = profiles.list;
  if (!Array.isArray(list)) {
    return { defaultProfile, profiles: [] };
  }

  const seen = new Set<string>();
  const result: RawWindowsTerminalProfile[] = [];
  for (const item of list) {
    if (!isRecord(item)) {
      continue;
    }
    const profile = item;
    if (profile.hidden === true || typeof profile.name !== 'string') {
      continue;
    }
    const name = profile.name.trim();
    if (!name || seen.has(name.toLocaleLowerCase())) {
      continue;
    }
    seen.add(name.toLocaleLowerCase());
    result.push({
      name,
      ...(typeof profile.icon === 'string' && profile.icon.trim()
        ? { icon: profile.icon.trim() }
        : {}),
      ...(typeof profile.commandline === 'string' && profile.commandline.trim()
        ? { commandline: profile.commandline.trim() }
        : {}),
      ...(typeof profile.guid === 'string' && profile.guid.trim()
        ? { guid: profile.guid.trim() }
        : {}),
      ...(typeof profile.source === 'string' && profile.source.trim()
        ? { source: profile.source.trim() }
        : {}),
    });
  }
  return { defaultProfile, profiles: result };
}

function expandWindowsEnvironmentVariables(value: string): string {
  return value.replace(/%([^%]+)%/g, (match, name: string) => {
    return process.env[name] ?? match;
  });
}

function resolveWindowsTerminalProfileIconPath(
  icon: string | undefined,
  settingsPath: string,
): string | null {
  if (!icon) {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(icon)) {
    return null;
  }
  const expanded = expandWindowsEnvironmentVariables(icon);
  return win32.isAbsolute(expanded)
    ? expanded
    : win32.join(win32.dirname(settingsPath), expanded);
}

function isWindowsTerminalGlyphIcon(icon: string | undefined): boolean {
  if (!icon) {
    return false;
  }
  return Array.from(icon).length === 1 && icon.charCodeAt(0) >= 0xe000;
}

function windowsTerminalGlyphIconDataUrl(glyph: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIZE_PX}" height="${ICON_SIZE_PX}" viewBox="0 0 ${ICON_SIZE_PX} ${ICON_SIZE_PX}"><rect width="100%" height="100%" rx="12" fill="#1f2937"/><text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" font-family="Segoe MDL2 Assets, Segoe Fluent Icons, Segoe UI Symbol, sans-serif" font-size="34" fill="#f9fafb">${glyph}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function windowsTerminalBadgeIconDataUrl(label: string, color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIZE_PX}" height="${ICON_SIZE_PX}" viewBox="0 0 ${ICON_SIZE_PX} ${ICON_SIZE_PX}"><rect width="100%" height="100%" rx="12" fill="${color}"/><text x="50%" y="53%" dominant-baseline="middle" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="24" font-weight="700" fill="#ffffff">${label}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function windowsTerminalSourceIconDataUrl(source: string | undefined): string {
  switch (source) {
    case 'Windows.Terminal.Azure':
      return windowsTerminalBadgeIconDataUrl('AZ', '#2563eb');
    case 'Windows.Terminal.VisualStudio':
      return windowsTerminalBadgeIconDataUrl('VS', '#7c3aed');
    default:
      return '';
  }
}

function extractExecutableFromWindowsCommandLine(
  commandline: string | undefined,
): string | null {
  if (!commandline) {
    return null;
  }
  const expanded = expandWindowsEnvironmentVariables(commandline).trim();
  if (!expanded) {
    return null;
  }
  if (expanded.startsWith('"')) {
    const endQuote = expanded.indexOf('"', 1);
    return endQuote > 1 ? expanded.slice(1, endQuote) : null;
  }
  const match = /^(.+?\.(?:exe|cmd|bat))(?=\s|$)/i.exec(expanded);
  return match?.[1] ?? expanded.split(/\s+/)[0] ?? null;
}

async function extractWindowsTerminalProfileIcon(
  icon: string | undefined,
  settingsPath: string,
  commandline: string | undefined,
  source: string | undefined,
): Promise<string> {
  if (isWindowsTerminalGlyphIcon(icon)) {
    return windowsTerminalGlyphIconDataUrl(icon ?? '');
  }

  const iconPath = resolveWindowsTerminalProfileIconPath(icon, settingsPath);
  if (iconPath) {
    const imageIcon = nativeImageToPngDataUrl(
      nativeImage.createFromPath(iconPath),
    );
    if (imageIcon) {
      return imageIcon;
    }
  }

  const executablePath = extractExecutableFromWindowsCommandLine(commandline);
  if (!executablePath) {
    return windowsTerminalSourceIconDataUrl(source);
  }

  try {
    return (
      (await extractIconFromExecutable(executablePath)) ||
      windowsTerminalSourceIconDataUrl(source)
    );
  } catch {
    return windowsTerminalSourceIconDataUrl(source);
  }
}

async function readWindowsTerminalSettings(): Promise<WindowsTerminalSettings> {
  for (const settingsPath of getWindowsTerminalSettingsPaths()) {
    try {
      const raw = await readFile(settingsPath, 'utf8');
      const parsed = parseWindowsTerminalSettings(raw);
      const profiles = await Promise.all(
        parsed.profiles.map(
          async (profile): Promise<WindowsTerminalProfile> => {
            return {
              name: profile.name,
              ...(profile.guid ? { guid: profile.guid } : {}),
              ...(profile.source ? { source: profile.source } : {}),
              icon: await extractWindowsTerminalProfileIcon(
                profile.icon,
                settingsPath,
                profile.commandline,
                profile.source,
              ),
            };
          },
        ),
      );
      if (profiles.length > 0) {
        return {
          ...(parsed.defaultProfile
            ? { defaultProfile: parsed.defaultProfile }
            : {}),
          profiles,
        };
      }
    } catch {
      // Try the next known Windows Terminal settings location.
    }
  }
  return { profiles: [] };
}

async function loadDetectedApps(): Promise<DetectedApp[]> {
  if (hostOperatingSystem() === 'linux') return detectLinuxDesktopApps();
  const results: DetectedApp[] = [];
  const candidates = getAppCandidates();

  await Promise.all(
    candidates.map(async (candidate) => {
      const installedPath = await findInstalledPath(candidate);
      if (!installedPath) return;

      let icon = '';
      try {
        icon = await extractCandidateIcon(candidate, installedPath);
      } catch {
        // Fall back to empty icon
      }

      let detectedIcon = icon;
      let windowsTerminalSettings: WindowsTerminalSettings | null = null;
      if (
        hostOperatingSystem() === 'win32' &&
        candidate.id === 'windows-terminal'
      ) {
        windowsTerminalSettings = await readWindowsTerminalSettings();
        const defaultProfile = windowsTerminalSettings.profiles.find(
          (profile) =>
            profile.guid &&
            windowsTerminalSettings?.defaultProfile &&
            profile.guid.toLocaleLowerCase() ===
              windowsTerminalSettings.defaultProfile.toLocaleLowerCase(),
        );
        detectedIcon = defaultProfile?.icon || icon;
      }

      results.push({
        id: candidate.id,
        name: candidate.name,
        category: candidate.category,
        icon: detectedIcon,
      });

      if (
        hostOperatingSystem() === 'win32' &&
        candidate.id === 'windows-terminal'
      ) {
        const terminalSettings =
          windowsTerminalSettings ?? (await readWindowsTerminalSettings());
        for (const profile of terminalSettings.profiles) {
          results.push({
            id: `${WINDOWS_TERMINAL_PROFILE_ID_PREFIX}${encodeIdComponent(
              profile.name,
            )}`,
            name: `Windows Terminal: ${profile.name}`,
            category: 'terminal',
            icon: profile.icon || detectedIcon || icon,
          });
        }
      }
    }),
  );

  // Preserve candidate order
  const orderMap = new Map(candidates.map((c, i) => [c.id, i]));
  results.sort((a, b) => {
    const aOrder =
      orderMap.get(a.id) ??
      (a.id.startsWith(WINDOWS_TERMINAL_PROFILE_ID_PREFIX)
        ? (orderMap.get('windows-terminal') ?? 0) + 0.1
        : candidates.length);
    const bOrder =
      orderMap.get(b.id) ??
      (b.id.startsWith(WINDOWS_TERMINAL_PROFILE_ID_PREFIX)
        ? (orderMap.get('windows-terminal') ?? 0) + 0.1
        : candidates.length);
    return aOrder - bOrder;
  });

  return results;
}

export async function detectInstalledApps(): Promise<DetectedApp[]> {
  if (!detectedAppsPromise) {
    const loading = loadDetectedApps().catch((error: unknown) => {
      if (detectedAppsPromise === loading) detectedAppsPromise = null;
      throw error;
    });
    detectedAppsPromise = loading;
  }

  return detectedAppsPromise;
}

export async function refreshDetectedApps(): Promise<DetectedApp[]> {
  detectedAppsPromise = null;
  return detectInstalledApps();
}

export function getAppName(appId: string): string | undefined {
  return getCandidateById(appId)?.appName;
}

export async function getDetectedAppLaunchSpec(
  appId: string,
  cwd: string,
): Promise<AppLaunchSpec | undefined> {
  if (hostOperatingSystem() === 'linux')
    return linuxDesktopLaunchSpec(appId, cwd);
  if (hostOperatingSystem() === 'win32') {
    const encodedProfileName = appId.startsWith(
      WINDOWS_TERMINAL_PROFILE_ID_PREFIX,
    )
      ? appId.slice(WINDOWS_TERMINAL_PROFILE_ID_PREFIX.length)
      : null;
    if (encodedProfileName) {
      const profileName = decodeIdComponent(encodedProfileName);
      const terminalCandidate = getCandidateById('windows-terminal');
      if (!profileName || !terminalCandidate) {
        return undefined;
      }
      const installedPath = await findInstalledPath(terminalCandidate);
      if (!installedPath) {
        return undefined;
      }
      return {
        id: appId,
        name: `Windows Terminal: ${profileName}`,
        command: installedPath,
        args: ['new-tab', '--profile', profileName, '--startingDirectory', cwd],
      };
    }
  }

  const candidate = getCandidateById(appId);
  if (!candidate) {
    return undefined;
  }

  const installedPath = await findInstalledPath(candidate);
  if (!installedPath) {
    return undefined;
  }

  if (hostOperatingSystem() === 'darwin') {
    const appName = candidate.appName;
    if (!appName) {
      return undefined;
    }
    return {
      id: candidate.id,
      name: candidate.name,
      command: '/usr/bin/open',
      args: ['-a', appName, cwd],
    };
  }

  if (hostOperatingSystem() !== 'win32') {
    return undefined;
  }

  if (candidate.id === 'file-explorer') {
    return {
      id: candidate.id,
      name: candidate.name,
      command: installedPath,
      args: [cwd],
    };
  }

  if (candidate.id === 'windows-terminal') {
    return {
      id: candidate.id,
      name: candidate.name,
      command: installedPath,
      args: ['-d', cwd],
    };
  }

  if (candidate.id === 'powershell') {
    return {
      id: candidate.id,
      name: candidate.name,
      command: quoteCmdArgument(installedPath),
      args: ['-NoLogo', '-NoExit'],
      cwd,
      shell: true,
    };
  }

  const launchSpec = wrapWindowsCommandShim({
    command: installedPath,
    args: [cwd],
  });

  return {
    id: candidate.id,
    name: candidate.name,
    command: launchSpec.command,
    args: launchSpec.args,
  };
}
