import { randomBytes } from 'node:crypto';
import { serialize } from 'node:v8';
import {
  encodeMessage,
  MAX_FRAGMENT_BYTES,
  MessageAssembler,
  MessageCodecError,
} from '../transport/message-codec';

function roundTrip(value: unknown): unknown {
  const assembler = new MessageAssembler();
  let decoded: unknown = undefined;
  for (const fragment of encodeMessage(value)) {
    const result = assembler.push(fragment);
    if (result !== null) decoded = result.value;
  }
  return decoded;
}

describe('message codec', () => {
  it('reports the serialized size before compression', () => {
    const value = { payload: Buffer.alloc(256 * 1024) };
    const sizes: number[] = [];
    encodeMessage(value, { onSerialized: (size) => sizes.push(size) });
    expect(sizes).toEqual([serialize(value).byteLength]);
  });

  it('round-trips structured values across fragments', () => {
    const payload = randomBytes(3 * MAX_FRAGMENT_BYTES + 17);
    const value = { at: new Date(0), payload, nested: new Map([[1, 'a']]) };
    expect(roundTrip(value)).toEqual(value);
  });

  it('refuses on the sender what the receiver would refuse, before compressing', () => {
    // Highly compressible: tiny once deflated, over the limit once inflated.
    const limit = 64 * 1024;
    expect(() =>
      encodeMessage(Buffer.alloc(limit + 1), { maxMessageBytes: limit }),
    ).toThrow(MessageCodecError);
    const assembler = new MessageAssembler({ maxMessageBytes: limit });
    const fragments = encodeMessage(Buffer.alloc(limit - 64), {
      maxMessageBytes: limit,
    });
    let done = false;
    for (const fragment of fragments) {
      if (assembler.push(fragment) !== null) done = true;
    }
    expect(done).toBe(true);
  });

  it('refuses partial fragments that are not full, such as empty ones', () => {
    const assembler = new MessageAssembler();
    // Flags 0: not final. A sender only splits at full fragments.
    expect(() => assembler.push(Buffer.from([0]))).toThrow(MessageCodecError);
    const partial = Buffer.alloc(1 + MAX_FRAGMENT_BYTES - 1);
    expect(() => new MessageAssembler().push(partial)).toThrow(
      MessageCodecError,
    );
  });
});
