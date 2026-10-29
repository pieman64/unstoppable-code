/** @jest-environment jsdom */
/* eslint-disable no-restricted-imports, @typescript-eslint/require-await */
import { webcrypto } from 'node:crypto';
import { TextDecoder, TextEncoder } from 'node:util';
import type { PersistedVisualReference } from '@canopy/agent-transcript/types';
import type { ChatVisualOwner } from '../chat-visual-host';
import {
  ChatVisualDocumentCache,
  readVisualRanges,
  verifyVisualDocument,
  VISUAL_RANGE_LIMIT,
} from '../chat-visual-reader';

Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: webcrypto,
});
Object.defineProperty(globalThis, 'TextDecoder', {
  configurable: true,
  value: TextDecoder,
});

async function fixture(text: string): Promise<{
  bytes: Uint8Array;
  reference: PersistedVisualReference;
  owner: ChatVisualOwner;
}> {
  const bytes = new TextEncoder().encode(text);
  const digest = await webcrypto.subtle.digest('SHA-256', bytes);
  const sha256 = Buffer.from(digest).toString('hex');
  const reference: PersistedVisualReference = {
    version: 1,
    visualId: 'vis_00000000-0000-0000-0000-000000000001',
    artifactId: `sha256-v1-${sha256}`,
    sha256,
    byteLength: bytes.length,
    mediaType: 'text/html',
    title: 'Chart',
    maxHeight: 400,
  };
  return {
    bytes,
    reference,
    owner: { messageId: 'message-1', toolUseId: 'tool-1', reference },
  };
}

it.each([0, 1, VISUAL_RANGE_LIMIT, VISUAL_RANGE_LIMIT + 1])(
  'assembles %i bytes in exact ranges',
  async (size) => {
    const { bytes, reference } = await fixture('a'.repeat(size));
    const calls: Array<[number, number]> = [];
    const result = await readVisualRanges(
      async (offset, limit) => {
        calls.push([offset, limit]);
        const page = bytes.slice(offset, offset + limit);
        return {
          bytes: page,
          offset,
          length: page.length,
          byteLength: bytes.length,
          sha256: reference.sha256,
        };
      },
      reference,
      new AbortController().signal,
    );
    expect(result).toEqual(bytes);
    expect(calls).toEqual(
      size === 0
        ? [[0, 1]]
        : size > VISUAL_RANGE_LIMIT
          ? [
              [0, VISUAL_RANGE_LIMIT],
              [VISUAL_RANGE_LIMIT, 1],
            ]
          : [[0, size]],
    );
  },
);

it.each(['gap', 'overrun', 'stale', 'short'])(
  'rejects a %s range',
  async (fault) => {
    const { bytes, reference } = await fixture('hello');
    await expect(
      readVisualRanges(
        async () => ({
          bytes:
            fault === 'overrun'
              ? new Uint8Array(6)
              : fault === 'short'
                ? bytes.slice(0, 4)
                : bytes,
          offset: fault === 'gap' ? 1 : 0,
          length: fault === 'overrun' ? 6 : fault === 'short' ? 4 : 5,
          byteLength: 5,
          sha256: fault === 'stale' ? 'bad' : reference.sha256,
        }),
        reference,
        new AbortController().signal,
      ),
    ).rejects.toThrow('changed');
  },
);

it('aborts before reading and before returning a pending page', async () => {
  const { bytes, reference } = await fixture('hello');
  const controller = new AbortController();
  controller.abort();
  const read = jest.fn(async () => ({
    bytes,
    offset: 0,
    length: 5,
    byteLength: 5,
    sha256: reference.sha256,
  }));
  await expect(
    readVisualRanges(read, reference, controller.signal),
  ).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
});

it('rejects digest mismatch and invalid UTF-8', async () => {
  const { bytes, reference } = await fixture('hello');
  await expect(
    verifyVisualDocument(new TextEncoder().encode('world'), reference),
  ).rejects.toThrow('does not match');
  const invalid = new Uint8Array([0xff]);
  const digest = await webcrypto.subtle.digest('SHA-256', invalid);
  await expect(
    verifyVisualDocument(invalid, {
      ...reference,
      byteLength: 1,
      sha256: Buffer.from(digest).toString('hex'),
    }),
  ).rejects.toThrow();
  await expect(verifyVisualDocument(bytes, reference)).resolves.toBe('hello');
});

it('reuses authorized bytes, checks a new owner, and evicts by byte budget', async () => {
  const first = await fixture('first');
  const second = await fixture('other');
  const cache = new ChatVisualDocumentCache(6);
  const authority = {};
  const read = jest.fn(async (owner: ChatVisualOwner) =>
    owner.reference.sha256 === first.reference.sha256
      ? first.bytes
      : second.bytes,
  );
  const authorize = jest.fn(async (): Promise<void> => {});
  const signal = new AbortController().signal;
  await cache.load(authority, first.owner, read, authorize, signal);
  await cache.load(authority, first.owner, read, authorize, signal);
  expect(read).toHaveBeenCalledTimes(1);
  const otherOwner = { ...first.owner, messageId: 'message-2' };
  await cache.load(authority, otherOwner, read, authorize, signal);
  expect(authorize).toHaveBeenCalledTimes(1);
  await cache.load(authority, second.owner, read, authorize, signal);
  expect(cache.byteLength).toBe(5);
  await cache.load(authority, first.owner, read, authorize, signal);
  expect(read).toHaveBeenCalledTimes(3);
});

it('coalesces concurrent reads without letting one abort cancel another', async () => {
  const { bytes, owner } = await fixture('shared');
  const cache = new ChatVisualDocumentCache();
  const first = new AbortController();
  const second = new AbortController();
  let release: (() => void) | undefined;
  const read = jest.fn(async (): Promise<Uint8Array> => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return bytes;
  });
  const authorize = jest.fn(async (): Promise<void> => {});
  const authority = {};
  const one = cache.load(authority, owner, read, authorize, first.signal);
  const two = cache.load(authority, owner, read, authorize, second.signal);
  first.abort();
  release?.();
  await expect(one).rejects.toBeDefined();
  await expect(two).resolves.toBe('shared');
  expect(read).toHaveBeenCalledTimes(1);
});

it('rechecks an owner whose reference differs in any field', async () => {
  // The host authorizes the whole reference, so cached bytes must not stand
  // in for a reference whose title, height, or id was altered.
  const { bytes, owner } = await fixture('<p>chart</p>');
  const cache = new ChatVisualDocumentCache();
  const authority = {};
  const signal = new AbortController().signal;
  const read = jest.fn(async (): Promise<Uint8Array> => bytes);
  const authorize = jest.fn(async (): Promise<void> => {});
  await cache.load(authority, owner, read, authorize, signal);
  const altered: ChatVisualOwner = {
    ...owner,
    reference: { ...owner.reference, title: 'Altered', maxHeight: 2000 },
  };
  await cache.load(authority, altered, read, authorize, signal);
  expect(authorize).toHaveBeenCalledTimes(1);
  expect(authorize).toHaveBeenCalledWith(altered, signal);
});

it('allocates only as bytes arrive, so a damaged length cannot', async () => {
  // A damaged reference's length is refused by the host on the first read;
  // nothing may be sized from it before then.
  const { reference } = await fixture('<p>chart</p>');
  const readRange = jest.fn(async () => {
    throw new Error('refused by host');
  });
  await expect(
    readVisualRanges(
      readRange,
      { ...reference, byteLength: Number.MAX_SAFE_INTEGER },
      new AbortController().signal,
    ),
  ).rejects.toThrow('refused by host');
  expect(readRange).toHaveBeenCalledTimes(1);
});
