import { ndJsonStream, type Stream } from '@agentclientprotocol/sdk';
import { AcpClientError } from './errors';
import { isValidAcpSessionUpdate } from './session-update-validation';
import type { AcpTransport } from './types';

const ACP_UPDATE_HIGH_WATER_BYTES = 64 * 1024;
const ACP_UPDATE_LOW_WATER_BYTES = 32 * 1024;

/** Credits are held until the SDK has handed an update to its actual sink. */
export class AcpUpdatePressure {
  private chargedBytes = 0;
  private readonly pending: Array<() => void> = [];
  private waiter:
    | { resolve: () => void; reject: (error: AcpClientError) => void }
    | undefined;
  private closed = false;

  async admit(frameBytes: number): Promise<void> {
    while (
      this.chargedBytes > 0 &&
      this.chargedBytes + frameBytes > ACP_UPDATE_HIGH_WATER_BYTES
    ) {
      if (this.closed)
        throw new AcpClientError('closed', 'ACP connection closed');
      await new Promise<void>((resolve, reject) => {
        this.waiter = { resolve, reject };
      });
    }
    if (this.closed)
      throw new AcpClientError('closed', 'ACP connection closed');
    this.chargedBytes += frameBytes;
    let released = false;
    this.pending.push(() => {
      if (released) return;
      released = true;
      this.chargedBytes -= frameBytes;
      if (this.chargedBytes <= ACP_UPDATE_LOW_WATER_BYTES) {
        const waiter = this.waiter;
        this.waiter = undefined;
        waiter?.resolve();
      }
    });
  }

  take(): () => void {
    return this.pending.shift() ?? ((): void => undefined);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.reject(new AcpClientError('closed', 'ACP connection closed'));
    for (const release of this.pending.splice(0)) release();
  }
}

/** Bound frames before the SDK buffers/parses them. Never put input in errors. */
export function createAcpStream(
  transport: AcpTransport,
  maxMessageBytes: number,
  onFailure: (error: AcpClientError) => void,
  updatePressure?: AcpUpdatePressure,
): Stream {
  // Normalize Node and DOM stream typings without casting either to the other.
  const reader = transport.input.getReader();
  const input = new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      try {
        const result = await reader.read();
        if (result.done) {
          reader.releaseLock();
          controller.close();
        } else controller.enqueue(result.value);
      } catch (error) {
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason): Promise<void> {
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
      }
    },
  });
  const output = new WritableStream<Uint8Array>({
    async write(chunk): Promise<void> {
      const writer = transport.output.getWriter();
      try {
        await writer.write(chunk);
      } finally {
        writer.releaseLock();
      }
    },
  });
  let buffer = Buffer.allocUnsafe(Math.min(4096, maxMessageBytes));
  let size = 0;
  const fail = (message: string): never => {
    const error = new AcpClientError('protocol', message);
    onFailure(error);
    throw error;
  };
  const append = (part: Uint8Array): void => {
    const nextSize = size + part.byteLength;
    if (nextSize > maxMessageBytes) fail('ACP message exceeds the size limit');
    if (nextSize > buffer.byteLength) {
      const grown = Buffer.allocUnsafe(
        Math.min(maxMessageBytes, Math.max(nextSize, buffer.byteLength * 2)),
      );
      buffer.copy(grown, 0, 0, size);
      buffer = grown;
    }
    buffer.set(part, size);
    size = nextSize;
  };
  const guard = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller): Promise<void> {
      let start = 0;
      for (;;) {
        // indexOf keeps per-chunk framing cost off the event loop (native for
        // Buffer chunks, a typed-array scan otherwise).
        const newline = chunk.indexOf(10, start);
        if (newline === -1) break;
        let line: Buffer;
        if (size === 0) {
          // A whole frame inside this chunk needs no copy: the chunk is not
          // reused after this transform returns.
          const length = newline + 1 - start;
          if (length > maxMessageBytes)
            fail('ACP message exceeds the size limit');
          line = Buffer.from(chunk.buffer, chunk.byteOffset + start, length);
        } else {
          append(chunk.subarray(start, newline + 1));
          // Detach from the reusable buffer before the SDK consumes the frame.
          line = Buffer.from(buffer.subarray(0, size));
          size = 0;
        }
        start = newline + 1;
        // Decode once. The envelope check must run before the SDK parses the
        // frame so a malformed message never reaches its own buffering.
        const text = line.toString('utf8');
        let isUpdate = false;
        let updateParams: unknown;
        if (text.trim()) {
          try {
            const value: unknown = JSON.parse(text);
            if (
              typeof value !== 'object' ||
              value === null ||
              Array.isArray(value) ||
              !('jsonrpc' in value) ||
              value.jsonrpc !== '2.0' ||
              ('id' in value &&
                value.id !== null &&
                typeof value.id !== 'string' &&
                typeof value.id !== 'number') ||
              ('method' in value
                ? typeof value.method !== 'string'
                : !('id' in value) || 'result' in value === 'error' in value)
            ) {
              throw new Error('Invalid envelope');
            }
            isUpdate = 'method' in value && value.method === 'session/update';
            if (isUpdate)
              updateParams = 'params' in value ? value.params : undefined;
          } catch {
            fail('Invalid ACP JSON-RPC frame');
          }
        }
        if (isUpdate) {
          if (!isValidAcpSessionUpdate(updateParams))
            fail('Unsupported or invalid ACP session update');
          await updatePressure?.admit(line.byteLength);
        }
        controller.enqueue(line);
      }
      if (start < chunk.byteLength) append(chunk.subarray(start));
    },
    flush(): void {
      if (size > 0) {
        fail('Incomplete ACP frame at disconnect');
      }
    },
  });
  return ndJsonStream(output, input.pipeThrough(guard));
}
