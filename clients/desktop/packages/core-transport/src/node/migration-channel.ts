import { Duplex } from 'node:stream';

/** Host-only byte port. No descriptor export or connection delegation. */
export interface MigrationByteChannel {
  read(signal?: AbortSignal): Promise<Uint8Array | null>;
  write(bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  close(): void;
}
const FIRST_FRAME = Buffer.from('canopy-migration-channel-v1\n');

/** Validates only the fixed prelude; returns the remaining byte stream, not peer identity. */
export async function migrationFirstFrame(
  channel: MigrationByteChannel,
  role: 'daemon' | 'launcher',
  capture: () => boolean,
  signal: AbortSignal,
): Promise<MigrationByteChannel> {
  try {
    signal.throwIfAborted();
    if (role === 'daemon') await channel.write(FIRST_FRAME, signal);
    let offset = 0;
    let pending: Uint8Array | undefined;
    while (offset < FIRST_FRAME.length) {
      const bytes = await channel.read(signal);
      signal.throwIfAborted();
      if (!bytes || bytes.length === 0)
        throw new Error('Migration channel refused.');
      const length = Math.min(bytes.length, FIRST_FRAME.length - offset);
      if (
        !FIRST_FRAME.subarray(offset, offset + length).equals(
          bytes.subarray(0, length),
        )
      )
        throw new Error('Migration channel refused.');
      offset += length;
      if (bytes.length > length)
        pending = Uint8Array.from(bytes.subarray(length));
    }
    if (!capture()) throw new Error('Migration peer refused.');
    signal.throwIfAborted();
    if (role === 'launcher') await channel.write(FIRST_FRAME, signal);
    signal.throwIfAborted();
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      pending = undefined;
      channel.close();
    };
    return {
      async read(readSignal): Promise<Uint8Array | null> {
        readSignal?.throwIfAborted();
        if (closed) throw new Error('Migration channel closed.');
        try {
          const buffered = pending;
          pending = undefined;
          const bytes = await (buffered ?? channel.read(readSignal));
          readSignal?.throwIfAborted();
          if (closed) throw new Error('Migration channel closed.');
          return bytes;
        } catch (error) {
          // A cancelled read may have consumed bytes; never resume it.
          close();
          throw error;
        }
      },
      async write(bytes, writeSignal): Promise<void> {
        writeSignal?.throwIfAborted();
        if (closed) throw new Error('Migration channel closed.');
        try {
          await channel.write(bytes, writeSignal);
          writeSignal?.throwIfAborted();
          if (closed) throw new Error('Migration channel closed.');
        } catch (error) {
          // A failed native write may have sent a partial frame; never resume it.
          close();
          throw error;
        }
      },
      close,
    };
  } catch (error) {
    channel.close();
    throw error;
  }
}

/** The framed transport owns this duplex, not the opaque native descriptor. */
export function migrationChannelDuplex(channel: MigrationByteChannel): Duplex {
  const stop = new AbortController();
  return new Duplex({
    read(): void {
      void channel.read(stop.signal).then(
        (bytes) => this.push(bytes === null ? null : Buffer.from(bytes)),
        () => this.destroy(),
      );
    },
    write(bytes: Buffer, _encoding, callback): void {
      void (async (): Promise<void> => {
        for (let at = 0; at < bytes.length; at += 65536)
          await channel.write(bytes.subarray(at, at + 65536), stop.signal);
      })().then(
        () => callback(),
        () => callback(new Error('Migration channel closed.')),
      );
    },
    final(callback): void {
      stop.abort();
      try {
        channel.close();
        callback();
      } catch {
        callback(new Error('Migration channel closed.'));
      }
    },
    destroy(error, callback): void {
      stop.abort();
      try {
        channel.close();
        callback(error);
      } catch {
        callback(error);
      }
    },
  });
}
