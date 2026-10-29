/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ProviderCarryoverSummary } from '@canopy/desktop-shared/types';
import { useProviderCarryover } from '../useProviderCarryover';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

let latest: ProviderCarryoverSummary | null | undefined;
function Probe({
  provider,
  enabled,
  refreshKey,
}: {
  provider: ProviderCarryoverSummary['provider'];
  enabled: boolean;
  refreshKey?: number;
}): JSX.Element | null {
  latest = useProviderCarryover(provider, enabled, refreshKey);
  return null;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useProviderCarryover', () => {
  let container: HTMLDivElement;
  let root: Root;
  let getProviderCarryover: jest.Mock;
  const originalApi = (window as unknown as Record<string, unknown>).api;

  beforeEach(() => {
    latest = undefined;
    getProviderCarryover = jest.fn();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { getProviderCarryover },
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    if (originalApi === undefined) Reflect.deleteProperty(window, 'api');
    else
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: originalApi,
      });
  });

  it('reads the summary once the provider is connected, and not before', async () => {
    const summary: ProviderCarryoverSummary = {
      provider: 'claude',
      skills: 1,
      commands: 0,
      plugins: 2,
      attention: [],
    };
    getProviderCarryover.mockResolvedValue(summary);
    act(() => {
      root.render(<Probe provider="claude" enabled={false} />);
    });
    await flush();
    expect(getProviderCarryover).not.toHaveBeenCalled();
    expect(latest).toBeNull();
    act(() => {
      root.render(<Probe provider="claude" enabled />);
    });
    await flush();
    expect(getProviderCarryover).toHaveBeenCalledWith('claude');
    expect(latest).toEqual(summary);
  });

  it('shows nothing for a new provider until its own read answers, even while the old read is pending', async () => {
    let answerClaude: (summary: ProviderCarryoverSummary) => void = () => {};
    const codexSummary: ProviderCarryoverSummary = {
      provider: 'codex',
      skills: 2,
      commands: 0,
      plugins: 0,
      attention: [],
    };
    getProviderCarryover.mockImplementation((provider: string) =>
      provider === 'claude'
        ? new Promise<ProviderCarryoverSummary>((resolve) => {
            answerClaude = resolve;
          })
        : Promise.resolve(codexSummary),
    );
    act(() => {
      root.render(<Probe provider="claude" enabled />);
    });
    await flush();
    expect(latest).toBeNull();
    // The panel switches to Codex before Claude's read answers.
    act(() => {
      root.render(<Probe provider="codex" enabled />);
    });
    await flush();
    expect(latest).toEqual(codexSummary);
    // Claude's late answer never stands in for Codex.
    act(() => {
      answerClaude({
        provider: 'claude',
        skills: 9,
        commands: 9,
        plugins: 9,
        attention: [],
      });
    });
    await flush();
    expect(latest).toEqual(codexSummary);
    // Switching back shows nothing until Claude's new read answers.
    getProviderCarryover.mockImplementation(
      () => new Promise<ProviderCarryoverSummary>(() => {}),
    );
    act(() => {
      root.render(<Probe provider="claude" enabled />);
    });
    await flush();
    expect(latest).toBeNull();
  });

  it('reads again when the refresh key changes and reports nothing on failure', async () => {
    getProviderCarryover
      .mockResolvedValueOnce({
        provider: 'codex',
        skills: 0,
        commands: 0,
        plugins: 1,
        attention: [],
      })
      .mockRejectedValueOnce(new Error('offline'));
    act(() => {
      root.render(<Probe provider="codex" enabled refreshKey={1} />);
    });
    await flush();
    expect(latest).toMatchObject({ plugins: 1 });
    act(() => {
      root.render(<Probe provider="codex" enabled refreshKey={2} />);
    });
    await flush();
    expect(getProviderCarryover).toHaveBeenCalledTimes(2);
    expect(latest).toBeNull();
  });
});
