import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type * as ChildProcessModule from 'node:child_process';
import { release } from 'node:os';
import { join } from 'node:path';

const { spawn: realSpawn }: typeof ChildProcessModule =
  jest.requireActual('node:child_process');

interface Observation {
  event: string;
  [key: string]: unknown;
}

interface NativePipeFixture {
  child: ChildProcessWithoutNullStreams;
  readonly nativeError: unknown;
  events: Observation[];
  closed: Promise<void>;
  record(event: string, details?: Record<string, unknown>): void;
  waitFor(event: string): Promise<Observation>;
  send(command: string): void;
  cleanup(): Promise<void>;
  evidence(): void;
}

export function errorDetails(error: unknown): Record<string, unknown> {
  if (typeof error !== 'object' || error === null) {
    return { message: String(error), code: null, syscall: null };
  }
  return {
    message: Reflect.get(error, 'message') ?? JSON.stringify(error),
    code: Reflect.get(error, 'code') ?? null,
    syscall: Reflect.get(error, 'syscall') ?? null,
  };
}

export async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Native pipe fixture deadline')),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function nativePipeChild(
  transport: 'mcp' | 'codex',
  phase: 'before' | 'during' | 'replacement',
): NativePipeFixture {
  const candidate = realSpawn(
    process.execPath,
    [join(__dirname, 'fixtures/native-pipe-child.ts'), transport, phase],
    {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      detached: true,
      // No provider configuration, credentials or inherited preload flags.
      env: {},
    },
  );
  function hasPipes(
    child: typeof candidate,
  ): child is ChildProcessWithoutNullStreams {
    return (
      child.stdin !== null && child.stdout !== null && child.stderr !== null
    );
  }
  if (!hasPipes(candidate)) throw new Error('Missing native fixture pipes');
  const child = candidate;
  const events: Observation[] = [];
  const changes = new EventEmitter();
  const record = (
    event: string,
    details: Record<string, unknown> = {},
  ): void => {
    events.push({ ...details, event });
    changes.emit('change');
  };
  child.on('message', (message: unknown) => {
    if (
      typeof message === 'object' &&
      message !== null &&
      'event' in message &&
      typeof message.event === 'string'
    ) {
      record(`child:${message.event}`, { ...message });
    }
  });
  child.on('error', (error) => record('process-error', errorDetails(error)));
  let nativeError: unknown;
  const emit = child.stdin.emit.bind(child.stdin);
  // Observe and forward emission without becoming an error owner: removing
  // production's error listener still exposes the native unhandled failure.
  child.stdin.emit = (event: string | symbol, ...args: unknown[]): boolean => {
    if (event === 'error') {
      nativeError = args[0];
      record('stdin-error', errorDetails(nativeError));
    }
    return emit(event, ...args);
  };
  child.on('exit', (code, signal) => record('exit', { code, signal }));
  const closed = new Promise<void>((resolve) =>
    child.on('close', (code, signal) => {
      record('close', { code, signal });
      resolve();
    }),
  );
  // Production retains its single write/frame. MCP's tiny initialize is
  // transparently split at _write (one byte, native close ACK, remainder),
  // proving closure while that write's completion is pending, not kernel
  // saturation. Codex uses its unfragmented large production turn request.
  const write = child.stdin._write.bind(child.stdin);
  child.stdin._write = (chunk: string | Buffer, encoding, callback): void => {
    record('write-start', {
      bytes: Buffer.byteLength(chunk, encoding),
      errorListeners: child.stdin.listenerCount('error'),
    });
    const finish = (error?: Error | null): void => {
      record(
        'write-callback',
        error ? errorDetails(error) : { code: null, syscall: null },
      );
      callback(error);
    };
    if (transport === 'mcp' && phase === 'during') {
      // Preserve Socket._write's original string/buffer + encoding contract.
      const original: unknown = chunk;
      if (typeof original !== 'string' && !Buffer.isBuffer(original)) {
        throw new Error('Unexpected native write chunk');
      }
      const prefix =
        typeof original === 'string'
          ? original.slice(0, 1)
          : original.subarray(0, 1);
      const remainder =
        typeof original === 'string' ? original.slice(1) : original.subarray(1);
      write(prefix, encoding, (error) => {
        record(
          'split-prefix-callback',
          error ? errorDetails(error) : { code: null },
        );
        if (error) {
          finish(error);
          return;
        }
        void waitFor('child:input-closed').then(
          () => {
            record('split-remainder-start', {
              bytes: Buffer.byteLength(chunk, encoding) - 1,
            });
            write(remainder, encoding, finish);
          },
          () => {
            // On fixture failure, native SIGKILL closes the real pipe; never
            // substitute a synthetic error at the production write callback.
            child.kill('SIGKILL');
            write(remainder, encoding, finish);
          },
        );
      });
    } else {
      write(chunk, encoding, finish);
    }
  };
  const waitFor = async (event: string): Promise<Observation> => {
    let listener: (() => void) | undefined;
    try {
      return await bounded(
        new Promise<Observation>((resolve) => {
          listener = (): void => {
            const observation = events.find((item) => item.event === event);
            if (observation) resolve(observation);
          };
          changes.on('change', listener);
          listener();
        }),
      );
    } finally {
      if (listener) changes.off('change', listener);
    }
  };
  const send = (command: string): void => {
    child.send(command, (error) => {
      if (error) record('control-error', errorDetails(error));
    });
  };
  return {
    child,
    get nativeError(): unknown {
      return nativeError;
    },
    events,
    closed,
    record,
    waitFor,
    send,
    async cleanup(): Promise<void> {
      if (!events.some((item) => item.event === 'close')) child.kill('SIGKILL');
      await bounded(closed);
    },
    evidence(): void {
      process.stdout.write(
        `CAN-3238 ${JSON.stringify({
          transport,
          phase,
          os: process.platform,
          release: release(),
          node: process.versions.node,
          uv: process.versions.uv,
          events,
        })}\n`,
      );
    },
  };
}
