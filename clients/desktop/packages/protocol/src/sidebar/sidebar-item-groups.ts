/** Browser-safe sidebar membership contracts; item order remains host-owned. */
import { SIDEBAR_ITEM_GROUP_COLORS } from '../canopy-core/sidebar-values';

export { SIDEBAR_ITEM_GROUP_COLORS };

export type SidebarItemGroupColor = (typeof SIDEBAR_ITEM_GROUP_COLORS)[number];
export const SIDEBAR_ITEM_GROUP_LIMIT = 100;
export const SIDEBAR_ITEM_GROUP_NAME_LIMIT = 80;

export interface SidebarItemGroup {
  id: string;
  /** Always non-empty once normalized; menus reference the group by it. */
  name: string;
  color: SidebarItemGroupColor;
  collapsed: boolean;
  /** Keep the name out of the left nav; omitted means the label is shown. */
  labelHidden?: boolean;
  /** Keep the group in the left nav once its last member leaves; omitted deletes it. */
  keepWhenEmpty?: boolean;
  /**
   * Host-maintained for kept groups: the item right after the group's rows,
   * so an emptied group keeps its slot above it. Absent places it last.
   */
  emptyAnchorId?: string;
  /** Only independent roots belong here; descendants travel with their root. */
  memberIds: string[];
}

export interface SidebarItemGroupsFile {
  version: 1;
  groups: SidebarItemGroup[];
}

export type SidebarItemGroupScope =
  | { workspaceLocalId: string; appAdvisor?: never }
  | { appAdvisor: true; workspaceLocalId?: never };

export interface SidebarItemGroupCreateRequest {
  scope: SidebarItemGroupScope;
  itemId: string;
  /** Blank or absent stores the default name (`Group 2`) with the label hidden. */
  name?: string;
  color?: SidebarItemGroupColor;
  labelHidden?: boolean;
}

export interface SidebarItemGroupUpdateRequest {
  scope: SidebarItemGroupScope;
  groupId: string;
  /** Blank stores the default name (`Group 2`) with the label hidden. */
  name?: string;
  color?: SidebarItemGroupColor;
  collapsed?: boolean;
  labelHidden?: boolean;
  keepWhenEmpty?: boolean;
}

/** Exactly one anchor or neither; hosts also validate untrusted wire input. */
export type SidebarItemGroupPosition =
  | { before: string; after?: never }
  | { after: string; before?: never }
  | { before?: never; after?: never };

export type SidebarItemGroupMoveItemRequest = SidebarItemGroupPosition & {
  scope: SidebarItemGroupScope;
  itemId: string;
  groupId: string | null;
};

export type SidebarItemGroupMoveRequest = SidebarItemGroupPosition & {
  scope: SidebarItemGroupScope;
  groupId: string;
};

/** Hosts wire this optional create field only after itemGrouping is enabled. */
export interface SidebarItemGroupCreationOptions {
  sidebarItemGroupId?: string;
}

export interface SidebarItemGroupInventory {
  /** Complete authoritative inventory, never a paged/filtered UI projection. */
  liveItemIds: readonly string[];
  /** Pinned, hidden, and stack-child ids supplied by the owning host. */
  ineligibleItemIds?: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSidebarItemGroupId(value: unknown): value is string {
  return typeof value === 'string' && /^grp-[a-z0-9][a-z0-9-]*$/.test(value);
}

export function isSidebarItemGroupColor(
  value: unknown,
): value is SidebarItemGroupColor {
  return SIDEBAR_ITEM_GROUP_COLORS.some((color) => color === value);
}

/** Repairs recoverable membership data without mutating the input. */
export function normalizeSidebarItemGroups(
  value: unknown,
  inventory: SidebarItemGroupInventory,
): SidebarItemGroup[] {
  return normalizeGroups(value, inventory, false);
}

function normalizeGroups(
  value: unknown,
  inventory: SidebarItemGroupInventory,
  projected: boolean,
): SidebarItemGroup[] {
  if (!Array.isArray(value)) return [];
  const live = new Set(inventory.liveItemIds);
  const ineligible = new Set(inventory.ineligibleItemIds);
  const usedGroups = new Set<string>();
  const usedMembers = new Set<string>();
  const groups: SidebarItemGroup[] = [];
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      !isSidebarItemGroupId(candidate.id) ||
      usedGroups.has(candidate.id) ||
      !Array.isArray(candidate.memberIds)
    )
      continue;
    const memberIds: string[] = [];
    for (const id of candidate.memberIds) {
      if (
        typeof id === 'string' &&
        (/^[a-z0-9][a-z0-9-]*$/.test(id) ||
          (projected && /^cloud:task:[a-z0-9][a-z0-9-]*$/.test(id))) &&
        live.has(id) &&
        !ineligible.has(id) &&
        !usedMembers.has(id)
      ) {
        memberIds.push(id);
        usedMembers.add(id);
      }
    }
    if (memberIds.length === 0 && candidate.keepWhenEmpty !== true) continue;
    usedGroups.add(candidate.id);
    groups.push({
      id: candidate.id,
      name: normalizeSidebarItemGroupName(candidate.name),
      color: isSidebarItemGroupColor(candidate.color)
        ? candidate.color
        : 'neutral',
      collapsed: resolveSidebarItemGroupCollapsed(
        {
          collapsed: candidate.collapsed === true,
          keepWhenEmpty: candidate.keepWhenEmpty === true,
          memberIds,
        },
        candidate.memberIds.length,
      ),
      ...(candidate.labelHidden === true ||
      (typeof candidate.name === 'string' &&
        isDefaultSidebarItemGroupName(candidate.name))
        ? { labelHidden: true }
        : {}),
      ...(candidate.keepWhenEmpty === true ? { keepWhenEmpty: true } : {}),
      ...(candidate.keepWhenEmpty === true &&
      typeof candidate.emptyAnchorId === 'string' &&
      (projected || live.has(candidate.emptyAnchorId))
        ? { emptyAnchorId: candidate.emptyAnchorId }
        : {}),
      memberIds,
    });
    if (groups.length === SIDEBAR_ITEM_GROUP_LIMIT) break;
  }
  // Legacy unnamed groups keep their labelless look under a stable default name.
  for (const group of groups) {
    if (group.name) continue;
    group.name = defaultSidebarItemGroupName(groups);
    group.labelHidden = true;
  }
  return groups;
}

/** Retained groups follow empty-state transitions, preserving manual toggles otherwise. */
export function resolveSidebarItemGroupCollapsed(
  group: Pick<SidebarItemGroup, 'collapsed' | 'keepWhenEmpty' | 'memberIds'>,
  previousMemberCount: number,
): boolean {
  const empty = group.memberIds.length === 0;
  return group.keepWhenEmpty === true && empty !== (previousMemberCount === 0)
    ? empty
    : group.collapsed;
}

/** False once a group that deletes when empty has lost its last member. */
export function isSidebarItemGroupRetained(
  group: Pick<SidebarItemGroup, 'memberIds' | 'keepWhenEmpty'>,
): boolean {
  return group.memberIds.length > 0 || group.keepWhenEmpty === true;
}

/** Trims and clamps a candidate name; non-strings become ''. */
export function normalizeSidebarItemGroupName(value: unknown): string {
  return typeof value === 'string'
    ? Array.from(value.trim())
        .slice(0, SIDEBAR_ITEM_GROUP_NAME_LIMIT)
        .join('')
        .trimEnd()
    : '';
}

/** Theme-independent swatch name; categorical hues vary by theme. */
export function sidebarItemGroupColorLabel(
  color: SidebarItemGroupColor,
): string {
  return color === 'neutral' ? 'Neutral' : `Color ${color.slice(-1)}`;
}

/** Case- and whitespace-insensitive identity used to match groups by name. */
export function sidebarItemGroupNameKey(name: string): string {
  return normalizeSidebarItemGroupName(name)
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase();
}

/** Names are not unique: the first match in list order wins. */
export function findSidebarItemGroupByName<T extends SidebarItemGroup>(
  groups: readonly T[],
  name: string,
): T | undefined {
  const key = sidebarItemGroupNameKey(name);
  if (!key) return undefined;
  return groups.find((group) => sidebarItemGroupNameKey(group.name) === key);
}

/** Prefix of generated names: `Group 1`, `Group 2`, … */
const DEFAULT_SIDEBAR_ITEM_GROUP_NAME_PREFIX = 'Group';

/** `Group <n>`, using the lowest n from 1 that no group name already uses. */
export function defaultSidebarItemGroupName(
  groups: readonly Pick<SidebarItemGroup, 'name'>[],
): string {
  const used = new Set(
    groups.map((group) => sidebarItemGroupNameKey(group.name)),
  );
  for (let counter = 1; ; counter += 1) {
    const candidate = `${DEFAULT_SIDEBAR_ITEM_GROUP_NAME_PREFIX} ${counter}`;
    if (!used.has(sidebarItemGroupNameKey(candidate))) return candidate;
  }
}

/** True when `name` has the generated default format, e.g. `Group 2`. */
export function isDefaultSidebarItemGroupName(name: string): boolean {
  const prefix =
    `${DEFAULT_SIDEBAR_ITEM_GROUP_NAME_PREFIX} `.toLocaleLowerCase();
  const key = sidebarItemGroupNameKey(name);
  return (
    key.startsWith(prefix) && /^[1-9][0-9]*$/.test(key.slice(prefix.length))
  );
}

export interface SidebarItemGroupLabelInput {
  /** Requested name; undefined keeps `previous.name`, blank requests the default. */
  name?: string;
  labelHidden?: boolean;
  /** Absent when creating. */
  previous?: Pick<SidebarItemGroup, 'name' | 'labelHidden'>;
  /** Every other group in the scope, excluding this one. */
  others: readonly Pick<SidebarItemGroup, 'name'>[];
}

/**
 * Single label policy for every host: names are required, a blank name stores
 * the default name (`Group 2`), and a name in the default format is always
 * hidden.
 */
export function resolveSidebarItemGroupLabel(
  input: SidebarItemGroupLabelInput,
): { name: string; labelHidden: boolean } {
  const { previous } = input;
  const requested =
    input.name === undefined
      ? undefined
      : normalizeSidebarItemGroupName(input.name);
  const previousIsDefault =
    previous !== undefined && isDefaultSidebarItemGroupName(previous.name);
  // Blanking a group that already has a default name keeps that name.
  if (requested === '' && previous !== undefined && previousIsDefault)
    return { name: previous.name, labelHidden: true };
  if (
    requested === '' ||
    (requested === undefined && (previous === undefined || !previous.name))
  ) {
    return {
      name: defaultSidebarItemGroupName(input.others),
      labelHidden: true,
    };
  }
  const name = requested ?? previous?.name ?? '';
  // A name in the default format is the generated name, which never shows.
  if (isDefaultSidebarItemGroupName(name)) return { name, labelHidden: true };
  if (requested === undefined)
    return {
      name,
      labelHidden: input.labelHidden ?? previous?.labelHidden === true,
    };
  return {
    name,
    labelHidden:
      input.labelHidden ??
      (previous !== undefined &&
        !previousIsDefault &&
        previous.labelHidden === true),
  };
}

/** Random color, preferring ones no group uses, then the least-used ones. */
export function pickSidebarItemGroupColor(
  groups: readonly Pick<SidebarItemGroup, 'color'>[],
  random: () => number = Math.random,
): SidebarItemGroupColor {
  const counts = new Map<SidebarItemGroupColor, number>(
    SIDEBAR_ITEM_GROUP_COLORS.map((color) => [color, 0]),
  );
  for (const group of groups)
    counts.set(group.color, (counts.get(group.color) ?? 0) + 1);
  const fewest = Math.min(...Array.from(counts.values()));
  const candidates = SIDEBAR_ITEM_GROUP_COLORS.filter(
    (color) => counts.get(color) === fewest,
  );
  const index = Math.min(
    candidates.length - 1,
    Math.max(0, Math.floor(random() * candidates.length)),
  );
  return candidates[index] ?? 'neutral';
}

/** Read-only transport projection. Off-page members are retained; only the owner reconciles inventory. */
export function readProjectedSidebarItemGroups(
  value: unknown,
): SidebarItemGroup[] {
  const liveItemIds = Array.isArray(value)
    ? value.flatMap((group: unknown) =>
        isRecord(group) && Array.isArray(group.memberIds)
          ? group.memberIds.filter(
              (id: unknown): id is string => typeof id === 'string',
            )
          : [],
      )
    : [];
  return normalizeGroups(value, { liveItemIds }, true);
}

export type SidebarItemGroupsParseResult =
  | { status: 'missing' }
  | { status: 'malformed' }
  | { status: 'unsupported-version'; version: number }
  | { status: 'ok'; value: SidebarItemGroupsFile };

/** Distinguishes future data so a host cannot overwrite it as version 1. */
export function parseSidebarItemGroupsFile(
  value: unknown,
  inventory: SidebarItemGroupInventory,
): SidebarItemGroupsParseResult {
  if (value === undefined || value === null) return { status: 'missing' };
  if (
    !isRecord(value) ||
    !Number.isInteger(value.version) ||
    typeof value.version !== 'number' ||
    value.version < 1
  ) {
    return { status: 'malformed' };
  }
  if (value.version !== 1)
    return { status: 'unsupported-version', version: value.version };
  if (!Array.isArray(value.groups)) return { status: 'malformed' };
  return {
    status: 'ok',
    value: {
      version: 1,
      groups: normalizeSidebarItemGroups(value.groups, inventory),
    },
  };
}

/** Starts with the first palette key; reuses it once every key is in use. */
export function nextSidebarItemGroupColor(
  groups: readonly SidebarItemGroup[],
): SidebarItemGroupColor {
  const used = new Set(groups.map((group) => group.color));
  return (
    SIDEBAR_ITEM_GROUP_COLORS.find((color) => !used.has(color)) ?? 'neutral'
  );
}

export interface SidebarItemGroupOrderOptions {
  /** Complete units, root first and descendants in their existing sibling order. */
  stackUnits?: readonly (readonly string[])[];
}

/**
 * Points each non-empty kept group at the first eligible item after its last
 * row in `order`, so it holds that slot once it empties. An empty group keeps
 * its anchor, moving past it only once it is pinned, hidden or a stack child.
 */
export function anchorKeptSidebarItemGroups(
  groups: readonly SidebarItemGroup[],
  order: readonly string[],
  options: SidebarItemGroupOrderOptions &
    Pick<SidebarItemGroupInventory, 'ineligibleItemIds'> = {},
): SidebarItemGroup[] {
  const rootOf = new Map<string, string>();
  for (const unit of options.stackUnits ?? [])
    for (const id of unit) if (unit[0]) rootOf.set(id, unit[0]);
  const ineligible = new Set(options.ineligibleItemIds);
  return groups.map((group) => {
    if (group.keepWhenEmpty !== true) return group;
    const members = new Set(group.memberIds);
    let from = -1;
    if (members.size > 0) {
      order.forEach((id, index) => {
        if (members.has(rootOf.get(id) ?? id)) from = index + 1;
      });
    } else if (
      group.emptyAnchorId !== undefined &&
      ineligible.has(group.emptyAnchorId)
    ) {
      from = order.indexOf(group.emptyAnchorId);
    }
    if (from < 0) return group;
    const anchor = order
      .slice(from)
      .find((id) => !ineligible.has(id) && !members.has(rootOf.get(id) ?? id));
    const anchored = { ...group };
    delete anchored.emptyAnchorId;
    if (anchor !== undefined) anchored.emptyAnchorId = anchor;
    return anchored;
  });
}

/**
 * Stable block rewrite at each group's first root slot, carrying all
 * descendants. Stack child slots do not anchor a unit; its root's slot does.
 */
export function normalizeGroupedOrder(
  orderIds: readonly string[],
  groups: readonly SidebarItemGroup[],
  options: SidebarItemGroupOrderOptions = {},
): string[] {
  const order = Array.from(new Set(orderIds));
  const live = new Set(order);
  const unitFor = new Map<string, readonly string[]>();
  for (const rawUnit of options.stackUnits ?? []) {
    // A root must be present; malformed or overlapping units cannot consume rows.
    if (
      !rawUnit[0] ||
      !live.has(rawUnit[0]) ||
      rawUnit.some((id) => unitFor.has(id))
    )
      continue;
    const unit = Array.from(new Set(rawUnit)).filter((id) => live.has(id));
    for (const id of unit) unitFor.set(id, unit);
  }
  const units: (readonly string[])[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    if (seen.has(id)) continue;
    const unit = unitFor.get(id) ?? [id];
    // A stack's complete unit is emitted where its root appears, even when a
    // newly prepended descendant occurs earlier in the registry.
    if (unit[0] !== id) continue;
    units.push(unit);
    for (const member of unit) seen.add(member);
  }
  const groupFor = new Map<string, SidebarItemGroup>();
  for (const group of groups) {
    for (const root of group.memberIds) {
      if (!groupFor.has(root)) groupFor.set(root, group);
    }
  }
  const emitted = new Set<SidebarItemGroup>();
  const result: string[] = [];
  for (const unit of units) {
    const root = unit[0];
    const group = root === undefined ? undefined : groupFor.get(root);
    if (!group) result.push(...unit);
    else if (!emitted.has(group)) {
      emitted.add(group);
      for (const other of units) {
        const otherRoot = other[0];
        if (otherRoot !== undefined && groupFor.get(otherRoot) === group)
          result.push(...other);
      }
    }
  }
  return result;
}
