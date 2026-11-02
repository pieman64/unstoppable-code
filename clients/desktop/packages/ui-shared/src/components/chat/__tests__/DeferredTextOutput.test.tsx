/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { REPLAY_BLOCK_CLASS } from '../../../lib/replay-privacy';
import { ChatLookProvider } from '../../chat-look';
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

  it('names a field-specific body and keeps its text out of replays', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <ChatLookProvider value="classic">
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
            openLabel="View full message"
            loadingLabel="Loading message…"
          />
        </ChatLookProvider>,
      );
    });

    expect(
      container.querySelector('[data-testid="chat-tool-output-open"]')
        ?.textContent,
    ).toBe('View full message');
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'Loading message…',
    );
    expect(
      container
        .querySelector('[data-testid="chat-tool-output-text"]')
        ?.classList.contains(REPLAY_BLOCK_CLASS),
    ).toBe(true);
    act(() => root.unmount());
  });

  it('uses the shared loading spinner inside its status', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <ChatLookProvider value="classic">
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
          />
        </ChatLookProvider>,
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
          <ChatLookProvider value="classic">
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
            />
          </ChatLookProvider>,
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

  it('draws an error result in the error tint', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const render = (tone?: 'default' | 'error'): string | undefined => {
      act(() => {
        root.render(
          <ChatLookProvider value="classic">
            <DeferredTextOutput
              preview="Exit code 1"
              loading={false}
              opened={false}
              hasPrevious={false}
              hasNext={false}
              onOpen={jest.fn()}
              onPrevious={jest.fn()}
              onNext={jest.fn()}
              onRetry={jest.fn()}
              onClose={jest.fn()}
              tone={tone}
            />
          </ChatLookProvider>,
        );
      });
      return container.querySelector('[data-testid="chat-tool-output-text"]')
        ?.className;
    };
    expect(render('error')).toContain('fg-destructive/80');
    expect(render('default')).not.toContain('fg-destructive');
    expect(render()).not.toContain('fg-destructive');
    act(() => root.unmount());
  });

  it('keeps an error result colorless under the clean look', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <ChatLookProvider value="clean">
          <DeferredTextOutput
            preview="Exit code 1"
            loading={false}
            opened={false}
            hasPrevious={false}
            hasNext={false}
            onOpen={jest.fn()}
            onPrevious={jest.fn()}
            onNext={jest.fn()}
            onRetry={jest.fn()}
            onClose={jest.fn()}
            tone="error"
          />
        </ChatLookProvider>,
      );
    });
    expect(
      container.querySelector('[data-testid="chat-tool-output-text"]')
        ?.className,
    ).not.toContain('fg-destructive');
    act(() => root.unmount());
  });
});
