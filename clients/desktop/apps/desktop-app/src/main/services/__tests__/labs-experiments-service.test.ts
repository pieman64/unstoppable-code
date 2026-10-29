/* eslint-disable @typescript-eslint/unbound-method -- Injected functions are closure based test doubles. */
import {
  LabsExperimentsService,
  type LabsExperimentsDependencies,
  type LabsAccountSession,
} from '../labs-experiments-service';
import {
  LABS_EXPERIMENTS,
  labsExperimentsSnapshotSchema,
  type LabsExperiment,
  type LabsExperimentsSnapshot,
} from '@canopy/desktop-shared/lib/labs-experiments';
import {
  getDefaultFeatureFlagSnapshot,
  CLIENT_FEATURE_FLAGS,
  type FeatureFlagDefaultMode,
} from '@canopy/protocol/feature-flags';
import type { LabsAvailabilityState } from '../../feature-flags/labs-availability';
import {
  labsContextIdentity,
  resolveLabsAvailability,
} from '../../feature-flags/labs-availability';
import {
  EXTRACTED_EARLY_ACCESS_EXPERIMENT_IDS,
  type LabsExperimentAvailability,
} from '@canopy/protocol/experiments';
const key = CLIENT_FEATURE_FLAGS.canopyDesktopLabsEarlyAccess.key;
const local: LabsAccountSession = {
  scope: 'local',
  signedIn: false,
  ready: true,
};
const account: LabsAccountSession = {
  scope: 'server/account-a',
  signedIn: true,
  ready: true,
};
function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function harness(
  cache: unknown = null,
  session = local,
  overrides: Partial<LabsExperimentsDependencies> = {},
): {
  service: LabsExperimentsService;
  deps: LabsExperimentsDependencies;
  files: Map<string, string>;
  page: LabsExperiment;
  setState(next: LabsAvailabilityState): void;
  live(value: unknown, context?: string): void;
} {
  let state: LabsAvailabilityState = {
    snapshot: getDefaultFeatureFlagSnapshot('not_configured'),
    contextIdentity: null,
    liveValues: {},
  };
  const page: LabsExperiment = {
    id: 'plugins-preview',
    name: 'Plugins',
    description: 'Preview.',
    pages: ['plugins'],
    sidebarKeys: ['plugins'],
    flagKey: 'fixture-plugins',
    requiresEarlyAccess: true,
    fixtureAvailability: 'offered',
  };
  const files = new Map<string, string>();
  const deps: LabsExperimentsDependencies = {
    choicesPath: 'choices',
    availabilityPath: 'availability',
    read: (path) => (path === 'choices' ? cache : null),
    write: jest.fn((path, data): Promise<void> => {
      files.set(path, data);
      return Promise.resolve();
    }),
    availability: () => state,
    fetchChoices: jest.fn(
      (): Promise<unknown> => Promise.resolve({ choices: {} }),
    ),
    putChoice: jest.fn(
      (_session, request): Promise<unknown> =>
        Promise.resolve({
          ...request,
          updatedAt: new Date().toISOString(),
        }),
    ),
    diagnostic: jest.fn(),
    mirror: jest.fn(),
    ...overrides,
  };
  const service = new LabsExperimentsService(deps, session, [
    ...LABS_EXPERIMENTS,
    page,
  ]);
  return {
    service,
    deps,
    files,
    page,
    setState: (next: LabsAvailabilityState): void => {
      state = next;
      service.availabilityChanged();
    },
    live: (value: unknown, context = 'a'.repeat(64)): void => {
      state = {
        snapshot: getDefaultFeatureFlagSnapshot('ready'),
        contextIdentity: context,
        liveValues: { [key]: value },
      };
      service.availabilityChanged();
    },
  };
}
describe('authoritative Labs state', () => {
  it('starts offered off and synchronously mirrors cached choices', () => {
    const first = harness();
    expect(first.service.getSnapshot().earlyAccessEnabled).toBe(false);
    const cached = harness({
      version: 1,
      accounts: { local: { 'early-access': true } },
    });
    expect(cached.service.getSnapshot().earlyAccessEnabled).toBe(true);
    expect(cached.deps.mirror).toHaveBeenCalledWith(true);
    expect(
      labsExperimentsSnapshotSchema.safeParse(cached.service.getSnapshot())
        .success,
    ).toBe(true);
  });
  it('ignores a cached choice for the retired agents-page experiment', () => {
    const cached = harness({
      version: 1,
      accounts: { local: { 'early-access': true, 'agents-page': true } },
    });
    const snapshot = cached.service.getSnapshot();
    expect(snapshot.earlyAccessEnabled).toBe(true);
    expect(
      snapshot.experiments.some((entry) => entry.id === 'agents-page'),
    ).toBe(false);
    expect(labsExperimentsSnapshotSchema.safeParse(snapshot).success).toBe(
      true,
    );
  });
  it.each([
    null,
    { version: 2, accounts: { local: { 'early-access': true } } },
    { version: 1, accounts: { local: { 'early-access': 'true' } } },
  ])('fails safely on invalid cache %p', (cache) => {
    expect(harness(cache).service.getSnapshot().earlyAccessEnabled).toBe(false);
  });
  it('commits local state only after durable storage and preserves unrelated choices', async () => {
    const h = harness({ version: 1, accounts: { local: { retired: true } } });
    const pending = deferred<void>();
    h.deps.write = jest.fn(() => pending.promise);
    const write = h.service.setChoice({
      experimentId: 'early-access',
      enabled: true,
    });
    await Promise.resolve();
    expect(h.service.getSnapshot().earlyAccessEnabled).toBe(false);
    pending.resolve();
    await write;
    expect(h.service.getSnapshot().earlyAccessEnabled).toBe(true);
    const saved: unknown = JSON.parse(
      jest.mocked(h.deps.write).mock.calls[0][1],
    );
    expect(saved).toMatchObject({ accounts: { local: { retired: true } } });
    expect(h.deps.putChoice).not.toHaveBeenCalled();
  });
  it('does not commit a failed local save', async () => {
    const h = harness();
    h.deps.write = jest.fn(
      (): Promise<never> => Promise.reject(new Error('disk full')),
    );
    await expect(
      h.service.setChoice({ experimentId: 'early-access', enabled: true }),
    ).rejects.toThrow('disk full');
    expect(h.service.getSnapshot().earlyAccessEnabled).toBe(false);
  });
  it('allows opt-out with the prerequisite off but refuses enabling, hidden and unknown entries', async () => {
    const h = harness();
    await expect(
      h.service.setChoice({
        experimentId: 'plugins-preview',
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: 'missing_capability' });
    await h.service.setChoice({
      experimentId: 'plugins-preview',
      enabled: false,
    });
    await expect(
      h.service.setChoice({ experimentId: 'unknown', enabled: true }),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
    h.live('hidden');
    await expect(
      h.service.setChoice({ experimentId: 'early-access', enabled: false }),
    ).rejects.toMatchObject({ code: 'missing_capability' });
  });
  it('enables a page experiment without Early access and keeps it across Early access toggles', async () => {
    const h = harness();
    const enabled = (id: string): boolean | undefined =>
      h.service.getSnapshot().experiments.find((entry) => entry.id === id)
        ?.enabled;
    await h.service.setChoice({
      experimentId: 'statistics-page',
      enabled: true,
    });
    expect(h.service.getSnapshot().earlyAccessEnabled).toBe(false);
    expect(enabled('statistics-page')).toBe(true);
    for (const earlyAccess of [true, false]) {
      await h.service.setChoice({
        experimentId: 'early-access',
        enabled: earlyAccess,
      });
      expect(h.service.getSnapshot().earlyAccessEnabled).toBe(earlyAccess);
      expect(enabled('statistics-page')).toBe(true);
    }
    expect(
      labsExperimentsSnapshotSchema.safeParse(h.service.getSnapshot()).success,
    ).toBe(true);
  });
  it('lists page experiments off by default without Early access', () => {
    const snapshot = harness().service.getSnapshot();
    for (const id of [
      'overview-page',
      'kanban-page',
      'statistics-page',
      'audit-trail-page',
    ])
      expect(
        snapshot.experiments.find((entry) => entry.id === id),
      ).toMatchObject({
        availability: 'offered',
        requiresEarlyAccess: false,
        listed: true,
        enabled: false,
      });
  });
  it('refuses enabling a hidden page experiment', async () => {
    const h = harness();
    h.setState({
      snapshot: getDefaultFeatureFlagSnapshot('ready'),
      contextIdentity: 'a'.repeat(64),
      liveValues: {
        [CLIENT_FEATURE_FLAGS.canopyDesktopLabsKanbanPage.key]: 'hidden',
      },
    });
    await expect(
      h.service.setChoice({ experimentId: 'kanban-page', enabled: true }),
    ).rejects.toMatchObject({ code: 'missing_capability' });
  });
  it('retains server-confirmed state if the cache fails', async () => {
    const h = harness(null, account);
    h.deps.write = jest.fn(
      (): Promise<never> => Promise.reject(new Error('disk full')),
    );
    await h.service.setChoice({ experimentId: 'early-access', enabled: true });
    expect(h.service.getSnapshot().earlyAccessEnabled).toBe(true);
    expect(h.deps.diagnostic).toHaveBeenCalled();
  });
  it('replaces the complete account cache with GET, retaining it on failure', async () => {
    const h = harness(
      {
        version: 1,
        accounts: { [account.scope]: { 'early-access': true, retired: true } },
      },
      account,
    );
    await h.service.refreshChoices();
    expect(h.service.getSnapshot().experiments[0].choice).toBe(null);
    await h.service.setChoice({ experimentId: 'early-access', enabled: true });
    h.deps.fetchChoices = jest.fn(
      (): Promise<never> => Promise.reject(new Error('offline')),
    );
    await h.service.refreshChoices();
    expect(h.service.getSnapshot().earlyAccessEnabled).toBe(true);
  });
  it('fences a delayed GET behind a newer mutation', async () => {
    const h = harness(null, account);
    const load = deferred<unknown>();
    h.deps.fetchChoices = jest.fn(() => load.promise);
    const refresh = h.service.refreshChoices();
    await Promise.resolve();
    await h.service.setChoice({ experimentId: 'early-access', enabled: true });
    load.resolve({ choices: {} });
    await refresh;
    expect(h.service.getSnapshot().earlyAccessEnabled).toBe(true);
  });
  it('coordinates a GET launched during a write and serializes duplicate writes', async () => {
    const h = harness(null, account);
    const put = deferred<unknown>();
    h.deps.putChoice = jest.fn(() => put.promise);
    const write = h.service.setChoice({
      experimentId: 'early-access',
      enabled: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    const load = h.service.refreshChoices();
    expect(h.deps.fetchChoices).not.toHaveBeenCalled();
    const second = h.service.setChoice({
      experimentId: 'early-access',
      enabled: false,
    });
    put.resolve({
      experimentId: 'early-access',
      enabled: true,
      updatedAt: new Date().toISOString(),
    });
    await write;
    h.deps.fetchChoices = jest.fn(
      (): Promise<unknown> =>
        Promise.resolve({
          choices: { 'early-access': false },
        }),
    );
    h.deps.putChoice = jest.fn(
      (_session, request): Promise<unknown> =>
        Promise.resolve({
          ...request,
          updatedAt: new Date().toISOString(),
        }),
    );
    await second;
    await load;
    expect(h.service.getSnapshot().earlyAccessEnabled).toBe(false);
  });
  it('immediately switches scope and ignores previous-account GETs', async () => {
    const h = harness(
      { version: 1, accounts: { [account.scope]: { 'early-access': true } } },
      account,
    );
    const load = deferred<unknown>();
    h.deps.fetchChoices = jest.fn(() => load.promise);
    const refresh = h.service.refreshChoices();
    await Promise.resolve();
    await h.service.activate(local);
    expect(h.service.getSnapshot().earlyAccessEnabled).toBe(false);
    load.resolve({ choices: { 'early-access': true } });
    await refresh;
    expect(h.service.getSnapshot().scope).toBe('local');
    expect(h.service.getSnapshot().earlyAccessEnabled).toBe(false);
  });
  it('ignores previous-account PUT completion', async () => {
    const h = harness(null, account);
    const put = deferred<unknown>();
    h.deps.putChoice = jest.fn(() => put.promise);
    const write = h.service.setChoice({
      experimentId: 'early-access',
      enabled: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    await h.service.activate(local);
    put.resolve({
      experimentId: 'early-access',
      enabled: true,
      updatedAt: new Date().toISOString(),
    });
    await expect(write).rejects.toMatchObject({ code: 'surface_unavailable' });
    expect(h.service.getSnapshot().earlyAccessEnabled).toBe(false);
  });
  it('reconciles response loss using a complete GET', async () => {
    const h = harness(null, account);
    h.deps.putChoice = jest.fn(
      (): Promise<never> => Promise.reject(new Error('response lost')),
    );
    h.deps.fetchChoices = jest.fn(
      (): Promise<unknown> =>
        Promise.resolve({
          choices: { 'early-access': true, retired: false },
        }),
    );
    await h.service.setChoice({ experimentId: 'early-access', enabled: true });
    expect(h.service.getSnapshot().earlyAccessEnabled).toBe(true);
  });
  it('leaves committed choice unchanged when PUT and reconciliation fail', async () => {
    const h = harness(null, account);
    h.deps.putChoice = jest.fn(
      (): Promise<never> => Promise.reject(new Error('network')),
    );
    h.deps.fetchChoices = jest.fn(
      (): Promise<never> => Promise.reject(new Error('offline')),
    );
    await expect(
      h.service.setChoice({ experimentId: 'early-access', enabled: true }),
    ).rejects.toThrow('network');
    expect(h.service.getSnapshot().experiments[0].choice).toBe(null);
  });
  it('a live kill switch during save wins without deleting the stored choice', async () => {
    const h = harness(null, account);
    const put = deferred<unknown>();
    h.deps.putChoice = jest.fn(() => put.promise);
    const write = h.service.setChoice({
      experimentId: 'early-access',
      enabled: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    h.live('hidden');
    put.resolve({
      experimentId: 'early-access',
      enabled: true,
      updatedAt: new Date().toISOString(),
    });
    const result = await write;
    expect(result.earlyAccessEnabled).toBe(false);
    expect(result.experiments[0].choice).toBe(true);
    h.live('offered');
    expect(h.service.getSnapshot().earlyAccessEnabled).toBe(true);
    await h.service.flush();
  });
  it('uses context-valid live values before cache, cache before defaults, and never caches malformed values', async () => {
    const h = harness();
    h.live('on');
    expect(h.service.getSnapshot().earlyAccessEnabled).toBe(true);
    h.live('garbage');
    expect(h.service.getSnapshot().earlyAccessEnabled).toBe(true);
    h.live('garbage', 'b'.repeat(64));
    expect(h.service.getSnapshot().earlyAccessEnabled).toBe(false);
    h.setState({
      snapshot: getDefaultFeatureFlagSnapshot('initializing'),
      contextIdentity: null,
      liveValues: {},
    });
    expect(h.service.getSnapshot().ready).toBe(false);
    await h.service.flush();
    const data: unknown = JSON.parse(h.files.get('availability') ?? '{}');
    expect(data).toMatchObject({
      contexts: { ['a'.repeat(64)]: { [key]: 'on' } },
    });
    expect(data).not.toHaveProperty(['contexts', 'b'.repeat(64)]);
  });
  it('offline restart restores context-scoped availability and account choice', () => {
    const h = harness(
      { version: 1, accounts: { [account.scope]: { 'early-access': true } } },
      account,
    );
    h.deps.read = (path): unknown =>
      path === 'availability'
        ? { version: 1, contexts: { ['a'.repeat(64)]: { [key]: 'on' } } }
        : {
            version: 1,
            accounts: { [account.scope]: { 'early-access': true } },
          };
    h.live(undefined);
    const restart = new LabsExperimentsService(h.deps, account);
    expect(restart.getSnapshot().earlyAccessEnabled).toBe(true);
    h.live('hidden', 'b'.repeat(64));
    const otherContext = new LabsExperimentsService(h.deps, account);
    expect(otherContext.getSnapshot().earlyAccessEnabled).toBe(false);
  });
  it('all subscribers get ordered authoritative snapshots', async () => {
    const h = harness();
    const first = jest.fn<void, [LabsExperimentsSnapshot]>();
    const second = jest.fn<void, [LabsExperimentsSnapshot]>();
    h.service.onSnapshotChanged(first);
    const unsubscribe = h.service.onSnapshotChanged(second);
    await h.service.setChoice({ experimentId: 'early-access', enabled: true });
    expect(first.mock.calls).toEqual(second.mock.calls);
    const before = first.mock.calls[0][0];
    unsubscribe();
    await h.service.activate(local);
    expect(first.mock.calls.at(-1)?.[0]?.generation).toBeGreaterThan(
      before.generation,
    );
    expect(first.mock.calls.at(-1)?.[0]?.revision).toBeGreaterThan(
      before.revision,
    );
  });
  it('context identity includes organization and every targeting field', () => {
    const one = {
      kind: 'user' as const,
      key: 'a',
      canopyOrganizationIds: ['org-a'],
    };
    expect(labsContextIdentity(one)).not.toBe(
      labsContextIdentity({ ...one, canopyOrganizationIds: ['org-b'] }),
    );
    expect(labsContextIdentity(one)).toBe(
      labsContextIdentity({
        canopyOrganizationIds: ['org-a'],
        key: 'a',
        kind: 'user',
      }),
    );
  });
});

describe('stacked notifications extraction', () => {
  const state = (service: LabsExperimentsService): boolean | undefined =>
    service.getSnapshot().experiments.find((entry) => entry.id === 'sidebar')
      ?.enabled;
  it.each([true, false])(
    'preserves the cached legacy choice %s across Early access changes and restart',
    async (enabled) => {
      const h = harness({
        version: 1,
        accounts: { local: { 'early-access': enabled } },
      });
      expect(state(h.service)).toBe(enabled);
      await h.service.setChoice({
        experimentId: 'early-access',
        enabled: !enabled,
      });
      expect(state(h.service)).toBe(enabled);
      await h.service.flush();
      const restarted = harness(JSON.parse(h.files.get('choices') ?? '{}'));
      expect(state(restarted.service)).toBe(enabled);
    },
  );
  it('keeps a new install off even after opting into Early access', async () => {
    const h = harness();
    await h.service.setChoice({ experimentId: 'early-access', enabled: true });
    expect(state(h.service)).toBe(false);
    await h.service.setChoice({
      experimentId: 'sidebar',
      enabled: true,
    });
    await h.service.setChoice({ experimentId: 'early-access', enabled: false });
    expect(state(h.service)).toBe(true);
  });
  it('never overwrites an explicit extracted choice or transfers guest choices', async () => {
    const h = harness({
      version: 1,
      accounts: {
        local: { 'early-access': true, sidebar: false },
      },
    });
    expect(state(h.service)).toBe(false);
    await h.service.activate(account);
    expect(state(h.service)).toBe(false);
  });
});

it('durably records the local extraction even without a later setting change', async () => {
  const h = harness({
    version: 1,
    accounts: { local: { 'early-access': true } },
  });
  await h.service.flush();
  expect(JSON.parse(h.files.get('choices') ?? '{}')).toMatchObject({
    accounts: {
      local: { 'early-access': true, sidebar: true },
    },
  });
});

it('applies the canonical choice map returned by a signed-in save, including extraction', async () => {
  const h = harness(null, account);
  const initial = deferred<unknown>();
  h.deps.fetchChoices = jest.fn(() => initial.promise);
  const loading = h.service.refreshChoices();
  await Promise.resolve();
  h.deps.putChoice = jest.fn(
    (_session, request): Promise<unknown> =>
      Promise.resolve({
        ...request,
        updatedAt: new Date().toISOString(),
        choices: { 'early-access': false, sidebar: true },
      }),
  );
  await h.service.setChoice({ experimentId: 'early-access', enabled: false });
  initial.resolve({
    choices: { 'early-access': true, sidebar: true },
  });
  await loading;
  expect(h.service.getSnapshot().earlyAccessEnabled).toBe(false);
  expect(
    h.service.getSnapshot().experiments.find((entry) => entry.id === 'sidebar'),
  ).toMatchObject({ choice: true, enabled: true });
});

it.each([null, { version: 2, accounts: { local: { 'early-access': true } } }])(
  'does not overwrite an unreadable or unsupported cache during extraction: %p',
  async (cache) => {
    const h = harness(cache);
    await h.service.flush();
    expect(h.deps.write).not.toHaveBeenCalled();
  },
);

it('does not list graduated features or allow changing their retired choices', async () => {
  const { service } = harness({
    version: 1,
    accounts: {
      local: {
        'early-access': false,
        'floating-advisor': false,
        'browser-warm-views': false,
      },
    },
  });
  expect(
    service
      .getSnapshot()
      .experiments.some((entry) => entry.id === 'floating-advisor'),
  ).toBe(false);
  await expect(
    service.setChoice({ experimentId: 'floating-advisor', enabled: false }),
  ).rejects.toThrow();
});

it.each([false, true])(
  'ignores a retired archive-tabs choice (%s) and rejects re-enabling it',
  async (enabled) => {
    const { service } = harness({
      version: 1,
      accounts: {
        local: { 'early-access': true, 'archived-chat-tabs': enabled },
      },
    });
    expect(
      service
        .getSnapshot()
        .experiments.some((entry) => entry.id === 'archived-chat-tabs'),
    ).toBe(false);
    await expect(
      service.setChoice({ experimentId: 'archived-chat-tabs', enabled: true }),
    ).rejects.toThrow();
  },
);
describe('injected Labs availability fallback', () => {
  const modes = [
    ['not_configured', 'launchdarkly_disabled'],
    ['error', 'launchdarkly_enabled_unavailable'],
  ] as const;
  // These test policies model future brand-specific entries, not a rollout.
  const brands = ['canopy', 'unstoppable-code', 'unknown-brand'] as const;
  const choices = [null, true, false] as const;
  for (const brand of brands) {
    for (const [status, mode] of modes) {
      it.each(choices)(`${brand} / ${mode} / choice %p`, (choice) => {
        const fallback = brand === 'canopy' ? 'on' : 'offered';
        const policy = jest.fn(
          (entry: LabsExperiment): LabsExperimentAvailability | undefined =>
            entry.id === 'early-access' ? fallback : undefined,
        );
        const h = harness(
          {
            version: 1,
            accounts: {
              local: choice === null ? {} : { 'early-access': choice },
            },
          },
          local,
          { availabilityFallback: policy },
        );
        h.setState({
          snapshot: getDefaultFeatureFlagSnapshot(status),
          contextIdentity: status === 'not_configured' ? null : 'a'.repeat(64),
          liveValues: {},
        });
        const snapshot = h.service.getSnapshot();
        expect(snapshot.ready).toBe(true);
        expect(snapshot.experiments[0]).toMatchObject({
          availability: fallback,
          choice,
          listed: true,
          enabled: fallback === 'on' ? choice !== false : choice === true,
        });
        expect(policy).toHaveBeenCalledWith(LABS_EXPERIMENTS[0], mode);
        expect(
          snapshot.experiments.find((entry) => entry.id === 'kanban-page'),
        ).toMatchObject({ availability: 'offered', enabled: false });
        expect(labsExperimentsSnapshotSchema.safeParse(snapshot).success).toBe(
          true,
        );
      });
    }
  }

  for (const [status, mode] of modes) {
    it.each(choices)(
      `preserves every existing experiment / ${mode} / choice %p`,
      (choice) => {
        const h = harness({
          version: 1,
          accounts: {
            local:
              choice === null
                ? {}
                : Object.fromEntries(
                    LABS_EXPERIMENTS.map((entry) => [entry.id, choice]),
                  ),
          },
        });
        h.setState({
          snapshot: getDefaultFeatureFlagSnapshot(status),
          contextIdentity: 'a'.repeat(64),
          liveValues: {},
        });
        for (const metadata of LABS_EXPERIMENTS) {
          const expectedChoice =
            choice === null &&
            EXTRACTED_EARLY_ACCESS_EXPERIMENT_IDS.includes(metadata.id)
              ? false
              : choice;
          expect(
            h.service
              .getSnapshot()
              .experiments.find((entry) => entry.id === metadata.id),
          ).toMatchObject({
            availability: 'offered',
            choice: expectedChoice,
            listed: true,
            enabled: expectedChoice === true,
          });
        }
      },
    );
  }

  it.each(LABS_EXPERIMENTS)(
    'applies a mode-specific override independently to $id',
    async (selected) => {
      const policy = (
        entry: LabsExperiment,
        mode: FeatureFlagDefaultMode,
      ): LabsExperimentAvailability | undefined =>
        entry.id === selected.id
          ? mode === 'launchdarkly_disabled'
            ? 'on'
            : 'hidden'
          : undefined;
      const h = harness(null, local, { availabilityFallback: policy });
      const statuses = ['not_configured', 'error', 'not_configured'] as const;
      for (const status of statuses) {
        const raw = getDefaultFeatureFlagSnapshot(
          status,
          null,
          'launchdarkly_disabled',
        );
        h.setState({
          snapshot: raw,
          contextIdentity: 'a'.repeat(64),
          liveValues: {},
        });
        const snapshot = h.service.getSnapshot();
        for (const metadata of LABS_EXPERIMENTS) {
          const choice = EXTRACTED_EARLY_ACCESS_EXPERIMENT_IDS.includes(
            metadata.id,
          )
            ? false
            : null;
          const overridden = metadata.id === selected.id;
          const availability = overridden
            ? status === 'not_configured'
              ? 'on'
              : 'hidden'
            : 'offered';
          expect(
            snapshot.experiments.find((entry) => entry.id === metadata.id),
          ).toMatchObject({
            availability,
            choice,
            listed: availability !== 'hidden',
            enabled: availability === 'on' && choice !== false,
          });
          expect(raw.values[metadata.flagKey]).toBe('offered');
        }
        expect(labsExperimentsSnapshotSchema.safeParse(snapshot).success).toBe(
          true,
        );
      }
      await h.service.flush();
      expect(h.files.has('availability')).toBe(false);
    },
  );

  it.each([local, account])(
    'retains an injected on default after a failed opt-out in $scope',
    async (session) => {
      const h = harness(null, session, {
        availabilityFallback: (entry) =>
          entry.id === 'kanban-page' ? 'on' : undefined,
      });
      const pending = deferred<never>();
      if (session.signedIn) {
        h.deps.putChoice = jest.fn(() => pending.promise);
        h.deps.fetchChoices = jest.fn(
          (): Promise<never> => Promise.reject(new Error('offline')),
        );
      } else {
        h.deps.write = jest.fn(() => pending.promise);
      }
      const before = h.service.getSnapshot();
      const write = h.service.setChoice({
        experimentId: 'kanban-page',
        enabled: false,
      });
      const failure = expect(write).rejects.toThrow('save failed');
      await Promise.resolve();
      await Promise.resolve();
      expect(h.service.getSnapshot()).toEqual(before);
      pending.reject(new Error('save failed'));
      await failure;
      expect(
        h.service
          .getSnapshot()
          .experiments.find((entry) => entry.id === 'kanban-page'),
      ).toMatchObject({ availability: 'on', choice: null, enabled: true });
    },
  );

  it.each(['on', 'offered'] as const)(
    'keeps live/cache ahead of %s fallback, fences contexts, and never caches fallback',
    async (fallback) => {
      const h = harness(null, local, {
        availabilityFallback: (entry) =>
          entry.id === 'early-access' ? fallback : undefined,
      });
      h.live(undefined);
      expect(h.service.getSnapshot().experiments[0].availability).toBe(
        fallback,
      );
      await h.service.flush();
      expect(h.files.has('availability')).toBe(false);
      h.live('hidden');
      expect(h.service.getSnapshot().experiments[0]).toMatchObject({
        availability: 'hidden',
        listed: false,
        enabled: false,
      });
      h.live('malformed');
      expect(h.service.getSnapshot().experiments[0].availability).toBe(
        'hidden',
      );
      h.live('on');
      expect(h.service.getSnapshot().experiments[0].enabled).toBe(true);
      h.live(undefined, 'b'.repeat(64));
      expect(h.service.getSnapshot().experiments[0].availability).toBe(
        fallback,
      );
      h.live(undefined);
      expect(h.service.getSnapshot().experiments[0].availability).toBe('on');
      h.setState({
        snapshot: getDefaultFeatureFlagSnapshot('not_configured'),
        contextIdentity: 'a'.repeat(64),
        liveValues: {},
      });
      expect(h.service.getSnapshot().experiments[0].availability).toBe(
        fallback,
      );
      await h.service.flush();
      expect(JSON.parse(h.files.get('availability') ?? '{}')).toEqual({
        version: 1,
        contexts: { ['a'.repeat(64)]: { [key]: 'on' } },
      });
      expect(
        h.service
          .getSnapshot()
          .experiments.find((entry) => entry.id === h.page.id)?.availability,
      ).toBe('offered');
    },
  );

  it('does not grant readiness while a configured context is unresolved', () => {
    const h = harness(null, local, { availabilityFallback: () => 'on' });
    h.setState({
      snapshot: getDefaultFeatureFlagSnapshot('initializing'),
      contextIdentity: null,
      liveValues: {},
    });
    expect(h.service.getSnapshot()).toMatchObject({
      ready: false,
      earlyAccessEnabled: false,
    });
    for (const entry of h.service.getSnapshot().experiments)
      expect(entry).toMatchObject({ listed: false, enabled: false });
  });

  it('restores persisted live availability before policy only for the same context', async () => {
    const h = harness(null, local, { availabilityFallback: () => 'on' });
    h.live('hidden');
    await h.service.flush();
    h.live(undefined);
    h.deps.read = (path): unknown => JSON.parse(h.files.get(path) ?? 'null');
    const restart = new LabsExperimentsService(h.deps, local);
    expect(restart.getSnapshot().experiments[0]).toMatchObject({
      availability: 'hidden',
      listed: false,
      enabled: false,
    });
    h.live(undefined, 'b'.repeat(64));
    const otherContext = new LabsExperimentsService(h.deps, local);
    expect(otherContext.getSnapshot().experiments[0]).toMatchObject({
      availability: 'on',
      enabled: true,
    });
  });
});

describe('Labs availability resolution precedence', () => {
  const entry: LabsExperiment = {
    id: 'policy-test',
    name: 'Policy test',
    description: 'Test fallback isolation.',
    pages: [],
    sidebarKeys: [],
    flagKey: key,
    requiresEarlyAccess: false,
  };
  const policy = jest.fn((): LabsExperimentAvailability => 'hidden');
  beforeEach(() => policy.mockClear());

  it.each(['initializing', 'ready', 'error'] as const)(
    'uses validated live values, then cache, then policy while %s',
    (status) => {
      const state: LabsAvailabilityState = {
        snapshot: getDefaultFeatureFlagSnapshot(status),
        contextIdentity: 'a'.repeat(64),
        liveValues: {},
      };
      for (const availability of ['hidden', 'offered', 'on'] as const) {
        expect(
          resolveLabsAvailability(
            entry,
            { ...state, liveValues: { [key]: availability } },
            { [key]: 'on' },
            policy,
          ),
        ).toBe(availability);
        expect(
          resolveLabsAvailability(
            entry,
            { ...state, liveValues: { [key]: true } },
            { [key]: availability },
            policy,
          ),
        ).toBe(availability);
      }
      expect(policy).not.toHaveBeenCalled();
      expect(resolveLabsAvailability(entry, state, {}, policy)).toBe('hidden');
      expect(policy).toHaveBeenCalledWith(
        entry,
        'launchdarkly_enabled_unavailable',
      );
    },
  );

  it('ignores live values and cache entirely when unconfigured', () => {
    expect(
      resolveLabsAvailability(
        entry,
        {
          snapshot: getDefaultFeatureFlagSnapshot('not_configured'),
          contextIdentity: 'a'.repeat(64),
          liveValues: { [key]: 'on' },
        },
        { [key]: 'offered' },
        policy,
      ),
    ).toBe('hidden');
    expect(policy).toHaveBeenCalledWith(entry, 'launchdarkly_disabled');
  });

  it('does not treat the raw snapshot default as a live value', () => {
    const state: LabsAvailabilityState = {
      snapshot: getDefaultFeatureFlagSnapshot('error'),
      contextIdentity: 'a'.repeat(64),
      liveValues: { [key]: 'invalid' },
    };
    expect(state.snapshot.values[key]).toBe('offered');
    expect(resolveLabsAvailability(entry, state, {}, policy)).toBe('hidden');
    expect(state.snapshot.values[key]).toBe('offered');
  });

  it.each(['not_configured', 'error'] as const)(
    'fixture availability bypasses policy, cache and live values while %s',
    (status) => {
      expect(
        resolveLabsAvailability(
          { ...entry, fixtureAvailability: 'offered' },
          {
            snapshot: getDefaultFeatureFlagSnapshot(status),
            contextIdentity: 'a'.repeat(64),
            liveValues: { [key]: 'hidden' },
          },
          { [key]: 'on' },
          policy,
        ),
      ).toBe('offered');
      expect(policy).not.toHaveBeenCalled();
    },
  );

  it.each(['not_configured', 'error'] as const)(
    'undefined policy values retain registered and legacy missing-flag defaults while %s',
    (status) => {
      const state: LabsAvailabilityState = {
        snapshot: getDefaultFeatureFlagSnapshot(status),
        contextIdentity: null,
        liveValues: {},
      };
      expect(resolveLabsAvailability(entry, state, {}, () => undefined)).toBe(
        'offered',
      );
      expect(
        resolveLabsAvailability(
          { ...entry, flagKey: 'unknown' },
          state,
          {},
          () => undefined,
        ),
      ).toBe(status === 'not_configured' ? 'on' : 'offered');
    },
  );
});
