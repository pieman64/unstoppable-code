/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});
import { RootErrorBoundary } from '../RootErrorBoundary';

jest.mock('@/lib/renderer-error-logging', () => ({
  reportRendererConsoleError: jest.fn(),
}));

it('keeps crash diagnostics in a selectable region', () => {
  const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
  function CrashedChild(): never {
    throw new Error('Diagnostic message to copy');
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        <RootErrorBoundary>
          <CrashedChild />
        </RootErrorBoundary>,
      ),
    );
    const diagnostic = container.querySelector('[role="alert"]');
    expect(diagnostic?.textContent).toContain('Diagnostic message to copy');
    expect(diagnostic?.closest('[data-selectable]')).not.toBeNull();
  } finally {
    act(() => root.unmount());
    errorLog.mockRestore();
  }
});
