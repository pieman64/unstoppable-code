import { execFile } from 'node:child_process';
import { spawn as spawnPty } from 'node-pty';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import {
  TerminalEngine,
  TerminalShells,
  type TerminalEngineHost,
  type TerminalEngineOptions,
  type TerminalResourceHandle,
  type TerminalShellHostPort,
  type WorkerTerminalEventType,
  type WorkerTerminalPort,
} from '@canopy/core-runtime/node/terminal';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  getEnhancedEnv,
  isLinuxLoginShellPathSupported,
  resolveLinuxAccountShell,
} from '@canopy/desktop-shared/pipelines/config-paths';
import { findExecutableOnPath } from '@canopy/desktop-shared/node/lib/path-lookup';
import { startWindowsProcessTreeKill } from '@canopy/desktop-shared/node/lib/process-kill';
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

/** Electron main's host ports for the terminal engine. */
export function createDesktopTerminalHost(): TerminalEngineHost {
  return {
    shells: desktopTerminalShells,
    pty: { spawn: spawnPty },
    environment: {
      base: () => getEnhancedEnv({ environment: false }),
      worktree: (projectId, worktreeId) =>
        buildWorktreeDataEnv(projectId, worktreeId, undefined, {
          runtime: 'canopy',
        }),
      variable: (name) => process.env[name],
    },
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

/** The in-process `worker.terminal` port every main-process caller uses. */
export const workerTerminal: WorkerTerminalPort = createDesktopTerminalEngine();
