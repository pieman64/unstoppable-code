import {
  isSidebarItemGroupColor,
  isSidebarItemGroupId,
  type SidebarItemGroup,
} from '@canopy/protocol/sidebar';
import type { AppAdvisorAction } from '../types';

export type SidebarItemGroupAction = Extract<
  AppAdvisorAction,
  { type: `sidebar.item_groups.${string}` }
>;

/** Validate untrusted action input before it reaches the existing owner bridge. */
export function isSidebarItemGroupAction(
  value: unknown,
): value is SidebarItemGroupAction {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('type' in value) ||
    !('scope' in value)
  )
    return false;
  const scope = value.scope;
  if (typeof scope !== 'object' || scope === null) return false;
  const id = (candidate: unknown): candidate is string =>
    typeof candidate === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(candidate);
  if (
    Object.keys(scope).length !== 1 ||
    !(
      ('appAdvisor' in scope && scope.appAdvisor === true) ||
      ('workspaceLocalId' in scope && id(scope.workspaceLocalId))
    )
  )
    return false;
  const name = 'name' in value ? value.name : undefined;
  const color = 'color' in value ? value.color : undefined;
  const collapsed = 'collapsed' in value ? value.collapsed : undefined;
  const labelHidden = 'labelHidden' in value ? value.labelHidden : undefined;
  const keepWhenEmpty =
    'keepWhenEmpty' in value ? value.keepWhenEmpty : undefined;
  const before = 'before' in value ? value.before : undefined;
  const after = 'after' in value ? value.after : undefined;
  if (
    (name !== undefined && typeof name !== 'string') ||
    (color !== undefined && !isSidebarItemGroupColor(color)) ||
    (collapsed !== undefined && typeof collapsed !== 'boolean') ||
    (labelHidden !== undefined && typeof labelHidden !== 'boolean') ||
    (keepWhenEmpty !== undefined && typeof keepWhenEmpty !== 'boolean') ||
    (before !== undefined && !id(before)) ||
    (after !== undefined && !id(after)) ||
    (before !== undefined && after !== undefined)
  )
    return false;
  const groupId = 'groupId' in value ? value.groupId : undefined;
  const itemId = 'itemId' in value ? value.itemId : undefined;
  const fields: Record<string, readonly string[]> = {
    'sidebar.item_groups.list': [],
    'sidebar.item_groups.list_items': ['groupId'],
    'sidebar.item_groups.set_item': ['itemId', 'groupId', 'newGroup'],
    'sidebar.item_groups.create': ['itemId', 'name', 'color', 'labelHidden'],
    'sidebar.item_groups.update': [
      'groupId',
      'name',
      'color',
      'collapsed',
      'labelHidden',
      'keepWhenEmpty',
    ],
    'sidebar.item_groups.move_item': ['itemId', 'groupId', 'before', 'after'],
    'sidebar.item_groups.move_group': ['groupId', 'before', 'after'],
    'sidebar.item_groups.ungroup': ['groupId'],
  };
  if (typeof value.type !== 'string') return false;
  const allowed = fields[value.type];
  if (
    !allowed ||
    Object.keys(value).some(
      (key) => key !== 'type' && key !== 'scope' && !allowed.includes(key),
    )
  )
    return false;
  switch (value.type) {
    case 'sidebar.item_groups.list':
      return true;
    case 'sidebar.item_groups.create':
      return id(itemId);
    case 'sidebar.item_groups.update':
    case 'sidebar.item_groups.list_items':
    case 'sidebar.item_groups.move_group':
    case 'sidebar.item_groups.ungroup':
      return isSidebarItemGroupId(groupId);
    case 'sidebar.item_groups.move_item':
      return id(itemId) && (groupId === null || isSidebarItemGroupId(groupId));
    case 'sidebar.item_groups.set_item': {
      if (!id(itemId)) return false;
      if ('groupId' in value)
        return (
          !('newGroup' in value) &&
          (groupId === null || isSidebarItemGroupId(groupId))
        );
      if (!('newGroup' in value)) return false;
      const group = value.newGroup;
      return (
        typeof group === 'object' &&
        group !== null &&
        !Array.isArray(group) &&
        Object.keys(group).every((key) =>
          ['name', 'color', 'labelHidden'].includes(key),
        ) &&
        (!('name' in group) || typeof group.name === 'string') &&
        (!('color' in group) || isSidebarItemGroupColor(group.color)) &&
        (!('labelHidden' in group) || typeof group.labelHidden === 'boolean')
      );
    }
    default:
      return false;
  }
}

/** Group order follows the canonical item registry, including whole-group moves. */
export function orderedSidebarItemGroups(
  groups: readonly SidebarItemGroup[],
  itemOrder: readonly string[],
): Array<SidebarItemGroup & { order: number }> {
  const positions = new Map(itemOrder.map((id, index) => [id, index]));
  const ranked = groups.map((group) => ({
    group,
    position: Math.min(
      itemOrder.length,
      ...group.memberIds.map((id) => positions.get(id) ?? itemOrder.length),
    ),
  }));
  const blocks = new Map<string, number>();
  for (const { group, position } of ranked)
    for (const id of group.memberIds) blocks.set(id, position);
  for (const entry of ranked) {
    if (entry.group.memberIds.length > 0) continue;
    const anchor = entry.group.emptyAnchorId;
    entry.position =
      anchor === undefined
        ? itemOrder.length
        : (blocks.get(anchor) ?? positions.get(anchor) ?? itemOrder.length);
  }
  return ranked
    .sort(
      (left, right) =>
        left.position - right.position ||
        Number(left.group.memberIds.length > 0) -
          Number(right.group.memberIds.length > 0),
    )
    .map(({ group }, order) => ({ ...group, order }));
}

/** Descendants project their root's membership without becoming independent members. */
export function sidebarItemGroupIds(
  groups: readonly SidebarItemGroup[],
  stackUnits: readonly (readonly string[])[],
): Map<string, string> {
  const rootGroups = new Map(
    groups.flatMap((group) =>
      group.memberIds.map((id) => [id, group.id] as const),
    ),
  );
  const result = new Map(rootGroups);
  for (const unit of stackUnits) {
    const root = unit[0];
    const groupId = root === undefined ? undefined : rootGroups.get(root);
    if (groupId) for (const itemId of unit) result.set(itemId, groupId);
  }
  return result;
}
