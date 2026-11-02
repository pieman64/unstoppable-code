/** @jest-environment jsdom */
import type { FileDocumentBytesResponse } from '@canopy/desktop-shared/types';
import { resolveDesktopDocumentBytes } from '../desktop-document-bytes';

const ready = (
  bytes = new Uint8Array([1, 2, 3]),
): FileDocumentBytesResponse => ({
  status: 'ready',
  bytes,
  filename: 'brief.pdf',
  sizeBytes: bytes.byteLength,
  modifiedAtMs: 123,
});

describe('resolveDesktopDocumentBytes', () => {
  it('copies only a subarray view and owns its bytes', async () => {
    const backing = new Uint8Array([99, 1, 2, 3, 99]);
    const result = await resolveDesktopDocumentBytes(
      () => Promise.resolve(ready(backing.subarray(1, 4))),
      new AbortController().signal,
    );
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('Expected document bytes');
    expect(new Uint8Array(result.bytes)).toEqual(new Uint8Array([1, 2, 3]));
    backing.fill(0);
    expect(new Uint8Array(result.bytes)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('maps an oversized response', async () => {
    const result = await resolveDesktopDocumentBytes(
      () =>
        Promise.resolve({
          status: 'too-large',
          maxBytes: 25 * 1024 * 1024,
          sizeBytes: 30 * 1024 * 1024,
        }),
      new AbortController().signal,
    );
    expect(result).toEqual({ status: 'too-large', maxBytes: 25 * 1024 * 1024 });
  });

  it('rejects a ready view larger than the byte budget', async () => {
    const result = await resolveDesktopDocumentBytes(
      () => Promise.resolve(ready(new Uint8Array(25 * 1024 * 1024 + 1))),
      new AbortController().signal,
    );
    expect(result).toEqual({ status: 'too-large', maxBytes: 25 * 1024 * 1024 });
  });

  it('applies a caller-supplied budget', async () => {
    const bytes = new Uint8Array(4);
    expect(
      await resolveDesktopDocumentBytes(
        () => Promise.resolve(ready(bytes)),
        new AbortController().signal,
        3,
      ),
    ).toEqual({ status: 'too-large', maxBytes: 3 });
    expect(
      (
        await resolveDesktopDocumentBytes(
          () => Promise.resolve(ready(bytes)),
          new AbortController().signal,
          4,
        )
      ).status,
    ).toBe('ready');
  });

  it('maps missing documents and read failures to the shared failure card', async () => {
    expect(
      await resolveDesktopDocumentBytes(
        () => Promise.resolve({ status: 'missing' }),
        new AbortController().signal,
      ),
    ).toEqual({ status: 'failed' });
    expect(
      await resolveDesktopDocumentBytes(
        () => Promise.reject(new Error('denied')),
        new AbortController().signal,
      ),
    ).toEqual({ status: 'failed' });
  });

  it('does not invoke IPC when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const read = jest.fn(() => Promise.resolve(ready()));
    await expect(
      resolveDesktopDocumentBytes(read, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)(
    'throws AbortError when aborted during IPC %s',
    async (outcome) => {
      const controller = new AbortController();
      const read = (): Promise<FileDocumentBytesResponse> => {
        controller.abort();
        if (outcome === 'reject')
          return Promise.reject(new Error('read failed'));
        return Promise.resolve(ready());
      };
      await expect(
        resolveDesktopDocumentBytes(read, controller.signal),
      ).rejects.toMatchObject({ name: 'AbortError' });
    },
  );
});
