/**
 * @jest-environment jsdom
 *
 * Its own file: the cache and the in-flight promise are module-scoped, and
 * Jest isolates modules per file rather than per test.
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
    await Promise.resolve();
  });
}

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

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  listProviderConnectors = jest.fn();
  Object.defineProperty(window, 'mcpServers', {
    configurable: true,
    value: { listProviderConnectors },
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('a read the user disowned by refreshing', () => {
  it('does not release the ownership slot a newer read now holds', async () => {
    // `refresh()` disowns the outstanding read by nulling the shared slot. If
    // that disowned promise then nulls the slot again when it finally settles,
    // it releases ownership a *newer* read is holding — and the next mount,
    // finding the slot empty, spawns a duplicate concurrent read instead of
    // joining the one already running. Each of those is a Claude CLI
    // invocation that health-checks every configured MCP server.
    //
    // The same interleaving reaches the sibling half of the guard: the
    // disowned read must not stamp its own pre-refresh answer into the cache
    // either. Both are asserted below. An earlier version of this test claimed
    // to cover the cache half and could not fail — it measured a call the
    // refresh replay had already made, never the mount it was about.
    let settleDisowned: (value: unknown) => void = () => undefined;
    listProviderConnectors
      .mockReturnValueOnce(
        new Promise((resolve) => {
          settleDisowned = resolve;
        }),
      )
      .mockReturnValueOnce(new Promise(() => undefined))
      .mockResolvedValue(linked(true));

    act(() => root.render(<Harness />));
    act(() => probe.refresh());

    // A newer read takes the slot while the disowned one is still outstanding.
    const secondContainer = document.createElement('div');
    document.body.appendChild(secondContainer);
    const secondRoot = createRoot(secondContainer);
    act(() => secondRoot.render(<Harness />));
    await flush();
    const callsBeforeSettle = listProviderConnectors.mock.calls.length;

    settleDisowned(linked(false));
    await flush();

    // A third mount must join the read already running, not start another.
    const thirdContainer = document.createElement('div');
    document.body.appendChild(thirdContainer);
    const thirdRoot = createRoot(thirdContainer);
    act(() => thirdRoot.render(<Harness />));
    await flush();

    expect(listProviderConnectors.mock.calls.length).toBe(callsBeforeSettle);
    // And the third mount must not be handed the disowned read's answer. It
    // joins the outstanding newer read instead, so it has no results yet —
    // without the guard the disowned read has written `connected: false` into
    // the cache with a fresh timestamp and the mount is served that.
    expect(probe.results).toBeUndefined();

    act(() => thirdRoot.unmount());
    thirdContainer.remove();
    act(() => secondRoot.unmount());
    secondContainer.remove();
  });
});
