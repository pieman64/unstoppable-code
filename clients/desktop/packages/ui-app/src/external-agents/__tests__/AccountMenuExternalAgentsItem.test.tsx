/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CanopyCapabilities,
  CanopyClient,
  CommandMap,
  CommandName,
  ExternalAgentsClient,
  ExternalAgentsResult,
  QueryMap,
  QueryName,
  Unsubscribe,
} from '@canopy/app-core';
import { CanopyClientProvider } from '@canopy/app-state';
import type {
  ExternalAgentConnectionDetail,
  ExternalAgentPendingAction,
  ExternalAgentsOverview,
} from '@canopy/protocol/external-agents';
import { AccountMenuExternalAgentsItem } from '../AccountMenuExternalAgentsItem';
import {
  EXTERNAL_AGENTS_LABEL,
  EXTERNAL_AGENTS_PATH,
  externalAgentConfirmationPath,
  externalAgentPath,
} from '../paths';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const CAPABILITIES: CanopyCapabilities = {
  localExecution: false,
  terminalPty: false,
  fileSystemAccess: 'read',
  voice: false,
  settingsScope: 'api-keys-only',
  pipelines: 'crud-only',
  routing: 'url',
  overviewNotifications: false,
  externalAgents: true,
};

type WaitingCountResult = ExternalAgentsResult<number>;

interface FakeExternalAgentsClient extends ExternalAgentsClient {
  readonly getWaitingCount: jest.Mock<Promise<WaitingCountResult>, []>;
}

function unavailable<T>(): ExternalAgentsResult<T> {
  return { ok: false, error: 'unavailable' };
}

function fakeExternalAgentsClient(
  getWaitingCount: jest.Mock<Promise<WaitingCountResult>, []>,
): FakeExternalAgentsClient {
  return {
    getOverview: () => Promise.resolve(unavailable<ExternalAgentsOverview>()),
    getConnection: () =>
      Promise.resolve(unavailable<ExternalAgentConnectionDetail>()),
    listDesktops: () => Promise.resolve({ ok: true, value: { desktops: [] } }),
    updateAccess: () =>
      Promise.resolve(unavailable<ExternalAgentConnectionDetail>()),
    pause: () => Promise.resolve(unavailable<ExternalAgentConnectionDetail>()),
    resume: () => Promise.resolve(unavailable<ExternalAgentConnectionDetail>()),
    remove: () => Promise.resolve({ ok: true, value: null }),
    getPendingAction: () =>
      Promise.resolve(unavailable<ExternalAgentPendingAction>()),
    decidePendingAction: () =>
      Promise.resolve(unavailable<ExternalAgentPendingAction>()),
    getWaitingCount,
  };
}

function fakeCanopyClient(
  externalAgents: ExternalAgentsClient | undefined,
  capabilities: CanopyCapabilities = CAPABILITIES,
): CanopyClient {
  return {
    capabilities,
    ...(externalAgents === undefined ? {} : { externalAgents }),
    query<K extends QueryName>(): Promise<QueryMap[K]['result']> {
      return Promise.reject(new Error('unused'));
    },
    command<K extends CommandName>(): Promise<CommandMap[K]['result']> {
      return Promise.reject(new Error('unused'));
    },
    subscribe(): Unsubscribe {
      return (): void => {};
    },
  };
}

function waitingCountMock(
  result: WaitingCountResult = { ok: true, value: 0 },
): jest.Mock<Promise<WaitingCountResult>, []> {
  return jest.fn<Promise<WaitingCountResult>, []>().mockResolvedValue(result);
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = (): void => {};
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe('external agent paths', () => {
  it('encodes connection IDs in detail paths', () => {
    expect(externalAgentPath('agent/one?')).toBe(
      '/account/external-agents/agent%2Fone%3F',
    );
  });

  it('encodes pending action IDs in confirmation paths', () => {
    expect(externalAgentConfirmationPath('pending/one?')).toBe(
      '/account/external-agents/confirm/pending%2Fone%3F',
    );
  });
});

describe('AccountMenuExternalAgentsItem', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.restoreAllMocks();
  });

  async function renderItem(client: CanopyClient): Promise<void> {
    await act(async (): Promise<void> => {
      root.render(
        <CanopyClientProvider client={client}>
          <AccountMenuExternalAgentsItem onOpenPath={jest.fn()} />
        </CanopyClientProvider>,
      );
      await Promise.resolve();
    });
  }

  async function flush(): Promise<void> {
    await act(async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function row(): HTMLElement {
    const found = container.querySelector<HTMLElement>(
      '[data-testid="account-external-agents-row"]',
    );
    if (found === null) throw new Error('Expected the External agents row');
    return found;
  }

  it('renders its label and opens the external agents page', async () => {
    const onOpenPath = jest.fn<void, [string]>();
    const getWaitingCount = waitingCountMock();
    await act(async (): Promise<void> => {
      root.render(
        <CanopyClientProvider
          client={fakeCanopyClient(fakeExternalAgentsClient(getWaitingCount))}
        >
          <AccountMenuExternalAgentsItem onOpenPath={onOpenPath} />
        </CanopyClientProvider>,
      );
      await Promise.resolve();
    });

    expect(row().textContent).toContain(EXTERNAL_AGENTS_LABEL);
    act(() => row().click());
    expect(onOpenPath.mock.calls).toEqual([[EXTERNAL_AGENTS_PATH]]);
  });

  it.each([
    [1, 'External agents (MCP), 1 request waiting'],
    [2, 'External agents (MCP), 2 requests waiting'],
  ] as const)(
    'shows waiting count %s in the accessible name',
    async (count, name) => {
      const getWaitingCount = waitingCountMock({ ok: true, value: count });
      await renderItem(
        fakeCanopyClient(fakeExternalAgentsClient(getWaitingCount)),
      );
      await flush();

      expect(row().getAttribute('aria-label')).toBe(name);
      expect(row().textContent).toContain(String(count));
      expect(getWaitingCount).toHaveBeenCalledTimes(1);
    },
  );

  it('renders before the waiting count resolves', async () => {
    const pending = deferred<WaitingCountResult>();
    const getWaitingCount = jest
      .fn<Promise<WaitingCountResult>, []>()
      .mockReturnValue(pending.promise);
    await renderItem(
      fakeCanopyClient(fakeExternalAgentsClient(getWaitingCount)),
    );

    expect(row().textContent).toContain(EXTERNAL_AGENTS_LABEL);
    expect(row().getAttribute('aria-label')).toBeNull();
    expect(getWaitingCount).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['zero', { ok: true, value: 0 }],
    ['failure', { ok: false, error: 'unavailable' }],
  ] as const)('hides the count after a %s result', async (_label, result) => {
    const getWaitingCount = waitingCountMock(result);
    await renderItem(
      fakeCanopyClient(fakeExternalAgentsClient(getWaitingCount)),
    );
    await flush();

    expect(row().textContent).toContain(EXTERNAL_AGENTS_LABEL);
    expect(row().getAttribute('aria-label')).toBeNull();
  });

  it('refetches on remount and ignores the disposed store result', async () => {
    const first = deferred<WaitingCountResult>();
    const second = deferred<WaitingCountResult>();
    const getWaitingCount = jest
      .fn<Promise<WaitingCountResult>, []>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const client = fakeCanopyClient(fakeExternalAgentsClient(getWaitingCount));
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation((): void => {});

    await renderItem(client);
    expect(getWaitingCount).toHaveBeenCalledTimes(1);
    act(() => root.unmount());

    root = createRoot(container);
    await renderItem(client);
    expect(getWaitingCount).toHaveBeenCalledTimes(2);

    await act(async (): Promise<void> => {
      second.resolve({ ok: true, value: 2 });
      await second.promise;
    });
    await flush();
    expect(row().getAttribute('aria-label')).toBe(
      'External agents (MCP), 2 requests waiting',
    );

    await act(async (): Promise<void> => {
      first.resolve({ ok: true, value: 1 });
      await first.promise;
    });
    await flush();

    expect(row().getAttribute('aria-label')).toBe(
      'External agents (MCP), 2 requests waiting',
    );
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('renders a plain row without the capability or client', async () => {
    const getWaitingCount = waitingCountMock({ ok: true, value: 2 });
    const agents = fakeExternalAgentsClient(getWaitingCount);
    await renderItem(
      fakeCanopyClient(agents, { ...CAPABILITIES, externalAgents: false }),
    );
    expect(row().textContent).toContain(EXTERNAL_AGENTS_LABEL);
    expect(row().getAttribute('aria-label')).toBeNull();
    expect(getWaitingCount).not.toHaveBeenCalled();

    act(() => root.unmount());
    root = createRoot(container);
    await renderItem(fakeCanopyClient(undefined));
    expect(row().textContent).toContain(EXTERNAL_AGENTS_LABEL);
    expect(row().getAttribute('aria-label')).toBeNull();
    expect(getWaitingCount).not.toHaveBeenCalled();
  });
});
