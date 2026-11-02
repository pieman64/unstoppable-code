import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const mockGetPath = jest.fn();
jest.mock('electron', () => ({ app: { getPath: mockGetPath } }));

describe('invited install metadata', () => {
  let directory: string;
  beforeEach(async () => {
    jest.resetModules();
    directory = await mkdtemp(path.join(tmpdir(), 'invited-install-'));
    mockGetPath.mockReturnValue(directory);
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('serializes one first acceptance with shipping/provider milestones', async () => {
    const identity = await import('../lib/anonymous-id');
    const key = await identity.getStablePostHogAnonymousKey();
    const file = path.join(directory, 'posthog-context.json');
    const stored: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (
      typeof stored !== 'object' ||
      stored === null ||
      !('createdAt' in stored) ||
      typeof stored.createdAt !== 'string'
    )
      throw new Error('Missing creation timestamp');
    expect(stored).toMatchObject({
      invitedInstall: null,
      createdAt: stored.createdAt,
    });
    expect(Number.isFinite(Date.parse(stored.createdAt))).toBe(true);
    expect(await identity.readPostHogInvitedInstall()).toBe(false);
    const claims = await Promise.all([
      ...Array.from({ length: 10 }, () =>
        identity.recordPostHogInviteAcceptance(key),
      ),
      identity.recordPostHogShippingMilestone('commit'),
      identity.recordPostHogProviderConnection('claude', false),
    ]);
    expect(
      claims
        .slice(0, 10)
        .filter(
          (value) =>
            typeof value === 'object' &&
            value !== null &&
            'is_first_accept_on_install' in value &&
            value.is_first_accept_on_install,
        ),
    ).toHaveLength(1);
    expect(await identity.readPostHogInvitedInstall()).toBe(true);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      anonymousKey: key,
      invitedInstall: true,
      shipping: { commit: true },
      providerConnection: { firstProvider: 'claude' },
    });
  });

  it('observes legacy acceptance without claiming first historical acceptance or inventing age', async () => {
    const identity = await import('../lib/anonymous-id');
    const key = '01234567-89ab-4cde-8fab-0123456789ab';
    await writeFile(
      path.join(directory, 'posthog-context.json'),
      JSON.stringify({ version: 1, anonymousKey: key }),
    );
    expect(await identity.readPostHogInvitedInstall()).toBeUndefined();
    expect(await identity.recordPostHogInviteAcceptance(key)).toEqual({});
    expect(await identity.readPostHogInvitedInstall()).toBe(true);
    expect(await identity.recordPostHogInviteAcceptance(key)).toEqual({
      is_first_accept_on_install: false,
    });
  });

  it.each([
    ['invalid', undefined],
    ['2026-02-30T00:00:00.000Z', undefined],
    ['2026-11-01T00:00:00.000Z', 0],
    ['2020-01-01T00:00:00.000Z', 365],
    ['2026-10-27T00:00:00.000Z', 2],
  ])('bounds install age for %s', async (createdAt, age) => {
    const identity = await import('../lib/anonymous-id');
    const key = '01234567-89ab-4cde-8fab-0123456789ab';
    await writeFile(
      path.join(directory, 'posthog-context.json'),
      JSON.stringify({
        version: 1,
        anonymousKey: key,
        createdAt,
        invitedInstall: null,
      }),
    );
    expect(
      await identity.recordPostHogInviteAcceptance(
        key,
        Date.parse('2026-10-29T00:00:00.000Z'),
      ),
    ).toEqual({
      is_first_accept_on_install: true,
      ...(age === undefined ? {} : { install_age_days: age }),
    });
  });

  it('leaves an unwritable identity intact and rechecks eligibility inside the writer queue', async () => {
    const identity = await import('../lib/anonymous-id');
    const key = await identity.getStablePostHogAnonymousKey();
    const file = path.join(directory, 'posthog-context.json');
    const before = await readFile(file, 'utf8');
    await expect(
      identity.recordPostHogInviteAcceptance(key, Date.now(), () => false),
    ).rejects.toThrow();
    await chmod(directory, 0o500);
    try {
      await expect(
        identity.recordPostHogInviteAcceptance(key),
      ).rejects.toThrow();
      expect(await readFile(file, 'utf8')).toBe(before);
      expect(await identity.readPostHogInvitedInstall()).toBe(false);
    } finally {
      await chmod(directory, 0o700);
    }
  });

  it('never repairs corrupt metadata or attaches an old acceptance to a reset identity', async () => {
    const identity = await import('../lib/anonymous-id');
    const key = await identity.getStablePostHogAnonymousKey();
    const file = path.join(directory, 'posthog-context.json');
    for (const raw of [
      '{bad',
      JSON.stringify({ version: 1, anonymousKey: key, invitedInstall: false }),
      JSON.stringify({
        version: 1,
        anonymousKey: '11111111-1111-4111-8111-111111111111',
        invitedInstall: null,
      }),
    ]) {
      await writeFile(file, raw);
      await expect(
        identity.recordPostHogInviteAcceptance(key),
      ).rejects.toThrow();
      expect(await readFile(file, 'utf8')).toBe(raw);
    }
    await rm(file);
    await expect(identity.recordPostHogInviteAcceptance(key)).rejects.toThrow();
    expect(await identity.readPostHogInvitedInstall()).toBeUndefined();
  });
});
