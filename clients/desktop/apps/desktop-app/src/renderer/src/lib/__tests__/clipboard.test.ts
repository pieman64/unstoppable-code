import { copyTextToClipboard } from '../clipboard';

const originalNavigator = Object.getOwnPropertyDescriptor(
  globalThis,
  'navigator',
);

describe('copyTextToClipboard', () => {
  afterEach((): void => {
    if (originalNavigator) {
      Object.defineProperty(globalThis, 'navigator', originalNavigator);
    } else {
      Reflect.deleteProperty(globalThis, 'navigator');
    }
  });

  it('uses the native clipboard API when available', async (): Promise<void> => {
    const writeText = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: { writeText } },
    });

    await expect(copyTextToClipboard('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('returns false when native copy fails and no DOM fallback is available', async (): Promise<void> => {
    const writeText = jest.fn<Promise<void>, [string]>(() =>
      Promise.reject(new Error('clipboard unavailable')),
    );
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: { writeText } },
    });

    await expect(copyTextToClipboard('hello')).resolves.toBe(false);
    expect(writeText).toHaveBeenCalledWith('hello');
  });
});
