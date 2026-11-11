import { execFile } from 'node:child_process';
import { spawn as spawnPty } from 'node-pty';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import {
  TerminalEngine,
  TerminalShells,
  prependPathEntries,
  sanitizeManagedBaseEnv,
  type TerminalEngineHost,
  type TerminalEngineOptions,
  type TerminalResourceHandle,
  type TerminalEnvironment,
  type TerminalShellHostPort,
  type WorkerTerminalEventType,
} from '@canopy/core-runtime/node/terminal';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { ManagedTerminalCommand } from '@canopy/protocol/terminal';
import {
  getEnhancedEnv,
  isLinuxLoginShellPathSupported,
  resolveLinuxAccountShell,
} from '@canopy/execution-engine/pipelines/config-paths';
import { findExecutableOnPath } from '@canopy/execution-engine/node/lib/path-lookup';
import { startWindowsProcessTreeKill } from '@canopy/execution-engine/node/lib/process-kill';
import { lowerSpawnedProcessPriority } from '../lib/background-process';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { drainOwnedProcess } from '../lib/process-kill';
import { resolveWindowsGitBash } from '../lib/windows-git-bash';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { buildWorktreeDataEnv } from '../lib/worktree-data-env';
import { assertWorkspaceTargetRuntimeStartAllowed } from '../lib/workspace-target-exclusion';
import {
  getExecutionAccounting,
  withExecutionLease,
} from '../execution-accounting';
import { getResourceMonitorService } from '../resource-monitor';
import { terminalPersistenceStore } from './persistence';
import { RoutedWorkerTerminal } from './routed-worker-terminal';

/** The renderer IPC channel each terminal event is sent on. */
export const TERMINAL_EVENT_CHANNELS = {
  spawned: IPC_CHANNELS.terminalSpawned,
  output: IPC_CHANNELS.terminalOutput,
  exit: IPC_CHANNELS.terminalExit,
  runningChanged: IPC_CHANNELS.terminalRunningChanged,
} as const satisfies Record<WorkerTerminalEventType, string>;

const desktopShellHost: TerminalShellHostPort = {
  platform: hostOperatingSystem,
  linuxLoginShellsSupported: isLinuxLoginShellPathSupported,
  accountShell: resolveLinuxAccountShell,
  findOnPath: findExecutableOnPath,
  windowsGitBash: resolveWindowsGitBash,
  variable: (name) => process.env[name],
};

function runTerminalProbe(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        args,
        { encoding: 'utf8', timeout: timeoutMs, windowsHide: true },
        (error, stdout) => {
          resolve(error || typeof stdout !== 'string' ? null : stdout);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

/** Shell selection for every desktop terminal, sharing one account-shell cache. */
export const desktopTerminalShells = new TerminalShells(desktopShellHost);

const desktopTerminalEnvironment: TerminalEngineHost['environment'] = {
  base: () => getEnhancedEnv({ environment: false }),
  worktree: (projectId, worktreeId) =>
    buildWorktreeDataEnv(projectId, worktreeId, undefined, {
      runtime: 'canopy',
    }),
  variable: (name) => process.env[name],
};

/**
 * A user shell's whole environment for a worktree, as the engine merges it;
 * daemon terminals receive it from main (CAN-5088).
 */
export function desktopTerminalEnvironmentFor(
  projectId: string,
  worktreeId: string,
): TerminalEnvironment {
  return {
    ...desktopTerminalEnvironment.base(),
    ...desktopTerminalEnvironment.worktree(projectId, worktreeId),
  };
}

/**
 * A managed command's whole environment as the in-process engine gives its
 * PTY, less what the terminal host adds itself (TERM, COLORTERM, a LANG
 * fallback); daemon-placed Claude terminals receive it from main (CAN-5097).
 */
export function desktopManagedTerminalEnvironmentFor(
  projectId: string,
  worktreeId: string,
  command: ManagedTerminalCommand,
): TerminalEnvironment {
  return {
    ...prependPathEntries(
      sanitizeManagedBaseEnv(
        desktopTerminalEnvironmentFor(projectId, worktreeId),
      ),
      command.pathPrepend,
    ),
    ...(command.env ?? {}),
  };
}

/** Electron main's host ports for the terminal engine. */
export function createDesktopTerminalHost(): TerminalEngineHost {
  return {
    shells: desktopTerminalShells,
    pty: { spawn: spawnPty },
    environment: desktopTerminalEnvironment,
    workspace: {
      worktreeCwd: (...args) => resolveWorktreeCwd(...args),
      assertStartAllowed: assertWorkspaceTargetRuntimeStartAllowed,
    },
    resources: {
      register: (session, pid): TerminalResourceHandle => {
        const claude =
          session.kind === 'claude-code' || session.kind === 'claude-worker';
        return withExecutionLease(
          getExecutionAccounting().track('terminal', session.id),
          getResourceMonitorService().registerProcess({
            id: `terminal:${session.id}`,
            groupId: claude ? 'claude' : 'terminal',
            kind: claude ? 'chat-provider' : 'terminal',
            label: session.title ?? session.shellBasename,
            pid,
            processGroupId: pid,
            metadata: { type: 'generic' },
          }),
        );
      },
    },
    persistence: terminalPersistenceStore,
    processes: {
      killWindowsTree: (pid, onFailure) =>
        startWindowsProcessTreeKill(pid, true, onFailure),
      drainOwned: drainOwnedProcess,
      lowerPriority: (pid) => lowerSpawnedProcessPriority(pid),
      probe: runTerminalProbe,
    },
    log: { warn: logMainProcessWarn },
  };
}

export function createDesktopTerminalEngine(
  overrides: {
    host?: Partial<TerminalEngineHost>;
    options?: TerminalEngineOptions;
  } = {},
): TerminalEngine {
  return new TerminalEngine(
    { ...createDesktopTerminalHost(), ...overrides.host },
    overrides.options,
  );
}

/**
 * The `worker.terminal` port every main-process caller uses: the in-process
 * engine, and eligible local window terminals placed in the
 * daemon (CAN-5088).
 */
export const workerTerminal = new RoutedWorkerTerminal(
  createDesktopTerminalEngine(),
);
