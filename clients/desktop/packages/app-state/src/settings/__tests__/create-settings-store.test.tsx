/** @jest-environment jsdom */
import { act, StrictMode, useEffect, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AccountOrganizationSettingsClient,
  SettingsSelectionStorage,
} from '@canopy/app-core/settings';
import {
  SettingsOperationError,
  type SettingsBootstrap,
  type SettingsPageData,
  type SettingsRoute,
} from '@canopy/protocol/settings';
import {
  createSettingsStore,
  settingsRouteKey,
} from '../create-settings-store';
import {
  SettingsStoreProvider,
  useOptionalSettingsStore,
  useSettingsStore,
  useSettingsStoreApi,
} from '../settings-store-context';
import { useSettingsBootstrap } from '../use-settings-page';
import { CLIENT_STORE_DISPOSE } from '../../client-store-lifecycle';
import type { SettingsStore } from '../create-settings-store';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const ACCOUNT_ROUTE: SettingsRoute = { scope: 'account', page: 'account' };
const SECURITY_ROUTE: SettingsRoute = { scope: 'account', page: 'security' };

function accountPage(name: string): SettingsPageData {
  return {
    kind: 'account.account',
    data: {
      initialName: name,
      initialImage: null,
      role: 'MEMBER',
      email: 'ada@example.com',
    },
  };
}

function bootstrap(organizations: string[]): SettingsBootstrap {
  return {
    version: 1,
    viewer: { id: 'account-1', email: 'ada@example.com', name: 'Ada' },
    account: {
      billingEnabled: true,
      digestsEnabled: true,
      integrationsEnabled: true,
      freeAccess: false,
    },
    organizations: organizations.map((id) => ({
      id,
      name: id,
      role: 'OWNER',
      isPersonal: false,
    })),
    organization: null,
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A client whose reads resolve when the test says so. */
function controllableClient(): {
  client: AccountOrganizationSettingsClient;
  reads: Array<{ operation: string; input: unknown; reply: Deferred<unknown> }>;
} {
  const reads: Array<{
    operation: string;
    input: unknown;
    reply: Deferred<unknown>;
  }> = [];
  const client: AccountOrganizationSettingsClient = {
    read(operation, input) {
      const reply = deferred<unknown>();
      reads.push({ operation, input, reply });
      // The test supplies a value of the entry's result type.
      return reply.promise as never;
    },
    write: () => Promise.reject(new Error('unexpected write')),
    subscribe: () => () => undefined,
  };
  return { client, reads };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('createSettingsStore', () => {
  it('caches page data per route and keeps data visible while refetching', async () => {
    const { client, reads } = controllableClient();
    const store = createSettingsStore(client, { accountId: 'account-1' });

    const first = store.getState().loadPage(ACCOUNT_ROUTE);
    expect(reads).toHaveLength(1);
    expect(reads[0]?.input).toEqual({ route: ACCOUNT_ROUTE });
    reads[0]?.reply.resolve(accountPage('Ada'));
    await first;

    const key = settingsRouteKey(ACCOUNT_ROUTE);
    expect(store.getState().pages[key]?.status).toBe('ready');

    // A second load of a ready route is served from the cache.
    await store.getState().loadPage(ACCOUNT_ROUTE);
    expect(reads).toHaveLength(1);

    // Another route is its own entry.
    void store.getState().loadPage(SECURITY_ROUTE);
    expect(reads).toHaveLength(2);
    expect(store.getState().pages[key]?.data).toEqual(accountPage('Ada'));

    // A forced refetch keeps the cached data until the new data arrives.
    const refetch = store.getState().loadPage(ACCOUNT_ROUTE, { force: true });
    expect(store.getState().pages[key]?.status).toBe('loading');
    expect(store.getState().pages[key]?.data).toEqual(accountPage('Ada'));
    reads[2]?.reply.resolve(accountPage('Ada Lovelace'));
    await refetch;
    expect(store.getState().pages[key]?.data).toEqual(
      accountPage('Ada Lovelace'),
    );
    expect(store.getState().pages[key]?.revision).toBe(2);
  });

  it('hydrates server-rendered data without fetching', async () => {
    const { client, reads } = controllableClient();
    const store = createSettingsStore(client, { accountId: 'account-1' });
    store.getState().hydratePage(ACCOUNT_ROUTE, accountPage('Ada'));
    await store.getState().loadPage(ACCOUNT_ROUTE);
    expect(reads).toHaveLength(0);
    expect(
      store.getState().pages[settingsRouteKey(ACCOUNT_ROUTE)]?.data,
    ).toEqual(accountPage('Ada'));
  });

  it('drops a slower superseded response', async () => {
    const { client, reads } = controllableClient();
    const store = createSettingsStore(client, { accountId: 'account-1' });
    const slow = store.getState().loadPage(ACCOUNT_ROUTE);
    const fast = store.getState().loadPage(ACCOUNT_ROUTE, { force: true });
    reads[1]?.reply.resolve(accountPage('New'));
    await fast;
    reads[0]?.reply.resolve(accountPage('Old'));
    await slow;
    expect(
      store.getState().pages[settingsRouteKey(ACCOUNT_ROUTE)]?.data,
    ).toEqual(accountPage('New'));
  });

  it('removes protected content when access is lost', async () => {
    const { client, reads } = controllableClient();
    const store = createSettingsStore(client, { accountId: 'account-1' });
    const load = store.getState().loadPage(ACCOUNT_ROUTE);
    reads[0]?.reply.resolve(accountPage('Ada'));
    await load;
    const refetch = store.getState().loadPage(ACCOUNT_ROUTE, { force: true });
    reads[1]?.reply.reject(
      new SettingsOperationError({ code: 'forbidden', status: 403 }),
    );
    await refetch;
    const entry = store.getState().pages[settingsRouteKey(ACCOUNT_ROUTE)];
    expect(entry?.status).toBe('error');
    expect(entry?.error?.code).toBe('forbidden');
    expect(entry?.data).toBeNull();
  });

  it('keeps cached data visible through an offline refetch', async () => {
    const { client, reads } = controllableClient();
    const store = createSettingsStore(client, { accountId: 'account-1' });
    const load = store.getState().loadPage(ACCOUNT_ROUTE);
    reads[0]?.reply.resolve(accountPage('Ada'));
    await load;
    const refetch = store.getState().loadPage(ACCOUNT_ROUTE, { force: true });
    reads[1]?.reply.reject(new SettingsOperationError({ code: 'offline' }));
    await refetch;
    const entry = store.getState().pages[settingsRouteKey(ACCOUNT_ROUTE)];
    expect(entry?.error?.code).toBe('offline');
    expect(entry?.data).toEqual(accountPage('Ada'));
  });

  it('ignores responses that arrive after disposal', async () => {
    const { client, reads } = controllableClient();
    const store = createSettingsStore(client, { accountId: 'account-1' });
    const load = store.getState().loadPage(ACCOUNT_ROUTE);
    store[CLIENT_STORE_DISPOSE]?.();
    reads[0]?.reply.resolve(accountPage('Ada'));
    await load;
    expect(
      store.getState().pages[settingsRouteKey(ACCOUNT_ROUTE)]?.status,
    ).toBe('loading');
  });

  it('restores a persisted organization only while membership lists it', () => {
    const values = new Map<string, string | null>([['account-1', 'org-b']]);
    const storage: SettingsSelectionStorage = {
      readOrganizationId: (accountId) => values.get(accountId) ?? null,
      writeOrganizationId: (accountId, id) => {
        values.set(accountId, id);
      },
    };
    const { client } = controllableClient();
    const store = createSettingsStore(client, {
      accountId: 'account-1',
      storage,
    });
    expect(
      store.getState().restoreOrganization(bootstrap(['org-a', 'org-b'])),
    ).toBe('org-b');
    expect(
      store.getState().restoreOrganization(bootstrap(['org-a'])),
    ).toBeNull();
    // The stale value was cleared, never used for another account.
    expect(values.get('account-1')).toBeNull();

    store.getState().selectOrganization('org-a');
    expect(values.get('account-1')).toBe('org-a');
    expect(values.has('account-2')).toBe(false);
  });

  it('loads the bootstrap per requested organization', () => {
    const { client, reads } = controllableClient();
    const store = createSettingsStore(client, { accountId: 'account-1' });
    void store.getState().loadBootstrap(null);
    void store.getState().loadBootstrap('org-a');
    expect(reads.map((read) => read.input)).toEqual([
      {},
      { organizationId: 'org-a' },
    ]);
  });
});

describe('initial bootstraps', () => {
  it('shows earlier bootstraps at once, then reads and replaces them in one step', async () => {
    const { client, reads } = controllableClient();
    const earlier = bootstrap(['org-a']);
    const store = createSettingsStore(client, {
      accountId: 'account-1',
      initialBootstraps: { '': earlier },
    });
    expect(store.getState().bootstraps['']).toEqual({
      status: 'idle',
      data: earlier,
      error: null,
    });

    const load = store.getState().loadBootstrap(null);
    expect(reads).toHaveLength(1);
    // The earlier data stays on screen while the read is in flight.
    expect(store.getState().bootstraps['']?.data).toBe(earlier);
    const fresh = bootstrap(['org-b']);
    reads[0]?.reply.resolve(fresh);
    await load;
    expect(store.getState().bootstraps['']).toEqual({
      status: 'ready',
      data: fresh,
      error: null,
    });
  });

  it('ignores earlier bootstraps when signed out', () => {
    const { client } = controllableClient();
    const store = createSettingsStore(client, {
      accountId: null,
      initialBootstraps: { '': bootstrap([]) },
    });
    expect(store.getState().bootstraps).toEqual({});
  });

  it('refreshes only the bootstraps this session requested', () => {
    const { client, reads } = controllableClient();
    const store = createSettingsStore(client, {
      accountId: 'account-1',
      initialBootstraps: { '': bootstrap([]), 'org-a': bootstrap(['org-a']) },
    });
    void store.getState().loadBootstrap(null);
    expect(reads).toHaveLength(1);
    void store.getState().refresh();
    expect(reads.map((read) => read.input)).toEqual([{}, {}]);
  });
});

describe('initial route', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('browses an organization route from creation', () => {
    const { client, reads } = controllableClient();
    const values = new Map<string, string | null>();
    const storage: SettingsSelectionStorage = {
      readOrganizationId: (accountId) => values.get(accountId) ?? null,
      writeOrganizationId: (accountId, organizationId) => {
        values.set(accountId, organizationId);
      },
    };
    const store = createSettingsStore(client, {
      accountId: 'account-1',
      storage,
      initialRoute: {
        scope: 'organization',
        organizationId: 'org-a',
        page: 'members',
      },
    });
    expect(store.getState().selectedOrganizationId).toBe('org-a');
    expect(values.get('account-1')).toBe('org-a');
    // Selecting is not fetching: the rail requests the bootstrap.
    expect(reads).toEqual([]);
  });

  it('browses nothing for other routes or when signed out', () => {
    const { client } = controllableClient();
    expect(
      createSettingsStore(client, {
        accountId: 'account-1',
        initialRoute: ACCOUNT_ROUTE,
      }).getState().selectedOrganizationId,
    ).toBeNull();
    expect(
      createSettingsStore(client, {
        accountId: null,
        initialRoute: {
          scope: 'organization',
          organizationId: 'org-a',
          page: 'feed',
        },
      }).getState().selectedOrganizationId,
    ).toBeNull();
  });

  it('starts exactly one organization bootstrap read on the first render', async () => {
    const { client, reads } = controllableClient();
    // The desktop rail: the browsed organization's bootstrap, plus the sync
    // that browses the route's organization (a no-op once it is browsed).
    function Rail(): null {
      const store = useSettingsStoreApi();
      const browsed = useSettingsStore((state) => state.selectedOrganizationId);
      useSettingsBootstrap(browsed);
      useEffect(() => {
        if (store.getState().selectedOrganizationId !== 'org-a')
          store.getState().selectOrganization('org-a');
      }, [store]);
      return null;
    }
    act(() => {
      root.render(
        <StrictMode>
          <SettingsStoreProvider
            client={client}
            accountId="account-1"
            initialRoute={{
              scope: 'organization',
              organizationId: 'org-a',
              page: 'feed',
            }}
          >
            <Rail />
          </SettingsStoreProvider>
        </StrictMode>,
      );
    });
    await flush();
    expect(reads.map((read) => read.input)).toEqual([
      { organizationId: 'org-a' },
    ]);
  });
});

describe('invite seat-charge cache', () => {
  it('remembers a check per organization and forgets one on request', () => {
    const { client } = controllableClient();
    const store = createSettingsStore(client, { accountId: 'account-1' });
    store.getState().rememberSeatCharge('org-a', 'handoff');
    store.getState().rememberSeatCharge('org-b', 'inline');
    expect(store.getState().seatCharges).toEqual({
      'org-a': 'handoff',
      'org-b': 'inline',
    });
    store.getState().forgetSeatCharge('org-a');
    expect(store.getState().seatCharges).toEqual({ 'org-b': 'inline' });
  });

  it('clears every check on refresh', async () => {
    const { client } = controllableClient();
    const store = createSettingsStore(client, { accountId: 'account-1' });
    store.getState().rememberSeatCharge('org-a', 'inline');
    await store.getState().refresh();
    expect(store.getState().seatCharges).toEqual({});
  });

  it('ignores writes after disposal', () => {
    const { client } = controllableClient();
    const store = createSettingsStore(client, { accountId: 'account-1' });
    store[CLIENT_STORE_DISPOSE]?.();
    store.getState().rememberSeatCharge('org-a', 'inline');
    expect(store.getState().seatCharges).toEqual({});
  });
});

describe('useOptionalSettingsStore', () => {
  let container: HTMLDivElement;
  let root: Root;
  let seen: Array<string | undefined> = [];

  function Probe(): JSX.Element {
    seen.push(useOptionalSettingsStore((state) => state.seatCharges['org-a']));
    return <span />;
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    seen = [];
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('reads undefined outside a provider', () => {
    act(() => root.render(<Probe />));
    expect(seen.at(-1)).toBeUndefined();
  });

  it('follows the store inside a provider', () => {
    const { client } = controllableClient();
    let store: SettingsStore | null = null;
    function Capture(): null {
      store = useSettingsStoreApi();
      return null;
    }
    act(() =>
      root.render(
        <SettingsStoreProvider client={client} accountId="account-1">
          <Capture />
          <Probe />
        </SettingsStoreProvider>,
      ),
    );
    expect(seen.at(-1)).toBeUndefined();
    act(() => store?.getState().rememberSeatCharge('org-a', 'handoff'));
    expect(seen.at(-1)).toBe('handoff');
  });
});

describe('SettingsStoreProvider', () => {
  let container: HTMLDivElement;
  let root: Root;
  const seen: SettingsStore[] = [];

  function Capture(): JSX.Element {
    seen.push(useSettingsStoreApi());
    return <span />;
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    seen.length = 0;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('survives StrictMode remounts and disposes a replaced store', async () => {
    const { client, reads } = controllableClient();
    act(() => {
      root.render(
        <StrictMode>
          <SettingsStoreProvider client={client} accountId="account-1">
            <Capture />
          </SettingsStoreProvider>
        </StrictMode>,
      );
    });
    await flush();
    const first = seen[seen.length - 1];
    if (first === undefined) throw new Error('no store');

    // The committed store still applies responses after StrictMode's
    // setup → cleanup → setup.
    const load = first.getState().loadPage(ACCOUNT_ROUTE);
    reads[0]?.reply.resolve(accountPage('Ada'));
    await load;
    expect(
      first.getState().pages[settingsRouteKey(ACCOUNT_ROUTE)]?.status,
    ).toBe('ready');

    // A different account gets a fresh store; the old one is disposed.
    act(() => {
      root.render(
        <StrictMode>
          <SettingsStoreProvider client={client} accountId="account-2">
            <Capture />
          </SettingsStoreProvider>
        </StrictMode>,
      );
    });
    await flush();
    const second = seen[seen.length - 1];
    expect(second).not.toBe(first);
    expect(second?.getState().accountId).toBe('account-2');

    const late = first.getState().loadPage(SECURITY_ROUTE);
    expect(reads).toHaveLength(1);
    await late;
  });
});
