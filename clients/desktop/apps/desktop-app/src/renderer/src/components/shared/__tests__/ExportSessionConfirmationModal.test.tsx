/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ExportSessionConfirmationModal } from '../ExportSessionConfirmationModal';

const mockUseCurrentUiStateReporter = jest.fn();
jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: (...args: unknown[]): void => {
    mockUseCurrentUiStateReporter(...args);
  },
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

describe('ExportSessionConfirmationModal', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mockUseCurrentUiStateReporter.mockClear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('explains the secure snapshot and requires confirmation before export', () => {
    const onConfirm = jest.fn();
    act(() => {
      root.render(
        <ExportSessionConfirmationModal
          onCancel={jest.fn()}
          onConfirm={onConfirm}
        />,
      );
    });

    const modal = document.querySelector(
      '[data-testid="export-session-confirmation-modal"]',
    );
    expect(modal?.textContent).toContain('Secure session snapshot export');
    expect(modal?.textContent).toContain('full, unredacted transcript');
    expect(modal?.textContent).toContain('provider session data');
    expect(modal?.textContent).toContain('working changes');
    expect(modal?.textContent).toContain('another device');
    expect(modal?.textContent).toContain('one-time snapshot');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(mockUseCurrentUiStateReporter).toHaveBeenCalledWith(
      'chat.exportSessionConfirmationModal',
      { open: true },
    );

    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="export-session-confirm"]',
        )
        ?.click();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
