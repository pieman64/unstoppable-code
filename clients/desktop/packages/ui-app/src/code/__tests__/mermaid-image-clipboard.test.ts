/** @jest-environment jsdom */
import {
  MERMAID_IMAGE_CLIPBOARD_UNSUPPORTED,
  browserImageClipboard,
} from '../mermaid-image-clipboard';

class FakeClipboardItem {
  static supportedTypes = new Set(['image/png', 'text/html']);
  static supports(type: string): boolean {
    return FakeClipboardItem.supportedTypes.has(type);
  }
  constructor(readonly items: Record<string, Promise<Blob>>) {}
}

function installClipboard(write: jest.Mock | undefined, secure = true): void {
  Object.defineProperty(window, 'isSecureContext', {
    configurable: true,
    value: secure,
  });
  Object.defineProperty(window, 'ClipboardItem', {
    configurable: true,
    value: FakeClipboardItem,
  });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: write ? { write } : undefined,
  });
}

describe('browser image clipboard', () => {
  afterEach(() => {
    FakeClipboardItem.supportedTypes = new Set(['image/png', 'text/html']);
    Reflect.deleteProperty(window, 'ClipboardItem');
  });

  it('writes one PNG + HTML item through the owner window', async () => {
    const write = jest.fn().mockResolvedValue(undefined);
    installClipboard(write);
    const clipboard = browserImageClipboard(true, window);
    if (clipboard.status !== 'available') throw new Error('expected available');
    const png = Promise.resolve(new Blob(['png'], { type: 'image/png' }));
    const html = Promise.resolve(new Blob(['<img>'], { type: 'text/html' }));
    await clipboard.write({ png, html }, document);
    expect(write).toHaveBeenCalledTimes(1);
    const [items] = write.mock.calls[0] as [FakeClipboardItem[]];
    expect(items).toHaveLength(1);
    expect(items[0]?.items).toEqual({ 'image/png': png, 'text/html': html });
  });

  it('uses the detached document’s clipboard and MIME checks', async () => {
    const mainWrite = jest.fn().mockResolvedValue(undefined);
    installClipboard(mainWrite);
    const frame = document.createElement('iframe');
    document.body.append(frame);
    try {
      const target = frame.contentWindow;
      const owner = frame.contentDocument;
      if (!target || !owner) throw new Error('Missing detached document');
      const detachedWrite = jest.fn().mockResolvedValue(undefined);
      Object.defineProperty(target, 'isSecureContext', {
        configurable: true,
        value: true,
      });
      Object.defineProperty(target, 'ClipboardItem', {
        configurable: true,
        value: FakeClipboardItem,
      });
      Object.defineProperty(target.navigator, 'clipboard', {
        configurable: true,
        value: { write: detachedWrite },
      });
      const clipboard = browserImageClipboard(true, window);
      if (clipboard.status !== 'available')
        throw new Error('expected available');
      const image = {
        png: Promise.resolve(new Blob()),
        html: Promise.resolve(new Blob()),
      };
      await clipboard.write(image, owner);
      expect(detachedWrite).toHaveBeenCalledTimes(1);
      expect(mainWrite).not.toHaveBeenCalled();
      Object.defineProperty(target, 'isSecureContext', {
        configurable: true,
        value: false,
      });
      await expect(clipboard.write(image, owner)).rejects.toThrow(
        MERMAID_IMAGE_CLIPBOARD_UNSUPPORTED,
      );
      expect(detachedWrite).toHaveBeenCalledTimes(1);
    } finally {
      frame.remove();
    }
  });

  it('stays unavailable when the host does not grant it', () => {
    installClipboard(jest.fn());
    expect(browserImageClipboard(false, window)).toEqual({
      status: 'unavailable',
      reason: 'Copying images isn’t available here.',
    });
  });

  it.each([
    ['an insecure context', (): void => installClipboard(jest.fn(), false)],
    ['a missing async clipboard', (): void => installClipboard(undefined)],
    [
      'an unsupported MIME type',
      (): void => {
        installClipboard(jest.fn());
        FakeClipboardItem.supportedTypes = new Set(['image/png']);
      },
    ],
  ])('explains %s', (_case, setup) => {
    setup();
    expect(browserImageClipboard(true, window)).toEqual({
      status: 'unavailable',
      reason: MERMAID_IMAGE_CLIPBOARD_UNSUPPORTED,
    });
  });

  it('passes a denied write back to the caller', async () => {
    const denied = new DOMException('Denied', 'NotAllowedError');
    installClipboard(jest.fn().mockRejectedValue(denied));
    const clipboard = browserImageClipboard(true, window);
    if (clipboard.status !== 'available') throw new Error('expected available');
    await expect(
      clipboard.write(
        { png: Promise.resolve(new Blob()), html: Promise.resolve(new Blob()) },
        document,
      ),
    ).rejects.toBe(denied);
  });
});
