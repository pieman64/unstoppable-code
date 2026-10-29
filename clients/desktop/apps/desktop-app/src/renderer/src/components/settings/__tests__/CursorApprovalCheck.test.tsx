/** @jest-environment jsdom */
jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: (): void => {},
}));

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CursorApprovalCheck } from '../CursorApprovalCheck';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('CursorApprovalCheck', () => {
  let container: HTMLDivElement;
  let root: Root;
  let previousApi: PropertyDescriptor | undefined;

  beforeEach(() => {
    previousApi = Object.getOwnPropertyDescriptor(window, 'api');
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadPreferences: jest
          .fn()
          .mockResolvedValue({ cursorAgentPath: '/Users/alice/cursor-agent' }),
        cursorApprovalCheck: {
          available: jest.fn().mockResolvedValue(true),
          run: jest.fn().mockResolvedValue({
            outcome: 'error',
            filePath: '/Users/alice/tmp/check.txt',
            message: 'Cursor CLI failed in /Users/alice/tmp',
            hookObserved: false,
            processExited: true,
          }),
          cancel: jest.fn().mockResolvedValue(undefined),
        },
        approvals: {
          onRequest: (): (() => void) => (): void => undefined,
          onCancelled: (): (() => void) => (): void => undefined,
        },
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    if (previousApi) Object.defineProperty(window, 'api', previousApi);
    else Reflect.deleteProperty(window, 'api');
  });

  it('shows the checked file path and the CLI error text', async () => {
    await act(async () => {
      root.render(<CursorApprovalCheck />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const run = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Test Cursor approvals',
    );
    if (!run) throw new Error('Run button not rendered');
    await act(async () => {
      run.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const path = container.querySelector('[data-testid="cursor-check-path"]');
    expect(path?.textContent).toBe('/Users/alice/tmp/check.txt');
    const status = container.querySelector(
      '[data-testid="cursor-check-status"]',
    );
    expect(status?.textContent).toBe('Cursor CLI failed in /Users/alice/tmp');
  });
});
