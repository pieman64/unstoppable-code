import type { SidebarItemGroup } from '@canopy/protocol/sidebar';
import { orderSidebarRows, type SidebarSortMode } from './sidebar-ordering';

/** Hosts supply complete root-first stack units, before caps or collapse. */
export interface SidebarItemGroupUnit {
  rootId: string;
  itemIds: readonly string[];
  pinned?: boolean;
  hidden?: boolean;
  recencyMs?: number;
}

export interface SidebarItemGroupBlock {
  kind: 'item' | 'group';
  id: string;
  group?: SidebarItemGroup;
  units: readonly SidebarItemGroupUnit[];
  visibleItemIds: readonly string[];
  retainedSelection?: boolean;
}

/** The slot a row asked for when it joined a group; neither side means the last slot. */
export interface SidebarItemGroupPendingPlacement {
  itemId: string;
  before?: string;
  after?: string;
}

/** Presentation-only membership retained while a host awaits registry reload. */
export interface SidebarItemGroupView extends SidebarItemGroup {
  retainedMemberIds?: readonly string[];
  /** Requests for rows that joined after `retainedMemberIds` was current. */
  pendingPlacements?: readonly SidebarItemGroupPendingPlacement[];
}

/**
 * A row that joined while the manual order still predates it has no slot of
 * its own yet. Show it where it asked to go, which is where the registry will
 * put it, instead of wherever the stale order happens to leave it. A row with
 * no recorded request (a created one arrives already ordered) stays put.
 */
function placePendingMembers(
  ordered: readonly SidebarItemGroupUnit[],
  retainedIds: ReadonlySet<string>,
  placements: readonly SidebarItemGroupPendingPlacement[],
): SidebarItemGroupUnit[] {
  const placed = [...ordered];
  for (const placement of placements) {
    const anchorId = placement.before ?? placement.after;
    if (retainedIds.has(placement.itemId) || anchorId === placement.itemId)
      continue;
    const from = placed.findIndex(
      (member) => member.rootId === placement.itemId,
    );
    const member = placed[from];
    if (member === undefined) continue;
    if (anchorId === undefined) {
      placed.splice(from, 1);
      placed.push(member);
      continue;
    }
    if (!placed.some((other) => other.rootId === anchorId)) continue;
    placed.splice(from, 1);
    const anchor = placed.findIndex((other) => other.rootId === anchorId);
    placed.splice(
      placement.before === undefined ? anchor + 1 : anchor,
      0,
      member,
    );
  }
  return placed;
}

export function buildSidebarItemGroupBlocks(
  units: readonly SidebarItemGroupUnit[],
  groups: readonly SidebarItemGroupView[],
  mode: SidebarSortMode,
  selectedId?: string,
): SidebarItemGroupBlock[] {
  const membership = new Map<string, SidebarItemGroupView>();
  for (const group of groups) {
    for (const id of group.memberIds) {
      if (!membership.has(id)) membership.set(id, group);
    }
  }
  const blocks: SidebarItemGroupBlock[] = [];
  const emitted = new Set<string>();
  const eligible = units.filter((unit) => !unit.hidden);
  const anchors = new Map<string, string>();
  if (mode === 'manual') {
    for (const unit of eligible) {
      if (unit.pinned) continue;
      const groupId = membership.get(unit.rootId)?.id;
      if (groupId && !anchors.has(groupId)) anchors.set(groupId, unit.rootId);
    }
    for (const group of groups) {
      // A pending membership change retains its old slot until registry reload.
      // Authoritative snapshots use registry order, which also drives drop targets.
      if (!group.retainedMemberIds) continue;
      const retainedIds = new Set(group.retainedMemberIds);
      const retainedAnchor = eligible.find(
        (unit) =>
          !unit.pinned &&
          retainedIds.has(unit.rootId) &&
          membership.get(unit.rootId)?.id === group.id,
      )?.rootId;
      if (retainedAnchor !== undefined) anchors.set(group.id, retainedAnchor);
    }
  }
  for (const unit of eligible) {
    const group = unit.pinned ? undefined : membership.get(unit.rootId);
    if (!group) {
      blocks.push({
        kind: 'item',
        id: unit.rootId,
        units: [unit],
        visibleItemIds: unit.itemIds,
      });
      continue;
    }
    if (emitted.has(group.id)) continue;
    if (mode === 'manual' && anchors.get(group.id) !== unit.rootId) continue;
    emitted.add(group.id);
    const ordered = orderSidebarRows(
      eligible.filter(
        (member) =>
          !member.pinned && membership.get(member.rootId)?.id === group.id,
      ),
      { mode, isPinned: () => false, recencyMs: (member) => member.recencyMs },
    );
    const members =
      mode === 'manual' && group.retainedMemberIds && group.pendingPlacements
        ? placePendingMembers(
            ordered,
            new Set(group.retainedMemberIds),
            group.pendingPlacements,
          )
        : ordered;
    const itemIds = members.flatMap((member) => [...member.itemIds]);
    blocks.push({
      kind: 'group',
      id: group.id,
      group,
      units: members,
      visibleItemIds: group.collapsed
        ? itemIds.filter((id) => id === selectedId)
        : itemIds,
    });
  }
  const ordered = orderSidebarRows(blocks, {
    mode,
    isPinned: (block) =>
      block.kind === 'item' && block.units[0]?.pinned === true,
    recencyMs: (block) => {
      const times = block.units.flatMap((unit) =>
        unit.recencyMs === undefined ? [] : [unit.recencyMs],
      );
      return times.length ? Math.max(...times) : undefined;
    },
  });
  // An empty kept group, and one whose first row is still joining it, holds
  // the slot it had before it emptied: above its anchor's block, else last.
  for (const group of groups) {
    const empty = group.keepWhenEmpty === true && !emitted.has(group.id);
    const joining = mode === 'manual' && group.retainedMemberIds?.length === 0;
    if (!empty && !joining) continue;
    const anchorId = group.emptyAnchorId;
    const holds = (block: SidebarItemGroupBlock): boolean =>
      anchorId !== undefined &&
      block.units.some((unit) => unit.itemIds.includes(anchorId));
    const from = ordered.findIndex((block) => block.group?.id === group.id);
    const block = ordered[from] ?? {
      kind: 'group' as const,
      id: group.id,
      group,
      units: [],
      visibleItemIds: [],
    };
    // A row that was the anchor joined in place, which is where main keeps it.
    if (holds(block)) continue;
    if (from >= 0) ordered.splice(from, 1);
    const anchor = ordered.findIndex(
      (other) => other.units[0]?.pinned !== true && holds(other),
    );
    ordered.splice(anchor < 0 ? ordered.length : anchor, 0, block);
  }
  return ordered;
}

/** A block that starts within the cap is rendered whole. Authority is untouched. */
export function capSidebarItemGroupBlocks(
  blocks: readonly SidebarItemGroupBlock[],
  cap: number,
  selectedId?: string,
): { visible: SidebarItemGroupBlock[]; hidden: SidebarItemGroupBlock[] } {
  const visible: SidebarItemGroupBlock[] = [];
  const hidden: SidebarItemGroupBlock[] = [];
  let used = 0;
  for (const block of blocks) {
    if (used < cap) {
      visible.push(block);
      used += block.group?.collapsed
        ? 1
        : Math.max(1, block.visibleItemIds.length);
    } else {
      hidden.push(block);
      if (
        selectedId &&
        block.units.some((unit) => unit.itemIds.includes(selectedId))
      ) {
        visible.push({
          ...block,
          group: block.group ? { ...block.group, collapsed: true } : undefined,
          retainedSelection: true,
          visibleItemIds: [selectedId],
        });
      }
    }
  }
  return { visible, hidden };
}

export type SidebarItemGroupDropTarget =
  | { kind: 'row'; rootId: string; half: 'before' | 'after' }
  /** `inside` is any group's header or body, collapsed or not: it joins at the end. */
  | {
      kind: 'collapsed-group';
      groupId: string;
      third: 'before' | 'inside' | 'after';
    }
  | { kind: 'block'; blockId: string; edge: 'before' | 'after' };

export interface SidebarItemGroupDrop {
  groupId: string | null;
  before?: string;
  after?: string;
  membershipOnly: boolean;
}

export interface SidebarItemGroupKeyboardDragState {
  targetIndex: number;
}

/** Keyboard sensors share the pointer drop table and never synthesize nesting. */
export function stepSidebarItemGroupKeyboardDrag(
  blocks: readonly SidebarItemGroupBlock[],
  source: { kind: 'item' | 'group'; id: string },
  mode: SidebarSortMode,
  state: SidebarItemGroupKeyboardDragState | null,
  key: string,
): {
  state: SidebarItemGroupKeyboardDragState | null;
  drop: SidebarItemGroupDrop | null;
  handled: boolean;
} {
  const sourceBlock = blocks.find((block) =>
    source.kind === 'group'
      ? block.group?.id === source.id
      : block.units.some((unit) => unit.rootId === source.id),
  );
  const sourceUnit = sourceBlock?.units.find(
    (unit) => unit.rootId === source.id,
  );
  const capabilities = sourceUnit
    ? sidebarItemGroupDragCapabilities(mode, sourceUnit)
    : null;
  if (
    !sourceBlock ||
    (source.kind === 'group'
      ? mode !== 'manual'
      : !capabilities || (!capabilities.membership && !capabilities.reorder))
  )
    return { state: null, drop: null, handled: false };
  const zones: SidebarItemGroupDropTarget[] = [];
  for (const block of blocks) {
    zones.push({ kind: 'block', blockId: block.id, edge: 'before' });
    if (source.kind === 'item') {
      if (!block.group?.collapsed)
        for (const unit of block.units) {
          zones.push(
            { kind: 'row', rootId: unit.rootId, half: 'before' },
            { kind: 'row', rootId: unit.rootId, half: 'after' },
          );
        }
      // After the rows, so the slot it shares with the last row keeps its line.
      if (block.group)
        zones.push({
          kind: 'collapsed-group',
          groupId: block.id,
          third: 'inside',
        });
    }
    zones.push({ kind: 'block', blockId: block.id, edge: 'after' });
  }
  const sourceIds = new Set(
    source.kind === 'group'
      ? sourceBlock.units.map((unit) => unit.rootId)
      : [source.id],
  );
  const rootsFor = (groupId: string | null): string[] =>
    (groupId
      ? (blocks.find((block) => block.group?.id === groupId)?.units ?? [])
      : blocks.flatMap((block) => [...block.units])
    ).map((unit) => unit.rootId);
  const currentGroupId =
    source.kind === 'item' ? (sourceBlock.group?.id ?? null) : null;
  const membershipOnly = mode !== 'manual' && sourceUnit?.pinned !== true;
  const currentRoots = rootsFor(currentGroupId);
  const currentSlot = currentRoots.findIndex((id) => sourceIds.has(id));
  const currentKey = JSON.stringify(
    membershipOnly ? [currentGroupId] : [currentGroupId, currentSlot],
  );
  const targets: (SidebarItemGroupDrop | null)[] = [];
  const seen = new Set<string>();
  let initialIndex = -1;
  for (const zone of zones) {
    const currentZone =
      source.kind === 'group'
        ? zone.kind === 'block' &&
          zone.blockId === source.id &&
          zone.edge === 'before'
        : sourceBlock.group?.collapsed
          ? zone.kind === 'collapsed-group' &&
            zone.groupId === sourceBlock.id &&
            zone.third === 'inside'
          : zone.kind === 'row' &&
            zone.rootId === source.id &&
            zone.half === 'before';
    if (currentZone) {
      initialIndex = targets.length;
      targets.push(null);
      continue;
    }
    const drop = resolveSidebarItemGroupDrop(blocks, source, zone, mode);
    if (!drop) continue;
    const roots = rootsFor(drop.groupId).filter((id) => !sourceIds.has(id));
    const slot =
      drop.before !== undefined
        ? roots.indexOf(drop.before)
        : drop.after !== undefined
          ? roots.indexOf(drop.after) + 1
          : roots.length;
    const key = JSON.stringify(
      drop.membershipOnly ? [drop.groupId] : [drop.groupId, slot],
    );
    if (key === currentKey || seen.has(key)) continue;
    seen.add(key);
    targets.push(drop);
  }
  if (initialIndex < 0 || !seen.size)
    return { state: null, drop: null, handled: false };
  if (key === 'Escape' && state)
    return { state: null, drop: null, handled: true };
  if (key === ' ')
    return state
      ? { state: null, drop: targets[state.targetIndex] ?? null, handled: true }
      : { state: { targetIndex: initialIndex }, drop: null, handled: true };
  if (
    state &&
    ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(key)
  ) {
    const direction = key === 'ArrowDown' || key === 'ArrowRight' ? 1 : -1;
    return {
      state: {
        targetIndex:
          (state.targetIndex + direction + targets.length) % targets.length,
      },
      drop: null,
      handled: true,
    };
  }
  return { state, drop: null, handled: false };
}

export function sidebarItemGroupDragCapabilities(
  mode: SidebarSortMode,
  unit: SidebarItemGroupUnit,
): { membership: boolean; reorder: boolean } {
  return {
    membership: !unit.pinned && !unit.hidden,
    reorder: !unit.hidden && (unit.pinned === true || mode === 'manual'),
  };
}

/** Pointer and keyboard sensors project the same zones into this pure table. */
export function resolveSidebarItemGroupDrop(
  blocks: readonly SidebarItemGroupBlock[],
  source: { kind: 'item' | 'group'; id: string },
  target: SidebarItemGroupDropTarget,
  mode: SidebarSortMode,
): SidebarItemGroupDrop | null {
  const sourceBlock = blocks.find((block) =>
    source.kind === 'group'
      ? block.group?.id === source.id
      : block.units.some((unit) => unit.rootId === source.id),
  );
  if (!sourceBlock || (source.kind === 'group' && mode !== 'manual'))
    return null;
  const sourceUnit = sourceBlock.units.find(
    (unit) => unit.rootId === source.id,
  );
  if (
    source.kind === 'item' &&
    (!sourceUnit ||
      (!sidebarItemGroupDragCapabilities(mode, sourceUnit).membership &&
        !sidebarItemGroupDragCapabilities(mode, sourceUnit).reorder))
  )
    return null;
  const block = blocks.find((entry) =>
    target.kind === 'row'
      ? entry.units.some((unit) => unit.rootId === target.rootId)
      : entry.id ===
        (target.kind === 'block' ? target.blockId : target.groupId),
  );
  const sourcePinned = source.kind === 'item' && sourceUnit?.pinned === true;
  // An empty group has no rows to place against; it only accepts members.
  const inside = target.kind === 'collapsed-group' && target.third === 'inside';
  if (block?.units.length === 0 && !inside) return null;
  if (
    !block ||
    block.units.some((unit) => unit.pinned === true) !== sourcePinned ||
    (source.kind === 'group' && block.id === source.id)
  )
    return null;
  if (
    mode !== 'manual' &&
    !sourcePinned &&
    source.kind === 'item' &&
    sourceBlock.group?.id === block.group?.id
  )
    return null;
  if (
    source.kind === 'group' &&
    target.kind === 'row' &&
    (target.half === 'before'
      ? block.units[0]?.rootId
      : block.units[block.units.length - 1]?.rootId) !== target.rootId
  )
    return null;
  let groupId: string | null = null;
  let before: string | undefined;
  let after: string | undefined;
  if (target.kind === 'row' && source.kind === 'item') {
    groupId = block.group?.id ?? null;
    if (target.half === 'before') before = target.rootId;
    else after = target.rootId;
  } else if (target.kind === 'collapsed-group' && target.third === 'inside') {
    if (source.kind === 'group' || !block.group) return null;
    groupId = block.group.id;
    after = block.units[block.units.length - 1]?.rootId;
  } else {
    const edge =
      target.kind === 'row'
        ? target.half
        : target.kind === 'block'
          ? target.edge
          : target.third;
    if (edge === 'before') before = block.units[0]?.rootId;
    else after = block.units[block.units.length - 1]?.rootId;
  }
  if (source.kind === 'item' && (before === source.id || after === source.id))
    return null;
  return {
    groupId,
    before: mode === 'manual' || sourcePinned ? before : undefined,
    after: mode === 'manual' || sourcePinned ? after : undefined,
    membershipOnly: mode !== 'manual' && !sourcePinned,
  };
}

/**
 * Moves that carry a bulk selection (CAN-3975) to where the dragged row's
 * `drop` put it, together and in rail order. `itemIds` are the selection's
 * movable roots in rail order. A membership-only drop moves each row not
 * already in the group; an ordered drop places the first row at the slot and
 * each next one after the one before, so the selection lands contiguous. A
 * slot beside another selected row is re-anchored on the nearest row staying
 * put, since that row is about to move too.
 */
export function sidebarItemGroupMultiMoves(
  blocks: readonly SidebarItemGroupBlock[],
  itemIds: readonly string[],
  drop: SidebarItemGroupDrop,
): { itemId: string; drop: SidebarItemGroupDrop }[] {
  if (drop.membershipOnly) {
    const groupOf = new Map(
      blocks.flatMap((block) =>
        block.units.map((unit) => [unit.rootId, block.group?.id ?? null]),
      ),
    );
    return itemIds
      .filter((id) => groupOf.get(id) !== drop.groupId)
      .map((itemId) => ({
        itemId,
        drop: { groupId: drop.groupId, membershipOnly: true },
      }));
  }
  const moving = new Set(itemIds);
  const roots = (
    drop.groupId === null
      ? blocks.flatMap((block) => [...block.units])
      : (blocks.find((block) => block.group?.id === drop.groupId)?.units ?? [])
  )
    .filter((unit) => unit.pinned !== true)
    .map((unit) => unit.rootId);
  const staying = roots.filter((id) => !moving.has(id));
  let { before, after } = drop;
  if (before !== undefined && moving.has(before)) {
    const index = roots.indexOf(before);
    before = roots.slice(index + 1).find((id) => !moving.has(id));
    if (before === undefined) after = staying[staying.length - 1];
  } else if (after !== undefined && moving.has(after)) {
    const index = roots.indexOf(after);
    after = roots
      .slice(0, Math.max(index, 0))
      .reverse()
      .find((id) => !moving.has(id));
    if (after === undefined) before = staying[0];
  }
  return itemIds.map((itemId, index) => {
    const previous = itemIds[index - 1];
    const slot =
      previous !== undefined
        ? { after: previous }
        : before !== undefined
          ? { before }
          : after !== undefined
            ? { after }
            : {};
    return {
      itemId,
      drop: { groupId: drop.groupId, ...slot, membershipOnly: false },
    };
  });
}
