import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import {
  SettingsOperationError,
  type OrganizationDetail,
  type OrganizationTeamPageData,
  type SettingsPageData,
  type SettingsRoute,
} from '@canopy/protocol/settings';
import {
  createSettingsStore,
  settingsRouteKey,
} from '../create-settings-store';

/**
 * The organization-header cache and hover prefetch (CAN-4558 item C): a tab
 * still loading draws the header from the last detail any tab loaded, and a
 * rail hover reads a page ahead without ever surfacing a failure.
 */

const FEED: SettingsRoute = {
  scope: 'organization',
  organizationId: 'org-1',
  page: 'feed',
};
const MEMBERS: SettingsRoute = {
  scope: 'organization',
  organizationId: 'org-1',
  page: 'members',
};
const FACTS: SettingsRoute = {
  scope: 'organization',
  organizationId: 'org-1',
  page: 'memory',
};

function detail(name: string, members = 0): OrganizationDetail {
  return {
    id: 'org-1',
    name,
    viewerRole: 'OWNER',
    members: Array.from({ length: members }, (_, index) => ({
      id: `member-${index}`,
      name: `Member ${index}`,
      email: `member${index}@example.com`,
      image: null,
      role: 'MEMBER',
      subTeamIds: [],
    })),
    subTeams: [],
    usageStatsMinRole: 'ADMIN',
    canViewUsageStats: true,
    logoUrl: null,
    githubConnection: { connected: false, accountLogin: null },
  };
}

function team(name: string, members = 0): OrganizationTeamPageData {
  return {
    detail: detail(name, members),
    organizations: [],
    viewerEmail: 'ada@example.com',
    billingEnabled: true,
    memoryEnabled: true,
    digestsEnabled: true,
    projectsEnabled: true,
    billingNeedsAttention: false,
    freeAccess: false,
    lapsed: null,
    mobileBrowser: false,
  };
}

function feedPage(name: string, members = 0): SettingsPageData {
  return { kind: 'organization.feed', data: team(name, members) };
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

function controllableClient(): {
  client: AccountOrganizationSettingsClient;
  reads: Array<{ input: unknown; reply: Deferred<unknown> }>;
} {
  const reads: Array<{ input: unknown; reply: Deferred<unknown> }> = [];
  const client: AccountOrganizationSettingsClient = {
    read(_operation, input) {
      const reply = deferred<unknown>();
      reads.push({ input, reply });
      // The test supplies a value of the entry's result type.
      return reply.promise as never;
    },
    write: () => Promise.reject(new Error('unexpected write')),
    subscribe: () => () => undefined,
  };
  return { client, reads };
}

describe('organization detail cache', () => {
  it('keeps the latest detail from every organization tab', async () => {
    const { client, reads } = controllableClient();
    const store = createSettingsStore(client, { accountId: 'account-1' });

    const feed = store.getState().loadPage(FEED);
    reads[0]?.reply.resolve(feedPage('Northwind', 2));
    await feed;
    expect(store.getState().organizationDetails['org-1']?.name).toBe(
      'Northwind',
    );

    const members = store.getState().loadPage(MEMBERS);
    reads[1]?.reply.resolve({
      kind: 'organization.members',
      data: team('Northwind Labs', 3),
    });
    await members;
    expect(store.getState().organizationDetails['org-1']?.members).toHaveLength(
      3,
    );
  });

  it('reads memory pages through their optional team and ignores a fact detail', async () => {
    const { client, reads } = controllableClient();
    const store = createSettingsStore(client, { accountId: 'account-1' });

    const withoutTeam = store.getState().loadPage(FACTS);
    reads[0]?.reply.resolve({
      kind: 'organization.memory.facts',
      data: { enabled: false },
    });
    await withoutTeam;
    expect(store.getState().organizationDetails).toEqual({});

    const fact = store.getState().loadPage({ ...FACTS, factId: 'fact-1' });
    reads[1]?.reply.resolve({
      kind: 'organization.memory.fact',
      data: { enabled: false, team: team('From memory') },
    });
    await fact;
    expect(store.getState().organizationDetails['org-1']?.name).toBe(
      'From memory',
    );
  });

  it('remembers a detail a tab changed', () => {
    const { client } = controllableClient();
    const store = createSettingsStore(client, { accountId: 'account-1' });
    const renamed = detail('Renamed');
    store.getState().rememberOrganizationDetail('org-1', renamed);
    expect(store.getState().organizationDetails['org-1']).toBe(renamed);
  });
});

describe('prefetch', () => {
  it('reads a route once and skips routes with data or a read in flight', async () => {
    const { client, reads } = controllableClient();
    const store = createSettingsStore(client, { accountId: 'account-1' });

    const first = store.getState().prefetch(FEED);
    void store.getState().prefetch(FEED);
    expect(reads).toHaveLength(1);
    reads[0]?.reply.resolve(feedPage('Northwind'));
    await first;

    const entry = store.getState().pages[settingsRouteKey(FEED)];
    expect(entry?.status).toBe('ready');
    expect(entry?.data).toEqual(feedPage('Northwind'));
    expect(store.getState().organizationDetails['org-1']?.name).toBe(
      'Northwind',
    );

    // Data present: neither a prefetch nor a visit reads again.
    await store.getState().prefetch(FEED);
    await store.getState().loadPage(FEED);
    expect(reads).toHaveLength(1);

    // A route already loading is not read a second time.
    void store.getState().loadPage(MEMBERS);
    await store.getState().prefetch(MEMBERS);
    expect(reads).toHaveLength(2);
  });

  it('drops a failure without an error state, and the visit reads again', async () => {
    const { client, reads } = controllableClient();
    const store = createSettingsStore(client, { accountId: 'account-1' });

    const prefetch = store.getState().prefetch(FEED);
    reads[0]?.reply.reject(new SettingsOperationError({ code: 'offline' }));
    await prefetch;
    expect(store.getState().pages[settingsRouteKey(FEED)]).toBeUndefined();

    const visit = store.getState().loadPage(FEED);
    expect(reads).toHaveLength(2);
    reads[1]?.reply.resolve(feedPage('Northwind'));
    await visit;
    expect(store.getState().pages[settingsRouteKey(FEED)]?.status).toBe(
      'ready',
    );
  });

  it('lets a visit reuse a prefetch in flight', async () => {
    const { client, reads } = controllableClient();
    const store = createSettingsStore(client, { accountId: 'account-1' });

    const prefetch = store.getState().prefetch(FEED);
    const visit = store.getState().loadPage(FEED);
    expect(store.getState().pages[settingsRouteKey(FEED)]?.status).toBe(
      'loading',
    );
    expect(reads).toHaveLength(1);
    reads[0]?.reply.resolve(feedPage('Northwind'));
    await Promise.all([prefetch, visit]);

    const entry = store.getState().pages[settingsRouteKey(FEED)];
    expect(entry?.status).toBe('ready');
    // Applied once, by the visit.
    expect(entry?.revision).toBe(1);
  });

  it('drops a prefetch in flight on refresh, so the visit reads again', async () => {
    const { client, reads } = controllableClient();
    const store = createSettingsStore(client, { accountId: 'account-1' });

    const prefetch = store.getState().prefetch(FEED);
    await store.getState().refresh();
    reads[0]?.reply.resolve(feedPage('Before'));
    await prefetch;
    expect(store.getState().pages[settingsRouteKey(FEED)]).toBeUndefined();

    const visit = store.getState().loadPage(FEED);
    expect(reads).toHaveLength(2);
    reads[1]?.reply.resolve(feedPage('After'));
    await visit;
    expect(store.getState().pages[settingsRouteKey(FEED)]?.data).toEqual(
      feedPage('After'),
    );
  });

  it('keeps a visit that adopted a prefetch when another route refreshes', async () => {
    const { client, reads } = controllableClient();
    const store = createSettingsStore(client, { accountId: 'account-1' });

    void store.getState().prefetch(FEED);
    const visit = store.getState().loadPage(FEED);
    const refresh = store.getState().refresh(MEMBERS);
    expect(reads).toHaveLength(2);
    reads[0]?.reply.resolve(feedPage('Northwind'));
    reads[1]?.reply.resolve(feedPage('Northwind'));
    await Promise.all([visit, refresh]);

    expect(store.getState().pages[settingsRouteKey(FEED)]?.status).toBe(
      'ready',
    );
  });

  it('drops a prefetch in flight on evict, so the next visit reads again', async () => {
    const { client, reads } = controllableClient();
    const store = createSettingsStore(client, { accountId: 'account-1' });

    const prefetch = store.getState().prefetch(FEED);
    store.getState().evict(FEED);
    const visit = store.getState().loadPage(FEED);
    expect(reads).toHaveLength(2);
    reads[0]?.reply.resolve(feedPage('Before'));
    reads[1]?.reply.resolve(feedPage('After'));
    await Promise.all([prefetch, visit]);
    expect(store.getState().pages[settingsRouteKey(FEED)]?.data).toEqual(
      feedPage('After'),
    );
  });

  it('drops a landed prefetch nobody visited, but keeps a visited one', async () => {
    const { client, reads } = controllableClient();
    const store = createSettingsStore(client, { accountId: 'account-1' });

    const feed = store.getState().prefetch(FEED);
    const members = store.getState().prefetch(MEMBERS);
    reads[0]?.reply.resolve(feedPage('Before'));
    reads[1]?.reply.resolve(feedPage('Before'));
    await Promise.all([feed, members]);
    // Members is visited; Feed only hovered.
    await store.getState().loadPage(MEMBERS);
    expect(reads).toHaveLength(2);

    // A change elsewhere (a rename, a role change) drops what only a hover read.
    store.getState().dropPrefetches();
    expect(store.getState().pages[settingsRouteKey(FEED)]).toBeUndefined();
    expect(store.getState().pages[settingsRouteKey(MEMBERS)]?.status).toBe(
      'ready',
    );

    const visit = store.getState().loadPage(FEED);
    expect(reads).toHaveLength(3);
    reads[2]?.reply.resolve(feedPage('After'));
    await visit;
    expect(store.getState().pages[settingsRouteKey(FEED)]?.data).toEqual(
      feedPage('After'),
    );
  });

  it('lets a forced reload replace what an adopted prefetch applied after a drop', async () => {
    const { client, reads } = controllableClient();
    const store = createSettingsStore(client, { accountId: 'account-1' });

    const prefetch = store.getState().prefetch(FEED);
    // The visit adopts the prefetch in flight.
    const visit = store.getState().loadPage(FEED);
    expect(reads).toHaveLength(1);
    store.getState().dropPrefetches();
    reads[0]?.reply.resolve(feedPage('Before'));
    await Promise.all([prefetch, visit]);
    // The adopted read still applies; the caller's forced reload replaces it.
    expect(store.getState().pages[settingsRouteKey(FEED)]?.data).toEqual(
      feedPage('Before'),
    );

    const reload = store.getState().loadPage(FEED, { force: true });
    expect(reads).toHaveLength(2);
    reads[1]?.reply.resolve(feedPage('After'));
    await reload;
    expect(store.getState().pages[settingsRouteKey(FEED)]?.data).toEqual(
      feedPage('After'),
    );
  });

  it('keeps a hydrated page that a prefetch filled first', async () => {
    const { client, reads } = controllableClient();
    const store = createSettingsStore(client, { accountId: 'account-1' });

    const feed = store.getState().prefetch(FEED);
    reads[0]?.reply.resolve(feedPage('Before'));
    await feed;
    store.getState().hydratePage(FEED, feedPage('Hydrated'));

    store.getState().dropPrefetches();
    expect(store.getState().pages[settingsRouteKey(FEED)]?.data).toEqual(
      feedPage('Hydrated'),
    );
  });

  it('falls back to its own read when the prefetch it reused fails', async () => {
    const { client, reads } = controllableClient();
    const store = createSettingsStore(client, { accountId: 'account-1' });

    void store.getState().prefetch(FEED);
    const visit = store.getState().loadPage(FEED);
    reads[0]?.reply.reject(new SettingsOperationError({ code: 'offline' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(reads).toHaveLength(2);
    reads[1]?.reply.resolve(feedPage('Northwind'));
    await visit;
    expect(store.getState().pages[settingsRouteKey(FEED)]?.status).toBe(
      'ready',
    );
  });
});

describe('refresh generation', () => {
  it('bumps on every refresh', async () => {
    const { client } = controllableClient();
    const store = createSettingsStore(client, { accountId: 'account-1' });
    expect(store.getState().refreshGeneration).toBe(0);
    await store.getState().refresh();
    expect(store.getState().refreshGeneration).toBe(1);
  });
});
