import { accessSync, constants, existsSync, statSync } from 'node:fs';
import path, { basename } from 'node:path';
import {
  TERMINAL_SHELL_UNAVAILABLE_PREFIX,
  type TerminalSession,
  type TerminalShellProfile,
  type TerminalShellProfileId,
} from '@canopy/protocol/terminal';
import type { PlatformOperatingSystem } from '../../platform/platform-services';
import type { TerminalShellHostPort } from './ports';

export interface ResolvedTerminalShell {
  shell: string;
  args: string[];
  shellBasename: string;
}

const LINUX_ACCOUNT_SHELL_TTL_MS = 5 * 60_000;
// Shells qualified for `-l` login startup. Anything else (nologin, tcsh, …)
// is not launched as the Default until it has been qualified.
const LINUX_SUPPORTED_DEFAULT_SHELLS = new Set(['bash', 'zsh', 'fish']);

export function getErrnoDetail(
  error: Error,
  key: 'code' | 'syscall',
): string | undefined {
  if (key === 'code') {
    return 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
  }
  return 'syscall' in error && typeof error.syscall === 'string'
    ? error.syscall
    : undefined;
}

export function unavailableShellError(sentence: string): Error {
  return new Error(`${TERMINAL_SHELL_UNAVAILABLE_PREFIX}${sentence}`);
}

function existingFile(candidate: string | null | undefined): string | null {
  if (!candidate) {
    return null;
  }
  try {
    const stat = existsSync(candidate);
    return stat ? candidate : null;
  } catch {
    return null;
  }
}

function firstExistingFile(
  candidates: Array<string | null | undefined>,
): string | null {
  for (const candidate of candidates) {
    const existing = existingFile(candidate);
    if (existing !== null) {
      return existing;
    }
  }
  return null;
}

export function terminalShellBasename(
  filePath: string,
  platform: PlatformOperatingSystem | null,
): string {
  return platform === 'win32'
    ? path.win32.basename(filePath)
    : basename(filePath);
}

/** Why a Linux shell path cannot be launched, or null when it can. */
function linuxShellFailure(shell: string): string | null {
  if (!path.posix.isAbsolute(shell) || /[\0\r\n]/.test(shell)) {
    return 'is not an absolute path';
  }
  try {
    if (!statSync(shell).isFile()) return 'is not a file';
    accessSync(shell, constants.X_OK);
    return null;
  } catch (error) {
    const code = error instanceof Error ? getErrnoDetail(error, 'code') : '';
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'was not found';
    return 'is not executable by this user';
  }
}

function isUsableLinuxDefaultShell(
  candidate: string | undefined,
): candidate is string {
  return (
    candidate !== undefined &&
    LINUX_SUPPORTED_DEFAULT_SHELLS.has(basename(candidate)) &&
    linuxShellFailure(candidate) === null
  );
}

interface LinuxShellLookup {
  shell: string | null;
  /** First candidate that exists but cannot be launched, with its reason. */
  problem: string | null;
}

function markExactlyOneDefaultProfile(
  profiles: TerminalShellProfile[],
): TerminalShellProfile[] {
  const defaultIndex = profiles.findIndex((profile) => profile.isDefault);
  const selectedDefaultIndex = defaultIndex >= 0 ? defaultIndex : 0;
  if (selectedDefaultIndex < 0) {
    return profiles;
  }
  return profiles.map((profile, index) => ({
    ...profile,
    isDefault: index === selectedDefaultIndex,
  }));
}

/**
 * Shell selection for terminals: profiles, the default shell and the shell a
 * restored terminal restarts with. One instance per host shares the Linux
 * account-shell cache between every engine on that host.
 */
export class TerminalShells {
  private linuxAccountShellCache: {
    shell: string | undefined;
    at: number;
  } | null = null;

  private linuxAccountShellRefresh: Promise<void> | null = null;

  private linuxAccountShellGeneration = 0;

  public constructor(private readonly host: TerminalShellHostPort) {}

  public platform(): PlatformOperatingSystem | null {
    return this.host.platform();
  }

  public linuxLoginShellsSupported(): boolean {
    return this.host.linuxLoginShellsSupported();
  }

  public basename(filePath: string): string {
    return terminalShellBasename(filePath, this.host.platform());
  }

  public windowsPowerShell(): string | null {
    return (
      this.host.findOnPath('pwsh.exe') ??
      this.host.findOnPath('powershell.exe') ??
      firstExistingFile([
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ])
    );
  }

  private windowsCommandPrompt(): string {
    const comSpec = this.host.variable('ComSpec')?.trim();
    return comSpec && comSpec.length > 0
      ? comSpec
      : 'C:\\Windows\\System32\\cmd.exe';
  }

  private refreshLinuxAccountShell(): Promise<void> {
    if (this.linuxAccountShellRefresh !== null) {
      return this.linuxAccountShellRefresh;
    }
    // A reset bumps the generation: a lookup that finishes afterwards neither
    // writes the cache nor clears its successor's in-flight slot.
    const generation = this.linuxAccountShellGeneration;
    const refresh: Promise<void> = this.host
      .accountShell()
      .then((shell): void => {
        if (generation === this.linuxAccountShellGeneration) {
          this.linuxAccountShellCache = { shell, at: Date.now() };
        }
      })
      .finally((): void => {
        if (this.linuxAccountShellRefresh === refresh) {
          this.linuxAccountShellRefresh = null;
        }
      });
    this.linuxAccountShellRefresh = refresh;
    return refresh;
  }

  /**
   * Cache-only read of the account's login shell: it never blocks. An absent
   * or expired entry starts one background bounded `getent` lookup (the same
   * one the login-shell PATH uses); the previous value, even a stale or
   * failed one, is returned meanwhile. Entry points that choose a user
   * default await {@link prewarm} first so this is warm when they spawn.
   */
  private cachedLinuxAccountShell(): string | undefined {
    if (
      this.linuxAccountShellCache === null ||
      Date.now() - this.linuxAccountShellCache.at >= LINUX_ACCOUNT_SHELL_TTL_MS
    ) {
      void this.refreshLinuxAccountShell();
    }
    return this.linuxAccountShellCache?.shell;
  }

  /**
   * Warm the account-shell cache before a Default terminal is chosen. A no-op
   * off supported Linux architectures and when `$SHELL` already names a usable shell. Never
   * rejects.
   */
  public async prewarm(): Promise<void> {
    if (
      !this.host.linuxLoginShellsSupported() ||
      isUsableLinuxDefaultShell(this.host.variable('SHELL')?.trim())
    ) {
      return;
    }
    if (
      this.linuxAccountShellCache !== null &&
      Date.now() - this.linuxAccountShellCache.at < LINUX_ACCOUNT_SHELL_TTL_MS
    ) {
      return;
    }
    await this.refreshLinuxAccountShell();
  }

  /** @internal — exposed for testing only */
  public resetForTests(): void {
    this.linuxAccountShellGeneration += 1;
    this.linuxAccountShellCache = null;
    this.linuxAccountShellRefresh = null;
  }

  private findLinuxShell(name: 'bash' | 'zsh'): LinuxShellLookup {
    const candidates = [
      `/bin/${name}`,
      `/usr/bin/${name}`,
      this.host.findOnPath(name),
    ];
    let problem: string | null = null;
    for (const candidate of candidates) {
      if (!candidate) continue;
      const failure = linuxShellFailure(candidate);
      if (failure === null) return { shell: candidate, problem: null };
      if (problem === null && failure !== 'was not found') {
        problem = `${candidate} ${failure}`;
      }
    }
    return { shell: null, problem };
  }

  private linuxDefaultShellPath(): string | null {
    const configured = this.host.variable('SHELL')?.trim();
    if (isUsableLinuxDefaultShell(configured)) return configured;
    const account = this.cachedLinuxAccountShell();
    if (isUsableLinuxDefaultShell(account)) return account;
    return this.findLinuxShell('bash').shell;
  }

  private defaultShell(): ResolvedTerminalShell {
    const platform = this.host.platform();
    if (platform === 'win32') {
      const shell = this.windowsPowerShell() ?? this.windowsCommandPrompt();
      return {
        shell,
        args: shell.toLowerCase().endsWith('cmd.exe') ? [] : ['-NoLogo'],
        shellBasename: this.basename(shell),
      };
    }

    if (this.host.linuxLoginShellsSupported()) {
      const shell = this.linuxDefaultShellPath();
      if (shell === null) {
        throw unavailableShellError(
          "No usable shell was found and Bash isn't installed. Install Bash and try again.",
        );
      }
      return { shell, args: ['-l'], shellBasename: this.basename(shell) };
    }

    const shell =
      this.host.variable('SHELL') ??
      (platform === 'linux' ? '/bin/bash' : '/bin/zsh');
    return { shell, args: ['-l'], shellBasename: this.basename(shell) };
  }

  /** The shell a restored terminal restarts with. */
  public persisted(session: TerminalSession): ResolvedTerminalShell {
    const shellBasename = session.shellBasename || this.basename(session.shell);
    if (this.host.platform() === 'win32') {
      const normalizedShell = session.shell.toLowerCase();
      if (normalizedShell.endsWith('cmd.exe')) {
        return { shell: session.shell, args: [], shellBasename };
      }
      if (normalizedShell.endsWith('bash.exe')) {
        return { shell: session.shell, args: ['--login'], shellBasename };
      }
      return { shell: session.shell, args: ['-NoLogo'], shellBasename };
    }

    if (this.host.linuxLoginShellsSupported()) {
      // Restart/restore keeps the shell the terminal was launched with; a shell
      // that has since been removed is reported, never swapped for another.
      const failure = linuxShellFailure(session.shell);
      if (failure !== null) {
        throw unavailableShellError(
          `This terminal's shell ${session.shell} ${failure}. Open a new terminal to choose another shell.`,
        );
      }
    }

    return { shell: session.shell, args: ['-l'], shellBasename };
  }

  private requireLinuxProfileShell(
    name: 'bash' | 'zsh',
  ): ResolvedTerminalShell {
    const { shell, problem } = this.findLinuxShell(name);
    if (shell === null) {
      throw unavailableShellError(
        `${name} can't start: ${problem ?? "it isn't installed on this computer"}. Choose another shell and try again.`,
      );
    }
    return { shell, args: ['-l'], shellBasename: this.basename(shell) };
  }

  /** The shell a new terminal with this profile starts. */
  public profile(
    profileId: TerminalShellProfileId | undefined,
  ): ResolvedTerminalShell {
    if (profileId === undefined || profileId === 'default') {
      return this.defaultShell();
    }

    if (this.host.platform() === 'win32') {
      if (profileId === 'cmd') {
        const shell = this.windowsCommandPrompt();
        return { shell, args: [], shellBasename: this.basename(shell) };
      }
      if (profileId === 'powershell') {
        const shell = this.windowsPowerShell();
        if (shell === null) {
          throw new Error(
            'PowerShell is not available on this Windows machine.',
          );
        }
        return {
          shell,
          args: shell.toLowerCase().endsWith('cmd.exe') ? [] : ['-NoLogo'],
          shellBasename: this.basename(shell),
        };
      }
      if (profileId === 'git-bash') {
        const shell = this.host.windowsGitBash();
        if (shell === null) {
          throw new Error('Git Bash is not available on this Windows machine.');
        }
        return {
          shell,
          args: ['--login'],
          shellBasename: this.basename(shell),
        };
      }
    }

    if (
      this.host.linuxLoginShellsSupported() &&
      (profileId === 'zsh' || profileId === 'bash')
    ) {
      return this.requireLinuxProfileShell(profileId);
    }
    if (profileId === 'zsh') {
      const shell = firstExistingFile([
        '/bin/zsh',
        this.host.findOnPath('zsh'),
      ]);
      if (shell === null) {
        throw new Error('zsh is not available on this machine.');
      }
      return { shell, args: ['-l'], shellBasename: this.basename(shell) };
    }
    if (profileId === 'bash') {
      const shell = firstExistingFile([
        '/bin/bash',
        this.host.findOnPath('bash'),
      ]);
      if (shell === null) {
        throw new Error('bash is not available on this machine.');
      }
      return { shell, args: ['-l'], shellBasename: this.basename(shell) };
    }

    throw new Error(`Unsupported terminal profile: ${profileId}`);
  }

  private linuxProfiles(): TerminalShellProfile[] {
    const defaultShellPath = this.linuxDefaultShellPath();
    const defaultShellBasename =
      defaultShellPath === null ? '' : basename(defaultShellPath);
    const profiles: TerminalShellProfile[] = [];
    if (this.findLinuxShell('zsh').shell !== null) {
      profiles.push({
        id: 'zsh',
        label: 'zsh',
        isDefault: defaultShellBasename === 'zsh',
      });
    }
    if (this.findLinuxShell('bash').shell !== null) {
      profiles.push({
        id: 'bash',
        label: 'bash',
        isDefault: defaultShellBasename === 'bash',
      });
    }
    if (defaultShellPath !== null && !profiles.some((p) => p.isDefault)) {
      profiles.unshift({
        id: 'default',
        label: defaultShellBasename,
        isDefault: true,
      });
    }
    return markExactlyOneDefaultProfile(profiles);
  }

  /** Actual default shell used to render reviewed terminal command arguments. */
  public defaultShellBasename(): string {
    return this.profile(undefined).shellBasename;
  }

  public listProfiles(): TerminalShellProfile[] {
    if (this.host.linuxLoginShellsSupported()) {
      return this.linuxProfiles();
    }
    const defaultShell = this.defaultShell();
    const defaultShellBasename = this.basename(defaultShell.shell);
    if (this.host.platform() === 'win32') {
      const profiles: TerminalShellProfile[] = [
        {
          id: 'cmd',
          label: 'Command Prompt',
          isDefault: defaultShell.shell.toLowerCase().endsWith('cmd.exe'),
        },
        {
          id: 'powershell',
          label: 'PowerShell',
          isDefault:
            defaultShell.shell.toLowerCase().endsWith('powershell.exe') ||
            defaultShell.shell.toLowerCase().endsWith('pwsh.exe'),
        },
      ];
      if (this.host.windowsGitBash() !== null) {
        profiles.push({
          id: 'git-bash',
          label: 'Git Bash',
          isDefault: false,
        });
      }
      return markExactlyOneDefaultProfile(profiles);
    }

    const profiles: TerminalShellProfile[] = [];
    const zsh = firstExistingFile(['/bin/zsh', this.host.findOnPath('zsh')]);
    if (zsh !== null) {
      profiles.push({
        id: 'zsh',
        label: 'zsh',
        isDefault: defaultShellBasename === 'zsh',
      });
    }
    const bash = firstExistingFile(['/bin/bash', this.host.findOnPath('bash')]);
    if (bash !== null) {
      profiles.push({
        id: 'bash',
        label: 'bash',
        isDefault: defaultShellBasename === 'bash',
      });
    }
    if (!profiles.some((profile) => profile.isDefault)) {
      profiles.unshift({
        id: 'default',
        label: defaultShellBasename || 'Default',
        isDefault: true,
      });
    }
    return markExactlyOneDefaultProfile(profiles);
  }
}
