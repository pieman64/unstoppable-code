/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { focusViaKeyboard } from '@/test-utils/dom';

const mockCopy = jest.fn();
let mockCopied = false;
jest.mock('@/hooks/useClipboardCopy', () => ({
  useClipboardCopy: (): { copied: boolean; copy: jest.Mock } => ({
    copied: mockCopied,
    copy: mockCopy,
  }),
}));

import { MessageCopyButton } from '../MessageCopyButton';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('MessageCopyButton', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mockCopied = false;
    mockCopy.mockReset();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
  });

  it('copies the message text on click', () => {
    act(() => {
      root.render(
        <MessageCopyButton getText={(): string => 'hello'} className="x" />,
      );
    });
    act(() => {
      host.querySelector('button')?.click();
    });
    expect(mockCopy).toHaveBeenCalledWith('hello');
  });

  it('explains the action with a rich tooltip instead of a native title (CAN-2799)', () => {
    act(() => {
      root.render(
        <MessageCopyButton getText={(): string => 'hello'} className="x" />,
      );
    });
    const button = host.querySelector<HTMLButtonElement>('button');
    expect(button?.getAttribute('aria-label')).toBe('Copy to clipboard');
    expect(button?.hasAttribute('title')).toBe(false);
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    act(() => {
      focusViaKeyboard(button);
    });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Copy to clipboard',
    );

    // The label flips in place once the copy lands.
    mockCopied = true;
    act(() => {
      root.render(
        <MessageCopyButton getText={(): string => 'hello'} className="x" />,
      );
    });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Copied',
    );
  });
});
