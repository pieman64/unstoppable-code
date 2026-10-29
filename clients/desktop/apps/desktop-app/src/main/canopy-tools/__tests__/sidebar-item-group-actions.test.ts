import type { SidebarItemGroup } from '@canopy/protocol/sidebar';
import { sidebarItemGroupsService } from '../../services/sidebar-item-groups-service';
import {
  dispatchSidebarItemGroupAction,
  type ScopedSidebarItemGroupAction,
} from '../sidebar-item-group-actions';
import { scopedSidebarItemGroupSchemas } from '../sidebar-item-group-schema';

jest.mock('../../services/sidebar-item-groups-service', () => ({
  sidebarItemGroupsService: {
    create: jest.fn(),
    describe: jest.fn(),
    listItems: jest.fn(),
    moveItem: jest.fn(),
    update: jest.fn(),
  },
}));

const groupsService = jest.mocked(sidebarItemGroupsService);

describe('scoped sidebar item group actions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    groupsService.describe.mockResolvedValue([]);
  });

  it('accepts labelHidden for scoped item assignment and group updates', () => {
    expect(
      scopedSidebarItemGroupSchemas[2].safeParse({
        type: 'sidebar.item_groups.set_item',
        newGroup: { name: 'Tasks', labelHidden: true },
      }).success,
    ).toBe(true);
    expect(
      scopedSidebarItemGroupSchemas[3].safeParse({
        type: 'sidebar.item_groups.update',
        groupId: 'grp-tasks',
        labelHidden: true,
      }).success,
    ).toBe(true);
  });

  it('rejects non-boolean labelHidden values at the scoped boundary', () => {
    expect(
      scopedSidebarItemGroupSchemas[2].safeParse({
        type: 'sidebar.item_groups.set_item',
        newGroup: { name: 'Tasks', labelHidden: 'yes' },
      }).success,
    ).toBe(false);
    expect(
      scopedSidebarItemGroupSchemas[3].safeParse({
        type: 'sidebar.item_groups.update',
        groupId: 'grp-tasks',
        labelHidden: 'yes',
      }).success,
    ).toBe(false);
  });

  it('forwards labelHidden when set_item creates its new group', async () => {
    const group: SidebarItemGroup = {
      id: 'grp-tasks',
      name: 'Tasks',
      color: 'neutral',
      collapsed: false,
      labelHidden: true,
      memberIds: ['worktree-one'],
    };
    groupsService.create.mockResolvedValue(group);

    const action: ScopedSidebarItemGroupAction = {
      type: 'sidebar.item_groups.set_item',
      newGroup: { name: 'Tasks', labelHidden: true },
    };
    await dispatchSidebarItemGroupAction(action, {
      projectId: 'workspace-one',
      worktreeId: 'worktree-one',
    });

    expect(groupsService.create).toHaveBeenCalledWith({
      scope: { workspaceLocalId: 'workspace-one' },
      itemId: 'worktree-one',
      name: 'Tasks',
      labelHidden: true,
    });
  });

  it('forwards labelHidden when updating a scoped group', async () => {
    const action: ScopedSidebarItemGroupAction = {
      type: 'sidebar.item_groups.update',
      groupId: 'grp-tasks',
      labelHidden: true,
    };
    await dispatchSidebarItemGroupAction(action, {
      projectId: 'workspace-one',
      worktreeId: 'worktree-one',
    });

    expect(groupsService.update).toHaveBeenCalledWith({
      scope: { workspaceLocalId: 'workspace-one' },
      groupId: 'grp-tasks',
      name: undefined,
      color: undefined,
      collapsed: undefined,
      labelHidden: true,
    });
  });
});
