import type { Socket } from 'node:net';
import type { PlatformByteStream } from '@canopy/core-runtime';

export const MAX_BYTES = 64 * 1024;

/** One outstanding read/write per stream; no application-side unbounded queue. */
export function byteStream(socket: Socket): PlatformByteStream {
  const controller = new AbortController();
  let reading = false;
  let writing = false;
  const closed = new Promise<void>((resolve) => socket.once('close', resolve));
  socket.on('error', () => controller.abort());
  socket.once('end', () => controller.abort());
  socket.once('close', () => controller.abort());

  function waitReadable(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      function cleanup(): void {
        socket.off('readable', ready);
        socket.off('close', ready);
        socket.off('end', ready);
        signal?.removeEventListener('abort', abort);
      }
      function ready(): void {
        cleanup();
        resolve();
      }
      function abort(): void {
        cleanup();
        reject(new Error('Read aborted.'));
      }
      socket.once('readable', ready);
      socket.once('close', ready);
      socket.once('end', ready);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else if (
        socket.readableLength ||
        socket.destroyed ||
        socket.readableEnded
      )
        ready();
    });
  }

  return {
    signal: controller.signal,
    read: async (options): Promise<Uint8Array | null> => {
      if (reading) throw new Error('Concurrent read.');
      reading = true;
      try {
        for (;;) {
          if (options?.signal?.aborted) throw new Error('Read aborted.');
          const bytes: unknown = socket.read(
            Math.min(socket.readableLength, MAX_BYTES),
          );
          if (bytes instanceof Uint8Array) return bytes;
          if (socket.destroyed || socket.readableEnded) return null;
          await waitReadable(options?.signal);
        }
      } finally {
        reading = false;
      }
    },
    write: async (bytes): Promise<void> => {
      if (writing || bytes.byteLength > MAX_BYTES)
        throw new Error('Write buffer limit.');
      if (socket.destroyed || socket.writableEnded)
        throw new Error('Stream closed.');
      writing = true;
      try {
        await new Promise<void>((resolve, reject) => {
          function onClose(): void {
            reject(new Error('Stream closed.'));
          }
          socket.once('close', onClose);
          socket.write(Buffer.from(bytes), (error) => {
            socket.off('close', onClose);
            if (error) reject(error);
            else resolve();
          });
        });
      } finally {
        writing = false;
      }
    },
    close: async (): Promise<void> => {
      socket.destroy();
      await closed;
    },
  };
}
