/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { TranscriptPagingControls } from '../TranscriptPagingControls';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

describe('TranscriptPagingControls', () => {
  it('uses the shared loading spinner inside its status', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <TranscriptPagingControls
          loading
          error={null}
          hasEarlier={false}
          onLoadEarlier={jest.fn()}
          onReload={jest.fn()}
        />,
      );
    });

    const status = container.querySelector('[role="status"]');
    expect(
      status?.querySelector('[data-testid="chat-transcript-loading-spinner"]'),
    ).not.toBeNull();
    act(() => root.unmount());
  });

  it('loads the initial transcript automatically without a button', () => {
    const root = createRoot(document.createElement('div'));
    const onReload = jest.fn();
    act(() =>
      root.render(
        <TranscriptPagingControls
          loading={false}
          error={null}
          hasEarlier={false}
          needsLoad
          onReload={onReload}
          onLoadEarlier={jest.fn()}
        />,
      ),
    );
    expect(onReload).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it('loads a visible gap once and observes the actual transcript scrollport', () => {
    const container = document.createElement('div');
    container.dataset.testid = 'chat-message-list-scroll';
    const root = createRoot(container);
    let intersect: (entries: Partial<IntersectionObserverEntry>[]) => void =
      jest.fn();
    const observe = jest.fn();
    const disconnect = jest.fn();
    const Observer = jest
      .fn()
      .mockImplementation((callback: typeof intersect) => {
        intersect = callback;
        return { observe, disconnect };
      });
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: Observer,
    });
    const load = jest.fn();
    act(() =>
      root.render(
        <TranscriptPagingControls
          loading={false}
          error={null}
          hasEarlier
          onReload={jest.fn()}
          onLoadEarlier={load}
        />,
      ),
    );
    expect(container.querySelector('button')).toBeNull();
    expect(Observer).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ root: container }),
    );
    act(() => {
      intersect([{ isIntersecting: true }]);
      intersect([{ isIntersecting: true }]);
    });
    expect(load).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('retries the failed page operation without replacing older messages', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const onLoadEarlier = jest.fn();
    const onReload = jest.fn();
    act(() => {
      root.render(
        <TranscriptPagingControls
          loading={false}
          error="Couldn't load messages."
          hasEarlier
          needsLoad={false}
          onLoadEarlier={onLoadEarlier}
          onReload={onReload}
        />,
      );
    });
    const retry = container.querySelector(
      '[data-testid="chat-transcript-retry"]',
    );
    if (!(retry instanceof HTMLButtonElement))
      throw new Error('Missing transcript retry button');
    act(() => retry.click());
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
    expect(onReload).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
