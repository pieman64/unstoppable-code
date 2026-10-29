import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { spawn as spawnPty, type IPty } from 'node-pty';
import {
  IPC_CHANNELS,
  type AuthTerminalExitEvent,
  type AuthTerminalOutputEvent,
  type AuthTerminalProvider,
} from '@canopy/desktop-shared/types';
import {
  getBundledClaudeBinaryPath,
  getBundledCodexBinaryPath,
  getBundledGhBinaryPath,
  getEnhancedEnv,
} from '@canopy/desktop-shared/pipelines/config-paths';
import { startWindowsProcessTreeKill } from '@canopy/desktop-shared/node/lib/process-kill';

const SIGTERM_GRACE_MS = 1500;
const DEFAULT_LANG = 'en_US.UTF-8';

type AuthTerminalChannel =
  | typeof IPC_CHANNELS.authTerminalOutput
  | typeof IPC_CHANNELS.authTerminalExit;

type AuthTerminalEventPayload = AuthTerminalOutputEvent | AuthTerminalExitEvent;

export type AuthTerminalEventSender = (
  channel: AuthTerminalChannel,
  payload: AuthTerminalEventPayload,
) => void;

interface ActiveSession {
  sessionId: string;
  provider: AuthTerminalProvider;
  pty: IPty;
  dataDisposable: { dispose(): void } | null;
  exitDisposable: { dispose(): void } | null;
  exited: boolean;
}

export interface AuthTerminalManagerOptions {
  ptySpawn?: typeof spawnPty;
  createSessionId?: () => string;
  getEnhancedEnvFn?: typeof getEnhancedEnv;
  getClaudeBinaryPath?: () => string;
  getCodexBinaryPath?: () => string;
  getGhBinaryPath?: () => string;
  /** Override for the working directory used when spawning login binaries. */
  homedirFn?: () => string;
  /** Override for the SIGTERM → SIGKILL grace period (ms). */
  sigtermGraceMs?: number;
}

function tryKillPid(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function forceKillPtyTree(pty: IPty): void {
  if (Number.isInteger(pty.pid) && pty.pid > 0) {
    if (process.platform === 'win32') {
      startWindowsProcessTreeKill(pty.pid, true, () => pty.kill());
      return;
    }
    if (tryKillPid(-pty.pid, 'SIGKILL')) {
      return;
    }
    if (tryKillPid(pty.pid, 'SIGKILL')) {
      return;
    }
  }
  try {
    pty.kill();
  } catch {
    // best effort
  }
}

function destroyPtyIfAvailable(pty: IPty): void {
  if (!('destroy' in pty)) {
    return;
  }
  const destroy = pty.destroy;
  if (typeof destroy !== 'function') {
    return;
  }
  try {
    destroy.call(pty);
  } catch {
    // best effort
  }
}

export class AuthTerminalManager {
  private readonly ptySpawn: typeof spawnPty;
  private readonly createSessionId: () => string;
  private readonly getEnhancedEnvFn: typeof getEnhancedEnv;
  private readonly getClaudeBinaryPath: () => string;
  private readonly getCodexBinaryPath: () => string;
  private readonly getGhBinaryPath: () => string;
  private readonly homedirFn: () => string;
  private readonly sigtermGraceMs: number;

  private active: ActiveSession | null = null;
  private eventSender: AuthTerminalEventSender = (): void => {};
  private readonly killTimers = new Map<string, NodeJS.Timeout>();

  public constructor(options: AuthTerminalManagerOptions = {}) {
    this.ptySpawn = options.ptySpawn ?? spawnPty;
    this.createSessionId = options.createSessionId ?? randomUUID;
    this.getEnhancedEnvFn = options.getEnhancedEnvFn ?? getEnhancedEnv;
    this.getClaudeBinaryPath =
      options.getClaudeBinaryPath ?? getBundledClaudeBinaryPath;
    this.getCodexBinaryPath =
      options.getCodexBinaryPath ?? getBundledCodexBinaryPath;
    this.getGhBinaryPath = options.getGhBinaryPath ?? getBundledGhBinaryPath;
    this.homedirFn = options.homedirFn ?? homedir;
    this.sigtermGraceMs = options.sigtermGraceMs ?? SIGTERM_GRACE_MS;
  }

  public setEventSender(sender: AuthTerminalEventSender): void {
    this.eventSender = sender;
  }

  public start(
    provider: AuthTerminalProvider,
    cols: number,
    rows: number,
    verifiedOpenCodeExecutable?: string,
  ): string {
    if (!Number.isInteger(cols) || cols <= 0) {
      throw new Error('Invalid cols: must be a positive integer');
    }
    if (!Number.isInteger(rows) || rows <= 0) {
      throw new Error('Invalid rows: must be a positive integer');
    }

    if (this.active && !this.active.exited) {
      this.killActiveImmediately();
    }

    const { executable, args } =
      provider === 'opencode'
        ? { executable: verifiedOpenCodeExecutable, args: ['auth', 'login'] }
        : this.resolveLoginCommand(provider);
    if (!executable)
      throw new Error('OpenCode runtime must be verified before sign-in.');
    // Auth login shells should not inherit user-configured Canopy
    // environments. The github (`gh auth login`) flow also must not inject the
    // Canopy-managed PAT as GH_TOKEN because gh refuses interactive login when
    // a token is already present.
    const enhancedEnv = this.getEnhancedEnvFn({
      environment: false,
      ...(['github', 'opencode'].includes(provider)
        ? { includeCanopySecrets: false }
        : {}),
    });
    const env = {
      ...enhancedEnv,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: enhancedEnv.LANG ?? DEFAULT_LANG,
      // Claude and Codex both honor BROWSER and still print their complete
      // authorization URL when the launcher exits successfully. Keep that
      // URL inside the auth terminal so the renderer can route it into the
      // worktree's Browser panel instead of stealing focus with a system
      // browser. GitHub's interactive device flow should retain its defaults.
      ...(provider === 'github' ? {} : { BROWSER: 'echo' }),
    };

    const pty = this.ptySpawn(executable, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: this.homedirFn(),
      env,
    });

    const sessionId = this.createSessionId();
    const session: ActiveSession = {
      sessionId,
      provider,
      pty,
      dataDisposable: null,
      exitDisposable: null,
      exited: false,
    };
    this.active = session;

    try {
      session.dataDisposable = pty.onData((data: string): void => {
        if (this.active?.sessionId !== sessionId) {
          return;
        }
        this.emit(IPC_CHANNELS.authTerminalOutput, {
          sessionId,
          data,
        });
      });

      session.exitDisposable = pty.onExit((event): void => {
        this.finalizeSessionExit(
          session,
          event.exitCode,
          typeof event.signal === 'number' ? String(event.signal) : null,
        );
      });
    } catch (error) {
      this.active = null;
      session.exited = true;
      this.disposeSessionResources(session, { destroyPty: true });
      forceKillPtyTree(pty);
      throw error;
    }

    return sessionId;
  }

  public write(sessionId: string, data: string): void {
    if (this.active?.sessionId !== sessionId || this.active.exited) {
      return;
    }
    this.active.pty.write(data);
  }

  public resize(sessionId: string, cols: number, rows: number): void {
    if (this.active?.sessionId !== sessionId || this.active.exited) {
      return;
    }
    if (!Number.isInteger(cols) || cols <= 0) {
      return;
    }
    if (!Number.isInteger(rows) || rows <= 0) {
      return;
    }
    try {
      this.active.pty.resize(cols, rows);
    } catch {
      // Resizing a dying PTY can throw on some platforms; ignore.
    }
  }

  public stop(sessionId: string): void {
    if (this.active?.sessionId !== sessionId || this.active.exited) {
      return;
    }
    const session = this.active;
    try {
      session.pty.kill('SIGTERM');
    } catch {
      // best effort
    }
    if (session.exited) {
      return;
    }
    if (this.killTimers.has(sessionId)) {
      return;
    }
    const timer = setTimeout((): void => {
      this.killTimers.delete(sessionId);
      if (!session.exited) {
        forceKillPtyTree(session.pty);
        this.finalizeSessionExit(session, null, 'forced-cleanup');
      }
    }, this.sigtermGraceMs);
    timer.unref?.();
    this.killTimers.set(sessionId, timer);
  }

  public shutdown(): void {
    this.killTimers.forEach((timer) => clearTimeout(timer));
    this.killTimers.clear();
    if (this.active && !this.active.exited) {
      this.killActiveImmediately();
    }
    this.active = null;
  }

  public getActiveSessionId(): string | null {
    return this.active && !this.active.exited ? this.active.sessionId : null;
  }

  private killActiveImmediately(): void {
    if (!this.active) {
      return;
    }
    const session = this.active;
    forceKillPtyTree(session.pty);
    if (!session.exited) {
      this.finalizeSessionExit(session, null, 'forced-cleanup');
    }
  }

  private finalizeSessionExit(
    session: ActiveSession,
    exitCode: number | null,
    signal: string | null,
  ): void {
    if (session.exited) {
      return;
    }
    const wasActive = this.active?.sessionId === session.sessionId;
    session.exited = true;
    if (wasActive) {
      this.active = null;
    }
    this.disposeSessionResources(session, { destroyPty: true });
    this.emit(IPC_CHANNELS.authTerminalExit, {
      sessionId: session.sessionId,
      provider: session.provider,
      exitCode,
      signal,
    });
  }

  private disposeSessionResources(
    session: ActiveSession,
    options: { destroyPty: boolean },
  ): void {
    const timer = this.killTimers.get(session.sessionId);
    if (timer) {
      clearTimeout(timer);
      this.killTimers.delete(session.sessionId);
    }

    try {
      session.dataDisposable?.dispose();
    } catch {
      // best effort
    }
    session.dataDisposable = null;

    try {
      session.exitDisposable?.dispose();
    } catch {
      // best effort
    }
    session.exitDisposable = null;

    if (options.destroyPty) {
      destroyPtyIfAvailable(session.pty);
    }
  }

  private resolveLoginCommand(
    provider: Exclude<AuthTerminalProvider, 'opencode'>,
  ): {
    executable: string;
    args: string[];
  } {
    if (provider === 'claude') {
      return {
        executable: this.getClaudeBinaryPath(),
        args: ['auth', 'login'],
      };
    }
    if (provider === 'github') {
      return {
        executable: this.getGhBinaryPath(),
        args: ['auth', 'login'],
      };
    }
    return {
      executable: this.getCodexBinaryPath(),
      args: ['login'],
    };
  }

  private emit(
    channel: AuthTerminalChannel,
    payload: AuthTerminalEventPayload,
  ): void {
    this.eventSender(channel, payload);
  }
}

let singleton: AuthTerminalManager | null = null;

export function getAuthTerminalManager(): AuthTerminalManager {
  if (!singleton) {
    singleton = new AuthTerminalManager();
  }
  return singleton;
}

export function resetAuthTerminalManagerForTesting(): void {
  singleton = null;
}
