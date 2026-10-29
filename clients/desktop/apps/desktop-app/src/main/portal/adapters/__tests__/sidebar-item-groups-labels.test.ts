jest.mock('../../../services/sidebar-item-groups-service', () => ({
  sidebarItemGroupsService: {
    list: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    ungroup: jest.fn(),
    moveItem: jest.fn(),
    moveGroup: jest.fn(),
  },
}));
jest.mock('../../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));
import type { SidebarItemGroup } from '@canopy/protocol/sidebar';
import type {
  PortalCommandEnvelope,
  PortalCommandType,
} from '@canopy/protocol/portal';
import { sidebarItemGroupsService } from '../../../services/sidebar-item-groups-service';
import { handlePortalSidebarItemGroups } from '../sidebar-item-groups-adapter';

function command(
  type: PortalCommandType,
  payload: unknown,
): PortalCommandEnvelope<unknown> {
  return {
    id: 'cmd-label',
    type,
    payload,
    sequence: 1,
    createdAt: '2026-10-09T00:00:00.000Z',
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

it('passes create label visibility to the existing owner and waits to acknowledge', async () => {
  const group: SidebarItemGroup = {
    id: 'grp-a',
    name: 'Docs',
    color: 'neutral',
    collapsed: false,
    labelHidden: true,
    memberIds: ['item-a'],
  };
  jest.mocked(sidebarItemGroupsService.create).mockResolvedValue(group);
  const ctx = context();
  const payload = {
    scope: { appAdvisor: true },
    itemId: 'item-a',
    name: 'Docs',
    labelHidden: true,
  };
  const cmd = command('portal.sidebar.item_groups.create', payload);

  await handlePortalSidebarItemGroups(cmd, ctx);

  expect(sidebarItemGroupsService.create).toHaveBeenCalledWith(payload);
  expect(ctx.complete).toHaveBeenCalledWith(cmd, group);
  expect(ctx.fail).not.toHaveBeenCalled();
});

it('passes false label visibility updates without adding a Portal command', async () => {
  const ctx = context();
  const payload = {
    scope: { workspaceLocalId: 'workspace-a' },
    groupId: 'grp-a',
    labelHidden: false,
  };
  const cmd = command('portal.sidebar.item_groups.update', payload);

  await handlePortalSidebarItemGroups(cmd, ctx);

  expect(sidebarItemGroupsService.update).toHaveBeenCalledWith(payload);
  expect(ctx.complete).toHaveBeenCalledWith(cmd, { ok: true });
  expect(ctx.fail).not.toHaveBeenCalled();
});
