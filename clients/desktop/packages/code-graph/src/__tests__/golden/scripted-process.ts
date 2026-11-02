import { EventEmitter } from 'node:events';

export type ScriptedProcessEvent =
  | { event: 'fork'; process: number }
  | { event: 'request'; process: number; request: unknown }
  | { event: 'kill'; process: number }
  | { event: 'exit'; process: number; code: number };

/**
 * A worker process driven by the scenario: it answers and exits only when told
 * to (or, like a real process, once a kill lands). It speaks the shape every
 * host process primitive exposes (`postMessage`, `kill`, `pid` and
 * `spawn`/`message`/`exit` events), so a binding can hand it to whichever
 * process launcher the code under test uses. It launches as soon as it is
 * forked; `spawn` fires on the next microtask, as it does asynchronously for
 * a real launch.
 */
export class ScriptedProcess extends EventEmitter {
  public pid: number | undefined;
  public readonly requests: unknown[] = [];
  public killed = false;
  public exited = false;

  public constructor(
    public readonly index: number,
    private readonly record: (event: ScriptedProcessEvent) => void,
  ) {
    super();
  }

  public postMessage(request: unknown): void {
    this.requests.push(request);
    this.record({ event: 'request', process: this.index, request });
  }

  public kill(): boolean {
    if (this.exited || this.pid === undefined) return false;
    if (!this.killed) this.record({ event: 'kill', process: this.index });
    this.killed = true;
    return true;
  }

  public launch(): void {
    this.pid = 10_000 + this.index;
    void Promise.resolve().then(() => this.emit('spawn'));
  }

  public reply(message: unknown): void {
    this.emit('message', message);
  }

  public exit(code = 0): void {
    if (this.exited) return;
    this.exited = true;
    this.record({ event: 'exit', process: this.index, code });
    this.emit('exit', code);
  }
}

/** Every process a scenario forked, in fork order, and their event log. */
export class ScriptedProcessPool {
  public readonly processes: ScriptedProcess[] = [];
  public readonly events: ScriptedProcessEvent[] = [];
  /** Exit as soon as a kill lands, as a real process does. */
  public exitOnKill = true;

  public fork(): ScriptedProcess {
    const index = this.processes.length + 1;
    const child = new ScriptedProcess(index, (event) => {
      this.events.push(event);
      if (event.event === 'kill' && this.exitOnKill) {
        // Native promises keep running under fake timers; queueMicrotask does not.
        void Promise.resolve().then(() => child.exit(0));
      }
    });
    this.processes.push(child);
    this.events.push({ event: 'fork', process: index });
    child.launch();
    return child;
  }

  public process(index: number): ScriptedProcess {
    const child = this.processes[index - 1];
    if (child === undefined) throw new Error(`No scripted process ${index}`);
    return child;
  }

  /** The live process whose latest request matches. */
  public serving(matches: (request: unknown) => boolean): ScriptedProcess {
    for (const child of [...this.processes].reverse()) {
      const latest = child.requests.at(-1);
      if (!child.exited && latest !== undefined && matches(latest)) {
        return child;
      }
    }
    throw new Error('No live scripted process is serving that request');
  }

  public exitAll(): void {
    for (const child of this.processes) child.exit(0);
  }
}

// Captured at import, before a test installs fake timers.
const realSetImmediate = globalThis.setImmediate;

/** Runs every promise continuation the code under test has queued. */
export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    realSetImmediate(resolve);
  });
}
