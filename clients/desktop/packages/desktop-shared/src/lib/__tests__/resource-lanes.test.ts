import {
  LanePartitioned,
  laneKey,
  lanesForContext,
  composeLanePages,
} from '../resource-lanes';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';

const personal: WorkspaceContext = { kind: 'personal' };
const orgA: WorkspaceContext = { kind: 'organization', organizationId: 'a' };
const orgB: WorkspaceContext = { kind: 'organization', organizationId: 'b' };

describe('resource lanes', () => {
  it.each([
    [personal, ['personal']],
    [orgA, ['personal', 'organization:a']],
    [orgB, ['personal', 'organization:b']],
  ])('composes only the active context %j', (context, expected) => {
    expect(lanesForContext(context).map(laneKey)).toEqual(expected);
  });

  it('isolates cursors, etags and data by lane and authorization version', () => {
    const lanes = new LanePartitioned<string[]>();
    const version = { account: 'user', authorization: '1' };
    const a = lanes.get(orgA, version);
    a.cursor = 'a-page-2';
    a.etag = 'a-etag';
    a.value = ['a'];
    expect(lanes.get(orgB, version).value).toBeUndefined();
    expect(lanes.get(personal, version).cursor).toBeNull();
    expect(lanes.get(orgA, version)).toBe(a);
    expect(
      lanes.get(orgA, { ...version, authorization: '2' }).value,
    ).toBeUndefined();
    expect(
      lanes.get(orgA, { ...version, account: 'other' }).etag,
    ).toBeUndefined();
  });

  it('deduplicates within a lane and fences responses after invalidation', async () => {
    const lanes = new LanePartitioned<string[]>();
    const version = { account: 'user', authorization: '1' };
    let finish: (value: string[]) => void = () => undefined;
    const fetch = jest.fn(
      () =>
        new Promise<string[]>((resolve) => {
          finish = resolve;
        }),
    );
    const first = lanes.run(orgA, version, fetch);
    const duplicate = lanes.run(orgA, version, fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    lanes.clear();
    finish(['stale']);
    await expect(first).rejects.toThrow('Resource lane changed');
    await expect(duplicate).rejects.toThrow('Resource lane changed');
    expect(lanes.get(orgA, version).value).toBeUndefined();
  });
});

it('composes two lanes under one budget and resumes retained rows', () => {
  const pages = [
    {
      lane: personal,
      position: { cursor: '', offset: 0 },
      data: ['p0', 'p1', 'p2', 'p3'],
      nextCursor: null,
    },
    {
      lane: orgA,
      position: { cursor: '', offset: 0 },
      data: ['a0', 'a1', 'a2', 'a3'],
      nextCursor: null,
    },
  ];
  const first = composeLanePages(pages, 5);
  expect(first.data).toEqual(['p0', 'p1', 'p2', 'p3', 'a0']);
  expect(first.lanes.personal.cursor).toBeNull();
  expect(first.lanes['organization:a']).toEqual({ cursor: '', offset: 1 });
  const second = composeLanePages(
    pages
      .filter((page) => first.lanes[laneKey(page.lane)].cursor !== null)
      .map((page) => ({ ...page, position: first.lanes[laneKey(page.lane)] })),
    5,
  );
  expect(second.data).toEqual(['a1', 'a2', 'a3']);
  expect(second.lanes['organization:a'].cursor).toBeNull();
});
it('preserves a single lane page and its continuation', () => {
  expect(
    composeLanePages(
      [
        {
          lane: personal,
          position: { cursor: '', offset: 0 },
          data: ['p'],
          nextCursor: 'next',
        },
      ],
      5,
    ),
  ).toEqual({
    data: ['p'],
    lanes: { personal: { cursor: 'next', offset: 0 } },
  });
});

it('includes the mapped personal organization only in Personal', () => {
  expect(lanesForContext(personal, 'p').map(laneKey)).toEqual([
    'personal',
    'organization:p',
  ]);
  expect(lanesForContext(orgA, 'p').map(laneKey)).toEqual([
    'personal',
    'organization:a',
  ]);
  expect(lanesForContext(personal, null).map(laneKey)).toEqual(['personal']);
});
