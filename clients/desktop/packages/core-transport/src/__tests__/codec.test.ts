import { Buffer } from 'node:buffer';

import {
  CORE_TRANSPORT_QUERY_DEFINITIONS,
  composeCanopyOperationEnvelopes,
} from '@canopy/protocol/canopy-core';

import {
  CANOPY_DEFAULT_MAX_FRAME_BYTES,
  CanopyAuthChallengeFrameSchema,
  CanopyBindingFrameSchema,
  CanopyFrameDecoder,
  CanopyTransportError,
  encodeCanopyChannelDataFrame,
  encodeCanopyJsonFrame,
} from '@canopy/core-transport';

const message = {
  jsonrpc: '2.0',
  id: 'req-1',
  method: 'core.runtime.health.get',
  params: { note: 'héllo ✓' },
};

const decodedMessage = {
  type: 'json',
  value: message,
  byteLength: Buffer.byteLength(JSON.stringify(message)),
};

function kindOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof CanopyTransportError) return error.payload.kind;
    throw error;
  }
  return undefined;
}

describe('length-prefix codec', () => {
  it('writes a big-endian u32 length before the UTF-8 JSON body', () => {
    const frame = encodeCanopyJsonFrame(message);
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    expect(frame.readUInt32BE(0)).toBe(body.length);
    expect(frame.subarray(4)).toEqual(body);
  });

  it('reassembles a frame split at every byte boundary', () => {
    const frame = encodeCanopyJsonFrame(message);
    for (let split = 0; split <= frame.length; split += 1) {
      const decoder = new CanopyFrameDecoder();
      const frames = [
        ...decoder.push(frame.subarray(0, split)),
        ...decoder.push(frame.subarray(split)),
      ];
      expect(frames).toEqual([decodedMessage]);
    }
  });

  it('decodes byte-at-a-time input and two frames in one chunk', () => {
    const decoder = new CanopyFrameDecoder();
    const frame = encodeCanopyJsonFrame(message);
    const decoded = Array.from(frame).flatMap((byte) =>
      decoder.push(Uint8Array.of(byte)),
    );
    expect(decoded).toHaveLength(1);
    const data = encodeCanopyChannelDataFrame('ch_1', Uint8Array.of(0, 1, 255));
    expect(
      new CanopyFrameDecoder().push(Buffer.concat([frame, data, frame])),
    ).toEqual([
      decodedMessage,
      {
        type: 'channel.data',
        channelId: 'ch_1',
        bytes: Uint8Array.of(0, 1, 255),
      },
      decodedMessage,
    ]);
  });

  it('appends raw bytes and decodes one frame at a time on demand', () => {
    const decoder = new CanopyFrameDecoder();
    const frame = encodeCanopyJsonFrame(message);
    decoder.append(Buffer.concat([frame, frame, frame.subarray(0, 5)]));
    expect(decoder.nextFrame()).toEqual(decodedMessage);
    expect(decoder.nextFrame()).toEqual(decodedMessage);
    expect(decoder.nextFrame()).toBeNull();
    decoder.append(frame.subarray(5));
    expect(decoder.nextFrame()).toEqual(decodedMessage);
  });

  it('enforces the frame cap on encode and before buffering on decode', () => {
    expect(CANOPY_DEFAULT_MAX_FRAME_BYTES).toBe(8 * 1024 * 1024);
    const large = { jsonrpc: '2.0', id: 1, result: 'x'.repeat(1_000) };
    const frame = encodeCanopyJsonFrame(large);
    expect(new CanopyFrameDecoder(frame.length - 4).push(frame)).toHaveLength(
      1,
    );
    expect(kindOf(() => encodeCanopyJsonFrame(large, 100))).toBe(
      'resource_exhausted',
    );
    // Only the header has arrived: the cap still trips.
    expect(
      kindOf(() => new CanopyFrameDecoder(100).push(frame.subarray(0, 4))),
    ).toBe('resource_exhausted');
  });

  it.each([
    ['an empty frame', Buffer.from([0, 0, 0, 0])],
    ['invalid UTF-8', Buffer.from([0, 0, 0, 3, 0x7b, 0xff, 0x7d])],
    ['invalid JSON', Buffer.from([0, 0, 0, 2, 0x7b, 0x7b])],
    ['an unknown body tag', Buffer.from([0, 0, 0, 2, 0x22, 0x22])],
    ['a channel frame without an id', Buffer.from([0, 0, 0, 2, 0, 0])],
    [
      'a channel frame with a non-ASCII id',
      Buffer.from([0, 0, 0, 5, 0, 2, 0x61, 0xe1, 7]),
    ],
  ])('rejects %s as invalid_argument', (_label, bytes) => {
    expect(kindOf(() => new CanopyFrameDecoder().push(bytes))).toBe(
      'invalid_argument',
    );
  });

  it('refuses a sparse array instead of sending holes as null', () => {
    const sparse: unknown[] = [];
    sparse.length = 2;
    sparse[1] = 'kept';
    expect(
      kindOf(() =>
        encodeCanopyJsonFrame({ jsonrpc: '2.0', id: 1, result: sparse }),
      ),
    ).toBe('invalid_argument');
  });

  function holeWithExtraKey(): unknown[] {
    const value: unknown[] = [1];
    value.length = 2;
    return Object.assign(value, { extra: 'dropped' });
  }

  it.each([
    [
      'a throwing getter',
      Object.defineProperty({}, 'boom', {
        enumerable: true,
        get: (): never => {
          throw new Error('getter ran');
        },
      }),
    ],
    [
      'an accessor property',
      Object.defineProperty({}, 'value', { enumerable: true, get: () => 1 }),
    ],
    ['a symbol-keyed property', { [Symbol('hidden')]: 1 }],
    [
      'an array with a symbol-keyed property',
      Object.assign([1], { [Symbol('s')]: 1 }),
    ],
    ['an array index getter', Object.defineProperty([0], 0, { get: () => 1 })],
    ['an array hole hidden by an extra key', holeWithExtraKey()],
    [
      'a proxy whose traps throw',
      new Proxy(
        {},
        {
          ownKeys: (): never => {
            throw new Error('trap ran');
          },
        },
      ),
    ],
  ])('refuses %s as invalid_argument', (_label, result) => {
    expect(
      kindOf(() => encodeCanopyJsonFrame({ jsonrpc: '2.0', id: 1, result })),
    ).toBe('invalid_argument');
  });

  it.each(['', 'bad id', 'ché', 'a'.repeat(65)])(
    'refuses to encode the channel id %j',
    (channelId) => {
      expect(
        kindOf(() => encodeCanopyChannelDataFrame(channelId, Uint8Array.of(1))),
      ).toBe('invalid_argument');
    },
  );

  it('round-trips binding frames through the codec', () => {
    const frames = [
      {
        type: 'auth.challenge',
        nonce: 'bm9uY2U',
        dataRootHash: 'a'.repeat(64),
      },
      { type: 'auth.response', proof: 'cHJvb2Y', dataRootHash: 'a'.repeat(64) },
      { type: 'auth.ok', connectionId: 'conn-1' },
      {
        type: 'auth.failed',
        error: {
          kind: 'unauthenticated',
          message: 'No.',
          retry: { kind: 'never' },
        },
      },
      {
        type: 'channel.open',
        channelId: 'ch_1',
        kind: 'pipeline.output',
        leaseId: 'lease-1',
        caps: { maxChunkBytes: 65_536, maxBufferedChunks: 16 },
      },
      {
        type: 'channel.opened',
        channelId: 'ch_1',
        caps: { maxChunkBytes: 1_024, maxBufferedChunks: 16 },
      },
      { type: 'channel.close', channelId: 'ch_1', error: null },
      { type: 'connection.close', error: null },
    ];
    for (const frame of frames) {
      const [decoded] = new CanopyFrameDecoder().push(
        encodeCanopyJsonFrame(frame),
      );
      expect(
        decoded.type === 'json' &&
          CanopyBindingFrameSchema.parse(decoded.value),
      ).toEqual(frame);
    }
    expect(
      CanopyAuthChallengeFrameSchema.safeParse({
        ...frames[0],
        dataRootHash: '/Users/me/data',
      }).success,
    ).toBe(false);
    expect(
      CanopyBindingFrameSchema.safeParse({
        ...frames[4],
        channelId: 'a'.repeat(65),
      }).success,
    ).toBe(false);
  });

  it('round-trips a valid initialize result through the codec', () => {
    const { response } = composeCanopyOperationEnvelopes(
      'core.runtime.initialize',
      CORE_TRANSPORT_QUERY_DEFINITIONS['core.runtime.initialize'],
    );
    const envelope = {
      jsonrpc: '2.0',
      id: 'init-1',
      result: {
        runtime: {
          runtimeId: 'runtime-1',
          hostId: 'host-1',
          authorityId: 'authority-1',
          profile: 'core',
          daemonEpoch: 'epoch-1',
          protocolVersions: [1],
          state: 'ready',
          buildVersion: '0.26.8',
        },
        selectedProtocolVersion: 1,
        capabilities: {
          operations: ['core.runtime.health.get'],
          events: ['core.chat.messageUpserted'],
          streams: ['core.events.subscribe'],
        },
        limits: { maxFrameBytes: CANOPY_DEFAULT_MAX_FRAME_BYTES },
        authentication: { required: true, methods: [] },
      },
    };
    expect(response.safeParse(envelope).success).toBe(true);
    const [decoded] = new CanopyFrameDecoder().push(
      encodeCanopyJsonFrame(envelope),
    );
    expect(decoded).toMatchObject({ type: 'json', value: envelope });
    expect(
      response.safeParse(decoded.type === 'json' ? decoded.value : null)
        .success,
    ).toBe(true);
  });
});
