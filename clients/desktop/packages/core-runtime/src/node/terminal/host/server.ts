import type {
  PersistedTerminalEntry,
  TerminalSession,
} from '@canopy/protocol/terminal';
import type { PlatformOperatingSystem } from '../../../platform/platform-services';
import { TerminalEngine, type TerminalEngineOptions } from '../engine';
import type {
  TerminalEngineHost,
  TerminalLogPort,
  TerminalProcessPort,
  TerminalPtyPort,
} from '../ports';
import { TerminalShells } from '../shells';
import {
  isTerminalHostRequestMessage,
  type TerminalHostError,
  type TerminalHostLaunch,
  type TerminalHostMessage,
  type TerminalHostRequest,
  type TerminalHostTerminal,
} from './protocol';

/** The execution host channel, as the terminal host uses it. */
export interface TerminalHostChannel {
  postMessage(message: TerminalHostMessage): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
}

export interface TerminalHostServerOptions {
  readonly channel: TerminalHostChannel;
  readonly pty: TerminalPtyPort;
  readonly processes: TerminalProcessPort;
  readonly platform: PlatformOperatingSystem;
  /** A variable of the host process environment (`LANG`). */
  readonly variable: (name: string) => string | undefined;
  readonly log: TerminalLogPort;
  readonly engine?: TerminalEngineOptions;
  /** How long `stop` waits for killed terminals to exit. */
  readonly stopTimeoutMs?: number;
}

/**
 * A terminal host's live terminals, at most the attachments a worker can
 * keep open for them with room left for other clients.
 */
export const TERMINAL_HOST_MAX_LIVE_TERMINALS = 48;

const STOP_TIMEOUT_MS = 3_000;

class TerminalHostFailure extends Error {
  public constructor(
    public readonly code: TerminalHostError['code'],
    message: string,
  ) {
    super(message);
  }
}

function hostError(error: unknown): TerminalHostError {
  if (error instanceof TerminalHostFailure)
    return { code: error.code, message: error.message };
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined;
  if (
    code === 'ERR_TERMINAL_CAPACITY' ||
    code === 'ERR_TERMINAL_ATTACHMENT_CAPACITY'
  )
    return { code: 'capacity', message };
  if (message.startsWith('Terminal not found'))
    return { code: 'notFound', message };
  if (message.startsWith('Terminal is not restorable'))
    return { code: 'invalidState', message };
  return { code: 'failed', message };
}

function scopeKey(projectId: string, worktreeId: string): string {
  return `${projectId}\u0000${worktreeId}`;
}

/**
 * Serves one terminal host process: the terminal engine over the host's PTY
 * library, behind the worker's private request channel. The host keeps no
 * terminal state of its own: its client resolves every directory, shell and
 * environment, and persists sessions and output.
 */
export function serveTerminalHost(options: TerminalHostServerOptions): {
  readonly engine: TerminalEngine;
} {
  const { channel } = options;
  const roots = new Map<string, string>();
  const seeded = new Map<string, PersistedTerminalEntry>();
  const pids = new Map<string, number>();
  const sizes = new Map<string, { cols: number; rows: number }>();
  const offsets = new Map<string, number>();
  const attachments = new Map<string, string>();

  const host: TerminalEngineHost = {
    shells: new TerminalShells({
      platform: () => options.platform,
      linuxLoginShellsSupported: () => false,
      accountShell: () => Promise.resolve(undefined),
      findOnPath: () => null,
      windowsGitBash: () => null,
      variable: options.variable,
    }),
    pty: options.pty,
    environment: {
      base: () => ({}),
      worktree: () => ({}),
      variable: options.variable,
    },
    workspace: {
      worktreeCwd: (projectId, worktreeId) => {
        const root = roots.get(scopeKey(projectId, worktreeId));
        if (root === undefined)
          throw new TerminalHostFailure(
            'invalidState',
            'The terminal scope has no resolved root.',
          );
        return root;
      },
      assertStartAllowed: () => undefined,
    },
    resources: {
      register: (session, pid) => {
        pids.set(session.id, pid);
        return {
          unregister: () => {
            if (pids.get(session.id) === pid) pids.delete(session.id);
          },
        };
      },
    },
    persistence: {
      registerLiveSession: () => undefined,
      appendTerminalOutput: () => undefined,
      markTerminalExited: () => undefined,
      getPersistedTerminalEntry: (terminalId) => seeded.get(terminalId) ?? null,
    },
    processes: options.processes,
    log: options.log,
  };
  const engine = new TerminalEngine(host, {
    maxLiveTerminals: TERMINAL_HOST_MAX_LIVE_TERMINALS,
    ...options.engine,
  });

  const post = (message: TerminalHostMessage): void => {
    channel.postMessage(message);
  };

  engine.setEventSink((event) => {
    if (event.type === 'output') {
      offsets.set(event.payload.terminalId, event.payload.seq);
      return;
    }
    if (event.type === 'runningChanged') {
      post({
        kind: 'event',
        event: {
          type: 'runningChanged',
          terminalId: event.payload.terminalId,
          running: event.payload.running,
          processName: event.payload.processName ?? null,
          ...(event.payload.interruptedByUser !== undefined && {
            interruptedByUser: event.payload.interruptedByUser,
          }),
        },
      });
      return;
    }
    if (event.type === 'exit') {
      const outputOffset = offsets.get(event.payload.terminalId) ?? 0;
      sizes.delete(event.payload.terminalId);
      offsets.delete(event.payload.terminalId);
      post({
        kind: 'event',
        event: {
          type: 'exit',
          terminalId: event.payload.terminalId,
          exitCode: event.payload.exitCode,
          signal: event.payload.signal,
          outputOffset,
        },
      });
    }
  });

  const describe = (session: TerminalSession): TerminalHostTerminal => {
    const size = sizes.get(session.id) ?? { cols: 1, rows: 1 };
    return {
      session,
      pid: pids.get(session.id) ?? null,
      cols: size.cols,
      rows: size.rows,
      outputOffset: offsets.get(session.id) ?? 0,
      running: session.running ?? false,
      processName: session.processName ?? null,
    };
  };

  const live = (terminalId: string): TerminalHostTerminal => {
    const session = engine
      .list()
      .find((candidate) => candidate.id === terminalId);
    if (!session)
      throw new TerminalHostFailure(
        'notFound',
        `Terminal not found: ${terminalId}`,
      );
    return describe(session);
  };

  const remember = (launch: TerminalHostLaunch): void => {
    roots.set(scopeKey(launch.projectId, launch.worktreeId), launch.root);
  };

  const handle = async (request: TerminalHostRequest): Promise<unknown> => {
    switch (request.op) {
      case 'create': {
        const { launch } = request;
        remember(launch);
        const session = engine.create({
          projectId: launch.projectId,
          worktreeId: launch.worktreeId,
          cols: request.cols,
          rows: request.rows,
          cwd: launch.cwd,
          environment: launch.environment,
          shell: launch.shell,
          ...(launch.initialCommand !== undefined && {
            initialCommand: launch.initialCommand,
          }),
        });
        sizes.set(session.id, { cols: request.cols, rows: request.rows });
        offsets.set(session.id, 0);
        return live(session.id);
      }
      case 'restore': {
        const { terminalId, cols, rows, recreate } = request;
        const existing = engine.get(terminalId);
        if (existing) {
          engine.restore({ terminalId, cols, rows });
          sizes.set(terminalId, { cols, rows });
          return { terminal: live(terminalId), recreated: false };
        }
        if (!recreate)
          throw new TerminalHostFailure(
            'notFound',
            `Terminal not found: ${terminalId}`,
          );
        remember(recreate);
        seeded.set(terminalId, {
          session: {
            id: terminalId,
            projectId: recreate.projectId,
            worktreeId: recreate.worktreeId,
            shell: recreate.shell.shell,
            shellBasename: recreate.shell.shellBasename,
            cwd: recreate.cwd,
            createdAt: Date.now(),
            ...(recreate.initialCommand !== undefined && {
              initialCommand: recreate.initialCommand,
            }),
          },
          scrollbackLines: recreate.scrollback.split('\n'),
          exitCode: null,
          signal: null,
        });
        try {
          engine.restore({
            terminalId,
            cols,
            rows,
            environment: recreate.environment,
            shell: recreate.shell,
          });
        } finally {
          seeded.delete(terminalId);
        }
        sizes.set(terminalId, { cols, rows });
        offsets.set(terminalId, engine.replay(terminalId).seq);
        return { terminal: live(terminalId), recreated: true };
      }
      case 'write':
        live(request.terminalId);
        engine.write(request.terminalId, request.data);
        return live(request.terminalId);
      case 'resize':
        live(request.terminalId);
        engine.resize(request.terminalId, request.cols, request.rows);
        sizes.set(request.terminalId, {
          cols: request.cols,
          rows: request.rows,
        });
        return live(request.terminalId);
      case 'kill': {
        const terminal = live(request.terminalId);
        engine.kill(request.terminalId);
        return terminal;
      }
      case 'release': {
        const released = engine.get(request.terminalId) !== null;
        await engine.release(request.terminalId);
        return released;
      }
      case 'list':
        return engine.list().map(describe);
      case 'attach': {
        const { attachmentId } = request;
        let ended = false;
        const attachment = engine.attach({
          terminalId: request.terminalId,
          fromOffset: request.fromOffset,
          ...(request.maxReplayBytes !== undefined && {
            maxReplayBytes: request.maxReplayBytes,
          }),
          sink: {
            item: (item) => {
              post({
                kind: 'item',
                attachmentId,
                item: {
                  terminalId: item.terminalId,
                  fromOffset: item.fromOffset,
                  toOffset: item.toOffset,
                  data: item.data,
                  truncatedBefore: item.truncatedBefore,
                  exit: item.exit && {
                    exitCode: item.exit.exitCode,
                    signal: item.exit.signal,
                  },
                },
              });
            },
            end: (end) => {
              ended = true;
              attachments.delete(attachmentId);
              post({
                kind: 'end',
                attachmentId,
                outcome: end.outcome,
                offset: end.offset,
              });
            },
          },
        });
        if (!ended) attachments.set(attachmentId, attachment.attachmentId);
        return live(request.terminalId);
      }
      case 'acknowledge': {
        const engineId = attachments.get(request.attachmentId);
        if (engineId !== undefined)
          engine.acknowledgeAttachment(engineId, request.offset);
        return null;
      }
      case 'detach': {
        const engineId = attachments.get(request.attachmentId);
        if (engineId !== undefined) engine.releaseAttachment(engineId);
        return null;
      }
      case 'stop': {
        engine.killAll();
        const deadline =
          Date.now() + (options.stopTimeoutMs ?? STOP_TIMEOUT_MS);
        while (engine.getLiveTerminalCount() > 0 && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 25));
        return engine.getLiveTerminalCount();
      }
    }
  };

  channel.on('message', ({ data }) => {
    if (!isTerminalHostRequestMessage(data)) return;
    const { id } = data;
    void Promise.resolve()
      .then(() => handle(data.request))
      .then(
        (value) => post({ kind: 'response', id, ok: true, value }),
        (error: unknown) =>
          post({ kind: 'response', id, ok: false, error: hostError(error) }),
      );
  });
  post({ kind: 'ready' });
  return { engine };
}
