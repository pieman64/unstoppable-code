import { isTranscriptPageForCurrentWindow } from '../transcript-window';
import { isTranscriptPageForCurrentWindow as fromPackageRoot } from '../../index';

describe('isTranscriptPageForCurrentWindow', () => {
  const requested = { chatId: 'chat-a', generation: 3 };

  it('accepts a page for the same window', () => {
    expect(
      isTranscriptPageForCurrentWindow(requested, {
        chatId: 'chat-a',
        generation: 3,
      }),
    ).toBe(true);
  });

  it('rejects a page once the window generation changed', () => {
    expect(
      isTranscriptPageForCurrentWindow(requested, {
        chatId: 'chat-a',
        generation: 4,
      }),
    ).toBe(false);
  });

  it('rejects a page for a different chat identity', () => {
    expect(
      isTranscriptPageForCurrentWindow(requested, {
        chatId: 'chat-b',
        generation: 3,
      }),
    ).toBe(false);
  });

  it('rejects a page when there is no current window', () => {
    expect(isTranscriptPageForCurrentWindow(requested, undefined)).toBe(false);
  });

  it('is exported from the package root', () => {
    expect(fromPackageRoot).toBe(isTranscriptPageForCurrentWindow);
  });
});
