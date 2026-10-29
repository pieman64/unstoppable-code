import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSharedContainerAcceptanceFilePath } from '../lib/paths';
import {
  acceptSharedContainer,
  allowSharedContainerRun,
  forgetSharedContainerAcceptance,
  getSharedContainerAcceptance,
  isSharedContainerAccepted,
  isSharedContainerRunAllowed,
  listAcceptedSharedContainers,
  revokeSharedContainerRun,
  withSharedContainerRunLifecycle,
} from '../shared-containers/acceptance-store';

describe('shared-container acceptance store', () => {
  const originalDataDir = process.env.CANOPY_DATA_DIR;
  let dataDir = '';

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'shared-container-accept-'));
    process.env.CANOPY_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
    await rm(dataDir, { recursive: true, force: true });
  });

  it('treats an absent file as nothing accepted', async () => {
    await expect(listAcceptedSharedContainers()).resolves.toEqual({});
    await expect(isSharedContainerAccepted('container-1')).resolves.toBe(false);
  });

  it('persists acceptance with the organization and a timestamp', async () => {
    await acceptSharedContainer('container-1', 'org-1', () => new Date(0));

    await expect(isSharedContainerAccepted('container-1')).resolves.toBe(true);
    await expect(listAcceptedSharedContainers()).resolves.toEqual({
      'container-1': {
        organizationId: 'org-1',
        acceptedAt: '1970-01-01T00:00:00.000Z',
      },
    });
    expect(
      JSON.parse(
        await readFile(getSharedContainerAcceptanceFilePath(), 'utf8'),
      ),
    ).toEqual({
      version: 1,
      accepted: {
        'container-1': {
          organizationId: 'org-1',
          acceptedAt: '1970-01-01T00:00:00.000Z',
        },
      },
    });
  });

  it('persists a direct share of a personal container without an organization', async () => {
    await acceptSharedContainer(
      'container-1',
      undefined,
      () => new Date(0),
      'direct',
    );

    await expect(getSharedContainerAcceptance('container-1')).resolves.toEqual({
      access: 'direct',
      acceptedAt: '1970-01-01T00:00:00.000Z',
    });
  });

  it('normalizes legacy and malformed access on read, still at version 1', async () => {
    await writeFile(
      getSharedContainerAcceptanceFilePath(),
      JSON.stringify({
        version: 1,
        accepted: {
          legacy: { organizationId: 'org-1', acceptedAt: 'then' },
          direct: {
            organizationId: 'org-2',
            access: 'direct',
            acceptedAt: 'then',
          },
          unknown: {
            organizationId: 'org-1',
            access: 'public',
            acceptedAt: 'then',
          },
          'blank-org': { organizationId: '', acceptedAt: 'then' },
        },
      }),
    );

    await expect(getSharedContainerAcceptance('legacy')).resolves.toEqual({
      organizationId: 'org-1',
      acceptedAt: 'then',
    });
    await expect(getSharedContainerAcceptance('direct')).resolves.toEqual({
      organizationId: 'org-2',
      access: 'direct',
      acceptedAt: 'then',
    });
    await expect(getSharedContainerAcceptance('unknown')).resolves.toEqual({
      organizationId: 'org-1',
      acceptedAt: 'then',
    });
    await expect(isSharedContainerAccepted('blank-org')).resolves.toBe(false);
  });

  it('lists the recorded identity of every accepted container', async () => {
    await writeFile(
      getSharedContainerAcceptanceFilePath(),
      JSON.stringify({
        version: 1,
        accepted: {
          // Written before external sharing: an organization share, no access.
          legacy: { organizationId: 'org-1', acceptedAt: 'then' },
          organization: {
            organizationId: 'org-1',
            access: 'organization',
            acceptedAt: 'then',
          },
          'direct-org-owned': {
            organizationId: 'org-2',
            access: 'direct',
            acceptedAt: 'then',
          },
          'direct-personal': { access: 'direct', acceptedAt: 'then' },
          'with-run-consent': {
            organizationId: 'org-1',
            acceptedAt: 'then',
            runAllowedAt: 'later',
            runAllowedPublisherUserId: 'publisher-1',
          },
          'blank-org': { organizationId: '', acceptedAt: 'then' },
        },
      }),
    );

    // Identity and when it was accepted: run consent stays in main.
    await expect(listAcceptedSharedContainers()).resolves.toEqual({
      legacy: { organizationId: 'org-1', acceptedAt: 'then' },
      organization: {
        organizationId: 'org-1',
        access: 'organization',
        acceptedAt: 'then',
      },
      'direct-org-owned': {
        organizationId: 'org-2',
        access: 'direct',
        acceptedAt: 'then',
      },
      'direct-personal': { access: 'direct', acceptedAt: 'then' },
      'with-run-consent': { organizationId: 'org-1', acceptedAt: 'then' },
    });
  });

  it('keeps the first accepted identity when the container is accepted again', async () => {
    await acceptSharedContainer(
      'container-1',
      'org-1',
      () => new Date(0),
      'organization',
    );

    // A later listing round can classify the same share differently; that
    // must not move the record the recipient's own accept wrote.
    await acceptSharedContainer(
      'container-1',
      'org-1',
      () => new Date(5_000),
      'direct',
    );
    await acceptSharedContainer(
      'container-1',
      undefined,
      () => new Date(6_000),
      'direct',
    );
    await acceptSharedContainer('container-1', 'org-2', () => new Date(7_000));

    await expect(getSharedContainerAcceptance('container-1')).resolves.toEqual({
      organizationId: 'org-1',
      access: 'organization',
      acceptedAt: '1970-01-01T00:00:00.000Z',
    });
    // The first accept's time is kept too, not the repeat's.
    await expect(listAcceptedSharedContainers()).resolves.toEqual({
      'container-1': {
        organizationId: 'org-1',
        access: 'organization',
        acceptedAt: '1970-01-01T00:00:00.000Z',
      },
    });
  });

  it('keeps a legacy record without access when accepted again as direct', async () => {
    await writeFile(
      getSharedContainerAcceptanceFilePath(),
      JSON.stringify({
        version: 1,
        accepted: {
          'container-1': { organizationId: 'org-1', acceptedAt: 'then' },
        },
      }),
    );

    await acceptSharedContainer(
      'container-1',
      'org-1',
      () => new Date(0),
      'direct',
    );

    await expect(getSharedContainerAcceptance('container-1')).resolves.toEqual({
      organizationId: 'org-1',
      acceptedAt: 'then',
    });
  });

  it('writes a fresh record when accepting again after a dismiss', async () => {
    await acceptSharedContainer(
      'container-1',
      'org-1',
      () => new Date(0),
      'organization',
    );
    await forgetSharedContainerAcceptance('container-1');

    await acceptSharedContainer(
      'container-1',
      undefined,
      () => new Date(9_000),
      'direct',
    );

    await expect(getSharedContainerAcceptance('container-1')).resolves.toEqual({
      access: 'direct',
      acceptedAt: '1970-01-01T00:00:09.000Z',
    });
  });

  it('keeps run consent on a re-accept only for the same owner identity', async () => {
    await acceptSharedContainer('container-1', 'org-1', () => new Date(0));
    await allowSharedContainerRun(
      'container-1',
      'publisher-1',
      () => new Date(1_000),
    );

    await acceptSharedContainer('container-1', 'org-1', () => new Date(2_000));
    await expect(isSharedContainerRunAllowed('container-1')).resolves.toBe(
      true,
    );

    // A different owner identity still cannot inherit run consent, even though
    // the recorded identity itself is written once.
    await acceptSharedContainer('container-1', 'org-2', () => new Date(3_000));
    await expect(isSharedContainerRunAllowed('container-1')).resolves.toBe(
      false,
    );
    await expect(getSharedContainerAcceptance('container-1')).resolves.toEqual({
      organizationId: 'org-1',
      acceptedAt: '1970-01-01T00:00:00.000Z',
    });

    // The record keeps naming the first owner, so consent granted again is
    // dropped by the next accept under the other identity as well. It fails
    // closed; removing the share and accepting it again resets the record.
    await allowSharedContainerRun(
      'container-1',
      'publisher-1',
      () => new Date(4_000),
    );
    await acceptSharedContainer('container-1', 'org-2', () => new Date(5_000));
    await expect(isSharedContainerRunAllowed('container-1')).resolves.toBe(
      false,
    );
  });

  it('answers every accept with the identity the record holds', async () => {
    // A first accept answers with what it wrote.
    await expect(
      acceptSharedContainer(
        'container-1',
        'org-1',
        () => new Date(0),
        'organization',
      ),
    ).resolves.toEqual({
      organizationId: 'org-1',
      access: 'organization',
      acceptedAt: '1970-01-01T00:00:00.000Z',
    });
    await expect(
      acceptSharedContainer(
        'container-2',
        undefined,
        () => new Date(0),
        'direct',
      ),
    ).resolves.toEqual({
      access: 'direct',
      acceptedAt: '1970-01-01T00:00:00.000Z',
    });

    // A repeat accept answers with the record it kept, not the identity it
    // was called with, so a caller can mirror the record without a reread.
    await expect(
      acceptSharedContainer(
        'container-1',
        undefined,
        () => new Date(5_000),
        'direct',
      ),
    ).resolves.toEqual({
      organizationId: 'org-1',
      access: 'organization',
      acceptedAt: '1970-01-01T00:00:00.000Z',
    });

    // The same holds on the path that strips run consent.
    await allowSharedContainerRun(
      'container-1',
      'publisher-1',
      () => new Date(6_000),
    );
    await expect(
      acceptSharedContainer('container-1', 'org-2', () => new Date(7_000)),
    ).resolves.toEqual({
      organizationId: 'org-1',
      access: 'organization',
      acceptedAt: '1970-01-01T00:00:00.000Z',
    });
    await expect(isSharedContainerRunAllowed('container-1')).resolves.toBe(
      false,
    );
  });

  it('keeps concurrent accepts from clobbering each other', async () => {
    const epoch = (): Date => new Date(0);
    await Promise.all([
      acceptSharedContainer('container-1', 'org-1', epoch),
      acceptSharedContainer('container-2', 'org-1', epoch),
      acceptSharedContainer('container-3', 'org-2', epoch),
    ]);

    await expect(listAcceptedSharedContainers()).resolves.toEqual({
      'container-1': {
        organizationId: 'org-1',
        acceptedAt: '1970-01-01T00:00:00.000Z',
      },
      'container-2': {
        organizationId: 'org-1',
        acceptedAt: '1970-01-01T00:00:00.000Z',
      },
      'container-3': {
        organizationId: 'org-2',
        acceptedAt: '1970-01-01T00:00:00.000Z',
      },
    });
  });

  it('round-trips and revokes run consent without dropping acceptance', async () => {
    await acceptSharedContainer('container-1', 'org-1', () => new Date(0));
    await allowSharedContainerRun(
      'container-1',
      'publisher-1',
      () => new Date(1_000),
    );

    await expect(isSharedContainerRunAllowed('container-1')).resolves.toBe(
      true,
    );
    await expect(getSharedContainerAcceptance('container-1')).resolves.toEqual({
      organizationId: 'org-1',
      acceptedAt: '1970-01-01T00:00:00.000Z',
      runAllowedAt: '1970-01-01T00:00:01.000Z',
      runAllowedPublisherUserId: 'publisher-1',
    });

    await revokeSharedContainerRun('container-1');
    await expect(isSharedContainerRunAllowed('container-1')).resolves.toBe(
      false,
    );
    await expect(isSharedContainerAccepted('container-1')).resolves.toBe(true);
  });

  it('serializes startup and teardown work for the same container', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    const events: string[] = [];
    const first = withSharedContainerRunLifecycle(
      'container-1',
      async (): Promise<void> => {
        events.push('first-entered');
        markFirstEntered();
        await firstGate;
        events.push('first-leaving');
      },
    );
    await firstEntered;

    const second = withSharedContainerRunLifecycle(
      'container-1',
      (): Promise<void> => {
        events.push('second-entered');
        return Promise.resolve();
      },
    );
    await Promise.resolve();

    expect(events).toEqual(['first-entered']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual([
      'first-entered',
      'first-leaving',
      'second-entered',
    ]);
  });

  it('forgets acceptance for a dismissed or revoked container', async () => {
    await acceptSharedContainer('container-1', 'org-1');
    await acceptSharedContainer('container-2', 'org-1', () => new Date(0));

    await forgetSharedContainerAcceptance('container-1');

    await expect(isSharedContainerAccepted('container-1')).resolves.toBe(false);
    await expect(listAcceptedSharedContainers()).resolves.toEqual({
      'container-2': {
        organizationId: 'org-1',
        acceptedAt: '1970-01-01T00:00:00.000Z',
      },
    });
  });

  it.each([
    'not json at all',
    JSON.stringify({ version: 2, accepted: { 'container-1': {} } }),
    JSON.stringify({ version: 1, accepted: 'nope' }),
    JSON.stringify({
      version: 1,
      accepted: { 'container-1': { organizationId: 'org-1' } },
    }),
  ])(
    'fails closed on unusable persisted content rather than assuming consent',
    async (contents) => {
      await writeFile(getSharedContainerAcceptanceFilePath(), contents, 'utf8');

      await expect(isSharedContainerAccepted('container-1')).resolves.toBe(
        false,
      );
      await expect(listAcceptedSharedContainers()).resolves.toEqual({});
    },
  );
});
