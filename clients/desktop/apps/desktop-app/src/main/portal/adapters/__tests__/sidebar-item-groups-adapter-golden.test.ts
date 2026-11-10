import type { PortalCommandEnvelope } from '@canopy/protocol/portal';
import type { SidebarItemGroup } from '@canopy/protocol/sidebar';
import { handlePortalSidebarItemGroupsAssignNamed } from '../sidebar-item-groups-adapter';
import type { PortalAdapterContext } from '../types';

let groups: SidebarItemGroup[] = [];
let rows = [{ id: 'entry-a' }, { id: 'entry-b' }, { id: 'entry-c' }];
const notify = jest.fn<void, []>();
jest.mock('../../../lib/worktree-update', () => ({
  reorderWorktreeGroupMembership: jest.fn(),
}));
jest.mock('../../../lib/chat-project-operation-queue', () => ({
  serializeWorkspaceMutation: (run: () => unknown): unknown => run(),
}));
jest.mock('../../../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(),
}));
jest.mock('../../../lib/workspace-persistence', () => ({
  readWorkspaceConfigDetailed: (): Promise<{
    authority: 'ok';
    config: { type: 'cowork' };
  }> =>
    Promise.resolve({
      authority: 'ok',
      config: { type: 'cowork' },
    }),
  setWorktreeRegistryReconciler: jest.fn(),
}));
jest.mock('../../../lib/cowork-migration-map', () => ({
  resolveCoworkWorkspaceId: (id: string): string => id,
}));
jest.mock('../../../lib/read-only-scope', () => ({
  assertWritableScope: jest.fn(),
}));
jest.mock('../../portal-event-bus', () => ({
  notifyPortalStructureChanged: (): void => notify(),
}));
jest.mock('../../../lib/cowork-work-entries', () => ({
  setWorkEntryRegistryReconciler: jest.fn(),
  updateWorkEntryRegistry: async (
    _id: string,
    change: (input: typeof rows) => Promise<typeof rows>,
    options: { afterWrite: () => Promise<void> },
  ): Promise<void> => {
    rows = await change(rows);
    await options.afterWrite();
  },
}));
jest.mock('../../../lib/sidebar-item-groups', () => ({
  readSidebarItemGroups: (): Promise<SidebarItemGroup[]> =>
    Promise.resolve(structuredClone(groups)),
  writeSidebarItemGroups: (
    _id: string,
    next: SidebarItemGroup[],
  ): Promise<void> => {
    groups = next;
    return Promise.resolve();
  },
  sidebarGroupInventory: (items: typeof rows): { liveItemIds: string[] } => ({
    liveItemIds: items.map((item) => item.id),
  }),
}));

const complete = jest.fn<
  ReturnType<PortalAdapterContext['complete']>,
  Parameters<PortalAdapterContext['complete']>
>();
const fail = jest.fn<
  ReturnType<PortalAdapterContext['fail']>,
  Parameters<PortalAdapterContext['fail']>
>();

function context(): PortalAdapterContext {
  return {
    complete,
    fail,
    enqueueEvent: jest.fn(),
    getWindow: () => null,
  };
}
function command(payload: unknown): PortalCommandEnvelope<unknown> {
  return {
    id: 'cmd-group',
    type: 'portal.sidebar.item_groups.assign_named',
    payload,
    sequence: 1,
    expiresAt: null,
    createdAt: '2026-11-04T00:00:00.000Z',
  };
}

function objectContaining<T extends object>(sample: Partial<T>): unknown {
  const matcher: unknown = expect.objectContaining(sample);
  return matcher;
}

beforeEach(() => {
  groups = [];
  rows = [{ id: 'entry-a' }, { id: 'entry-b' }, { id: 'entry-c' }];
  jest.clearAllMocks();
});

test('assign_named creates a group through the canonical transaction and broadcasts', async () => {
  const ctx = context();
  const cmd = command({
    scope: { workspaceLocalId: 'project-a' },
    itemId: 'entry-c',
    name: 'Team',
    color: 'categorical-1',
  });
  await handlePortalSidebarItemGroupsAssignNamed(cmd, ctx);
  expect(fail).not.toHaveBeenCalled();
  expect(complete).toHaveBeenCalledWith(cmd, {
    group: objectContaining<SidebarItemGroup>({
      name: 'Team',
      color: 'categorical-1',
      memberIds: ['entry-c'],
    }),
    created: true,
  });
  expect(groups).toHaveLength(1);
  expect(notify).toHaveBeenCalledTimes(1);
});

test('assign_named reuses the first nav-ordered match and keeps its color', async () => {
  groups = [
    {
      id: 'grp-later',
      name: 'Team',
      color: 'categorical-2',
      collapsed: false,
      memberIds: ['entry-b'],
    },
    {
      id: 'grp-first',
      name: 'Team',
      color: 'categorical-3',
      collapsed: false,
      memberIds: ['entry-a'],
    },
  ];
  const ctx = context();
  const cmd = command({
    scope: { workspaceLocalId: 'project-a' },
    itemId: 'entry-c',
    name: ' team ',
    color: 'categorical-1',
  });
  await handlePortalSidebarItemGroupsAssignNamed(cmd, ctx);
  expect(fail).not.toHaveBeenCalled();
  expect(complete).toHaveBeenCalledWith(cmd, {
    group: objectContaining<SidebarItemGroup>({
      id: 'grp-first',
      color: 'categorical-3',
      memberIds: ['entry-a', 'entry-c'],
    }),
    created: false,
  });
  expect(groups).toHaveLength(2);
});

test('assign_named accepts App Advisor scope', async () => {
  const ctx = context();
  await handlePortalSidebarItemGroupsAssignNamed(
    command({ scope: { appAdvisor: true }, itemId: 'entry-a', name: 'Team' }),
    ctx,
  );
  expect(fail).not.toHaveBeenCalled();
  expect(complete).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ created: true }),
  );
});

test.each([
  null,
  [],
  {},
  { scope: { workspaceLocalId: '../bad' }, itemId: 'entry-a', name: 'Team' },
  {
    scope: { workspaceLocalId: 'project-a', appAdvisor: true },
    itemId: 'entry-a',
    name: 'Team',
  },
  { scope: { appAdvisor: false }, itemId: 'entry-a', name: 'Team' },
  { scope: { workspaceLocalId: 'project-a' }, itemId: '../bad', name: 'Team' },
  { scope: { workspaceLocalId: 'project-a' }, itemId: 'entry-a', name: ' ' },
  { scope: { workspaceLocalId: 'project-a' }, itemId: 'entry-a', name: 3 },
  {
    scope: { workspaceLocalId: 'project-a' },
    itemId: 'entry-a',
    name: 'Team',
    color: 'invalid',
  },
  {
    scope: { workspaceLocalId: 'project-a' },
    itemId: 'entry-a',
    name: 'Team',
    hidden: true,
  },
])(
  'assign_named rejects malformed payload %# before writing',
  async (payload) => {
    const ctx = context();
    const cmd = command(payload);
    await handlePortalSidebarItemGroupsAssignNamed(cmd, ctx);
    expect(fail).toHaveBeenCalledWith(
      cmd,
      'invalid_payload',
      expect.any(String),
      false,
    );
    expect(complete).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  },
);
