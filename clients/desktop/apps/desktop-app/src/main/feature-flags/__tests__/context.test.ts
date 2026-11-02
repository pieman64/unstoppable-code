import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const mockGetPath = jest.fn();

jest.mock('electron', () => ({
  app: {
    get getPath(): typeof mockGetPath {
      return mockGetPath;
    },
    getVersion: jest.fn(() => '0.24.6'),
  },
}));

jest.mock('../account-targeting', () => ({
  readGitHubTargetingInfo: jest.fn(),
  readClaudeTargetingInfo: jest.fn(),
  readCodexTargetingInfo: jest.fn(),
  readCanopyServerTargetingInfo: jest.fn(),
}));

import {
  buildDesktopFeatureFlagContextFromTargeting,
  getStableAnonymousKey,
} from '../context';

import { getStablePostHogAnonymousKey } from '../../lib/anonymous-id';

describe('desktop feature flag context', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'canopy-ff-context-'));
    mockGetPath.mockReturnValue(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('persists a separate PostHog UUID for concurrent app windows', async () => {
    const datadogId = await getStableAnonymousKey();
    const ids = await Promise.all(
      Array.from({ length: 20 }, () => getStablePostHogAnonymousKey()),
    );
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(ids[0]).not.toBe(datadogId);
    const stored: unknown = JSON.parse(
      await readFile(path.join(tempDir, 'posthog-context.json'), 'utf8'),
    );
    if (
      typeof stored !== 'object' ||
      stored === null ||
      !('anonymousKey' in stored) ||
      typeof stored.anonymousKey !== 'string'
    ) {
      throw new Error('Invalid persisted PostHog identity');
    }
    expect(stored.anonymousKey).toBe(ids[0]);
    expect(await getStableAnonymousKey()).toBe(datadogId);
  });

  it('reloads PostHog identity after restart and rotates only the deleted store', async () => {
    const datadogId = await getStableAnonymousKey();
    const posthogId = await getStablePostHogAnonymousKey();
    jest.resetModules();
    let identity = await import('../../lib/anonymous-id');
    expect(await identity.getStablePostHogAnonymousKey()).toBe(posthogId);
    await rm(path.join(tempDir, 'posthog-context.json'));
    jest.resetModules();
    identity = await import('../../lib/anonymous-id');
    const rotated = await identity.getStablePostHogAnonymousKey();
    expect(rotated).not.toBe(posthogId);
    expect(await identity.getStableAnonymousKey()).toBe(datadogId);
    await rm(path.join(tempDir, 'feature-flags-context.json'));
    jest.resetModules();
    identity = await import('../../lib/anonymous-id');
    expect(await identity.getStableAnonymousKey()).not.toBe(datadogId);
    expect(await identity.getStablePostHogAnonymousKey()).toBe(rotated);
  });

  describe('shipping milestones', () => {
    const storedKey = '01234567-89ab-4cde-8fab-0123456789ab';
    const shipping = { commit: null, pullRequest: null, merge: null };

    it('serializes independent claims with provider writes and retains unrelated metadata', async () => {
      const identity = await import('../../lib/anonymous-id');
      const key = await identity.getStablePostHogAnonymousKey();
      const filePath = path.join(tempDir, 'posthog-context.json');
      const stored: unknown = JSON.parse(await readFile(filePath, 'utf8'));
      if (typeof stored !== 'object' || stored === null)
        throw new Error('Invalid identity fixture');
      expect(stored).toMatchObject({ shipping });
      await writeFile(
        filePath,
        JSON.stringify({ ...stored, unrelated: { retained: true } }),
      );
      const claims = await Promise.all([
        ...Array.from({ length: 12 }, () =>
          identity.recordPostHogShippingMilestone('commit'),
        ),
        identity.recordPostHogShippingMilestone('pull_request'),
        identity.recordPostHogShippingMilestone('merge'),
        identity.recordPostHogProviderConnection('claude', false),
      ]);
      expect(
        claims.slice(0, 12).filter((value) => value === true),
      ).toHaveLength(1);
      expect(claims.slice(12, 14)).toEqual([true, true]);
      expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
        version: 1,
        anonymousKey: key,
        ...stored,
        shipping: { commit: true, pullRequest: true, merge: true },
        providerConnection: { firstProvider: 'claude' },
        unrelated: { retained: true },
      });
      jest.resetModules();
      const restarted = await import('../../lib/anonymous-id');
      expect(await restarted.recordPostHogShippingMilestone('commit')).toBe(
        false,
      );
      await rm(filePath);
      await expect(
        restarted.recordPostHogShippingMilestone('merge'),
      ).rejects.toThrow();
      jest.resetModules();
      const reset = await import('../../lib/anonymous-id');
      expect(await reset.getStablePostHogAnonymousKey()).not.toBe(key);
      expect(await reset.recordPostHogShippingMilestone('commit')).toBe(true);
    });

    it('persists unknown history for every legacy kind without rotating the identity', async () => {
      const identity = await import('../../lib/anonymous-id');
      const filePath = path.join(tempDir, 'posthog-context.json');
      await writeFile(
        filePath,
        JSON.stringify({ version: 1, anonymousKey: storedKey }),
      );
      expect(await identity.recordPostHogShippingMilestone('commit')).toBe(
        false,
      );
      expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
        version: 1,
        anonymousKey: storedKey,
        shipping: {
          commit: 'unknown',
          pullRequest: 'unknown',
          merge: 'unknown',
        },
      });
      expect(
        await identity.recordPostHogShippingMilestone('pull_request'),
      ).toBe(false);
    });

    it.each([
      '{corrupt',
      'null',
      JSON.stringify({ version: 2, anonymousKey: storedKey, shipping }),
      JSON.stringify({ version: 1, anonymousKey: 'invalid', shipping }),
      JSON.stringify({
        version: 1,
        anonymousKey: storedKey,
        shipping: { commit: null },
      }),
      JSON.stringify({
        version: 1,
        anonymousKey: storedKey,
        shipping: { ...shipping, merge: false },
      }),
    ])('preserves malformed metadata bytes: %s', async (bytes) => {
      const identity = await import('../../lib/anonymous-id');
      const filePath = path.join(tempDir, 'posthog-context.json');
      await writeFile(filePath, bytes);
      await expect(
        identity.recordPostHogShippingMilestone('commit'),
      ).rejects.toThrow();
      expect(await readFile(filePath, 'utf8')).toBe(bytes);
    });

    it('does not create missing metadata or overwrite a replaced identity', async () => {
      const identity = await import('../../lib/anonymous-id');
      await expect(
        identity.recordPostHogShippingMilestone('commit'),
      ).rejects.toThrow();
      const key = await identity.getStablePostHogAnonymousKey();
      const filePath = path.join(tempDir, 'posthog-context.json');
      const bytes = JSON.stringify({
        version: 1,
        anonymousKey: storedKey,
        shipping,
      });
      await writeFile(filePath, bytes);
      await expect(
        identity.recordPostHogShippingMilestone('commit'),
      ).rejects.toThrow();
      expect(await readFile(filePath, 'utf8')).toBe(bytes);
      expect(await identity.getStablePostHogAnonymousKey()).toBe(key);
    });

    it('cannot claim first when the atomic write fails and can retry later', async () => {
      const identity = await import('../../lib/anonymous-id');
      await identity.getStablePostHogAnonymousKey();
      const filePath = path.join(tempDir, 'posthog-context.json');
      const bytes = await readFile(filePath, 'utf8');
      await chmod(tempDir, 0o555);
      try {
        await expect(
          identity.recordPostHogShippingMilestone('merge'),
        ).rejects.toThrow();
        expect(await readFile(filePath, 'utf8')).toBe(bytes);
      } finally {
        await chmod(tempDir, 0o755);
      }
      expect(await identity.recordPostHogShippingMilestone('merge')).toBe(true);
    });
  });

  describe('first provider connection', () => {
    const storedKey = '01234567-89ab-4cde-8fab-0123456789ab';

    it.each([
      [
        'unsupported version',
        JSON.stringify({ version: 2, anonymousKey: storedKey }),
      ],
      [
        'malformed UUID',
        JSON.stringify({ version: 1, anonymousKey: 'not-a-uuid' }),
      ],
      ['missing UUID', JSON.stringify({ version: 1 })],
      ['missing version', JSON.stringify({ anonymousKey: storedKey })],
      ['non-object JSON', 'null'],
      ['malformed JSON', '{corrupt'],
    ])(
      'preserves %s bytes when the SDK has not initialized',
      async (_label, bytes) => {
        jest.resetModules();
        const identity = await import('../../lib/anonymous-id');
        const filePath = path.join(tempDir, 'posthog-context.json');
        await writeFile(filePath, bytes);
        // No identity resolver: this is also the SDK-disabled launch path.
        for (const atStartup of [true, false]) {
          await expect(
            identity.recordPostHogProviderConnection('claude', atStartup),
          ).rejects.toThrow();
          expect(await readFile(filePath, 'utf8')).toBe(bytes);
        }
      },
    );

    it('rejects a cached-key mismatch without changing the replacement identity', async () => {
      const identity = await import('../../lib/anonymous-id');
      const cachedKey = await identity.getStablePostHogAnonymousKey();
      const filePath = path.join(tempDir, 'posthog-context.json');
      const bytes = JSON.stringify({
        version: 1,
        anonymousKey: storedKey,
        providerConnection: { firstProvider: null },
      });
      await writeFile(filePath, bytes);
      await expect(
        identity.recordPostHogProviderConnection('claude', false),
      ).rejects.toThrow('PostHog identity changed');
      expect(await readFile(filePath, 'utf8')).toBe(bytes);
      expect(await identity.getStablePostHogAnonymousKey()).toBe(cachedKey);
    });

    it('preserves legacy identity bytes without initializing the SDK', async () => {
      const identity = await import('../../lib/anonymous-id');
      const filePath = path.join(tempDir, 'posthog-context.json');
      const bytes = JSON.stringify({ version: 1, anonymousKey: storedKey });
      await writeFile(filePath, bytes);
      expect(
        await identity.recordPostHogProviderConnection('claude', false),
      ).toEqual({
        is_first_connection: false,
        first_connected_provider: 'unknown',
      });
      expect(await readFile(filePath, 'utf8')).toBe(bytes);
    });

    it('serializes provider writes without rotating an existing uncached identity', async () => {
      const identity = await import('../../lib/anonymous-id');
      const filePath = path.join(tempDir, 'posthog-context.json');
      await writeFile(
        filePath,
        JSON.stringify({
          version: 1,
          anonymousKey: storedKey,
          providerConnection: { firstProvider: null },
        }),
      );
      expect(
        await Promise.all([
          identity.recordPostHogProviderConnection('claude', false),
          identity.recordPostHogProviderConnection('codex', false),
        ]),
      ).toEqual([
        { is_first_connection: true, first_connected_provider: 'claude' },
        { is_first_connection: false, first_connected_provider: 'claude' },
      ]);
      expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
        version: 1,
        anonymousKey: storedKey,
        providerConnection: { firstProvider: 'claude' },
      });
    });

    it('does not create an analytics identity solely for provider observations', async () => {
      const identity = await import('../../lib/anonymous-id');
      await expect(
        identity.recordPostHogProviderConnection('claude', false),
      ).rejects.toThrow();
      await expect(
        readFile(path.join(tempDir, 'posthog-context.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('serializes concurrent successes and retains the first provider after restart', async () => {
      const identity = await import('../../lib/anonymous-id');
      await identity.getStablePostHogAnonymousKey();
      const results = await Promise.all([
        identity.recordPostHogProviderConnection('claude', false),
        identity.recordPostHogProviderConnection('codex', false),
      ]);
      expect(results).toEqual([
        { is_first_connection: true, first_connected_provider: 'claude' },
        { is_first_connection: false, first_connected_provider: 'claude' },
      ]);
      jest.resetModules();
      const restarted = await import('../../lib/anonymous-id');
      expect(
        await restarted.recordPostHogProviderConnection('cursor', false),
      ).toEqual({
        is_first_connection: false,
        first_connected_provider: 'claude',
      });
    });

    it('an existing account establishes an unknown historical baseline without claiming activation', async () => {
      const identity = await import('../../lib/anonymous-id');
      await identity.getStablePostHogAnonymousKey();
      await identity.recordPostHogProviderConnection('claude', true);
      expect(
        await identity.recordPostHogProviderConnection('codex', false),
      ).toEqual({
        is_first_connection: false,
        first_connected_provider: 'unknown',
      });
    });

    it('a legacy gateway baseline prevents Copilot claiming first across restart', async () => {
      const identity = await import('../../lib/anonymous-id');
      const events = await import('../../lib/provider-connection-events');
      events.resetProviderConnectionEventsForTests();
      await identity.getStablePostHogAnonymousKey();
      const pending: Promise<unknown>[] = [];
      const stop = events.subscribeProviderConnections((event) => {
        pending.push(
          identity.recordPostHogProviderConnection(
            event.provider,
            event.connectSource === 'at_startup',
          ),
        );
      });
      try {
        events.observeProviderConnection({
          provider: 'model_gateway',
          connectionMethod: 'api_key',
          via: 'read',
          fingerprint: 'legacy-key',
          baselineOnly: true,
        });
        await Promise.all(pending);
        expect(pending).toHaveLength(1);
        expect(
          await identity.recordPostHogProviderConnection('copilot', false),
        ).toEqual({
          is_first_connection: false,
          first_connected_provider: 'unknown',
        });
        jest.resetModules();
        const restarted = await import('../../lib/anonymous-id');
        expect(
          await restarted.recordPostHogProviderConnection('copilot', false),
        ).toEqual({
          is_first_connection: false,
          first_connected_provider: 'unknown',
        });
      } finally {
        stop();
        events.resetProviderConnectionEventsForTests();
      }
    });

    it('a damaged identity file does not fabricate first-connection metadata', async () => {
      const identity = await import('../../lib/anonymous-id');
      await identity.getStablePostHogAnonymousKey();
      await writeFile(path.join(tempDir, 'posthog-context.json'), '{corrupt');
      await expect(
        identity.recordPostHogProviderConnection('claude', false),
      ).rejects.toThrow();
      expect(
        await readFile(path.join(tempDir, 'posthog-context.json'), 'utf8'),
      ).toBe('{corrupt');
    });
  });

  describe('PostHog install launch', () => {
    let dataDir: string;
    const testWithPosixPermissions =
      process.platform === 'win32' ? it.skip : it;
    const originalDataDir = process.env.CANOPY_DATA_DIR;

    beforeEach(async () => {
      dataDir = await mkdtemp(path.join(tmpdir(), 'canopy-ff-data-'));
      process.env.CANOPY_DATA_DIR = dataDir;
      jest.resetModules();
    });

    afterEach(async () => {
      if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = originalDataDir;
      await rm(dataDir, { recursive: true, force: true });
    });

    async function writeWorkspaceIndex(ids: string[]): Promise<void> {
      await mkdir(path.join(dataDir, 'workspaces'), { recursive: true });
      await writeFile(
        path.join(dataDir, 'workspaces', 'index.json'),
        JSON.stringify({ workspaces: ids.map((id) => ({ id })) }),
      );
    }

    async function launch(): Promise<unknown> {
      jest.resetModules();
      const identity = await import('../../lib/anonymous-id');
      return identity.getPostHogInstallLaunch();
    }

    it('marks only the launch that creates the identity on a new install', async () => {
      // A boot auto-provisions the empty default cowork workspace, which is
      // not evidence of an earlier install.
      await writeWorkspaceIndex(['cowork-default']);
      expect(await launch()).toEqual({
        isFirstLaunch: true,
        isReinstall: false,
        isInvitedInstall: false,
      });
      expect(await launch()).toEqual({
        isFirstLaunch: false,
        isReinstall: false,
        isInvitedInstall: false,
      });
    });

    it('flags a new identity over existing install data as a reinstall', async () => {
      expect(await launch()).toEqual({
        isFirstLaunch: true,
        isReinstall: false,
        isInvitedInstall: false,
      });
      await writeWorkspaceIndex(['cowork-default', 'user-workspace']);
      await rm(path.join(tempDir, 'posthog-context.json'));
      expect(await launch()).toEqual({
        isFirstLaunch: false,
        isReinstall: true,
        isInvitedInstall: false,
      });
      expect(await launch()).toEqual({
        isFirstLaunch: false,
        isReinstall: false,
        isInvitedInstall: false,
      });
    });

    testWithPosixPermissions(
      'leaves classification unknown when the install data cannot be read',
      async () => {
        await writeWorkspaceIndex(['user-workspace']);
        await chmod(dataDir, 0o000);
        try {
          await expect(launch()).rejects.toMatchObject({ code: 'EACCES' });
        } finally {
          await chmod(dataDir, 0o700);
        }
      },
    );

    testWithPosixPermissions.each([
      'app-workspaces',
      'workspaces',
      'workspaces/cowork-default/chats',
    ])(
      'leaves classification unknown when %s is unreadable',
      async (relativePath) => {
        await writeWorkspaceIndex(['cowork-default']);
        const unreadablePath = path.join(dataDir, relativePath);
        await mkdir(unreadablePath, { recursive: true });
        await chmod(unreadablePath, 0o000);
        try {
          await expect(launch()).rejects.toMatchObject({ code: 'EACCES' });
        } finally {
          await chmod(unreadablePath, 0o700);
        }
      },
    );

    it('leaves classification unknown when the workspace index is corrupt', async () => {
      await writeWorkspaceIndex([]);
      await writeFile(path.join(dataDir, 'workspaces', 'index.json'), '{');
      await expect(launch()).rejects.toThrow(SyntaxError);
    });

    it('shares one answer with concurrent identity requests', async () => {
      jest.resetModules();
      const identity = await import('../../lib/anonymous-id');
      const [, first, second] = await Promise.all([
        identity.getStablePostHogAnonymousKey(),
        identity.getPostHogInstallLaunch(),
        identity.getPostHogInstallLaunch(),
      ]);
      expect(first).toEqual({
        isFirstLaunch: true,
        isReinstall: false,
        isInvitedInstall: false,
      });
      expect(second).toEqual(first);
    });
  });

  it('persists the anonymous UUID fallback across calls', async () => {
    const first = await getStableAnonymousKey();
    const second = await getStableAnonymousKey();

    expect(first).toBe(second);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('shares one anonymous UUID across concurrent first-run calls', async () => {
    const keys = await Promise.all(
      Array.from({ length: 20 }, () => getStableAnonymousKey()),
    );
    const uniqueKeys = new Set(keys);
    const stored = JSON.parse(
      await readFile(path.join(tempDir, 'feature-flags-context.json'), 'utf8'),
    ) as { anonymousKey: string };

    expect(uniqueKeys.size).toBe(1);
    expect(stored.anonymousKey).toBe(keys[0]);
  });

  it('uses the required stable-key priority', () => {
    const context = buildDesktopFeatureFlagContextFromTargeting({
      anonymousKey: 'anon',
      github: { id: '123', username: 'alice', email: 'gh@example.com' },
      claude: { email: 'claude@example.com', accountLabel: null },
      codex: { email: 'codex@example.com', accountLabel: null },
      canopy: {
        userIds: ['user-b', 'user-a'],
        emails: [],
        organizationIds: [],
        teamIds: [],
      },
    });

    expect(context.key).toBe('user-a');
    expect(context.anonymous).toBe(false);
  });

  it('deduplicates and sorts array attributes', () => {
    const context = buildDesktopFeatureFlagContextFromTargeting({
      anonymousKey: 'anon',
      github: { id: null, username: null, email: null },
      claude: { email: null, accountLabel: null },
      codex: { email: null, accountLabel: null },
      canopy: {
        userIds: [],
        emails: ['b@example.com', 'a@example.com', 'a@example.com'],
        organizationIds: ['org-b', 'org-a', 'org-a'],
        teamIds: ['team-b', 'team-a'],
      },
    });

    expect(context.key).toBe('anon');
    expect(context.anonymous).toBe(true);
    expect(context.canopyUserEmails).toEqual([
      'a@example.com',
      'b@example.com',
    ]);
    expect(context.canopyOrganizationIds).toEqual(['org-a', 'org-b']);
    expect(context.canopyTeamIds).toEqual(['team-a', 'team-b']);
  });

  function buildContextForCanopyEmails(
    emails: string[],
  ): ReturnType<typeof buildDesktopFeatureFlagContextFromTargeting> {
    return buildDesktopFeatureFlagContextFromTargeting({
      anonymousKey: 'anon',
      github: { id: null, username: null, email: null },
      claude: { email: null, accountLabel: null },
      codex: { email: null, accountLabel: null },
      canopy: {
        userIds: emails.length > 0 ? ['user-1'] : [],
        emails,
        organizationIds: [],
        teamIds: [],
      },
    });
  }

  it('lowercases the account email without changing canopyUserEmails', () => {
    const context = buildContextForCanopyEmails(['Person@Example.com']);

    expect(context.email).toBe('person@example.com');
    expect(context.canopyUserEmails).toEqual(['Person@Example.com']);
    expect(context.key).toBe('user-1');
  });

  it('trims the account email', () => {
    const context = buildContextForCanopyEmails(['  person@example.com ']);

    expect(context.email).toBe('person@example.com');
  });

  it('picks the first normalized account email deterministically', () => {
    const context = buildContextForCanopyEmails([
      'b@example.com',
      'A@Example.com',
      'a@example.com',
    ]);

    expect(context.email).toBe('a@example.com');
  });

  it('emits the account email when the stored account has no user id', () => {
    const context = buildDesktopFeatureFlagContextFromTargeting({
      anonymousKey: 'anon',
      github: { id: null, username: null, email: null },
      claude: { email: null, accountLabel: null },
      codex: { email: null, accountLabel: null },
      canopy: {
        userIds: [],
        emails: ['Person@Example.com'],
        organizationIds: [],
        teamIds: [],
      },
    });

    expect(context.email).toBe('person@example.com');
    expect(context.key).toBe('anon');
  });

  it('omits the account email when only whitespace is stored', () => {
    const context = buildContextForCanopyEmails(['   ']);

    expect(context).not.toHaveProperty('email');
  });

  it('never uses a provider email as the account email', () => {
    const context = buildDesktopFeatureFlagContextFromTargeting({
      anonymousKey: 'anon',
      github: { id: '123', username: 'alice', email: 'gh@example.com' },
      claude: { email: 'claude@example.com', accountLabel: null },
      codex: { email: 'codex@example.com', accountLabel: null },
      canopy: {
        userIds: [],
        emails: [],
        organizationIds: [],
        teamIds: [],
      },
    });

    expect(context).not.toHaveProperty('email');
  });
});
