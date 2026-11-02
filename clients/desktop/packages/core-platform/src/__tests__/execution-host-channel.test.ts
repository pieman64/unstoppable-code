import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type {
  PlatformExecutionOutcome,
  PlatformExecutionProcess,
  PlatformExecutionProcessServices,
} from '@canopy/core-runtime';
import {
  createStdioExecutionHostChannel,
  encodeExecutionHostFrame,
  ExecutionHostFrameReader,
} from '../execution-host/channel';
import { runExecutionProbe } from '../execution-host/owned-process-host';

function reader(maxFrameBytes = 1024): {
  push: (text: string | Buffer) => void;
  frames: unknown[];
  other: string[];
  oversize: number;
} {
  const frames: unknown[] = [];
  const other: string[] = [];
  const state = { oversize: 0 };
  const instance = new ExecutionHostFrameReader(
    (message) => frames.push(message),
    (bytes) => other.push(bytes.toString('utf8')),
    () => {
      state.oversize += 1;
    },
    maxFrameBytes,
  );
  return {
    push: (text) =>
      instance.push(typeof text === 'string' ? Buffer.from(text) : text),
    frames,
    other,
    get oversize(): number {
      return state.oversize;
    },
  };
}

describe('execution host frame reader', () => {
  it('decodes a frame split across chunks', () => {
    const subject = reader();
    const frame = encodeExecutionHostFrame({ type: 'result', value: 1 });
    subject.push(frame.subarray(0, 5));
    subject.push(frame.subarray(5, 20));
    subject.push(frame.subarray(20));
    expect(subject.frames).toEqual([{ type: 'result', value: 1 }]);
    expect(subject.other).toEqual([]);
  });

  it('passes unterminated output on as it arrives instead of buffering it', () => {
    const subject = reader(64);
    const chunk = 'x'.repeat(100);
    for (let index = 0; index < 50; index += 1) subject.push(chunk);
    // Far past the frame bound, but output that is not a frame is never held.
    expect(subject.other.join('')).toBe(chunk.repeat(50));
    subject.push('\n');
    subject.push(encodeExecutionHostFrame({ type: 'after' }));
    expect(subject.frames).toEqual([{ type: 'after' }]);
    expect(subject.oversize).toBe(0);
  });

  it('drops an oversized frame that arrives complete in one chunk', () => {
    const subject = reader(64);
    subject.push(encodeExecutionHostFrame({ payload: 'z'.repeat(200) }));
    expect(subject.oversize).toBe(1);
    expect(subject.frames).toEqual([]);
    expect(subject.other).toEqual([]);
    subject.push(encodeExecutionHostFrame({ type: 'next' }));
    expect(subject.frames).toEqual([{ type: 'next' }]);
  });

  it('drops a frame past its bound, reports it once, and decodes the next', () => {
    const subject = reader(64);
    const oversized = encodeExecutionHostFrame({ payload: 'y'.repeat(200) });
    for (let start = 0; start < oversized.byteLength; start += 16)
      subject.push(oversized.subarray(start, start + 16));
    expect(subject.oversize).toBe(1);
    expect(subject.frames).toEqual([]);
    subject.push(encodeExecutionHostFrame({ type: 'next' }));
    expect(subject.frames).toEqual([{ type: 'next' }]);
  });
});

/** A pipe that accepts one write at a time until `release` is called. */
class SlowPipe extends Writable {
  readonly written: Buffer[] = [];
  private pending: (() => void)[] = [];

  constructor() {
    super({ highWaterMark: 1 });
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: () => void,
  ): void {
    this.written.push(chunk);
    this.pending.push(callback);
  }

  release(): void {
    for (const callback of this.pending.splice(0)) callback();
  }
}

describe('stdio execution host channel', () => {
  it('holds frames while the pipe is full and exits only after the last one', async () => {
    const output = new SlowPipe();
    const exits: number[] = [];
    const channel = createStdioExecutionHostChannel(
      new PassThrough(),
      output,
      (code) => exits.push(code),
    );
    channel.postMessage({ index: 1 });
    channel.postMessage({ index: 2 });
    channel.postMessage({ index: 3 });
    channel.exit(0);
    // The full pipe took the first frame; the rest wait for it to drain.
    expect(output.written).toHaveLength(1);
    expect(exits).toEqual([]);

    for (let turn = 0; turn < 10 && exits.length === 0; turn += 1) {
      output.release();
      await new Promise((resolve) => setImmediate(resolve));
    }
    const frames = output.written.filter((chunk) => chunk.byteLength > 0);
    expect(frames).toEqual(
      [1, 2, 3].map((index) => encodeExecutionHostFrame({ index })),
    );
    expect(exits).toEqual([0]);
  });

  it('reports congestion past its high-water mark until held frames drain', async () => {
    const output = new SlowPipe();
    const frame = encodeExecutionHostFrame({ payload: 'x'.repeat(100) });
    const channel = createStdioExecutionHostChannel(
      new PassThrough(),
      output,
      () => undefined,
      frame.byteLength * 2,
    );
    channel.postMessage({ payload: 'x'.repeat(100) });
    expect(channel.congested()).toBe(false);
    channel.postMessage({ payload: 'x'.repeat(100) });
    channel.postMessage({ payload: 'x'.repeat(100) });
    expect(channel.congested()).toBe(true);
    const drained = jest.fn();
    channel.onceDrained(drained);
    expect(drained).not.toHaveBeenCalled();

    for (
      let turn = 0;
      turn < 10 && drained.mock.calls.length === 0;
      turn += 1
    ) {
      output.release();
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(drained).toHaveBeenCalledTimes(1);
    expect(channel.congested()).toBe(false);
  });

  it('reports drained only once the pipe itself drains', async () => {
    const output = new SlowPipe();
    const channel = createStdioExecutionHostChannel(
      new PassThrough(),
      output,
      () => undefined,
      1,
    );
    // The pipe refuses the only frame: nothing is queued, yet nothing drained.
    channel.postMessage({ index: 1 });
    const drained = jest.fn();
    channel.onceDrained(drained);
    await new Promise((resolve) => setImmediate(resolve));
    expect(drained).not.toHaveBeenCalled();

    output.release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(drained).toHaveBeenCalledTimes(1);
  });

  it('exits when the launcher stops reading', () => {
    const output = new PassThrough();
    const exits: number[] = [];
    createStdioExecutionHostChannel(new PassThrough(), output, (code) =>
      exits.push(code),
    );
    output.emit('error', new Error('EPIPE'));
    expect(exits).toEqual([0]);
  });
});

describe('execution probes', () => {
  it('reports a timeout only after the probe tree has stopped', async () => {
    let releaseStop: () => void = () => undefined;
    const stop = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const read = new EventEmitter();
    const child: PlatformExecutionProcess = {
      pid: 4242,
      stdin: null,
      stderr: null,
      stdout: {
        // Never produces output: only the stop ends the stream.
        read: () =>
          new Promise((resolve) => read.once('stop', () => resolve(null))),
        acknowledge: () => undefined,
        discard: () => undefined,
      },
      outcome: new Promise<PlatformExecutionOutcome>((resolve) =>
        read.once('stop', () =>
          resolve({
            kind: 'cancelled',
            code: null,
            signal: 'SIGKILL',
            output: 'discarded',
          }),
        ),
      ),
      terminate: () => {
        read.emit('stop');
        return stop;
      },
    };
    const services: PlatformExecutionProcessServices = {
      start: () => Promise.resolve(child),
      shutdown: () => Promise.resolve(),
    };
    let settled = false;
    const result = runExecutionProbe(services, '/', {
      executable: '/bin/sh',
      args: [],
      environment: {},
      timeoutMs: 5,
      maxOutputBytes: 10,
    }).finally(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    releaseStop();
    await expect(result).resolves.toEqual({ ok: false, reason: 'timeout' });
  });
});
