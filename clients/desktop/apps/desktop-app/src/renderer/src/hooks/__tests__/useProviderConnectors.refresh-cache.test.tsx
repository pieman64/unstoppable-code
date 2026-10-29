/**
 * @jest-environment jsdom
 *
 * Its own file: the cache is module-scoped and Jest isolates modules per file,
 * so a neighbouring test's entry would decide this one's outcome.
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useProviderConnectors } from '../useProviderConnectors';

let container: HTMLDivElement;
let root: Root;
let listProviderConnectors: jest.Mock;
let probe: ReturnType<typeof useProviderConnectors>;

function Harness(): null {
  probe = useProviderConnectors();
  return null;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  listProviderConnectors = jest.fn().mockResolvedValue([]);
  Object.defineProperty(window, 'mcpServers', {
    configurable: true,
    value: { listProviderConnectors },
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function linked(connected: boolean): unknown[] {
  return [
    {
      provider: 'claude',
      connectors: [
        {
          name: 'claude.ai Gmail',
          displayName: 'Gmail',
          connected,
          status: connected ? '✔ Connected' : 'Not connected',
        },
      ],
    },
  ];
}

describe('an explicit refresh clears the answer everyone else is sharing', () => {
  it('does not serve a sibling the pre-refresh result while the refresh runs', async () => {
    // `read({ allowCache: false })` bypasses the cache for the instance that
    // refreshed, but the entry is module-scoped and survives. Leaving it means
    // that during the refresh window — the seconds the CLI takes — a picker
    // opened a moment later is handed the pre-link answer instantly, which is
    // the false negative this whole surface exists to remove, arriving by a
    // different route. The sibling mounts before the refresh read settles.
    listProviderConnectors.mockResolvedValueOnce(linked(false));
    act(() => root.render(<Harness />));
    await flush();
    expect(probe.results?.[0]?.connectors[0]?.connected).toBe(false);

    // The user links the account elsewhere, comes back, and hits Re-check.
    let settleRefresh: (value: unknown) => void = () => undefined;
    listProviderConnectors.mockReturnValueOnce(
      new Promise((resolve) => {
        settleRefresh = resolve;
      }),
    );
    act(() => probe.refresh());

    // Sibling opens while that read is still outstanding.
    const siblingContainer = document.createElement('div');
    document.body.appendChild(siblingContainer);
    const siblingRoot = createRoot(siblingContainer);
    act(() => siblingRoot.render(<Harness />));
    await flush();

    // It must be waiting on the new read, not holding the stale "not linked".
    expect(probe.results).toBeUndefined();

    settleRefresh(linked(true));
    await flush();
    expect(probe.results?.[0]?.connectors[0]?.connected).toBe(true);

    act(() => siblingRoot.unmount());
    siblingContainer.remove();
  });
});
