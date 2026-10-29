/**
 * @jest-environment jsdom
 */
import { copyTextToClipboard } from '../copy-to-clipboard';

describe('copyTextToClipboard', () => {
  it('puts the requested payload on the fallback copy event even with an older DOM selection', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('denied')) },
    });
    const paragraph = document.createElement('p');
    paragraph.textContent = 'Previously selected message';
    document.body.append(paragraph);
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    document.getSelection()?.addRange(range);
    const previousSelection = document.getSelection()?.toString() ?? '';
    expect(previousSelection).toBe('Previously selected message');
    let copied = '';
    const clipboardData = {
      setData: (format: string, value: string): void => {
        expect(format).toBe('text/plain');
        copied = value;
      },
    };
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: (): boolean => {
        const event = new Event('copy', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'clipboardData', { value: clipboardData });
        document.dispatchEvent(event);
        // Model the native fallback retaining the previous transcript range.
        if (!event.defaultPrevented) copied = previousSelection;
        return true;
      },
    });
    try {
      await expect(
        copyTextToClipboard('https://example.com/issue/42'),
      ).resolves.toBe(true);
      expect(copied).toBe('https://example.com/issue/42');
      copied = '';
      const later = new Event('copy', { cancelable: true });
      Object.defineProperty(later, 'clipboardData', { value: clipboardData });
      document.dispatchEvent(later);
      expect(copied).toBe('');
    } finally {
      document.getSelection()?.removeAllRanges();
      paragraph.remove();
    }
  });
  it('restores focus to a control adopted from the main window after a fallback copy', async () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const doc = frame.contentDocument;
    const view = doc?.defaultView;
    if (!doc || !view) throw new Error('auxiliary document missing');
    const button = document.createElement('button');
    doc.body.append(button);
    button.focus();
    expect(doc.activeElement).toBe(button);
    expect(button instanceof view.HTMLElement).toBe(false);
    Object.defineProperty(view.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('denied')) },
    });
    Object.defineProperty(doc, 'execCommand', {
      configurable: true,
      value: () => true,
    });
    try {
      await expect(copyTextToClipboard('adopted reply', doc)).resolves.toBe(
        true,
      );
      expect(doc.activeElement).toBe(button);
    } finally {
      frame.remove();
    }
  });
  it('writes through the owner window clipboard', async () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const doc = frame.contentDocument;
    const view = doc?.defaultView;
    if (!doc || !view) throw new Error('auxiliary document missing');
    const writeText = jest.fn(() => Promise.resolve());
    Object.defineProperty(view.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    try {
      await expect(copyTextToClipboard('aux text', doc)).resolves.toBe(true);
      expect(writeText).toHaveBeenCalledWith('aux text');
    } finally {
      frame.remove();
    }
  });

  it('falls back to the owner document when its clipboard rejects', async () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const doc = frame.contentDocument;
    const view = doc?.defaultView;
    if (!doc || !view) throw new Error('auxiliary document missing');
    Object.defineProperty(view.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('denied')) },
    });
    let copiedFrom: HTMLTextAreaElement | null = null;
    const execCommand = jest.fn((): boolean => {
      const active = doc.activeElement;
      copiedFrom = active instanceof view.HTMLTextAreaElement ? active : null;
      return true;
    });
    Object.defineProperty(doc, 'execCommand', {
      configurable: true,
      value: execCommand,
    });
    const mainExecCommand = jest.fn(() => true);
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: mainExecCommand,
    });
    try {
      await expect(copyTextToClipboard('fallback', doc)).resolves.toBe(true);
      expect(execCommand).toHaveBeenCalledWith('copy');
      expect(mainExecCommand).not.toHaveBeenCalled();
      expect(copiedFrom).not.toBeNull();
      expect(doc.querySelector('textarea')).toBeNull();
    } finally {
      frame.remove();
    }
  });

  it('reports failure when the fallback cannot copy', async () => {
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: () => false,
    });
    await expect(copyTextToClipboard('nope')).resolves.toBe(false);
  });
});
