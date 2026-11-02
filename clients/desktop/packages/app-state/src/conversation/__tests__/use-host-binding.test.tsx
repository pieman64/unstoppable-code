/** @jest-environment jsdom */

import { StrictMode, act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import type {
  ConversationPresentation,
  ConversationPresentationSource,
} from '@canopy/app-core/conversation';
import { useConversationHostBinding } from '../use-host-binding';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function snapshot(status: 'closed' | 'ready'): ConversationPresentation {
  return {
    hostStatus: status,
    binding: null,
    sessionStatus: 'UNKNOWN',
    transcript: [],
    activeExecution: null,
  };
}

interface FakeResource {
  readonly resource: ConversationPresentationSource;
  readonly open: jest.Mock<Promise<void>, []>;
  readonly close: jest.Mock<void, []>;
  readonly listeners: Set<() => void>;
}

function fakeResource(): FakeResource {
  const listeners = new Set<() => void>();
  let current = snapshot('closed');
  const open = jest.fn(() => {
    current = snapshot('ready');
    listeners.forEach((listener) => listener());
    return Promise.resolve();
  });
  const close = jest.fn(() => {
    current = snapshot('closed');
    listeners.forEach((listener) => listener());
  });
  const resource: ConversationPresentationSource = {
    open,
    close,
    getSnapshot: () => current,
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { resource, open, close, listeners };
}

function Probe({
  resource,
  onOpenError,
}: {
  readonly resource: ConversationPresentationSource;
  readonly onOpenError?: (error: unknown) => void;
}): JSX.Element {
  const view = useConversationHostBinding(resource, { onOpenError });
  return <div data-status={view.hostStatus} />;
}

describe('useConversationHostBinding', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test('survives Strict Mode remount and releases subscriptions on unmount', async () => {
    const fake = fakeResource();

    await act(async () => {
      root.render(
        <StrictMode>
          <Probe resource={fake.resource} />
        </StrictMode>,
      );
      await Promise.resolve();
    });

    expect(fake.open).toHaveBeenCalledTimes(2);
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(fake.listeners.size).toBe(1);
    expect(container.firstElementChild?.getAttribute('data-status')).toBe(
      'ready',
    );

    act(() => root.unmount());
    expect(fake.close).toHaveBeenCalledTimes(2);
    expect(fake.listeners.size).toBe(0);
  });

  test('does not open a resource during a render that never commits', () => {
    const fake = fakeResource();

    expect(renderToString(<Probe resource={fake.resource} />)).toContain(
      'data-status="closed"',
    );
    expect(fake.open).not.toHaveBeenCalled();
    expect(fake.listeners.size).toBe(0);
  });

  test('closes the old resource before opening a replacement', async () => {
    const first = fakeResource();
    const second = fakeResource();
    await act(async () => {
      root.render(<Probe resource={first.resource} />);
      await Promise.resolve();
    });

    await act(async () => {
      root.render(<Probe resource={second.resource} />);
      await Promise.resolve();
    });

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(first.listeners.size).toBe(0);
    expect(second.open).toHaveBeenCalledTimes(1);
    expect(second.listeners.size).toBe(1);
  });

  test('does not reopen when the error callback identity changes', async () => {
    const fake = fakeResource();
    await act(async () => {
      root.render(
        <Probe resource={fake.resource} onOpenError={() => undefined} />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      root.render(
        <Probe resource={fake.resource} onOpenError={() => undefined} />,
      );
      await Promise.resolve();
    });

    expect(fake.open).toHaveBeenCalledTimes(1);
    expect(fake.close).not.toHaveBeenCalled();
  });
});
