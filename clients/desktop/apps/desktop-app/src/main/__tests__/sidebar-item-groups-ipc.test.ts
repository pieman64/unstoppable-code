jest.mock('../ipc/register', () => ({ registerIpcHandler: jest.fn() }));
jest.mock('../services/sidebar-item-groups-service', () => ({
  sidebarItemGroupsService: {
    list: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    ungroup: jest.fn(),
    moveItem: jest.fn(),
    moveGroup: jest.fn(),
  },
}));
jest.mock('../lib/window-send', () => ({ sendToAllWindows: jest.fn() }));
jest.mock('../services/desktop-session-snapshot-invalidation', () => ({
  scheduleDesktopSessionSnapshotInvalidation: jest.fn(),
}));
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { registerSidebarItemGroupHandlers } from '../ipc/sidebar-item-groups';
import { registerIpcHandler } from '../ipc/register';
import { sidebarItemGroupsService as service } from '../services/sidebar-item-groups-service';

function handler(channel: string): (request: unknown) => Promise<unknown> {
  const call = jest
    .mocked(registerIpcHandler)
    .mock.calls.find(([name]) => name === channel);
  if (!call) throw new Error('Expected handler');
  return (request): Promise<unknown> =>
    Promise.resolve(Reflect.apply(call[1], undefined, [undefined, request]));
}
beforeEach(() => {
  jest.clearAllMocks();
  registerSidebarItemGroupHandlers();
});
it('registers all typed host operations and forwards validation to the single service', async () => {
  const request = {
    scope: { workspaceLocalId: 'workspace-a' },
    groupId: 'grp-a',
  };
  for (const [channel, operation] of [
    [IPC_CHANNELS.sidebarItemGroupsList, service.list],
    [IPC_CHANNELS.sidebarItemGroupsCreate, service.create],
    [IPC_CHANNELS.sidebarItemGroupsUpdate, service.update],
    [IPC_CHANNELS.sidebarItemGroupsUngroup, service.ungroup],
    [IPC_CHANNELS.sidebarItemGroupsMoveItem, service.moveItem],
    [IPC_CHANNELS.sidebarItemGroupsMoveGroup, service.moveGroup],
  ] as const) {
    await handler(channel)(request);
    expect(operation).toHaveBeenCalledWith(request);
  }
});
it('forwards label visibility through the existing create and update channels', async () => {
  const createRequest = {
    scope: { workspaceLocalId: 'workspace-a' },
    itemId: 'item-a',
    name: 'Docs',
    labelHidden: true,
  };
  const updateRequest = {
    scope: { workspaceLocalId: 'workspace-a' },
    groupId: 'grp-a',
    labelHidden: false,
  };

  await handler(IPC_CHANNELS.sidebarItemGroupsCreate)(createRequest);
  await handler(IPC_CHANNELS.sidebarItemGroupsUpdate)(updateRequest);

  expect(service.create).toHaveBeenCalledWith(createRequest);
  expect(service.update).toHaveBeenCalledWith(updateRequest);
  expect(
    Object.keys(IPC_CHANNELS).filter((key) =>
      key.startsWith('sidebarItemGroups'),
    ),
  ).toEqual([
    'sidebarItemGroupsList',
    'sidebarItemGroupsCreate',
    'sidebarItemGroupsUpdate',
    'sidebarItemGroupsUngroup',
    'sidebarItemGroupsMoveItem',
    'sidebarItemGroupsMoveGroup',
    'sidebarItemGroupsChanged',
  ]);
});
it('never acknowledges a rejected durability operation', async () => {
  jest
    .mocked(service.moveItem)
    .mockRejectedValueOnce(new Error('membership unavailable'));
  await expect(
    handler(IPC_CHANNELS.sidebarItemGroupsMoveItem)({
      scope: { appAdvisor: true },
    }),
  ).rejects.toThrow('membership unavailable');
});
