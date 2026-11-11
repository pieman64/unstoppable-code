import type { ChildProcess } from 'node:child_process';
import { release } from 'node:os';

export type Closure = 'before' | 'during';
export type PipeChild = ChildProcess & {
  stdin: NonNullable<ChildProcess['stdin']>;
  stderr: NonNullable<ChildProcess['stderr']>;
};

export function faultScript(closure: Closure, identity: boolean): string {
  // The adversarial child never deletes anything. Only fd 0 is closed; the
  // child stays alive until the parent terminates it, with a hard lifetime cap.
  return `
    const fs = require('node:fs');
    setTimeout(() => process.exit(71), 5000);
    function closeInput() {
      fs.closeSync(0);
      fs.writeSync(2, 'CAN3238:closed\\n');
      ${identity && closure === 'before' ? identityScript() : ''}
    }
    ${identity && closure === 'during' ? identityScript() : ''}
    ${
      closure === 'during'
        ? `
      // Do not create process.stdin: closing a libuv-owned fd directly would
      // abort the fixture, rather than qualify the parent's pipe transport.
      fs.read(0, Buffer.alloc(65536), 0, 65536, null, (error, bytes) => {
        if (error || bytes < 1) process.exit(72);
        fs.writeSync(2, 'CAN3238:prefix:' + bytes + '\\n');
        closeInput();
      });
    `
        : 'closeInput();'
    }
  `;
}

function identityScript(): string {
  return `{
    const stat = fs.lstatSync('.', { bigint: true });
    fs.writeSync(1, JSON.stringify({ type: 'identity', dev: String(stat.dev),
      ino: String(stat.ino), birthtime: String(stat.birthtimeNs) }) + '\\n');
  }`;
}

function failure(error: unknown): object {
  const property = (object: object, key: string): unknown =>
    Reflect.get(object, key);
  // Native callback errors can originate in Node's realm, not Jest's realm.
  return error !== null && typeof error === 'object'
    ? {
        message: property(error, 'message'),
        code: property(error, 'code'),
        syscall: property(error, 'syscall'),
        errno: property(error, 'errno'),
      }
    : { value: String(error) };
}

export class NativePipe {
  readonly events: Array<{ event: string; detail?: unknown }> = [];
  inputError: unknown;
  private child: PipeChild | undefined;
  private closed: Promise<void> | undefined;
  private deadline: NodeJS.Timeout | undefined;
  private acknowledgeClosure: (() => void) | undefined;
  private readonly closureAck = new Promise<void>((resolve) => {
    this.acknowledgeClosure = resolve;
  });

  constructor(
    readonly transport: string,
    readonly closure: Closure,
  ) {}

  record(event: string, detail?: unknown): void {
    this.events.push({ event, ...(detail === undefined ? {} : { detail }) });
  }

  attach(candidate: ChildProcess): void {
    const hasPipes = (child: ChildProcess): child is PipeChild =>
      child.stdin !== null && child.stderr !== null;
    if (!hasPipes(candidate)) throw new Error('Missing native fixture pipes');
    const child = candidate;
    if (this.child) throw new Error('Fault child unexpectedly replayed');
    this.child = child;
    this.deadline = setTimeout(() => child.kill('SIGKILL'), 8000);
    this.closed = new Promise((resolve) => {
      child.once('close', (code, signal) => {
        this.record('close', { code, signal });
        if (this.deadline) clearTimeout(this.deadline);
        resolve();
      });
    });
    child.once('exit', (code, signal) => this.record('exit', { code, signal }));
    child.once('error', (error) => this.record('child-error', failure(error)));

    const input = child.stdin;
    // Observe emit, NOT an extra error listener: removing the product's error
    // owner must still expose an unhandled native stream failure to Jest.
    const emit = input.emit.bind(input);
    jest
      .spyOn(input, 'emit')
      .mockImplementation((event, ...args: unknown[]) => {
        if (event === 'error') {
          this.inputError = args[0];
          this.record('stdin-error', failure(args[0]));
        }
        return emit(event, ...args);
      });

    const end = input.end.bind(input);
    const split =
      this.closure === 'during' &&
      this.transport === 'shared-container-cleanup';
    let pending: string | undefined;
    let peerClosed = false;
    const flush = (): void => {
      if (!peerClosed || pending === undefined) return;
      const remainder = pending;
      pending = undefined;
      this.record('remainder-write', { bytes: Buffer.byteLength(remainder) });
      end(remainder, (error?: Error | null) =>
        this.record('write-callback', error ? failure(error) : { ok: true }),
      );
    };
    // clean\n fits in one atomic native write. For the during case the
    // existing stream boundary transparently forwards a one-byte prefix,
    // then forwards the unchanged remainder after the child's fd-close ACK.
    // No synthetic errors, stream destruction or replacement Writable.
    jest.spyOn(input, 'end').mockImplementation((...args: unknown[]) => {
      const [chunk] = args;
      if (typeof chunk !== 'string') throw new Error('Expected string input');
      if (pending !== undefined) throw new Error('Overlapping input command');
      this.record('production-end', { bytes: Buffer.byteLength(chunk) });
      // Git uses an ordinary >4MiB production end: the native write is still
      // buffered when the child closes after its first read. Only cleanup's
      // six-byte atomic command needs the transparent split described above.
      if (this.closure === 'during' && !split) {
        this.record('input-write', { bytes: Buffer.byteLength(chunk) });
        end(chunk, (error?: Error | null) =>
          this.record('write-callback', error ? failure(error) : { ok: true }),
        );
        this.record('buffered-input', { bytes: input.writableLength });
        expect(input.writableLength).toBeGreaterThan(4 * 1024 * 1024);
        return input;
      }
      pending = split ? chunk.slice(1) : chunk;
      if (split) {
        this.record('prefix-write');
        input.write(chunk.slice(0, 1), (error?: Error | null) =>
          this.record('prefix-callback', error ? failure(error) : { ok: true }),
        );
      }
      flush();
      return input;
    });
    let stderr = '';
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
      let newline: number;
      while ((newline = stderr.indexOf('\n')) !== -1) {
        const line = stderr.slice(0, newline);
        stderr = stderr.slice(newline + 1);
        if (line.startsWith('CAN3238:prefix:'))
          this.record('peer-read-prefix', {
            bytes: Number(line.split(':')[2]),
          });
        if (line === 'CAN3238:closed') {
          peerClosed = true;
          this.record('peer-closed');
          this.acknowledgeClosure?.();
          flush();
        }
      }
    });
  }

  async observedClosure(): Promise<void> {
    await Promise.race([
      this.closureAck,
      this.closed?.then(() => {
        throw new Error('Child closed without fd-close acknowledgement');
      }),
    ]);
  }

  async rejection(pending: Promise<unknown>): Promise<unknown> {
    try {
      await pending;
      this.record('unexpected-success');
      throw new Error('Closed input unexpectedly succeeded');
    } catch (error) {
      this.record('rejection', failure(error));
      return error;
    }
  }

  assertNativeFailure(): void {
    const error = this.inputError;
    if (error === null || typeof error !== 'object') {
      throw new Error('Expected native input failure object');
    }
    expect(Reflect.get(error, 'code')).toEqual(expect.any(String));
    expect(Reflect.get(error, 'syscall')).toBe('write');
    expect(Reflect.get(error, 'errno')).toEqual(expect.any(Number));
    expect(Reflect.get(error, 'errno')).toBeLessThan(0);
    const names = this.events.map(({ event }) => event);
    if (
      this.closure === 'before' ||
      this.transport === 'shared-container-cleanup'
    ) {
      expect(names.indexOf('peer-closed')).toBeLessThan(
        names.indexOf('remainder-write'),
      );
      expect(names.indexOf('remainder-write')).toBeLessThan(
        names.indexOf('stdin-error'),
      );
    } else {
      expect(names.indexOf('input-write')).toBeLessThan(
        names.indexOf('stdin-error'),
      );
      expect(names).toContain('buffered-input');
    }
    expect(names).toContain('write-callback');
    expect(names).toContain('exit');
    expect(names).toContain('close');
    expect(names).not.toContain('unexpected-success');
    if (this.closure === 'during') {
      const write =
        this.transport === 'shared-container-cleanup'
          ? 'prefix-write'
          : 'input-write';
      expect(names.indexOf(write)).toBeLessThan(
        names.indexOf('peer-read-prefix'),
      );
      expect(names.indexOf('peer-read-prefix')).toBeLessThan(
        names.indexOf('peer-closed'),
      );
    } else {
      expect(names).not.toContain('prefix-write');
    }
  }

  async dispose(): Promise<void> {
    if (this.child?.exitCode === null && this.child.signalCode === null) {
      this.record('fixture-terminate');
      this.child.kill('SIGKILL');
    }
    await this.closed;
    if (this.deadline) clearTimeout(this.deadline);
  }

  report(): void {
    process.stdout.write(
      `CAN-3238 ${JSON.stringify({
        transport: this.transport,
        closure: this.closure,
        os: process.platform,
        release: release(),
        node: process.versions.node,
        uv: process.versions.uv,
        events: this.events,
      })}\n`,
    );
  }
}
