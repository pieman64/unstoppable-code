import type { GitHubPreviewTarget } from '@canopy/protocol/reference-previews';
import type * as CredentialModule from '../lib/github-preview-credential';
import type * as PreviewModule from '../lib/github-reference-preview';

interface CloudIdentity {
  apiKey: string;
  account: { id: string };
  createdAt: string;
}

type AccountRead =
  | { status: 'ok'; entry: CloudIdentity | null }
  | { status: 'unavailable' }
  | { status: 'error'; error: unknown };

const ANY_STRING: unknown = expect.any(String);
const TOKEN = 'ghp_same';

const ACCOUNT: CloudIdentity = {
  apiKey: 'cloud-key',
  account: { id: 'acct' },
  createdAt: '2026-10-13T00:00:00.000Z',
};

const REPO: GitHubPreviewTarget = {
  kind: 'repository',
  owner: 'acme',
  repository: 'widgets',
};

const REPOSITORY = {
  full_name: 'Acme/Widgets',
  html_url: 'https://github.com/Acme/Widgets',
  description: 'Widgets',
  private: false,
  archived: false,
  updated_at: '2026-09-30T08:00:00Z',
};

const DEGRADED_READS: Array<[string, AccountRead]> = [
  ['unavailable', { status: 'unavailable' }],
  ['error', { status: 'error', error: new Error('decrypt failed') }],
];

const flush = (): Promise<void> =>
  new Promise((done) => {
    setImmediate(done);
  });

/**
 * A fresh module registry whose account store starts with a cold cache: the
 * store's peek reports `null` both before its first read and after a real
 * sign-out, so a peek alone never proves an identity.
 */
async function loadPreviewCredential(initial: AccountRead): Promise<{
  credential: typeof CredentialModule;
  preview: typeof PreviewModule;
  execute: jest.Mock;
  setAccountRead: (next: AccountRead) => void;
  emitAccountChange: (entry: CloudIdentity | null) => void;
}> {
  jest.resetModules();
  let accountRead = initial;
  let lastLoadDegraded = false;
  const listeners: Array<(entry: CloudIdentity | null) => void> = [];
  jest.doMock('../lib/canopy-cloud-account-store', () => ({
    ...jest.requireActual<object>('../lib/canopy-cloud-account-store'),
    peekCanopyCloudAccount: (): null => null,
    readCanopyCloudAccountWithStatus: (): Promise<AccountRead> =>
      Promise.resolve(accountRead),
    // Mirrors the real collapse: unavailable and error read as `null`.
    loadCanopyCloudAccount: (): Promise<CloudIdentity | null> => {
      lastLoadDegraded = accountRead.status !== 'ok';
      return Promise.resolve(
        accountRead.status === 'ok' ? accountRead.entry : null,
      );
    },
    isCanopyCloudAccountReadDegraded: (): boolean => lastLoadDegraded,
    subscribeCanopyCloudAccountChanges: (
      listener: (entry: CloudIdentity | null) => void,
    ): (() => void) => {
      listeners.push(listener);
      return (): void => undefined;
    },
  }));
  jest.doMock('../lib/github-auth', () => ({
    ...jest.requireActual<object>('../lib/github-auth'),
    resolveGitHubTokenWithSource: (): Promise<{ token: string }> =>
      Promise.resolve({ token: TOKEN }),
  }));
  const execute = jest.fn(() =>
    Promise.resolve({ data: REPOSITORY, status: 200, headers: {} }),
  );
  jest.doMock('../lib/github-broker', () => ({
    ...jest.requireActual<object>('../lib/github-broker'),
    getGitHubBroker: (): {
      getCredentialGeneration: () => number;
      execute: typeof execute;
    } => ({
      getCredentialGeneration: (): number => 0,
      execute,
    }),
  }));
  const credential = await import('../lib/github-preview-credential');
  const preview = await import('../lib/github-reference-preview');
  return {
    credential,
    preview,
    execute,
    setAccountRead: (next): void => {
      accountRead = next;
    },
    // The store persists, refreshes its cache, then notifies.
    emitAccountChange: (entry): void => {
      accountRead = { status: 'ok', entry };
      for (const listener of listeners) listener(entry ? { ...entry } : null);
    },
  };
}

/** A preview reader whose repository read waits until released. */
function pendingPreviewRead(preview: typeof PreviewModule): {
  read: ReturnType<
    ReturnType<typeof preview.createGitHubReferencePreviewReader>['read']
  >;
  release: () => void;
} {
  let release: () => void = () => undefined;
  const pending = new Promise<unknown>((done) => {
    release = (): void => done(REPOSITORY);
  });
  const github = preview.createGitHubReferencePreviewReader({
    resolveToken: () => Promise.resolve(TOKEN),
    resolveAccountId: () => Promise.resolve('acct-identity'),
    requestItem: () => Promise.reject(new Error('unexpected item read')),
    readPullState: () => Promise.reject(new Error('unexpected pull read')),
    requestRepository: () => pending,
    resolveOriginRepository: () => Promise.resolve(null),
    isCoworkProject: () => false,
    now: () => 1_000,
  });
  return { read: github.read(REPO), release };
}

it('fences sign-out and same-account replacement without disowning a benign refresh', async () => {
  jest.resetModules();
  const account: CloudIdentity = {
    apiKey: 'cloud-key',
    account: { id: 'acct' },
    createdAt: '2026-10-13T00:00:00.000Z',
  };
  let current: CloudIdentity | null = account;
  const listeners: Array<(entry: CloudIdentity | null) => void> = [];
  jest.doMock('../lib/canopy-cloud-account-store', () => ({
    peekCanopyCloudAccount: (): null => null,
    readCanopyCloudAccountWithStatus: (): Promise<AccountRead> =>
      Promise.resolve({ status: 'ok', entry: current }),
    subscribeCanopyCloudAccountChanges: (
      listener: (entry: CloudIdentity | null) => void,
    ): (() => void) => {
      listeners.push(listener);
      return (): void => undefined;
    },
  }));
  jest.doMock('../lib/github-auth', () => ({
    resolveGitHubTokenWithSource: (): Promise<{ token: string }> =>
      Promise.resolve({ token: 'ghp_same' }),
  }));
  const credential = await import('../lib/github-preview-credential');
  const first = await credential.readGitHubPreviewCredential();
  const generation = credential.getCloudAccountIdentityGeneration();
  const notify = listeners[0];
  if (!notify) throw new Error('Account subscriber was not registered');
  notify({ ...account });
  expect(credential.getCloudAccountIdentityGeneration()).toBe(generation);
  current = null;
  notify(null);
  current = { ...account, createdAt: '2026-10-13T01:00:00.000Z' };
  notify(current);
  expect(credential.getCloudAccountIdentityGeneration()).toBe(generation + 2);
  expect((await credential.readGitHubPreviewCredential())?.scope).not.toBe(
    first?.scope,
  );
});

it.each(DEGRADED_READS)(
  'keeps tracking authentication through an %s account read while previews fail closed',
  async (_label, degraded) => {
    const harness = await loadPreviewCredential(degraded);
    const first = await harness.credential.readGitHubTrackingCredential();
    expect(first).toMatchObject({
      token: TOKEN,
      authenticationScope: ANY_STRING,
      scope: undefined,
    });
    expect(await harness.credential.readGitHubPreviewCredential()).toBeNull();
    const generation = harness.credential.getCloudAccountIdentityGeneration();
    harness.setAccountRead({ status: 'ok', entry: ACCOUNT });
    const recovered = await harness.credential.readGitHubTrackingCredential();
    expect(recovered?.authenticationScope).toBe(first?.authenticationScope);
    expect(recovered?.scope).toEqual(ANY_STRING);
    expect(
      (await harness.credential.readGitHubPreviewCredential())?.scope,
    ).toBe(recovered?.scope);
    expect(harness.credential.getCloudAccountIdentityGeneration()).toBe(
      generation,
    );
  },
);

describe('cloud account identity generation', () => {
  it.each(['a credential read', 'an account event'] as const)(
    'adopts the first authoritative identity from %s without disowning a pending preview',
    async (source) => {
      const harness = await loadPreviewCredential({
        status: 'ok',
        entry: ACCOUNT,
      });
      const generation = harness.credential.getCloudAccountIdentityGeneration();
      const pending = pendingPreviewRead(harness.preview);
      await flush();

      // A cold store cache is unknown, not a confirmed sign-out.
      if (source === 'a credential read') {
        expect(
          await harness.credential.readGitHubPreviewCredential(),
        ).toMatchObject({ token: TOKEN });
      } else {
        harness.emitAccountChange({ ...ACCOUNT });
      }
      expect(harness.credential.getCloudAccountIdentityGeneration()).toBe(
        generation,
      );

      pending.release();
      expect(await pending.read).toMatchObject({ status: 'ok' });
    },
  );

  it.each(DEGRADED_READS)(
    'treats an %s account read as unknown: no scope, no generation change, and recovery is silent',
    async (_label, degraded) => {
      const harness = await loadPreviewCredential({
        status: 'ok',
        entry: ACCOUNT,
      });
      const known = await harness.credential.readGitHubPreviewCredential();
      expect(known?.scope).toEqual(ANY_STRING);
      const generation = harness.credential.getCloudAccountIdentityGeneration();
      const pending = pendingPreviewRead(harness.preview);
      await flush();

      harness.setAccountRead(degraded);
      expect(await harness.credential.readGitHubPreviewCredential()).toBeNull();
      expect(await harness.credential.readGitHubPreviewCredential()).toBeNull();
      expect(harness.credential.getCloudAccountIdentityGeneration()).toBe(
        generation,
      );

      pending.release();
      expect(await pending.read).toMatchObject({ status: 'ok' });

      harness.setAccountRead({ status: 'ok', entry: ACCOUNT });
      expect(
        (await harness.credential.readGitHubPreviewCredential())?.scope,
      ).toBe(known?.scope);
      expect(harness.credential.getCloudAccountIdentityGeneration()).toBe(
        generation,
      );
    },
  );

  it('fences a confirmed sign-out and a relogin, and an outage between them changes nothing', async () => {
    const harness = await loadPreviewCredential({
      status: 'ok',
      entry: ACCOUNT,
    });
    const known = await harness.credential.readGitHubPreviewCredential();
    const generation = harness.credential.getCloudAccountIdentityGeneration();
    const pending = pendingPreviewRead(harness.preview);
    await flush();

    harness.emitAccountChange(null);
    expect(harness.credential.getCloudAccountIdentityGeneration()).toBe(
      generation + 1,
    );
    pending.release();
    expect(await pending.read).toEqual({ status: 'disconnected' });
    // Signed out is a verified identity; it may scope local-only reads.
    expect(
      (await harness.credential.readGitHubPreviewCredential())?.scope,
    ).not.toBe(known?.scope);

    harness.setAccountRead({ status: 'unavailable' });
    expect(await harness.credential.readGitHubPreviewCredential()).toBeNull();
    expect(harness.credential.getCloudAccountIdentityGeneration()).toBe(
      generation + 1,
    );

    const relogin = { ...ACCOUNT, createdAt: '2026-10-13T01:00:00.000Z' };
    harness.emitAccountChange(relogin);
    expect(harness.credential.getCloudAccountIdentityGeneration()).toBe(
      generation + 2,
    );
    const after = await harness.credential.readGitHubPreviewCredential();
    expect(after?.scope).toEqual(ANY_STRING);
    expect(after?.scope).not.toBe(known?.scope);
  });

  it('fences a sign-out first seen by an authoritative read', async () => {
    const harness = await loadPreviewCredential({
      status: 'ok',
      entry: ACCOUNT,
    });
    await harness.credential.readGitHubPreviewCredential();
    const generation = harness.credential.getCloudAccountIdentityGeneration();
    harness.setAccountRead({ status: 'ok', entry: null });
    await harness.credential.readGitHubPreviewCredential();
    expect(harness.credential.getCloudAccountIdentityGeneration()).toBe(
      generation + 1,
    );
  });
});

describe('default reference preview reader', () => {
  it.each(DEGRADED_READS)(
    'keeps the displayed preview through an %s account read and recovers the same scope',
    async (_label, degraded) => {
      const harness = await loadPreviewCredential({
        status: 'ok',
        entry: ACCOUNT,
      });
      const github = harness.preview.createGitHubReferencePreviewReader();
      const scope = (await github.readScope()).scope;
      expect(scope).toEqual(ANY_STRING);
      // Poller snapshots and previews must agree on the scope to be reused.
      expect(
        (await harness.credential.readGitHubPreviewCredential())?.scope,
      ).toBe(scope);

      harness.setAccountRead(degraded);
      // A rejected scope read leaves the renderer's saved previews in place;
      // `{ scope: null }` would disown them.
      await expect(github.readScope()).rejects.toThrow();
      expect(await github.read(REPO)).toEqual({ status: 'failed' });
      expect(harness.execute).not.toHaveBeenCalled();

      harness.setAccountRead({ status: 'ok', entry: ACCOUNT });
      expect((await github.readScope()).scope).toBe(scope);
      expect(await github.read(REPO)).toMatchObject({ status: 'ok', scope });
      expect(harness.execute).toHaveBeenCalledTimes(1);
    },
  );

  it('re-scopes a confirmed sign-out instead of treating it as unknown', async () => {
    const harness = await loadPreviewCredential({
      status: 'ok',
      entry: ACCOUNT,
    });
    const github = harness.preview.createGitHubReferencePreviewReader();
    const scope = (await github.readScope()).scope;
    harness.setAccountRead({ status: 'ok', entry: null });
    expect((await github.readScope()).scope).not.toBe(scope);
  });
});
