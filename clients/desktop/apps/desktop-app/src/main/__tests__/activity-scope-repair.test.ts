import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  WorkspaceOwnerBinding,
  WorkspaceOwnershipTransfer,
} from '@canopy/desktop-shared/types';
import { CanopyCloudClientError } from '../canopy-cloud/client';
import {
  activityRepairTarget,
  classifyActivityRepairFailure,
  createActivityRepairLedger,
  normalizeActivityRepairLedger,
} from '../lib/activity-scope-repair';

const organizationId = '11111111-1111-4111-8111-111111111111';
const projectId = '33333333-3333-4333-8333-333333333333';
const owner: WorkspaceOwnerBinding = {
  type: 'organization',
  organizationId,
  projectId,
  instanceId: '44444444-4444-4444-8444-444444444444',
  bindingGeneration: 0,
};
const converted: WorkspaceOwnershipTransfer = {
  version: 1,
  previousOwner: { type: 'personal' },
  organizationId,
  projectId,
  convertedAt: '2026-09-27T00:00:00.000Z',
};

describe('activityRepairTarget (CAN-3517)', (): void => {
  it('follows the converted project, repairs other bound work, and returns Personal work', (): void => {
    expect(
      activityRepairTarget({ owner, ownershipTransfer: converted }),
    ).toEqual({ kind: 'converted', projectId });
    expect(activityRepairTarget({ owner })).toEqual({
      kind: 'organization',
      organizationId,
      projectId,
      key: `organization:${organizationId}:${projectId}`,
    });
    // Converted into another project, or moved back and set up again.
    expect(
      activityRepairTarget({
        owner,
        ownershipTransfer: { ...converted, projectId: organizationId },
      }),
    ).toMatchObject({ kind: 'organization' });
    expect(activityRepairTarget({})).toEqual({
      kind: 'personal',
      key: 'personal',
    });
  });

  it('never returns the activity of a project that was moved back', (): void => {
    expect(
      activityRepairTarget({
        ownershipTransfer: {
          ...converted,
          movedBackAt: '2026-09-28T00:00:00.000Z',
        },
      }),
    ).toBeNull();
  });
});

describe('classifyActivityRepairFailure', (): void => {
  it('retries what can change and remembers what cannot', (): void => {
    for (const error of [
      new CanopyCloudClientError('network-error', 'offline'),
      new CanopyCloudClientError('http-error', 'Not found', 404),
      new CanopyCloudClientError('http-error', 'Slow down', 429),
      new CanopyCloudClientError('http-error', 'Busy', 409, 'conflict'),
      new CanopyCloudClientError('http-error', 'Not yet', 409, 'not_converted'),
      new CanopyCloudClientError('http-error', 'Down', 503),
      new Error('unknown'),
    ]) {
      expect(classifyActivityRepairFailure(error)).toBe('retry');
    }
    expect(
      classifyActivityRepairFailure(
        new CanopyCloudClientError(
          'http-error',
          'Withheld',
          403,
          'scope_prohibited',
        ),
      ),
    ).toBe('refused-scope_prohibited');
    expect(
      classifyActivityRepairFailure(
        new CanopyCloudClientError('http-error', 'Bad', 400),
      ),
    ).toBe('refused-invalid_request');
    expect(
      classifyActivityRepairFailure(
        new CanopyCloudClientError(
          'http-error',
          'Other repo',
          409,
          'repository_mismatch',
        ),
      ),
    ).toBe('refused-repository_mismatch');
  });
});

describe('activity repair ledger', (): void => {
  let root: string;
  beforeEach(async (): Promise<void> => {
    root = await mkdtemp(join(tmpdir(), 'activity-repair-'));
  });
  afterEach(async (): Promise<void> => {
    await rm(root, { recursive: true, force: true });
  });

  it('records each workspace per account and reads it back', async (): Promise<void> => {
    const file = join(root, 'activity-scope-repair.json');
    const ledger = createActivityRepairLedger(() => file);
    expect(await ledger.read('account-a')).toEqual({});
    await Promise.all([
      ledger.record('account-a', 'payments', {
        target: 'personal',
        outcome: 'returned',
        at: '2026-09-30T00:00:00.000Z',
      }),
      ledger.record('account-a', 'notes', {
        target: `organization:${organizationId}:${projectId}`,
        outcome: 'kept-private',
        at: '2026-09-30T00:00:00.000Z',
      }),
    ]);
    expect(Object.keys(await ledger.read('account-a')).sort()).toEqual([
      'notes',
      'payments',
    ]);
    expect(await ledger.read('account-b')).toEqual({});
    const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
    expect(raw).toMatchObject({ version: 1 });
  });

  it('reads a missing, corrupt or foreign file as empty', async (): Promise<void> => {
    const file = join(root, 'activity-scope-repair.json');
    await writeFile(file, '{not json');
    expect(await createActivityRepairLedger(() => file).read('a')).toEqual({});
    expect(
      normalizeActivityRepairLedger({
        version: 1,
        byAccount: {
          __proto__: { x: { target: 'personal', outcome: 'returned', at: '' } },
          ok: {
            good: { target: 'personal', outcome: 'returned', at: 'now' },
            '../bad': { target: 'personal', outcome: 'returned', at: 'now' },
            bad: { target: 1 },
          },
        },
      }),
    ).toEqual({
      version: 1,
      byAccount: {
        ok: { good: { target: 'personal', outcome: 'returned', at: 'now' } },
      },
    });
    expect(normalizeActivityRepairLedger({ version: 2 })).toEqual({
      version: 1,
      byAccount: {},
    });
  });
});
