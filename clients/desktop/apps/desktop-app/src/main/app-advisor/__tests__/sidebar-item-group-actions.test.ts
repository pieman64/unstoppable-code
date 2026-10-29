import { appAdvisorActionSchema } from '../definitions';

describe('Advisor sidebar item group actions', () => {
  it('accepts each canonical group command with an explicit scope', () => {
    for (const action of [
      { type: 'sidebar.item_groups.list', scope: { appAdvisor: true } },
      {
        type: 'sidebar.item_groups.list_items',
        scope: { workspaceLocalId: 'workspace-one' },
        groupId: 'grp-one',
      },
      {
        type: 'sidebar.item_groups.set_item',
        scope: { workspaceLocalId: 'workspace-one' },
        itemId: 'entry-one',
        groupId: null,
      },
      {
        type: 'sidebar.item_groups.set_item',
        scope: { appAdvisor: true },
        itemId: 'entry-one',
        newGroup: {
          name: 'Tasks',
          color: 'categorical-2',
          labelHidden: true,
        },
      },
      {
        type: 'sidebar.item_groups.create',
        scope: { appAdvisor: true },
        itemId: 'entry-one',
        labelHidden: false,
      },
      {
        type: 'sidebar.item_groups.update',
        scope: { workspaceLocalId: 'workspace-one' },
        groupId: 'grp-one',
        collapsed: true,
        labelHidden: true,
      },
      {
        type: 'sidebar.item_groups.move_item',
        scope: { appAdvisor: true },
        itemId: 'entry-one',
        groupId: null,
        before: 'entry-two',
      },
      {
        type: 'sidebar.item_groups.move_group',
        scope: { appAdvisor: true },
        groupId: 'grp-one',
        after: 'entry-two',
      },
      {
        type: 'sidebar.item_groups.ungroup',
        scope: { appAdvisor: true },
        groupId: 'grp-one',
      },
    ])
      expect(appAdvisorActionSchema.safeParse(action).success).toBe(true);
  });
  it('rejects ambiguous scopes, paths, unknown colors and conflicting anchors', () => {
    for (const action of [
      {
        type: 'sidebar.item_groups.set_item',
        scope: { appAdvisor: true },
        itemId: 'entry-one',
      },
      {
        type: 'sidebar.item_groups.set_item',
        scope: { appAdvisor: true },
        itemId: 'entry-one',
        groupId: 'grp-one',
        newGroup: {},
      },
      {
        type: 'sidebar.item_groups.set_item',
        scope: { appAdvisor: true },
        itemId: 'entry-one',
        newGroup: { color: 'red' },
      },
      {
        type: 'sidebar.item_groups.set_item',
        scope: { appAdvisor: true },
        itemId: 'entry-one',
        newGroup: { labelHidden: 'yes' },
      },
      {
        type: 'sidebar.item_groups.list',
        scope: { appAdvisor: true, workspaceLocalId: 'workspace-one' },
      },
      {
        type: 'sidebar.item_groups.create',
        scope: { workspaceLocalId: '../outside' },
        itemId: 'entry-one',
      },
      {
        type: 'sidebar.item_groups.update',
        scope: { appAdvisor: true },
        groupId: 'grp-one',
        color: 'red',
      },
      {
        type: 'sidebar.item_groups.update',
        scope: { appAdvisor: true },
        groupId: 'grp-one',
        labelHidden: 'yes',
      },
      {
        type: 'sidebar.item_groups.move_item',
        scope: { appAdvisor: true },
        itemId: 'entry-one',
        groupId: null,
        before: 'entry-two',
        after: 'entry-three',
      },
    ])
      expect(appAdvisorActionSchema.safeParse(action).success).toBe(false);
  });
});

it('accepts sidebarGroupName on create and update automation actions', () => {
  const schedule = {
    kind: 'cron',
    expression: '0 9 * * *',
    timezone: 'local',
  };
  const promptActions = [
    { type: 'app_advisor_prompt', prompt: 'Review', sidebarGroupName: 'Daily' },
    {
      type: 'standalone_prompt',
      chatProjectId: 'cowork-one',
      prompt: 'Review',
      sidebarGroupName: 'Daily',
    },
    {
      type: 'worktree_prompt',
      workspaceId: 'workspace-one',
      prompt: 'Review',
      sidebarGroupName: 'Daily',
    },
  ];

  for (const action of promptActions) {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'automation.create',
        input: { name: 'Daily', schedule, action },
      }).success,
    ).toBe(true);
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'automation.update',
        id: 'activity-one',
        patch: { action },
      }).success,
    ).toBe(true);
  }
});
