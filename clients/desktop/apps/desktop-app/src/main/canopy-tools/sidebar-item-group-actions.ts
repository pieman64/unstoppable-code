import type { SidebarItemGroupAction } from '@canopy/desktop-shared/lib/sidebar-item-group-actions';
import type {
  AppAdvisorActionResponse,
  AppAdvisorJson,
} from '@canopy/desktop-shared/types';
import { sidebarItemGroupsService } from '../services/sidebar-item-groups-service';
import type { WorktreeActionRuntime } from './worktree-actions';

type InCurrentContext<T> = T extends { scope: unknown }
  ? Omit<T, 'scope' | 'itemId'>
  : never;
export type ScopedSidebarItemGroupAction = InCurrentContext<
  Extract<
    SidebarItemGroupAction,
    {
      type:
        | 'sidebar.item_groups.list'
        | 'sidebar.item_groups.list_items'
        | 'sidebar.item_groups.set_item'
        | 'sidebar.item_groups.update';
    }
  >
>;

function jsonValue(value: unknown): AppAdvisorJson {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  )
    return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, jsonValue(item)]),
    );
  throw new Error('Group action returned an unsupported value.');
}

/** Trusted chat context supplies both the project and the current sidebar item. */
export async function dispatchSidebarItemGroupAction(
  action: ScopedSidebarItemGroupAction,
  runtime: Pick<WorktreeActionRuntime, 'projectId' | 'worktreeId'>,
): Promise<AppAdvisorActionResponse> {
  const scope = { workspaceLocalId: runtime.projectId };
  try {
    if (action.type === 'sidebar.item_groups.list_items') {
      return {
        requestId: '',
        ok: true,
        result: jsonValue(
          await sidebarItemGroupsService.listItems({
            scope,
            groupId: action.groupId,
          }),
        ),
      };
    }
    if (action.type === 'sidebar.item_groups.list') {
      return {
        requestId: '',
        ok: true,
        result: jsonValue({
          groups: await sidebarItemGroupsService.describe(scope),
        }),
      };
    }
    let groupId: string | null | undefined;
    switch (action.type) {
      case 'sidebar.item_groups.set_item':
        if (action.newGroup !== undefined) {
          groupId = (
            await sidebarItemGroupsService.create({
              scope,
              itemId: runtime.worktreeId,
              ...action.newGroup,
            })
          ).id;
        } else {
          groupId = action.groupId;
          await sidebarItemGroupsService.moveItem({
            scope,
            itemId: runtime.worktreeId,
            groupId,
          });
        }
        break;
      case 'sidebar.item_groups.update':
        await sidebarItemGroupsService.update({
          scope,
          groupId: action.groupId,
          name: action.name,
          color: action.color,
          collapsed: action.collapsed,
          labelHidden: action.labelHidden,
          keepWhenEmpty: action.keepWhenEmpty,
        });
        break;
    }
    const acknowledged = {
      applied: action.type,
      groupId:
        groupId !== undefined
          ? groupId
          : action.type === 'sidebar.item_groups.update'
            ? action.groupId
            : null,
      ...(action.type === 'sidebar.item_groups.set_item'
        ? { itemId: runtime.worktreeId }
        : {}),
    };
    try {
      return {
        requestId: '',
        ok: true,
        result: jsonValue({
          ...acknowledged,
          groups: await sidebarItemGroupsService.describe(scope),
        }),
      };
    } catch {
      return {
        requestId: '',
        ok: true,
        result: jsonValue({ ...acknowledged, refreshFailed: true }),
      };
    }
  } catch (cause) {
    return {
      requestId: '',
      ok: false,
      error: {
        code: 'invalid_target',
        message: cause instanceof Error ? cause.message : String(cause),
      },
    };
  }
}
