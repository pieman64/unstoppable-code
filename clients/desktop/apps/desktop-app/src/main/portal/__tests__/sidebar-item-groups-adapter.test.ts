jest.mock('../../services/sidebar-item-groups-service', () => ({
  sidebarItemGroupsService: {
    list: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    ungroup: jest.fn(),
    moveItem: jest.fn(),
    moveGroup: jest.fn(),
  },
}));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));
import type { SidebarItemGroup } from '@canopy/protocol/sidebar';
import { sidebarItemGroupsService } from '../../services/sidebar-item-groups-service';
import { handlePortalSidebarItemGroups } from '../adapters/sidebar-item-groups-adapter';
import type {
  PortalCommandEnvelope,
  PortalCommandType,
} from '@canopy/protocol/portal';
function command(
  type: PortalCommandType,
  payload: unknown,
): PortalCommandEnvelope<unknown> {
  return {
    id: 'cmd-a',
    type,
    payload,
    sequence: 1,
    createdAt: '2026-10-04T00:00:00.000Z',
    expiresAt: null,
  };
}
function context(): {
  getWindow: () => null;
  enqueueEvent: jest.Mock;
  complete: jest.Mock;
  fail: jest.Mock;
} {
  return {
    getWindow: () => null,
    enqueueEvent: jest.fn(),
    complete: jest.fn(),
    fail: jest.fn(),
  };
}
beforeEach(() => jest.resetAllMocks());
it('acknowledges creation only after the existing owner commits', async () => {
  const group: SidebarItemGroup = {
    id: 'grp-a',
    name: 'Review',
    color: 'neutral',
    collapsed: false,
    memberIds: ['entry-a'],
  };
  let resolve: ((group: SidebarItemGroup) => void) | undefined;
  jest.mocked(sidebarItemGroupsService.create).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const ctx = context();
  const cmd = command('portal.sidebar.item_groups.create', {
    scope: { appAdvisor: true },
    itemId: 'entry-a',
  });
  const pending = handlePortalSidebarItemGroups(cmd, ctx);
  expect(jest.mocked(ctx.complete)).not.toHaveBeenCalled();
  resolve?.(group);
  await pending;
  expect(jest.mocked(ctx.complete)).toHaveBeenCalledWith(cmd, group);
});
it('returns a path-free failure without success when the owner rejects', async () => {
  jest
    .mocked(sidebarItemGroupsService.moveItem)
    .mockRejectedValue(
      new Error('/private/owner/sidebar-item-groups.json rename failed'),
    );
  const ctx = context();
  const cmd = command('portal.sidebar.item_groups.move_item', {
    scope: { workspaceLocalId: 'ws-a' },
    itemId: 'entry-a',
    groupId: null,
  });
  await handlePortalSidebarItemGroups(cmd, ctx);
  expect(jest.mocked(ctx.complete)).not.toHaveBeenCalled();
  expect(jest.mocked(ctx.fail)).toHaveBeenCalledWith(
    cmd,
    'execution_failed',
    'Could not update the sidebar group. Refresh and try again.',
    false,
  );
});
it('rejects ambiguous list scopes before reading any owner', async () => {
  const ctx = context();
  await handlePortalSidebarItemGroups(
    command('portal.sidebar.item_groups.list', {
      scope: { appAdvisor: true, workspaceLocalId: 'ws-a' },
    }),
    ctx,
  );
  expect(sidebarItemGroupsService.list).not.toHaveBeenCalled();
  expect(jest.mocked(ctx.fail)).toHaveBeenCalledTimes(1);
});
it('lists the explicit workspace owner', async () => {
  jest.mocked(sidebarItemGroupsService.list).mockResolvedValue([]);
  const ctx = context();
  const cmd = command('portal.sidebar.item_groups.list', {
    scope: { workspaceLocalId: 'ws-a' },
  });
  await handlePortalSidebarItemGroups(cmd, ctx);
  expect(sidebarItemGroupsService.list).toHaveBeenCalledWith({
    workspaceLocalId: 'ws-a',
  });
  expect(jest.mocked(ctx.complete)).toHaveBeenCalledWith(cmd, { groups: [] });
});
