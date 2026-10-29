import type { SharedPlanDetail } from '@canopy/protocol/plans';

jest.mock('../../canopy-cloud/client', () => ({
  assertCanopyCloudCapability: jest.fn(),
  requestCanopyCloudJson: jest.fn(),
}));

import {
  assertCanopyCloudCapability,
  requestCanopyCloudJson,
} from '../../canopy-cloud/client';
import { getSharedPlan } from '../canopy-server-client';

const mockedAssert = jest.mocked(assertCanopyCloudCapability);
const mockedRequest = jest.mocked(requestCanopyCloudJson);

function makeDetail(
  overrides: Partial<SharedPlanDetail> = {},
): SharedPlanDetail {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Plan One',
    content: 'Do the work',
    contentHash: 'content-hash',
    diagramsHash: 'diagram-hash',
    snapshotHash: 'server-snapshot',
    localRevisionNumber: 1,
    remoteRevisionNumber: 1,
    repositories: [],
    shareScope: 'private',
    owner: { type: 'user', id: 'user-1', name: 'Owner' },
    createdBy: { id: 'user-1', name: 'Owner', email: 'owner@example.test' },
    createdAt: '2026-06-09T12:06:00.000Z',
    updatedAt: '2026-06-09T12:06:00.000Z',
    canUpdate: true,
    canDelete: true,
    ...overrides,
  };
}

describe('getSharedPlan in-flight coalescing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedAssert.mockResolvedValue(undefined);
  });

  it('coalesces concurrent GETs for the same remote id into one request', async () => {
    const detail = makeDetail();
    let resolveRequest: ((value: SharedPlanDetail) => void) | undefined;
    mockedRequest.mockImplementation(
      () =>
        new Promise<SharedPlanDetail>((resolve) => {
          resolveRequest = resolve;
        }),
    );

    const first = getSharedPlan('remote-1');
    const second = getSharedPlan('remote-1');
    const third = getSharedPlan('remote-1');

    // Let the awaited capability check settle so the network call would fire.
    await Promise.resolve();
    await Promise.resolve();

    expect(mockedAssert).toHaveBeenCalledTimes(1);
    expect(mockedRequest).toHaveBeenCalledTimes(1);

    resolveRequest?.(detail);
    const [a, b, c] = await Promise.all([first, second, third]);

    expect(a).toBe(detail);
    expect(b).toBe(detail);
    expect(c).toBe(detail);
  });

  it('does not coalesce distinct remote ids', async () => {
    const detailA = makeDetail({ id: 'remote-a' });
    const detailB = makeDetail({ id: 'remote-b' });
    mockedRequest.mockImplementation((pathname: string) =>
      Promise.resolve(pathname.includes('remote-a') ? detailA : detailB),
    );

    const [a, b] = await Promise.all([
      getSharedPlan('remote-a'),
      getSharedPlan('remote-b'),
    ]);

    expect(mockedRequest).toHaveBeenCalledTimes(2);
    expect(a).toBe(detailA);
    expect(b).toBe(detailB);
  });

  it('issues a fresh request after the in-flight request settles (no stale cache)', async () => {
    const detail = makeDetail();
    mockedRequest.mockResolvedValue(detail);

    const first = await getSharedPlan('remote-1');
    const second = await getSharedPlan('remote-1');

    expect(first).toBe(detail);
    expect(second).toBe(detail);
    expect(mockedRequest).toHaveBeenCalledTimes(2);
  });

  it('clears the in-flight entry when the request rejects', async () => {
    mockedRequest.mockRejectedValueOnce(new Error('boom'));
    await expect(getSharedPlan('remote-1')).rejects.toThrow('boom');

    const detail = makeDetail();
    mockedRequest.mockResolvedValueOnce(detail);
    await expect(getSharedPlan('remote-1')).resolves.toBe(detail);
    expect(mockedRequest).toHaveBeenCalledTimes(2);
  });
});
