import {
  migrationFirstFrame,
  type MigrationByteChannel,
} from '../migration-channel';

const PRELUDE = Buffer.from('canopy-migration-channel-v1\n');
const AUTH = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);

it.each(Array.from({ length: PRELUDE.length }, (_, split) => split))(
  'preserves coalesced authentication bytes after prelude split at %i',
  async (split) => {
    const chunks = [
      ...(split ? [PRELUDE.subarray(0, split)] : []),
      Buffer.concat([PRELUDE.subarray(split), AUTH]),
      Buffer.from('next'),
      null,
    ];
    const read = jest.fn(() => Promise.resolve(chunks.shift() ?? null));
    const close = jest.fn();
    const capture = jest.fn(() => {
      expect(read).toHaveBeenCalledTimes(split ? 2 : 1);
      return true;
    });
    const channel: MigrationByteChannel = { read, write: jest.fn(), close };
    const framed = await migrationFirstFrame(
      channel,
      'daemon',
      capture,
      AbortSignal.timeout(1000),
    );
    expect(capture).toHaveBeenCalledTimes(1);
    expect(await framed.read()).toEqual(AUTH);
    expect(read).toHaveBeenCalledTimes(split ? 2 : 1);
    expect(await framed.read()).toEqual(Buffer.from('next'));
    expect(await framed.read()).toBeNull();
    expect(close).not.toHaveBeenCalled();
  },
);

it.each(['daemon', 'launcher'] as const)(
  'accepts coalesced bytes for %s without capturing or forwarding them twice',
  async (role) => {
    const channel = {
      read: jest.fn(() => Promise.resolve(Buffer.concat([PRELUDE, AUTH]))),
      write: jest.fn(),
      close: jest.fn(),
    } satisfies MigrationByteChannel;
    const capture = jest.fn(() => true);
    const framed = await migrationFirstFrame(
      channel,
      role,
      capture,
      AbortSignal.timeout(1000),
    );
    expect(capture).toHaveBeenCalledTimes(1);
    expect(channel.write).toHaveBeenCalledTimes(1);
    expect(channel.write).toHaveBeenCalledWith(PRELUDE, expect.anything());
    expect(await framed.read()).toEqual(AUTH);
    const cancelled = AbortSignal.abort(new Error('cancelled'));
    await expect(framed.read(cancelled)).rejects.toThrow('cancelled');
    expect(channel.read).toHaveBeenCalledTimes(1);
    framed.close();
    await expect(framed.read()).rejects.toThrow();
    expect(channel.close).toHaveBeenCalledTimes(1);
  },
);

it.each([null, Buffer.alloc(0), Buffer.from('wrong\n'), Buffer.from('X\n')])(
  'refuses a truncated or malformed peer prelude before capture: %s',
  async (last) => {
    const chunks = [PRELUDE.subarray(0, -2), last];
    const capture = jest.fn(() => true);
    const close = jest.fn();
    await expect(
      migrationFirstFrame(
        {
          read: () => Promise.resolve(chunks.shift() ?? null),
          write: jest.fn(),
          close,
        },
        'daemon',
        capture,
        AbortSignal.timeout(1000),
      ),
    ).rejects.toThrow('Migration channel refused.');
    expect(capture).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  },
);

it.each(['before', 'read', 'capture'] as const)(
  'fails closed on cancellation %s the prelude is validated',
  async (when) => {
    const stop = new AbortController();
    const reason = new Error('cancelled');
    if (when === 'before') stop.abort(reason);
    const capture = jest.fn(() => {
      if (when === 'capture') stop.abort(reason);
      return true;
    });
    const read = jest.fn(() => {
      if (when === 'read') stop.abort(reason);
      return Promise.resolve(Buffer.concat([PRELUDE, AUTH]));
    });
    const write = jest.fn();
    const close = jest.fn();
    await expect(
      migrationFirstFrame(
        { read, write, close },
        'launcher',
        capture,
        stop.signal,
      ),
    ).rejects.toBe(reason);
    expect(capture).toHaveBeenCalledTimes(when === 'capture' ? 1 : 0);
    expect(write).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  },
);

it('does not expose buffered bytes when peer capture refuses', async () => {
  const close = jest.fn();
  const capture = jest.fn(() => false);
  await expect(
    migrationFirstFrame(
      {
        read: () => Promise.resolve(Buffer.concat([PRELUDE, AUTH])),
        write: jest.fn(),
        close,
      },
      'daemon',
      capture,
      AbortSignal.timeout(1000),
    ),
  ).rejects.toThrow('Migration peer refused.');
  expect(capture).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
});

it.each(Array.from({ length: PRELUDE.length }, (_, length) => length))(
  'does not capture on EOF after %i prelude bytes',
  async (length) => {
    const chunks = [...(length ? [PRELUDE.subarray(0, length)] : []), null];
    const capture = jest.fn(() => true);
    const close = jest.fn();
    await expect(
      migrationFirstFrame(
        {
          read: () => Promise.resolve(chunks.shift() ?? null),
          write: jest.fn(),
          close,
        },
        'launcher',
        capture,
        AbortSignal.timeout(1000),
      ),
    ).rejects.toThrow('Migration channel refused.');
    expect(capture).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  },
);

it('validates a byte-at-a-time prelude without reading past it', async () => {
  const read = jest.fn(() => Promise.resolve(chunks.shift() ?? null));
  const chunks = [...PRELUDE].map((byte) => Buffer.from([byte]));
  const capture = jest.fn(() => {
    expect(read).toHaveBeenCalledTimes(PRELUDE.length);
    return true;
  });
  const framed = await migrationFirstFrame(
    { read, write: jest.fn(), close: jest.fn() },
    'launcher',
    capture,
    AbortSignal.timeout(1000),
  );
  expect(capture).toHaveBeenCalledTimes(1);
  expect(await framed.read()).toBeNull();
});

it('does not consume buffered bytes on a cancelled read and discards them on close', async () => {
  const channel = {
    read: jest.fn(() => Promise.resolve(Buffer.concat([PRELUDE, AUTH]))),
    write: jest.fn(),
    close: jest.fn(),
  } satisfies MigrationByteChannel;
  const framed = await migrationFirstFrame(
    channel,
    'daemon',
    () => true,
    AbortSignal.timeout(1000),
  );
  await expect(framed.read(AbortSignal.abort())).rejects.toThrow();
  expect(await framed.read()).toEqual(AUTH);
  framed.close();
  framed.close();
  await expect(framed.read()).rejects.toThrow('Migration channel closed.');
  expect(channel.read).toHaveBeenCalledTimes(1);
  expect(channel.close).toHaveBeenCalledTimes(1);
});

it.each(['read', 'write', 'capture', 'read-reject', 'write-reject'] as const)(
  'closes the channel when %s fails',
  async (failure) => {
    const reason = new Error(failure);
    const close = jest.fn();
    const capture = jest.fn(() => {
      if (failure === 'capture') throw reason;
      return true;
    });
    await expect(
      migrationFirstFrame(
        {
          read: () => {
            if (failure === 'read') throw reason;
            return failure === 'read-reject'
              ? Promise.reject(reason)
              : Promise.resolve(Buffer.concat([PRELUDE, AUTH]));
          },
          write: () => {
            if (failure === 'write') throw reason;
            return failure === 'write-reject'
              ? Promise.reject(reason)
              : Promise.resolve();
          },
          close,
        },
        'launcher',
        capture,
        AbortSignal.timeout(1000),
      ),
    ).rejects.toBe(reason);
    expect(capture).toHaveBeenCalledTimes(
      failure === 'read' || failure === 'read-reject' ? 0 : 1,
    );
    expect(close).toHaveBeenCalledTimes(1);
  },
);

it.each(['close', 'abort'] as const)(
  'revokes an in-flight read when %s races its native completion',
  async (action) => {
    const next = Promise.withResolvers<Uint8Array | null>();
    const read = jest.fn(() => next.promise).mockResolvedValueOnce(PRELUDE);
    const channel = {
      read,
      write: jest.fn(),
      close: jest.fn(),
    } satisfies MigrationByteChannel;
    const framed = await migrationFirstFrame(
      channel,
      'launcher',
      () => true,
      AbortSignal.timeout(1000),
    );
    const stop = new AbortController();
    const result = framed.read(stop.signal);
    // A polled native read can already have resolved before cancellation runs.
    next.resolve(AUTH);
    if (action === 'close') framed.close();
    else stop.abort(new Error('cancelled'));
    await expect(result).rejects.toThrow(
      action === 'close' ? 'Migration channel closed.' : 'cancelled',
    );
    await expect(framed.read()).rejects.toThrow('Migration channel closed.');
    expect(read).toHaveBeenCalledTimes(2);
    expect(channel.close).toHaveBeenCalledTimes(1);
  },
);

it('never forwards writes after adapter shutdown', async () => {
  const write = jest.fn(() => Promise.resolve());
  const close = jest.fn();
  const framed = await migrationFirstFrame(
    { read: () => Promise.resolve(PRELUDE), write, close },
    'launcher',
    () => true,
    AbortSignal.timeout(1000),
  );
  framed.close();
  await expect(framed.write(AUTH)).rejects.toThrow('Migration channel closed.');
  expect(write).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
});

it.each(['close', 'abort'] as const)(
  'revokes a buffered read when %s races its delivery',
  async (action) => {
    const read = jest.fn(() => Promise.resolve(Buffer.concat([PRELUDE, AUTH])));
    const close = jest.fn();
    const framed = await migrationFirstFrame(
      { read, write: jest.fn(), close },
      'launcher',
      () => true,
      AbortSignal.timeout(1000),
    );
    const stop = new AbortController();
    const result = framed.read(stop.signal);
    if (action === 'close') framed.close();
    else stop.abort(new Error('cancelled'));
    await expect(result).rejects.toThrow(
      action === 'close' ? 'Migration channel closed.' : 'cancelled',
    );
    await expect(framed.read()).rejects.toThrow('Migration channel closed.');
    expect(read).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  },
);

it.each(['close', 'abort'] as const)(
  'refuses success when %s races a native write completion',
  async (action) => {
    const next = Promise.withResolvers<void>();
    const write = jest.fn(() => next.promise).mockResolvedValueOnce();
    const close = jest.fn();
    const framed = await migrationFirstFrame(
      { read: () => Promise.resolve(PRELUDE), write, close },
      'launcher',
      () => true,
      AbortSignal.timeout(1000),
    );
    const stop = new AbortController();
    const result = framed.write(AUTH, stop.signal);
    // A native write may have completed before its promise continuation runs.
    next.resolve();
    if (action === 'close') framed.close();
    else stop.abort(new Error('cancelled'));
    await expect(result).rejects.toThrow(
      action === 'close' ? 'Migration channel closed.' : 'cancelled',
    );
    await expect(framed.write(AUTH)).rejects.toThrow(
      'Migration channel closed.',
    );
    expect(write).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
  },
);

it('revokes the buffered stream when a native write rejects', async () => {
  const reason = new Error('partial write failed');
  const write = jest
    .fn((): Promise<void> => Promise.reject(reason))
    .mockResolvedValueOnce(undefined);
  const read = jest.fn(() => Promise.resolve(Buffer.concat([PRELUDE, AUTH])));
  const close = jest.fn();
  const framed = await migrationFirstFrame(
    { read, write, close },
    'launcher',
    () => true,
    AbortSignal.timeout(1000),
  );
  await expect(framed.write(AUTH)).rejects.toBe(reason);
  expect(close).toHaveBeenCalledTimes(1);
  await expect(framed.read()).rejects.toThrow('Migration channel closed.');
  await expect(framed.write(AUTH)).rejects.toThrow('Migration channel closed.');
  expect(read).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledTimes(2);
});
