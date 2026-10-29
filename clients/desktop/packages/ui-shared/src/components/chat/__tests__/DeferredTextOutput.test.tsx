/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { DeferredTextOutput } from '../DeferredTextOutput';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

describe('DeferredTextOutput', () => {
  it('is memoized for message-list rendering', () => {
    expect(DeferredTextOutput).toHaveProperty(
      '$$typeof',
      Symbol.for('react.memo'),
    );
  });

  it('uses the shared loading spinner inside its status', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <DeferredTextOutput
          preview="preview"
          loading
          opened={false}
          hasPrevious={false}
          hasNext={false}
          onOpen={jest.fn()}
          onPrevious={jest.fn()}
          onNext={jest.fn()}
          onRetry={jest.fn()}
          onClose={jest.fn()}
        />,
      );
    });

    const status = container.querySelector('[role="status"]');
    expect(
      status?.querySelector('[data-testid="chat-output-loading-spinner"]'),
    ).not.toBeNull();
    act(() => root.unmount());
  });

  it('renders no preview block for an empty preview until the output opens', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const render = (opened: boolean, text?: string): void => {
      act(() => {
        root.render(
          <DeferredTextOutput
            preview=""
            text={text}
            loading={false}
            opened={opened}
            hasPrevious={false}
            hasNext={false}
            onOpen={jest.fn()}
            onPrevious={jest.fn()}
            onNext={jest.fn()}
            onRetry={jest.fn()}
            onClose={jest.fn()}
          />,
        );
      });
    };
    render(false);
    expect(
      container.querySelector('[data-testid="chat-tool-output-text"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="chat-tool-output-open"]'),
    ).not.toBeNull();
    render(true, 'full output');
    expect(
      container.querySelector('[data-testid="chat-tool-output-text"]')
        ?.textContent,
    ).toBe('full output');
    act(() => root.unmount());
  });
});
