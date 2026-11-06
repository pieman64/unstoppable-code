import { basename } from 'node:path';
import type {
  TerminalAttachment,
  TerminalAttachmentRequest,
  TerminalCreateRequest,
  TerminalRestoreRequest,
  TerminalWorktreeScope,
  WorkerTerminalEvent,
  WorkerTerminalEventListener,
  WorkerTerminalPort,
} from '@canopy/core-runtime/node/terminal';
import type {
  TerminalAttachResponse,
  TerminalSession,
  TerminalShellProfile,
} from '@canopy/protocol/terminal';

/** A worker.terminal engine double that records every call (CAN-5097 goldens). */
export interface RecordingTerminalEngine extends WorkerTerminalPort {
  readonly creates: TerminalCreateRequest[];
  readonly writes: Array<[terminalId: string, data: string]>;
  readonly kills: Array<
    [terminalId: string, options: { signal?: string | null } | undefined]
  >;
  /** Delivers an event through the sink the routed port installed. */
  emitEvent(event: WorkerTerminalEvent): void;
  reset(): void;
}

export function createRecordingTerminalEngine(): RecordingTerminalEngine {
  const creates: TerminalCreateRequest[] = [];
  const writes: Array<[string, string]> = [];
  const kills: Array<[string, { signal?: string | null } | undefined]> = [];
  const sessions = new Map<string, TerminalSession>();
  let sink: WorkerTerminalEventListener = (): void => undefined;
  let created = 0;

  return {
    creates,
    writes,
    kills,
    emitEvent(event: WorkerTerminalEvent): void {
      sink(event);
    },
    reset(): void {
      creates.length = 0;
      writes.length = 0;
      kills.length = 0;
      sessions.clear();
      created = 0;
    },
    create(request: TerminalCreateRequest): TerminalSession {
      creates.push(request);
      created += 1;
      const shell = request.managedCommand?.executable ?? '/bin/zsh';
      const managedCommand = request.managedCommand;
      const session: TerminalSession = {
        id: `terminal-${created}`,
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        shell,
        shellBasename: basename(shell),
        cwd: request.cwd ?? '/worktree',
        createdAt: 1,
        ...(managedCommand
          ? {
              kind: managedCommand.kind,
              focusOnSpawn: managedCommand.focusOnSpawn,
              title: managedCommand.title,
              chatId: managedCommand.chatId,
              sessionKey: managedCommand.sessionKey,
            }
          : {}),
      };
      sessions.set(session.id, session);
      return session;
    },
    restore(request: TerminalRestoreRequest): TerminalSession {
      const session = sessions.get(request.terminalId);
      if (!session)
        throw new Error(`Terminal not found: ${request.terminalId}`);
      return session;
    },
    list(): TerminalSession[] {
      return [...sessions.values()];
    },
    get(terminalId: string): TerminalSession | null {
      return sessions.get(terminalId) ?? null;
    },
    replay(terminalId: string): TerminalAttachResponse {
      const session = sessions.get(terminalId);
      if (!session) throw new Error(`Terminal not found: ${terminalId}`);
      return { session, replay: new Uint8Array(0), seq: 0 };
    },
    attach(request: TerminalAttachmentRequest): TerminalAttachment {
      throw new Error(`Terminal not found: ${request.terminalId}`);
    },
    acknowledgeAttachment(): void {
      return undefined;
    },
    releaseAttachment(): void {
      return undefined;
    },
    replayText(): string {
      return '';
    },
    write(terminalId: string, data: string): void {
      writes.push([terminalId, data]);
    },
    resize(): void {
      return undefined;
    },
    kill(terminalId: string, options?: { signal?: string | null }): void {
      kills.push([terminalId, options]);
      sessions.delete(terminalId);
    },
    killWorktree(): void {
      return undefined;
    },
    killAll(): void {
      return undefined;
    },
    release(): Promise<void> {
      return Promise.resolve();
    },
    releaseWorktree(): Promise<void> {
      return Promise.resolve();
    },
    hasLiveTerminals(): boolean {
      return false;
    },
    runningWorktrees(): TerminalWorktreeScope[] {
      return [];
    },
    lowerPriority(): void {
      return undefined;
    },
    profiles(): TerminalShellProfile[] {
      return [];
    },
    defaultShellBasename(): string {
      return 'zsh';
    },
    prewarmShell(): Promise<void> {
      return Promise.resolve();
    },
    setEventSink(next: WorkerTerminalEventListener): void {
      sink = next;
    },
    addEventListener(): () => void {
      return (): void => undefined;
    },
  };
}
