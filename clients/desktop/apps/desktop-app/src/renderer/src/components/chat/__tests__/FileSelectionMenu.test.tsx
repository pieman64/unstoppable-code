/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FileSelectionMenu } from '../FileSelectionMenu';

describe('FileSelectionMenu', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it('offers terminal-style send/copy actions and opens comments only on request', async () => {
    const onSendToChat = jest.fn();
    const onCopy = jest.fn().mockResolvedValue(true);
    const onComment = jest.fn();
    const onClose = jest.fn();

    act(() => {
      root.render(
        <FileSelectionMenu
          anchorRect={new DOMRect(100, 100, 20, 16)}
          onSendToChat={onSendToChat}
          onCopy={onCopy}
          onComment={onComment}
          onClose={onClose}
        />,
      );
    });

    expect(document.activeElement).toBe(document.body);
    expect(onComment).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('⌘L');
    expect(document.body.textContent).not.toContain('Ctrl+L');

    document
      .querySelector<HTMLButtonElement>(
        '[data-testid="file-selection-send-to-chat"]',
      )
      ?.click();
    expect(onSendToChat).toHaveBeenCalledTimes(1);

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="file-selection-copy"]')
        ?.click();
      await Promise.resolve();
    });
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('Copied');

    document
      .querySelector<HTMLButtonElement>(
        '[data-testid="file-selection-comment"]',
      )
      ?.click();
    expect(onComment).toHaveBeenCalledTimes(1);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
