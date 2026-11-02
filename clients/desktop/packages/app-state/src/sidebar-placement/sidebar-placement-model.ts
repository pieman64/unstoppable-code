import {
  anchorKeptSidebarItemGroups,
  isSidebarItemGroupRetained,
  normalizeGroupedOrder,
  resolveSidebarItemGroupCollapsed,
} from '@canopy/protocol/sidebar';
import type {
  SidebarItemGroup,
  SidebarItemGroupMoveItemRequest,
} from '@canopy/protocol/sidebar';

/** Membership projection shared by hosts; validation and collapse policy stay with the caller. */
export function moveSidebarItemMembership<T extends SidebarItemGroup>(
  groups: readonly T[],
  itemId: string,
  groupId: string | null,
): T[] {
  return groups.map((group) => ({
    ...group,
    memberIds:
      group.id === groupId
        ? [...group.memberIds.filter((id) => id !== itemId), itemId]
        : group.memberIds.filter((id) => id !== itemId),
  }));
}

export interface SidebarPlacementSnapshot {
  readonly order: readonly string[];
  readonly groups: readonly SidebarItemGroup[];
  readonly movableItemIds: ReadonlySet<string>;
}
export interface SidebarPlacementIntent {
  readonly id: number;
  readonly generation: number;
  readonly request: SidebarItemGroupMoveItemRequest;
  readonly membershipOnly: boolean;
  readonly status: 'queued' | 'saving' | 'acknowledged' | 'uncertain';
}

export function validSidebarPlacement(
  snapshot: SidebarPlacementSnapshot,
  request: SidebarItemGroupMoveItemRequest,
): boolean {
  const anchor = request.before ?? request.after;
  return (
    snapshot.movableItemIds.has(request.itemId) &&
    snapshot.order.includes(request.itemId) &&
    (anchor === undefined ||
      (anchor !== request.itemId &&
        snapshot.movableItemIds.has(anchor) &&
        snapshot.order.includes(anchor))) &&
    (request.groupId === null ||
      snapshot.groups.some((group) => group.id === request.groupId))
  );
}

/** Mirror the existing writer's row/empty-block placement without changing persistence. */
function placeManualItem(
  order: readonly string[],
  groups: readonly SidebarItemGroup[],
  request: SidebarItemGroupMoveItemRequest,
): string[] {
  const anchor = request.before ?? request.after;
  const target = groups.find((group) => group.id === request.groupId);
  if (
    anchor === undefined &&
    (!target || target.memberIds.includes(request.itemId))
  )
    return [...order];
  const rest = order.filter((id) => id !== request.itemId);
  let index: number;
  if (anchor !== undefined)
    index = rest.indexOf(anchor) + (request.after === undefined ? 0 : 1);
  else {
    const members = new Set(target?.memberIds);
    let lastMember = -1;
    rest.forEach((id, index) => {
      if (members.has(id)) lastMember = index;
    });
    if (lastMember >= 0) index = lastMember + 1;
    else {
      const retainedAnchor = target?.emptyAnchorId;
      const owner = groups.find(
        (group) =>
          retainedAnchor !== undefined &&
          group.memberIds.includes(retainedAnchor),
      );
      const roots = new Set(
        owner?.memberIds ??
          (retainedAnchor === undefined ? [] : [retainedAnchor]),
      );
      const slot = order.findIndex((id) => roots.has(id));
      const source = order.indexOf(request.itemId);
      index = slot < 0 ? rest.length : slot - (source < slot ? 1 : 0);
    }
  }
  rest.splice(index, 0, request.itemId);
  return rest;
}

/** Replay interface intents over authoritative inventory; never manufacture rows or groups. */
export function projectPlacements(
  confirmed: SidebarPlacementSnapshot,
  pending: readonly SidebarPlacementIntent[],
): SidebarPlacementSnapshot {
  let order = [...confirmed.order];
  let groups = anchorKeptSidebarItemGroups(confirmed.groups, order, {
    ineligibleItemIds: order.filter((id) => !confirmed.movableItemIds.has(id)),
  })
    .map((group) => ({
      ...group,
      memberIds: group.memberIds.filter((id) => confirmed.order.includes(id)),
    }))
    .filter(isSidebarItemGroupRetained);
  for (const intent of pending) {
    const request = intent.request;
    if (!validSidebarPlacement({ ...confirmed, order, groups }, request))
      continue;
    const before = groups;
    groups = moveSidebarItemMembership(groups, request.itemId, request.groupId)
      .map((group) => ({
        ...group,
        collapsed: resolveSidebarItemGroupCollapsed(
          group,
          before.find((previous) => previous.id === group.id)?.memberIds
            .length ?? 0,
        ),
      }))
      .filter(isSidebarItemGroupRetained);
    if (!intent.membershipOnly)
      order = normalizeGroupedOrder(
        placeManualItem(order, before, request),
        groups,
      );
    groups = anchorKeptSidebarItemGroups(groups, order, {
      ineligibleItemIds: order.filter(
        (id) => !confirmed.movableItemIds.has(id),
      ),
    });
  }
  return { order, groups, movableItemIds: confirmed.movableItemIds };
}

/** The desktop shell and Remote Control project the same Work Entry indices. */
export interface SidebarPlacementChat {
  readonly workEntryId?: string;
  readonly projectLocalId?: string;
  readonly workEntryOrder?: number;
}

export function projectSidebarPlacementOrders<
  T extends { readonly standaloneChats: readonly SidebarPlacementChat[] },
>(snapshot: T, orders: Readonly<Record<string, readonly string[]>>): T {
  if (Object.keys(orders).length === 0) return snapshot;
  const ranks = new Map(
    Object.entries(orders).map(([scope, order]) => [
      scope,
      new Map(order.map((id, index) => [id, index])),
    ]),
  );
  let changed = false;
  const standaloneChats = snapshot.standaloneChats.map((chat) => {
    const index =
      chat.workEntryId === undefined
        ? undefined
        : ranks
            .get(`workspace:${chat.projectLocalId ?? ''}`)
            ?.get(chat.workEntryId);
    if (index === undefined || index === chat.workEntryOrder) return chat;
    changed = true;
    return { ...chat, workEntryOrder: index };
  });
  return changed ? { ...snapshot, standaloneChats } : snapshot;
}
