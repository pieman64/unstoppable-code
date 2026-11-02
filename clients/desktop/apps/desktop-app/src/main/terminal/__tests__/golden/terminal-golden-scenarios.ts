// Scenarios for the terminal behavior golden (CAN-5063). Each one drives the
// terminal engine through the operations its callers use today and lets the
// host record what crosses the boundary. A scenario names the OS it simulates;
// the suite itself runs on whatever OS runs Jest.
import {
  TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
  type ManagedTerminalCommand,
  type PersistedTerminalEntry,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type TerminalSpawnRequest,
  type TerminalSession,
} from '@canopy/desktop-shared/types';
import { withWorkspaceTargetArchiveDrain } from '../../../lib/workspace-target-exclusion';
import type * as TerminalService from '../../../services/terminal-service';
import type {
  TerminalAttachmentSink,
  TerminalEngine,
} from '@canopy/core-runtime/node/terminal';
import type { GoldenHost } from './terminal-golden-host';

const PROJECT_ID = 'golden-project';
const WORKTREE_ID = 'golden-worktree';
const OTHER_WORKTREE_ID = 'golden-other-worktree';
export const PACKAGE_DIR = 'packages/web';

/**
 * The `worker.terminal` port operations the scenarios call. Recorded call
 * names keep the engine's names from before the extraction, so the replay
 * read is still recorded as `engine.attach`.
 */
type TerminalGoldenEngine = Pick<
  TerminalEngine,
  | 'create'
  | 'restore'
  | 'replay'
  | 'attach'
  | 'acknowledgeAttachment'
  | 'releaseAttachment'
  | 'write'
  | 'resize'
  | 'kill'
  | 'list'
  | 'killWorktree'
  | 'release'
  | 'killAll'
  | 'replayText'
>;

/** The entry points renderer IPC and the Portal call. */
type TerminalGoldenService = Pick<
  typeof TerminalService,
  | 'spawnTerminal'
  | 'spawnManagedTerminal'
  | 'restoreTerminalForRenderer'
  | 'writeTerminal'
  | 'resizeTerminal'
  | 'closeTerminal'
>;

interface GoldenPaths {
  /** Real worktree checkout, recorded as `<worktree>`. */
  root: string;
  /** Real directory outside the worktree, recorded as `<outside>`. */
  outside: string;
}

export interface GoldenContext extends GoldenPaths {
  host: GoldenHost;
  engine: TerminalGoldenEngine;
  service: TerminalGoldenService;
  /** Record an operation, its input and its result or error. */
  call<T>(name: string, input: unknown, run: () => T): T | undefined;
  callAsync<T>(
    name: string,
    input: unknown,
    run: () => Promise<T>,
  ): Promise<T | undefined>;
  step(label: string): void;
  /** Let microtasks and immediates run. */
  settle(): Promise<void>;
  /** Advance fake time, then settle. */
  advance(ms: number): Promise<void>;
  setEnv(name: string, value: string | undefined): void;
}

export interface GoldenScenario {
  name: string;
  platform: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  env?: Record<string, string | undefined>;
  maxLiveTerminals?: number;
  setup?: (host: GoldenHost, paths: GoldenPaths) => void;
  run: (ctx: GoldenContext) => Promise<void>;
}

const MAC_SHELLS = { '/bin/zsh': 'exec', '/bin/bash': 'exec' } as const;

const BASE_SIZE = { cols: 120, rows: 32 };

function target(
  extra: Partial<TerminalSpawnRequest> = {},
): TerminalSpawnRequest {
  return {
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    ...BASE_SIZE,
    ...extra,
  };
}

function claudeCommand(
  host: GoldenHost,
  extra: Partial<ManagedTerminalCommand> = {},
): ManagedTerminalCommand {
  return {
    executable: host.bundledClaudePath,
    args: ['--session-id', 'golden-session'],
    env: { CANOPY_GOLDEN_CHAT: 'chat-1' },
    title: 'Claude Code',
    kind: 'claude-code',
    focusOnSpawn: true,
    chatId: 'chat-1',
    sessionKey: 'session-key-1',
    ...extra,
  };
}

function persistedShell(
  paths: GoldenPaths,
  id: string,
  extra: {
    session?: Partial<TerminalSession>;
    scrollbackLines?: string[];
    signal?: string | null;
    exitCode?: number | null;
  } = {},
): PersistedTerminalEntry {
  return {
    session: {
      id,
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      shell: '/bin/bash',
      shellBasename: 'bash',
      cwd: paths.root,
      createdAt: 1_700_000_000_000,
      ...extra.session,
    },
    scrollbackLines: extra.scrollbackLines ?? ['echo before', 'before', ''],
    exitCode: extra.exitCode ?? null,
    signal: extra.signal === undefined ? 'app-quit' : extra.signal,
  };
}

function sessionId(session: TerminalSession | undefined): string {
  if (!session) throw new Error('The scenario expected a terminal session');
  return session.id;
}

export const TERMINAL_GOLDEN_SCENARIOS: GoldenScenario[] = [
  {
    name: 'create: default login shell on macOS',
    platform: 'darwin',
    env: { SHELL: '/bin/zsh', LANG: undefined },
    setup: (host: GoldenHost): void => {
      host.virtualFiles = { ...MAC_SHELLS };
    },
    run: async (ctx: GoldenContext): Promise<void> => {
      const session = ctx.call('service.spawnTerminal', target(), () =>
        ctx.service.spawnTerminal(target()),
      );
      const id = sessionId(session);
      ctx.step('the shell prints its prompt');
      ctx.host.pty(0).output('golden% ');
      await ctx.settle();
      ctx.call('engine.list', null, () => ctx.engine.list());
      await ctx.settle();
      ctx.step('the shell exits normally');
      ctx.host.pty(0).exit(0, 0);
      await ctx.settle();
      ctx.call('engine.attach', id, () => ctx.engine.replay(id));
      ctx.call('service.writeTerminal', { terminalId: id, data: 'ls\r' }, () =>
        ctx.service.writeTerminal({ terminalId: id, data: 'ls\r' }),
      );
    },
  },
  {
    name: 'create: explicit shell profiles on macOS',
    platform: 'darwin',
    env: { SHELL: '/bin/zsh', LANG: 'C.UTF-8' },
    setup: (host: GoldenHost): void => {
      host.virtualFiles = { '/bin/bash': 'exec' };
    },
    run: async (ctx: GoldenContext): Promise<void> => {
      for (const terminalProfileId of [
        'bash',
        'zsh',
        'default',
        'cmd',
      ] as const) {
        const request = target({ terminalProfileId });
        ctx.call('service.spawnTerminal', request, () =>
          ctx.service.spawnTerminal(request),
        );
      }
      const invalid = { ...target(), terminalProfileId: 'fish' };
      ctx.call('service.spawnTerminal', invalid, (): unknown =>
        Reflect.apply(ctx.service.spawnTerminal, undefined, [invalid]),
      );
      await ctx.settle();
    },
  },
  {
    name: 'create: shell profiles on Windows',
    platform: 'win32',
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe', LANG: undefined },
    setup: (host: GoldenHost): void => {
      host.executablesOnPath = {
        'pwsh.exe': 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      };
      host.windowsGitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    },
    run: async (ctx: GoldenContext): Promise<void> => {
      for (const terminalProfileId of [
        undefined,
        'cmd',
        'powershell',
        'git-bash',
      ] as const) {
        const request = target(terminalProfileId ? { terminalProfileId } : {});
        ctx.call('service.spawnTerminal', request, () =>
          ctx.service.spawnTerminal(request),
        );
      }
      ctx.step('PowerShell and Git Bash are uninstalled');
      ctx.host.executablesOnPath = {};
      ctx.host.windowsGitBash = null;
      for (const terminalProfileId of [
        undefined,
        'powershell',
        'git-bash',
      ] as const) {
        const request = target(terminalProfileId ? { terminalProfileId } : {});
        ctx.call('service.spawnTerminal', request, () =>
          ctx.service.spawnTerminal(request),
        );
      }
      ctx.step('ComSpec is empty');
      ctx.setEnv('ComSpec', '');
      const cmd = target({ terminalProfileId: 'cmd' });
      ctx.call('service.spawnTerminal', cmd, () =>
        ctx.service.spawnTerminal(cmd),
      );
      await ctx.settle();
    },
  },
  {
    name: 'create: Linux x64 default shell resolution',
    platform: 'linux',
    arch: 'x64',
    env: { SHELL: '/usr/bin/fish', LANG: undefined },
    setup: (host: GoldenHost): void => {
      host.virtualFiles = {
        '/usr/bin/fish': 'exec',
        '/usr/bin/zsh': 'exec',
        '/bin/bash': 'exec',
        '/usr/bin/tcsh': 'exec',
      };
      host.linuxAccountShell = '/usr/bin/zsh';
    },
    run: async (ctx: GoldenContext): Promise<void> => {
      ctx.step('SHELL names a usable, qualified shell');
      ctx.call('service.spawnTerminal', target(), () =>
        ctx.service.spawnTerminal(target()),
      );
      ctx.step('SHELL names an unqualified shell; the account lookup is cold');
      ctx.setEnv('SHELL', '/usr/bin/tcsh');
      ctx.call('service.spawnTerminal', target(), () =>
        ctx.service.spawnTerminal(target()),
      );
      await ctx.settle();
      ctx.step('the account lookup has finished');
      ctx.call('service.spawnTerminal', target(), () =>
        ctx.service.spawnTerminal(target()),
      );
      ctx.step('explicit profiles');
      for (const terminalProfileId of ['zsh', 'bash'] as const) {
        const request = target({ terminalProfileId });
        ctx.call('service.spawnTerminal', request, () =>
          ctx.service.spawnTerminal(request),
        );
      }
      ctx.step('/bin/bash is gone; /usr/bin/bash is present');
      ctx.host.virtualFiles = { '/usr/bin/bash': 'exec' };
      ctx.setEnv('SHELL', undefined);
      const bash = target({ terminalProfileId: 'bash' });
      ctx.call('service.spawnTerminal', bash, () =>
        ctx.service.spawnTerminal(bash),
      );
      const zsh = target({ terminalProfileId: 'zsh' });
      ctx.call('service.spawnTerminal', zsh, () =>
        ctx.service.spawnTerminal(zsh),
      );
      ctx.step('bash is present but not executable');
      ctx.host.virtualFiles = { '/bin/bash': 'plain' };
      ctx.call('service.spawnTerminal', bash, () =>
        ctx.service.spawnTerminal(bash),
      );
      ctx.step('no usable shell at all');
      ctx.host.linuxAccountShell = undefined;
      ctx.host.virtualFiles = {};
      ctx.call('service.spawnTerminal', target(), () =>
        ctx.service.spawnTerminal(target()),
      );
      ctx.step('node-pty cannot start the selected shell');
      ctx.host.virtualFiles = { '/bin/bash': 'exec' };
      ctx.host.ptySpawnFailure = 'posix_spawnp failed.';
      ctx.call('service.spawnTerminal', target(), () =>
        ctx.service.spawnTerminal(target()),
      );
      await ctx.settle();
    },
  },
  {
    name: 'create: one-shot initial command in a POSIX shell',
    platform: 'darwin',
    env: { SHELL: '/bin/zsh', LANG: undefined },
    setup: (host: GoldenHost): void => {
      host.virtualFiles = { ...MAC_SHELLS };
    },
    run: async (ctx: GoldenContext): Promise<void> => {
      const command = "printf '%s\\n' \"it's ready\"";
      const request = target({ initialCommand: command });
      const id = sessionId(
        ctx.call('service.spawnTerminal', request, () =>
          ctx.service.spawnTerminal(request),
        ),
      );
      ctx.step('startup output is held back and debounces the submission');
      ctx.host.pty(0).output('Last login: today\r\n');
      await ctx.advance(60);
      ctx.host.pty(0).output('golden% ');
      await ctx.advance(99);
      await ctx.advance(1);
      ctx.step('the echoed submission is hidden up to its line feed');
      ctx.host.pty(0).output("eval -- 'printf '\"'\"'%s");
      await ctx.settle();
      ctx.host
        .pty(0)
        .output("\\n'\"'\"' \"it's ready\"'; exit\r\nit's ready\r\n");
      await ctx.settle();
      ctx.call('engine.attach', id, () => ctx.engine.replay(id));
      ctx.host.pty(0).exit(0, 0);
      await ctx.settle();
      ctx.step('a silent shell gets the command after the fallback delay');
      const silent = target({ initialCommand: 'make test' });
      ctx.call('service.spawnTerminal', silent, () =>
        ctx.service.spawnTerminal(silent),
      );
      await ctx.advance(999);
      await ctx.advance(1);
      ctx.step('a command over the write limit is refused');
      const oversized = target({ initialCommand: 'x'.repeat(64 * 1024 + 1) });
      ctx.call(
        'service.spawnTerminal',
        { initialCommand: '<64 KiB + 1>' },
        () => ctx.service.spawnTerminal(oversized),
      );
      const blank = target({ initialCommand: '   ' });
      ctx.call('service.spawnTerminal', blank, () =>
        ctx.service.spawnTerminal(blank),
      );
    },
  },
  {
    name: 'create: one-shot initial command in Windows shells',
    platform: 'win32',
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe', LANG: undefined },
    setup: (host: GoldenHost): void => {
      host.executablesOnPath = {
        'powershell.exe':
          'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      };
      host.windowsGitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    },
    run: async (ctx: GoldenContext): Promise<void> => {
      const command = "Write-Output 'it''s ready'";
      for (const terminalProfileId of [
        'powershell',
        'cmd',
        'git-bash',
      ] as const) {
        const request = target({ terminalProfileId, initialCommand: command });
        ctx.call('service.spawnTerminal', request, () =>
          ctx.service.spawnTerminal(request),
        );
      }
      await ctx.advance(1000);
    },
  },
  {
    name: 'create: managed commands with relativeCwd',
    platform: 'darwin',
    env: { SHELL: '/bin/zsh', LANG: undefined },
    setup: (host: GoldenHost): void => {
      host.virtualFiles = { ...MAC_SHELLS };
    },
    run: async (ctx: GoldenContext): Promise<void> => {
      ctx.step('renderer IPC: Claude Code in a package directory');
      const claude = target({
        managedCommand: claudeCommand(ctx.host),
        relativeCwd: PACKAGE_DIR,
      });
      ctx.call('service.spawnTerminal', claude, () =>
        ctx.service.spawnTerminal(claude),
      );
      const worker = target({
        managedCommand: claudeCommand(ctx.host, {
          kind: 'claude-worker',
          title: 'Claude worker',
          focusOnSpawn: false,
        }),
      });
      ctx.call('service.spawnTerminal', worker, () =>
        ctx.service.spawnTerminal(worker),
      );
      ctx.step('renderer IPC refusals');
      const refusals: Array<[string, TerminalSpawnRequest]> = [
        [
          'shell profile',
          target({
            managedCommand: claudeCommand(ctx.host),
            terminalProfileId: 'bash',
          }),
        ],
        [
          'initial command',
          target({
            managedCommand: claudeCommand(ctx.host),
            initialCommand: 'ls',
          }),
        ],
        [
          'unbundled executable',
          target({
            managedCommand: claudeCommand(ctx.host, {
              executable: '/usr/local/bin/claude',
            }),
          }),
        ],
        [
          'path override',
          target({
            managedCommand: claudeCommand(ctx.host, {
              pathPrepend: ['/opt/canopy/shims'],
            }),
          }),
        ],
        [
          'blocked env',
          target({
            managedCommand: claudeCommand(ctx.host, {
              env: { NODE_OPTIONS: '--inspect' },
            }),
          }),
        ],
        [
          'script kind',
          target({
            managedCommand: claudeCommand(ctx.host, { kind: 'script' }),
          }),
        ],
        [
          'parent directory',
          target({
            managedCommand: claudeCommand(ctx.host),
            relativeCwd: '../outside',
          }),
        ],
        [
          'symlink out of the worktree',
          target({
            managedCommand: claudeCommand(ctx.host),
            relativeCwd: 'escape',
          }),
        ],
        [
          'file, not a directory',
          target({
            managedCommand: claudeCommand(ctx.host),
            relativeCwd: 'README.md',
          }),
        ],
        [
          'missing directory',
          target({
            managedCommand: claudeCommand(ctx.host),
            relativeCwd: 'packages/missing',
          }),
        ],
        [
          'absolute directory',
          target({
            managedCommand: claudeCommand(ctx.host),
            relativeCwd: '/tmp',
          }),
        ],
      ];
      for (const [label, request] of refusals) {
        ctx.call(`service.spawnTerminal (${label})`, request, () =>
          ctx.service.spawnTerminal(request),
        );
      }
      ctx.step('internal launches: path overrides and absolute directories');
      const internal = {
        ...target({
          managedCommand: claudeCommand(ctx.host, {
            pathPrepend: ['/opt/canopy/shims', '/opt/canopy/bin'],
          }),
          relativeCwd: PACKAGE_DIR,
        }),
      };
      ctx.call('service.spawnManagedTerminal', internal, () =>
        ctx.service.spawnManagedTerminal(internal),
      );
      const absolute = {
        ...target({ managedCommand: claudeCommand(ctx.host) }),
        cwd: ctx.outside,
      };
      ctx.call('service.spawnManagedTerminal', absolute, () =>
        ctx.service.spawnManagedTerminal(absolute),
      );
      const conflict = { ...absolute, relativeCwd: PACKAGE_DIR };
      ctx.call(
        'service.spawnManagedTerminal (both directories)',
        conflict,
        () => ctx.service.spawnManagedTerminal(conflict),
      );
      const missing = target();
      ctx.call('service.spawnManagedTerminal (no command)', missing, () =>
        ctx.service.spawnManagedTerminal(missing),
      );
      ctx.step('script runner: an interactive script in a directory');
      const script: ManagedTerminalCommand = {
        executable: '/bin/zsh',
        args: ['-lc', 'pnpm dev'],
        env: { FORCE_COLOR: '1' },
        title: 'dev',
        kind: 'script',
        focusOnSpawn: true,
      };
      const packageDir = `${ctx.root}/${PACKAGE_DIR}`;
      ctx.call(
        'engine.spawn',
        [PROJECT_ID, WORKTREE_ID, 80, 24, null, script, packageDir],
        () =>
          ctx.engine.create({
            projectId: PROJECT_ID,
            worktreeId: WORKTREE_ID,
            cols: 80,
            rows: 24,
            managedCommand: script,
            cwd: packageDir,
          }),
      );
      ctx.step('script runner: an exact environment boundary');
      const exactEnv = { PATH: '/opt/share/bin', SHARED_SECRET: 'run-copy' };
      ctx.call(
        'engine.spawnWithEnvironment',
        [exactEnv, PROJECT_ID, WORKTREE_ID, 80, 24, null, script, packageDir],
        () =>
          ctx.engine.create({
            projectId: PROJECT_ID,
            worktreeId: WORKTREE_ID,
            cols: 80,
            rows: 24,
            managedCommand: script,
            cwd: packageDir,
            environment: exactEnv,
          }),
      );
      await ctx.settle();
    },
  },
  {
    name: 'create: script action shell in a package directory',
    platform: 'darwin',
    env: { SHELL: '/bin/zsh', LANG: undefined },
    setup: (host: GoldenHost, paths: GoldenPaths): void => {
      host.virtualFiles = { ...MAC_SHELLS };
      host.repoCheckouts = { 'repo-api': `${paths.root}/services/api` };
    },
    run: async (ctx: GoldenContext): Promise<void> => {
      const request = target({ relativeCwd: PACKAGE_DIR });
      const id = sessionId(
        ctx.call('service.spawnTerminal', request, () =>
          ctx.service.spawnTerminal(request),
        ),
      );
      const write = {
        terminalId: id,
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        data: 'pnpm dev\r',
        idempotencyKey: 'script-run-1',
      };
      ctx.call('service.writeTerminal', write, () =>
        ctx.service.writeTerminal(write),
      );
      ctx.step('a retried submission is not written twice');
      ctx.call('service.writeTerminal', write, () =>
        ctx.service.writeTerminal(write),
      );
      ctx.step('the selected repository is the base for relativeCwd');
      const repo = target({ selectedRepoId: 'repo-api', relativeCwd: 'src' });
      ctx.call('service.spawnTerminal', repo, () =>
        ctx.service.spawnTerminal(repo),
      );
      const plainRepo = target({ selectedRepoId: 'repo-api' });
      ctx.call('service.spawnTerminal', plainRepo, () =>
        ctx.service.spawnTerminal(plainRepo),
      );
      const withCommand = target({
        relativeCwd: PACKAGE_DIR,
        terminalProfileId: 'bash',
        initialCommand: 'pnpm test',
      });
      ctx.call('service.spawnTerminal', withCommand, () =>
        ctx.service.spawnTerminal(withCommand),
      );
      const escape = target({ relativeCwd: '../outside' });
      ctx.call('service.spawnTerminal', escape, () =>
        ctx.service.spawnTerminal(escape),
      );
      await ctx.advance(1000);
    },
  },
  {
    name: 'create: refusals before and after spawning',
    platform: 'darwin',
    env: { SHELL: '/bin/zsh', LANG: undefined },
    maxLiveTerminals: 2,
    setup: (host: GoldenHost): void => {
      host.virtualFiles = { ...MAC_SHELLS };
    },
    run: async (ctx: GoldenContext): Promise<void> => {
      const invalid: Array<[string, TerminalSpawnRequest]> = [
        ['zero columns', target({ cols: 0 })],
        ['fractional rows', target({ rows: 2.5 })],
        ['invalid project id', target({ projectId: '../project' })],
        [
          'shared-container viewer',
          target({ projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID }),
        ],
      ];
      for (const [label, request] of invalid) {
        ctx.call(`service.spawnTerminal (${label})`, request, () =>
          ctx.service.spawnTerminal(request),
        );
      }
      ctx.step('an archive in progress refuses new terminals in that worktree');
      await withWorkspaceTargetArchiveDrain(
        PROJECT_ID,
        WORKTREE_ID,
        async (): Promise<void> => {
          ctx.call('service.spawnTerminal', target(), () =>
            ctx.service.spawnTerminal(target()),
          );
          await ctx.settle();
        },
      );
      ctx.step('the live terminal cap');
      for (let index = 0; index < 3; index += 1) {
        ctx.call('service.spawnTerminal', target(), () =>
          ctx.service.spawnTerminal(target()),
        );
      }
      await ctx.settle();
    },
  },
  {
    name: 'attach: output frames, sequence numbers and replay',
    platform: 'darwin',
    env: { SHELL: '/bin/zsh', LANG: undefined },
    setup: (host: GoldenHost): void => {
      host.virtualFiles = { ...MAC_SHELLS };
    },
    run: async (ctx: GoldenContext): Promise<void> => {
      const id = sessionId(
        ctx.call('service.spawnTerminal', target(), () =>
          ctx.service.spawnTerminal(target()),
        ),
      );
      ctx.call('engine.attach (before output)', id, () =>
        ctx.engine.replay(id),
      );
      ctx.step('chunks in one tick coalesce into one frame');
      ctx.host.pty(0).output('one ');
      ctx.host.pty(0).output('two ');
      ctx.host.pty(0).output('three\r\n');
      await ctx.settle();
      ctx.step('a multi-byte character is counted in bytes');
      ctx.host.pty(0).output('caf\u00e9 \u2713\r\n');
      await ctx.settle();
      ctx.step('8 KiB of queued output flushes without waiting');
      ctx.host.pty(0).output('a'.repeat(8 * 1024));
      ctx.host.pty(0).output('tail\r\n');
      await ctx.settle();
      ctx.call('engine.attach', id, () => ctx.engine.replay(id));
      ctx.call('engine.attach (again)', id, () => ctx.engine.replay(id));
      ctx.step('the live replay keeps the last 256 KiB');
      ctx.host.pty(0).output('b'.repeat(300 * 1024));
      await ctx.settle();
      ctx.call('engine.attach', id, () => ctx.engine.replay(id));
      ctx.call(
        'engine.getReplayBufferText (length)',
        id,
        () => ctx.engine.replayText(id)?.length,
      );
      ctx.step('more than 2 MiB unflushed is replaced by a marker');
      ctx.host.pty(0).output('c'.repeat(1024));
      ctx.host.pty(0).output('d'.repeat(2 * 1024 * 1024));
      await ctx.settle();
      ctx.call('engine.attach', id, () => ctx.engine.replay(id));
      ctx.step('after exit, attach reads the persisted entry');
      ctx.host.pty(0).exit(0, 0);
      await ctx.settle();
      ctx.host.persistedEntries.set(
        id,
        persistedShell(ctx, id, {
          session: { shell: '/bin/zsh', shellBasename: 'zsh' },
          scrollbackLines: ['one two three', 'caf\u00e9 \u2713', ''],
          exitCode: 0,
          signal: null,
        }),
      );
      ctx.call('engine.attach (historical)', id, () => ctx.engine.replay(id));
      ctx.call('engine.getReplayBufferText (historical)', id, () =>
        ctx.engine.replayText(id),
      );
      ctx.call('engine.attach (unknown)', 'missing-terminal', () =>
        ctx.engine.replay('missing-terminal'),
      );
    },
  },
  {
    name: 'attach: every attach after restore gets the full history',
    platform: 'darwin',
    env: { SHELL: '/bin/zsh', LANG: undefined },
    setup: (host: GoldenHost, paths: GoldenPaths): void => {
      host.virtualFiles = { ...MAC_SHELLS };
      const line = 'h'.repeat(1023);
      host.persistedEntries.set(
        'restored-long',
        persistedShell(paths, 'restored-long', {
          scrollbackLines: Array.from({ length: 400 }, () => line),
        }),
      );
      host.persistedEntries.set(
        'restored-huge',
        persistedShell(paths, 'restored-huge', {
          scrollbackLines: Array.from({ length: 1100 }, () => line),
        }),
      );
      host.persistedEntries.set(
        'restored-empty',
        persistedShell(paths, 'restored-empty', { scrollbackLines: [] }),
      );
    },
    run: async (ctx: GoldenContext): Promise<void> => {
      ctx.call('engine.restore', ['restored-long', 100, 30], () =>
        ctx.engine.restore({
          terminalId: 'restored-long',
          cols: 100,
          rows: 30,
        }),
      );
      ctx.step(
        'CAN-5075: every attach reads the same window, history included',
      );
      ctx.call('engine.attach (first)', 'restored-long', () =>
        ctx.engine.replay('restored-long'),
      );
      ctx.call('engine.attach (second)', 'restored-long', () =>
        ctx.engine.replay('restored-long'),
      );
      ctx.host.pty(0).output('after restore\r\n');
      await ctx.settle();
      ctx.call('engine.attach (third)', 'restored-long', () =>
        ctx.engine.replay('restored-long'),
      );
      ctx.step('history over 1 MiB is clipped behind a marker');
      ctx.call('engine.restore', ['restored-huge', 100, 30], () =>
        ctx.engine.restore({
          terminalId: 'restored-huge',
          cols: 100,
          rows: 30,
        }),
      );
      ctx.host.pty(1).output('live before attach\r\n');
      await ctx.settle();
      ctx.call('engine.attach (first)', 'restored-huge', () =>
        ctx.engine.replay('restored-huge'),
      );
      ctx.step('an empty history restores with only the marker');
      ctx.call('engine.restore', ['restored-empty', 100, 30], () =>
        ctx.engine.restore({
          terminalId: 'restored-empty',
          cols: 100,
          rows: 30,
        }),
      );
      ctx.call('engine.attach (first)', 'restored-empty', () =>
        ctx.engine.replay('restored-empty'),
      );
    },
  },
  {
    name: 'attachments: own replay and cursor, release and exit',
    platform: 'darwin',
    env: { SHELL: '/bin/zsh', LANG: undefined },
    setup: (host: GoldenHost): void => {
      host.virtualFiles = { ...MAC_SHELLS };
    },
    run: async (ctx: GoldenContext): Promise<void> => {
      const id = sessionId(
        ctx.call('service.spawnTerminal', target(), () =>
          ctx.service.spawnTerminal(target()),
        ),
      );
      ctx.host.pty(0).output('first\r\n');
      await ctx.settle();
      const deliveries: Record<string, unknown[]> = { a: [], b: [] };
      const sink = (name: 'a' | 'b'): TerminalAttachmentSink => ({
        item: (item): void => {
          deliveries[name].push(item);
        },
        end: (end): void => {
          deliveries[name].push({ end });
        },
      });
      const take = (name: 'a' | 'b'): unknown[] =>
        deliveries[name].splice(0, deliveries[name].length);
      ctx.step('two attachments each get their own replay');
      ctx.call('engine.attach (attachment a)', id, () =>
        ctx.engine.attach({ terminalId: id, fromOffset: 0, sink: sink('a') }),
      );
      ctx.call('attachment a deliveries', null, () => take('a'));
      const b = ctx.call(
        'engine.attach (attachment b, from offset 3)',
        id,
        () =>
          ctx.engine.attach({ terminalId: id, fromOffset: 3, sink: sink('b') }),
      );
      ctx.call('attachment b deliveries', null, () => take('b'));
      ctx.step('live output reaches both, each at its own cursor');
      ctx.host.pty(0).output('second\r\n');
      await ctx.settle();
      ctx.call('attachment a deliveries', null, () => take('a'));
      ctx.call('attachment b deliveries', null, () => take('b'));
      ctx.step('releasing one attachment leaves the terminal and the other');
      if (b) ctx.engine.releaseAttachment(b.attachmentId);
      ctx.call('attachment b deliveries', null, () => take('b'));
      ctx.host.pty(0).output('third\r\n');
      await ctx.settle();
      ctx.call('attachment a deliveries', null, () => take('a'));
      ctx.call('attachment b deliveries', null, () => take('b'));
      ctx.call('engine.list', null, () => ctx.engine.list());
      ctx.step('the exit is the last item, then the attachment completes');
      ctx.host.pty(0).exit(0, 0);
      await ctx.settle();
      ctx.call('attachment a deliveries', null, () => take('a'));
      ctx.call('engine.attach (attachment after exit)', id, () =>
        ctx.engine.attach({ terminalId: id, fromOffset: 0, sink: sink('b') }),
      );
    },
  },
  {
    name: 'input and resize',
    platform: 'darwin',
    env: { SHELL: '/bin/zsh', LANG: undefined },
    setup: (host: GoldenHost): void => {
      host.virtualFiles = { ...MAC_SHELLS };
    },
    run: async (ctx: GoldenContext): Promise<void> => {
      const id = sessionId(
        ctx.call('service.spawnTerminal', target(), () =>
          ctx.service.spawnTerminal(target()),
        ),
      );
      const scope = { projectId: PROJECT_ID, worktreeId: WORKTREE_ID };
      const write = { terminalId: id, ...scope, data: 'npm start\r' };
      ctx.call('service.writeTerminal', write, () =>
        ctx.service.writeTerminal(write),
      );
      await ctx.settle();
      ctx.step('a foreground process starts');
      ctx.host.pty(0).process = 'node';
      await ctx.advance(250);
      ctx.step('Ctrl+C interrupts it and the shell returns');
      const interrupt = { terminalId: id, ...scope, data: '\x03' };
      ctx.call('service.writeTerminal', interrupt, () =>
        ctx.service.writeTerminal(interrupt),
      );
      await ctx.settle();
      ctx.host.pty(0).process = 'zsh';
      await ctx.advance(250);
      ctx.step('an interrupt that takes longer than 5 s is not attributed');
      ctx.host.pty(0).process = 'node';
      await ctx.advance(250);
      ctx.call('service.writeTerminal', interrupt, () =>
        ctx.service.writeTerminal(interrupt),
      );
      await ctx.advance(5250);
      ctx.host.pty(0).process = 'zsh';
      await ctx.advance(250);
      const resize = { terminalId: id, ...scope, cols: 200, rows: 50 };
      ctx.call('service.resizeTerminal', resize, () =>
        ctx.service.resizeTerminal(resize),
      );
      await ctx.settle();
      ctx.step('refused input');
      const refused: Array<[string, () => void, unknown]> = [
        [
          'resize to zero rows',
          (): void => ctx.service.resizeTerminal({ ...resize, rows: 0 }),
          { ...resize, rows: 0 },
        ],
        [
          'write over 64 KiB',
          (): void => {
            ctx.service.writeTerminal({
              ...write,
              data: 'x'.repeat(64 * 1024 + 1),
            });
          },
          { ...write, data: '<64 KiB + 1>' },
        ],
        [
          'write to another worktree',
          (): void => {
            ctx.service.writeTerminal({
              ...write,
              worktreeId: OTHER_WORKTREE_ID,
            });
          },
          { ...write, worktreeId: OTHER_WORKTREE_ID },
        ],
        [
          'resize an unknown terminal',
          (): void =>
            ctx.service.resizeTerminal({ ...resize, terminalId: 'missing' }),
          { ...resize, terminalId: 'missing' },
        ],
        [
          'invalid idempotency key',
          (): void => {
            ctx.service.writeTerminal({ ...write, idempotencyKey: '../key' });
          },
          { ...write, idempotencyKey: '../key' },
        ],
      ];
      for (const [label, run, input] of refused) {
        ctx.call(`service (${label})`, input, run);
      }
      await ctx.settle();
      ctx.step('input and resize after exit are ignored');
      ctx.host.pty(0).exit(130, 0);
      await ctx.settle();
      ctx.call('engine.write', [id, 'late\r'], () =>
        ctx.engine.write(id, 'late\r'),
      );
      ctx.call('engine.resize', [id, 90, 20], () =>
        ctx.engine.resize(id, 90, 20),
      );
    },
  },
  {
    name: 'kill: POSIX process-group teardown',
    platform: 'darwin',
    env: { SHELL: '/bin/zsh', LANG: undefined },
    setup: (host: GoldenHost): void => {
      host.virtualFiles = { ...MAC_SHELLS };
    },
    run: async (ctx: GoldenContext): Promise<void> => {
      const ids: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        ids.push(
          sessionId(
            ctx.call('service.spawnTerminal', target(), () =>
              ctx.service.spawnTerminal(target()),
            ),
          ),
        );
      }
      const scope = { projectId: PROJECT_ID, worktreeId: WORKTREE_ID };
      ctx.step('user close signals the process group');
      ctx.call('service.closeTerminal', { terminalId: ids[0], ...scope }, () =>
        ctx.service.closeTerminal({ terminalId: ids[0] ?? '', ...scope }),
      );
      ctx.host.pty(0).exit(0, 9);
      await ctx.settle();
      ctx.step('no process group: the shell process is signalled');
      ctx.host.ungroupedProcesses.add(ctx.host.pty(1).pid);
      ctx.call('engine.kill', ids[1], () => ctx.engine.kill(ids[1] ?? ''));
      ctx.host.pty(1).exit(0, 9);
      await ctx.settle();
      ctx.step('both signals refused: node-pty kills it');
      ctx.host.refusedKillTargets.set(-ctx.host.pty(2).pid, 'EPERM');
      ctx.host.refusedKillTargets.set(ctx.host.pty(2).pid, 'EPERM');
      ctx.call(
        'engine.kill',
        [ids[2], { signalOverride: TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL }],
        () =>
          ctx.engine.kill(ids[2] ?? '', {
            signal: TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
          }),
      );
      ctx.host.pty(2).exit(0, 1);
      await ctx.settle();
      ctx.step('a PTY that never reports exit is cleaned up after 2 s');
      ctx.host.pty(3).process = 'node';
      await ctx.advance(250);
      ctx.call('engine.kill', ids[3], () => ctx.engine.kill(ids[3] ?? ''));
      ctx.call('engine.kill (repeated)', ids[3], () =>
        ctx.engine.kill(ids[3] ?? ''),
      );
      await ctx.advance(1999);
      ctx.step('the grace period ends');
      await ctx.advance(1);
      ctx.step('a late exit and a second kill change nothing');
      ctx.host.pty(3).exit(0, 9);
      ctx.call('engine.kill', ids[3], () => ctx.engine.kill(ids[3] ?? ''));
      await ctx.settle();
    },
  },
  {
    name: 'kill: Windows process-tree teardown',
    platform: 'win32',
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe', LANG: undefined },
    run: async (ctx: GoldenContext): Promise<void> => {
      const request = target({ terminalProfileId: 'cmd' });
      const first = sessionId(
        ctx.call('service.spawnTerminal', request, () =>
          ctx.service.spawnTerminal(request),
        ),
      );
      const second = sessionId(
        ctx.call('service.spawnTerminal', request, () =>
          ctx.service.spawnTerminal(request),
        ),
      );
      const scope = { projectId: PROJECT_ID, worktreeId: WORKTREE_ID };
      ctx.step('taskkill succeeds');
      ctx.call('service.closeTerminal', { terminalId: first, ...scope }, () =>
        ctx.service.closeTerminal({ terminalId: first, ...scope }),
      );
      await ctx.settle();
      ctx.host.pty(0).exit(1);
      await ctx.settle();
      ctx.step('taskkill fails: node-pty kills it, then the grace period ends');
      ctx.host.taskkillExitCode = 128;
      ctx.call('engine.kill', second, () => ctx.engine.kill(second));
      await ctx.settle();
      await ctx.advance(2000);
    },
  },
  {
    name: 'kill: worktree cleanup, archive drain and quit',
    platform: 'darwin',
    env: { SHELL: '/bin/zsh', LANG: undefined },
    setup: (host: GoldenHost): void => {
      host.virtualFiles = { ...MAC_SHELLS };
    },
    run: async (ctx: GoldenContext): Promise<void> => {
      const spawnIn = (worktreeId: string): string =>
        sessionId(
          ctx.call('service.spawnTerminal', target({ worktreeId }), () =>
            ctx.service.spawnTerminal(target({ worktreeId })),
          ),
        );
      spawnIn(WORKTREE_ID);
      spawnIn(WORKTREE_ID);
      const other = spawnIn(OTHER_WORKTREE_ID);
      ctx.host.pty(0).process = 'node';
      await ctx.advance(250);
      ctx.step(
        'worktree cleanup kills only that worktree, without running changes',
      );
      ctx.call('engine.killWorktreeTerminals', [PROJECT_ID, WORKTREE_ID], () =>
        ctx.engine.killWorktree({
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
        }),
      );
      ctx.host.pty(0).exit(0, 9);
      ctx.host.pty(1).exit(0, 9);
      await ctx.settle();
      ctx.step('archive drain waits for the process group to exit');
      await ctx.callAsync('engine.drainTerminal', other, () =>
        ctx.engine.release(other),
      );
      ctx.step('quit kills every live terminal');
      spawnIn(WORKTREE_ID);
      spawnIn(OTHER_WORKTREE_ID);
      ctx.call('engine.killAll', null, () => ctx.engine.killAll());
      ctx.host.pty(3).exit(0, 9);
      ctx.host.pty(4).exit(0, 9);
      await ctx.settle();
    },
  },
  {
    name: 'kill: Windows archive drain and input pipe failure',
    platform: 'win32',
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe', LANG: undefined },
    setup: (host: GoldenHost, paths: GoldenPaths): void => {
      host.attachWindowsInputSocket = true;
      host.persistedEntries.set(
        'pipe-restart',
        persistedShell(paths, 'pipe-restart', {
          session: {
            shell: 'C:\\Windows\\System32\\cmd.exe',
            shellBasename: 'cmd.exe',
          },
          signal: 'pipe-error',
        }),
      );
    },
    run: async (ctx: GoldenContext): Promise<void> => {
      const request = target({ terminalProfileId: 'cmd' });
      const drained = sessionId(
        ctx.call('service.spawnTerminal', request, () =>
          ctx.service.spawnTerminal(request),
        ),
      );
      ctx.step('archive drain awaits taskkill');
      await ctx.callAsync('engine.drainTerminal', drained, () =>
        ctx.engine.release(drained),
      );
      ctx.step('the input socket reports EOF');
      ctx.call('service.spawnTerminal', request, () =>
        ctx.service.spawnTerminal(request),
      );
      ctx.host.pty(1).output('C:\\golden>');
      ctx.host.pty(1).failInput('EOF', 'write');
      await ctx.settle();
      ctx.step('a pipe failure is restorable');
      ctx.call('engine.restore', ['pipe-restart', 80, 24], () =>
        ctx.engine.restore({ terminalId: 'pipe-restart', cols: 80, rows: 24 }),
      );
      await ctx.settle();
    },
  },
  {
    name: 'restore: after an app restart',
    platform: 'darwin',
    env: { SHELL: '/bin/zsh', LANG: undefined },
    setup: (host: GoldenHost, paths: GoldenPaths): void => {
      host.virtualFiles = { ...MAC_SHELLS };
      const entries = [
        persistedShell(paths, 'restart-in-package', {
          session: { cwd: `${paths.root}/${PACKAGE_DIR}` },
        }),
        persistedShell(paths, 'restart-outside', {
          session: { cwd: paths.outside },
          signal: null,
          exitCode: 0,
        }),
        persistedShell(paths, 'restart-missing-cwd', {
          session: { cwd: `${paths.root}/deleted` },
          signal: 'fatal-exit',
        }),
        persistedShell(paths, 'restart-relative-cwd', {
          session: { cwd: PACKAGE_DIR },
          signal: '0',
        }),
        persistedShell(paths, 'restart-command', {
          session: { initialCommand: 'pnpm build' },
        }),
        persistedShell(paths, 'cleanup-closed', { signal: 'worktree-cleanup' }),
        persistedShell(paths, 'user-closed', { signal: 'user-close' }),
        persistedShell(paths, 'killed', { signal: '9' }),
        persistedShell(paths, 'managed-claude', {
          session: { kind: 'claude-code', title: 'Claude Code' },
        }),
        persistedShell(paths, 'script-run', { session: { kind: 'script' } }),
      ];
      for (const entry of entries) {
        host.persistedEntries.set(entry.session.id, entry);
      }
    },
    run: async (ctx: GoldenContext): Promise<void> => {
      for (const id of [
        'restart-in-package',
        'restart-outside',
        'restart-missing-cwd',
        'restart-relative-cwd',
        'restart-command',
        'cleanup-closed',
        'user-closed',
        'killed',
        'managed-claude',
        'script-run',
        'never-persisted',
      ]) {
        const request = { terminalId: id, cols: 100, rows: 30 };
        await ctx.callAsync('service.restoreTerminalForRenderer', request, () =>
          ctx.service.restoreTerminalForRenderer(request, undefined),
        );
      }
      ctx.step('the restored command reruns');
      await ctx.advance(1000);
      ctx.step('restoring a live terminal only resizes it');
      ctx.call('engine.restore', ['restart-in-package', 140, 40], () =>
        ctx.engine.restore({
          terminalId: 'restart-in-package',
          cols: 140,
          rows: 40,
        }),
      );
      ctx.step('a restored terminal can be restored again after it exits');
      ctx.host.pty(0).exit(0, 0);
      await ctx.settle();
      ctx.call('engine.restore', ['restart-in-package', 100, 30], () =>
        ctx.engine.restore({
          terminalId: 'restart-in-package',
          cols: 100,
          rows: 30,
        }),
      );
      await ctx.settle();
    },
  },
  {
    name: 'restore: Linux x64 shell recovery',
    platform: 'linux',
    arch: 'x64',
    env: { SHELL: '/usr/bin/fish', LANG: undefined },
    setup: (host: GoldenHost, paths: GoldenPaths): void => {
      host.virtualFiles = { '/usr/bin/fish': 'exec', '/bin/bash': 'exec' };
      host.persistedEntries.set(
        'linux-zsh',
        persistedShell(paths, 'linux-zsh', {
          session: { shell: '/usr/bin/zsh', shellBasename: 'zsh' },
        }),
      );
      host.persistedEntries.set(
        'linux-bash',
        persistedShell(paths, 'linux-bash', {
          session: { shell: '/bin/bash', shellBasename: 'bash' },
        }),
      );
    },
    run: async (ctx: GoldenContext): Promise<void> => {
      const restore = async (id: string): Promise<void> => {
        const request = { terminalId: id, cols: 100, rows: 30 };
        await ctx.callAsync('service.restoreTerminalForRenderer', request, () =>
          ctx.service.restoreTerminalForRenderer(request, undefined),
        );
      };
      ctx.step('the persisted shell was removed: no other shell is started');
      await restore('linux-zsh');
      ctx.step('the persisted shell is present but not executable');
      ctx.host.virtualFiles['/usr/bin/zsh'] = 'plain';
      await restore('linux-zsh');
      ctx.step('the shell is reinstalled: the same terminal recovers');
      ctx.host.virtualFiles['/usr/bin/zsh'] = 'exec';
      await restore('linux-zsh');
      ctx.step('the persisted shell is kept over the current default');
      await restore('linux-bash');
      ctx.step('node-pty fails to start the persisted shell');
      ctx.host.pty(0).exit(0, 0);
      ctx.host.pty(1).exit(0, 0);
      await ctx.settle();
      ctx.host.ptySpawnFailure = 'posix_spawnp failed.';
      await restore('linux-bash');
      await ctx.settle();
    },
  },
  {
    name: 'restore: persisted Windows shells',
    platform: 'win32',
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe', LANG: undefined },
    setup: (host: GoldenHost, paths: GoldenPaths): void => {
      const shells: Array<[string, string, string]> = [
        ['win-cmd', 'C:\\Windows\\System32\\cmd.exe', 'cmd.exe'],
        ['win-git-bash', 'C:\\Program Files\\Git\\bin\\bash.exe', 'bash.exe'],
        ['win-pwsh', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'pwsh.exe'],
      ];
      for (const [id, shell, shellBasename] of shells) {
        host.persistedEntries.set(
          id,
          persistedShell(paths, id, { session: { shell, shellBasename } }),
        );
      }
    },
    run: async (ctx: GoldenContext): Promise<void> => {
      for (const id of ['win-cmd', 'win-git-bash', 'win-pwsh']) {
        ctx.call('engine.restore', [id, 100, 30], () =>
          ctx.engine.restore({ terminalId: id, cols: 100, rows: 30 }),
        );
      }
      await ctx.settle();
    },
  },
];
