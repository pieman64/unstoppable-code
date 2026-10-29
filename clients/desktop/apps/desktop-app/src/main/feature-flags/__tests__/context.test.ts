import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const mockGetPath = jest.fn();

jest.mock('electron', () => ({
  app: {
    getPath: mockGetPath,
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
