import type { TerminalClient } from '@canopy/app-core';
import type { TerminalSession } from '@canopy/protocol/terminal';
import { ScriptActionRunError } from './script-action-eligibility';

/** Identity of one reusable run: who executes what, where. */
export interface ScriptActionRunKeyParts {
  readonly projectId: string;
  readonly worktreeId: string;
  /** {@link ResolvedScriptActionTarget.targetKey}. */
  readonly targetKey: string;
  readonly relativeCwd: string | null;
  readonly actionId: string;
  readonly revision: string;
}

/**
 * Registry key. The client half of the identity is the registry itself (one
 * per client object), so the same action on two connected hosts never shares.
 */
export function scriptActionRunKey(parts: ScriptActionRunKeyParts): string {
  return JSON.stringify([
    parts.projectId,
    parts.worktreeId,
    parts.targetKey,
    parts.relativeCwd ?? '',
    parts.actionId,
    parts.revision,
  ]);
}

export type ScriptActionRunOutcome =
  | { readonly kind: 'started'; readonly session: TerminalSession }
  | { readonly kind: 'reused'; readonly session: TerminalSession };

interface RunEntry {
  readonly terminalId: string;
  readonly projectId: string;
  readonly worktreeId: string;
  readonly actionId: string;
  /** Last observed foreground state; null until the detector reports. */
  running: boolean | null;
}

type RegistryClient = Pick<TerminalClient, 'query' | 'subscribe'>;

/** Immutable view of the registry for rendering. */
export interface ScriptActionRunState {
  /** Keys whose terminal reports a running command. */
  readonly running: ReadonlySet<string>;
  /** Keys with a run between request and terminal write. */
  readonly pending: ReadonlySet<string>;
}

const EMPTY_STATE: ScriptActionRunState = {
  running: new Set(),
  pending: new Set(),
};

/**
 * Terminals started by pins and shortcuts for one client. Concurrent requests
 * for one key share a single in-flight promise, so rapid clicks and key
 * repeats spawn once. Terminal lifecycle events keep the running indicators
 * current and drop entries whose terminal exited.
 */
export class ScriptActionRunRegistry {
  private readonly client: RegistryClient;
  private readonly inflight = new Map<
    string,
    Promise<ScriptActionRunOutcome>
  >();
  private readonly entries = new Map<string, RunEntry>();
  private readonly listeners = new Set<() => void>();
  private state: ScriptActionRunState = EMPTY_STATE;
  private unsubscribeEvents: (() => void) | null = null;

  constructor(client: RegistryClient) {
    this.client = client;
  }

  /** `useSyncExternalStore` subscription; also keeps lifecycle events attached. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.attachEvents();
    return () => {
      this.listeners.delete(listener);
      this.detachEventsWhenIdle();
    };
  };

  /** `useSyncExternalStore` snapshot; a new object after every change. */
  getState = (): ScriptActionRunState => this.state;

  /**
   * Reveal the still-running terminal for `key`, or start a new run. Only a
   * session `terminal.list` reports as `running === true` is reused; a missing, idle or unknown session starts a new run.
   * A failed list query is surfaced and nothing is spawned. `start` is never
   * retried: a failed write may already have reached the shell.
   */
  run(
    key: string,
    context: {
      readonly projectId: string;
      readonly worktreeId: string;
      readonly actionId: string;
    },
    start: () => Promise<TerminalSession>,
    revealExisting: ((session: TerminalSession) => void) | undefined,
    validate?: () => Promise<void>,
  ): Promise<ScriptActionRunOutcome> {
    const existing = this.inflight.get(key);
    if (existing !== undefined) return existing;
    const promise = this.execute(
      key,
      context,
      start,
      revealExisting,
      validate,
    ).finally(() => {
      this.inflight.delete(key);
      this.notify();
    });
    this.inflight.set(key, promise);
    this.notify();
    return promise;
  }

  private async execute(
    key: string,
    context: {
      readonly projectId: string;
      readonly worktreeId: string;
      readonly actionId: string;
    },
    start: () => Promise<TerminalSession>,
    revealExisting: ((session: TerminalSession) => void) | undefined,
    validate?: () => Promise<void>,
  ): Promise<ScriptActionRunOutcome> {
    await validate?.();
    const entry = this.entries.get(key);
    if (entry !== undefined) {
      let sessions: TerminalSession[];
      try {
        sessions = await this.client.query('terminal.list', {
          projectId: context.projectId,
          worktreeId: context.worktreeId,
        });
      } catch (error) {
        throw new ScriptActionRunError('status-unavailable', undefined, error);
      }
      // The entry may have been replaced or cleared while the query ran.
      if (this.entries.get(key) === entry) {
        const session = sessions.find(
          (candidate) => candidate.id === entry.terminalId,
        );
        if (session === undefined) {
          this.entries.delete(key);
        } else if (session.running === true) {
          entry.running = true;
          revealExisting?.(session);
          return { kind: 'reused', session };
        } else {
          entry.running = false;
        }
      }
    }
    const session = await start();
    this.attachEvents();
    this.entries.set(key, {
      terminalId: session.id,
      projectId: context.projectId,
      worktreeId: context.worktreeId,
      actionId: context.actionId,
      running: null,
    });
    return { kind: 'started', session };
  }

  /** Lifecycle input, exposed for hosts and tests that already hold the events. */
  noteRunningChanged(terminalId: string, running: boolean): void {
    let changed = false;
    this.entries.forEach((entry) => {
      if (entry.terminalId !== terminalId) return;
      if (entry.running !== running) {
        entry.running = running;
        changed = true;
      }
    });
    if (changed) this.notify();
  }

  noteExit(terminalId: string): void {
    let changed = false;
    this.entries.forEach((entry, key) => {
      if (entry.terminalId === terminalId) {
        this.entries.delete(key);
        changed = true;
      }
    });
    if (changed) {
      this.notify();
      this.detachEventsWhenIdle();
    }
  }

  private attachEvents(): void {
    if (this.unsubscribeEvents !== null) return;
    const offRunning = this.client.subscribe(
      'terminal.running-changed',
      (event) => this.noteRunningChanged(event.terminalId, event.running),
    );
    const offExit = this.client.subscribe('terminal.exit', (event) =>
      this.noteExit(event.terminalId),
    );
    this.unsubscribeEvents = (): void => {
      offRunning();
      offExit();
    };
  }

  private detachEventsWhenIdle(): void {
    if (this.listeners.size > 0 || this.entries.size > 0) return;
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
  }

  private notify(): void {
    const running = new Set<string>();
    this.entries.forEach((entry, key) => {
      if (entry.running === true) running.add(key);
    });
    this.state = { running, pending: new Set(this.inflight.keys()) };
    this.listeners.forEach((listener) => listener());
  }
}

const registries = new WeakMap<object, ScriptActionRunRegistry>();

/** The registry for `client`, created on first use. */
export function scriptActionRunRegistryFor(
  client: RegistryClient,
): ScriptActionRunRegistry {
  const existing = registries.get(client);
  if (existing !== undefined) return existing;
  const registry = new ScriptActionRunRegistry(client);
  registries.set(client, registry);
  return registry;
}
