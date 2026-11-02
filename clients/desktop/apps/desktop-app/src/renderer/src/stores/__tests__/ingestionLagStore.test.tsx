/** @jest-environment jsdom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatIngestionLag } from '@canopy/desktop-shared/types';
import { chatBannerKey, type ChatBannerTarget } from '../aiCreditsBannerStore';
import {
  INGESTION_LAG_STALE_AFTER_MS,
  useCatchingUpLag,
  useIngestionLagStore,
  visibleCatchingUpLag,
} from '../ingestionLagStore';

const TARGET: ChatBannerTarget = {
  projectId: 'p',
  worktreeId: 'w',
  chatId: 'c',
};

function sample(overrides: Partial<ChatIngestionLag> = {}): ChatIngestionLag {
  return {
    lagMs: 1200,
    source: 'provider',
    sampledAtMs: Date.now(),
    catchingUp: true,
    ...overrides,
  };
}

function LagHarness({
  target,
}: {
  target: ChatBannerTarget | null;
}): React.ReactNode {
  const lag = useCatchingUpLag(target);
  return createElement('output', null, lag ? String(lag.lagMs) : 'none');
}

describe('ingestionLagStore', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useIngestionLagStore.setState({ lagByChat: {} });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('shows a catching-up sample and replaces it with a later sample', () => {
    act(() => {
      useIngestionLagStore.getState().setLag(TARGET, sample());
      root.render(createElement(LagHarness, { target: TARGET }));
    });
    expect(container.textContent).toBe('1200');

    act(() => {
      useIngestionLagStore.getState().setLag(TARGET, sample({ lagMs: 2400 }));
    });
    expect(container.textContent).toBe('2400');

    act(() => useIngestionLagStore.getState().setLag(TARGET, null));
    expect(container.textContent).toBe('none');
  });

  it('does not show a sample that is not catching up', () => {
    act(() => {
      useIngestionLagStore
        .getState()
        .setLag(TARGET, sample({ catchingUp: false }));
      root.render(createElement(LagHarness, { target: TARGET }));
    });

    expect(container.textContent).toBe('none');
  });

  it('hides a sample at its staleness deadline without another store event', () => {
    jest.useFakeTimers();
    let nowMs = 1000;
    jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    act(() => {
      useIngestionLagStore.getState().setLag(TARGET, sample());
      root.render(createElement(LagHarness, { target: TARGET }));
    });
    expect(container.textContent).toBe('1200');

    nowMs = 1000 + INGESTION_LAG_STALE_AFTER_MS + 1;
    act(() => {
      jest.advanceTimersByTime(INGESTION_LAG_STALE_AFTER_MS + 1);
    });
    expect(container.textContent).toBe('none');
  });

  it('keeps a sample visible at exactly the staleness limit', () => {
    const lag = sample();

    expect(
      visibleCatchingUpLag(lag, lag.sampledAtMs + INGESTION_LAG_STALE_AFTER_MS),
    ).toBe(lag);
  });

  it('removes only the exact project and worktree scope', () => {
    const targets: ChatBannerTarget[] = [
      { projectId: 'p', worktreeId: 'w', chatId: 'one' },
      { projectId: 'p', worktreeId: 'w2', chatId: 'two' },
      { projectId: 'p2', worktreeId: 'w', chatId: 'three' },
    ];
    for (const target of targets) {
      useIngestionLagStore.getState().setLag(target, sample());
    }

    useIngestionLagStore.getState().clearForScope('p', 'w');

    const entries = useIngestionLagStore.getState().lagByChat;
    expect(entries[chatBannerKey(targets[0] ?? TARGET)]).toBeUndefined();
    expect(entries[chatBannerKey(targets[1] ?? TARGET)]).toBeDefined();
    expect(entries[chatBannerKey(targets[2] ?? TARGET)]).toBeDefined();
  });

  it('clears one chat and leaves other chats intact', () => {
    const first: ChatBannerTarget = { ...TARGET, chatId: 'first' };
    const second: ChatBannerTarget = { ...TARGET, chatId: 'second' };
    useIngestionLagStore.getState().setLag(first, sample());
    useIngestionLagStore.getState().setLag(second, sample());

    useIngestionLagStore.getState().clearForChat(first);

    const entries = useIngestionLagStore.getState().lagByChat;
    expect(entries[chatBannerKey(first)]).toBeUndefined();
    expect(entries[chatBannerKey(second)]).toBeDefined();
  });

  it('returns the same state for no-op updates and a null target returns null', () => {
    const initialState = useIngestionLagStore.getState();
    useIngestionLagStore.getState().setLag(TARGET, null);
    useIngestionLagStore.getState().clearForChat(TARGET);
    expect(useIngestionLagStore.getState()).toBe(initialState);

    const currentLag = sample();
    useIngestionLagStore.getState().setLag(TARGET, currentLag);
    const stateWithLag = useIngestionLagStore.getState();
    useIngestionLagStore.getState().setLag(TARGET, { ...currentLag });
    useIngestionLagStore
      .getState()
      .clearForScope('other-project', 'other-worktree');
    expect(useIngestionLagStore.getState()).toBe(stateWithLag);

    act(() => root.render(createElement(LagHarness, { target: null })));
    expect(container.textContent).toBe('none');
  });

  it('renders with renderToStaticMarkup without relying on effects', () => {
    expect(
      renderToStaticMarkup(createElement(LagHarness, { target: TARGET })),
    ).toBe('<output>none</output>');
  });
});
