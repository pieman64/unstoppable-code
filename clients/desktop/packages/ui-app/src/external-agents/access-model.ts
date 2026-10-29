import { EXTERNAL_AGENT_TOOL_GROUPS } from '@canopy/protocol/external-agents';
import type {
  ExternalAgentAccess,
  ExternalAgentAccessGroup,
  ExternalAgentAccessTool,
  ExternalAgentConnectionDetail,
  ExternalAgentDesktop,
  ExternalAgentOrganization,
  ExternalAgentServer,
  ExternalAgentToolGroup,
} from '@canopy/protocol/external-agents';
import type {
  AgentAccessGroupRow,
  AgentAccessLevel,
  AgentAccessPreset,
  AgentAccessToolRow,
  AgentToolMarker,
} from '@canopy/ui-shared/components';

export interface AccessModelSource {
  readonly server: ExternalAgentServer;
  readonly groups: readonly ExternalAgentAccessGroup[];
  /** Fallback levels when the state has none for a group (consent: vm.initial.levels). */
  readonly initialLevels?: Partial<
    Record<ExternalAgentToolGroup, AgentAccessLevel>
  >;
}

export interface AccessFormState {
  readonly preset: AgentAccessPreset;
  readonly levels: Partial<Record<ExternalAgentToolGroup, AgentAccessLevel>>;
  readonly destructiveGroups: readonly ExternalAgentToolGroup[];
  readonly disabledTools: readonly string[];
  readonly enabledDefaultOff: readonly string[];
  readonly organizations: {
    readonly mode: 'all' | 'selected';
    readonly organizationIds: readonly string[];
  };
  readonly remotes: {
    readonly mode: 'all' | 'selected';
    readonly remoteIds: readonly string[];
  };
}

export type AccessPresetLevels = Partial<
  Record<ExternalAgentToolGroup, 'read' | 'write'>
>;

export function organizationChoiceUnavailable(
  organization: Pick<ExternalAgentOrganization, 'unavailableReason'>,
  selection: {
    readonly selected: boolean;
    readonly initiallySelected: boolean;
  },
): boolean {
  return (
    organization.unavailableReason !== null &&
    !selection.selected &&
    !selection.initiallySelected
  );
}

const ORGANIZATION_GROUPS: readonly ExternalAgentToolGroup[] = [
  'digests',
  'usage',
  'billing',
  'org',
  'library',
  'work',
  'memory',
];

const EXTERNAL_AGENT_TOOL_GROUP_SET: ReadonlySet<string> = new Set(
  EXTERNAL_AGENT_TOOL_GROUPS,
);

const DESTRUCTIVE_GROUP_COPY: Partial<
  Record<
    ExternalAgentToolGroup,
    { readonly label: string; readonly description: string }
  >
> = {
  org: {
    label: 'Allow removing members and teams',
    description: 'Each removal still asks you to confirm it.',
  },
  library: {
    label: 'Allow deleting library items',
    description: 'Each deletion still asks you to confirm it.',
  },
};

const UNVERIFIED_DESTRUCTIVE_WARNING =
  "This agent isn't verified. Allow this only if you trust it.";

function groupLevel(
  source: AccessModelSource,
  levels: Partial<Record<ExternalAgentToolGroup, AgentAccessLevel>>,
  groupId: ExternalAgentToolGroup,
): AgentAccessLevel {
  return levels[groupId] ?? source.initialLevels?.[groupId] ?? 'off';
}

function effectiveGroupLevel(
  group: ExternalAgentAccessGroup,
  level: AgentAccessLevel,
): AgentAccessLevel {
  if (group.unavailableReason !== null) return 'off';
  if (group.minimum === 'read' && level === 'off') return 'read';
  if (!group.writable && level === 'write') return 'read';
  return level;
}

function accessRank(access: 'read' | 'write'): number {
  return access === 'read' ? 1 : 2;
}

function levelRank(level: AgentAccessLevel): number {
  if (level === 'read') return 1;
  if (level === 'write') return 2;
  return 0;
}

function markerList(tool: ExternalAgentAccessTool): AgentToolMarker[] {
  const markers: AgentToolMarker[] = [];
  if (tool.markers.spendsCredits) markers.push('spendsCredits');
  if (tool.markers.sendsEmail) markers.push('sendsEmail');
  if (tool.markers.publicEffect) markers.push('publicEffect');
  if (tool.markers.actsOnRemote) markers.push('actsOnRemote');
  return markers;
}

function toggleName<Name extends string>(
  names: readonly Name[],
  name: Name,
  included: boolean,
): Name[] {
  const next = names.filter((candidate) => candidate !== name);
  return included ? [...next, name] : next;
}

function availableToolNames(source: AccessModelSource): Set<string> {
  return new Set(
    source.groups.flatMap((group) =>
      group.unavailableReason === null
        ? [...group.tools.map((tool) => tool.name), ...group.destructiveTools]
        : [],
    ),
  );
}

export function accessPresets(groups: readonly ExternalAgentAccessGroup[]): {
  read: AccessPresetLevels;
  write: AccessPresetLevels;
} {
  const read: AccessPresetLevels = {};
  const write: AccessPresetLevels = {};

  for (const group of groups) {
    if (group.unavailableReason !== null) continue;
    read[group.id] = 'read';
    write[group.id] = group.writable ? 'write' : 'read';
  }

  return { read, write };
}

export function matchingPreset(
  source: AccessModelSource,
  levels: Partial<Record<ExternalAgentToolGroup, AgentAccessLevel>>,
  presets: {
    readonly read: AccessPresetLevels;
    readonly write: AccessPresetLevels;
  },
  destructiveGroups: readonly ExternalAgentToolGroup[] = [],
): AgentAccessPreset {
  if (destructiveGroups.length > 0) return 'custom';

  for (const preset of ['read', 'write'] as const) {
    const matches = source.groups.every((group) => {
      const currentLevel = effectiveGroupLevel(
        group,
        groupLevel(source, levels, group.id),
      );
      const presetLevel = presets[preset][group.id] ?? 'off';
      return currentLevel === presetLevel;
    });
    if (matches) return preset;
  }
  return 'custom';
}

export function applyAccessPreset(
  state: AccessFormState,
  source: AccessModelSource,
  presets: {
    readonly read: AccessPresetLevels;
    readonly write: AccessPresetLevels;
  },
  preset: AgentAccessPreset,
): AccessFormState {
  if (preset === 'custom') return state;

  const levels: Partial<Record<ExternalAgentToolGroup, AgentAccessLevel>> = {};
  for (const group of source.groups) {
    levels[group.id] = presets[preset][group.id] ?? 'off';
  }

  return {
    ...state,
    preset,
    levels,
    destructiveGroups: [],
    disabledTools: [],
    enabledDefaultOff: [],
  };
}

export function setAccessGroupLevel(
  state: AccessFormState,
  source: AccessModelSource,
  groupId: ExternalAgentToolGroup,
  level: AgentAccessLevel,
): AccessFormState {
  const group = source.groups.find((candidate) => candidate.id === groupId);
  if (group === undefined) return state;

  const effectiveLevel = effectiveGroupLevel(group, level);

  return {
    ...state,
    preset: 'custom',
    ...(effectiveLevel === 'write'
      ? {}
      : {
          destructiveGroups: state.destructiveGroups.filter(
            (candidate) => candidate !== groupId,
          ),
        }),
    levels: {
      ...state.levels,
      [groupId]: effectiveLevel,
    },
  };
}

export function setAccessDestructive(
  state: AccessFormState,
  source: AccessModelSource,
  groupId: string,
  enabled: boolean,
): AccessFormState {
  const group = source.groups.find((candidate) => candidate.id === groupId);
  if (
    group === undefined ||
    !group.destructive ||
    effectiveGroupLevel(group, groupLevel(source, state.levels, group.id)) !==
      'write'
  ) {
    return state;
  }

  return {
    ...state,
    preset: 'custom',
    destructiveGroups: toggleName(state.destructiveGroups, group.id, enabled),
  };
}

export function setAccessToolEnabled(
  state: AccessFormState,
  tool: ExternalAgentAccessTool,
  enabled: boolean,
): AccessFormState {
  return {
    ...state,
    preset: 'custom',
    ...(tool.defaultOff
      ? {
          enabledDefaultOff: toggleName(
            state.enabledDefaultOff,
            tool.name,
            enabled,
          ),
        }
      : {
          disabledTools: toggleName(state.disabledTools, tool.name, !enabled),
        }),
  };
}

/** Every tool the server offers, whether or not the current choice turns it on. */
export function countAccessTools(source: AccessModelSource): number {
  return source.groups.reduce(
    (count, group) =>
      count + group.tools.length + group.destructiveTools.length,
    0,
  );
}

export function countEnabledAccessTools(
  source: AccessModelSource,
  state: AccessFormState,
): number {
  const disabled = new Set(state.disabledTools);
  const enabledDefaultOff = new Set(state.enabledDefaultOff);
  const destructiveGroups = new Set(state.destructiveGroups);

  return source.groups.reduce((count, group) => {
    if (group.unavailableReason !== null) return count;
    const level = effectiveGroupLevel(
      group,
      groupLevel(source, state.levels, group.id),
    );
    return (
      count +
      group.tools.filter((tool) => {
        if (disabled.has(tool.name)) return false;
        if (tool.defaultOff && !enabledDefaultOff.has(tool.name)) return false;
        return levelRank(level) >= accessRank(tool.access);
      }).length +
      (group.destructive && level === 'write' && destructiveGroups.has(group.id)
        ? group.destructiveTools.filter((name) => !disabled.has(name)).length
        : 0)
    );
  }, 0);
}

export function toAccessEditorGroups(
  source: AccessModelSource,
  state: AccessFormState,
  options: { readonly verified?: boolean } = {},
): AgentAccessGroupRow[] {
  const disabled = new Set(state.disabledTools);
  const enabledDefaultOff = new Set(state.enabledDefaultOff);

  return source.groups.map((group) => {
    const level = effectiveGroupLevel(
      group,
      groupLevel(source, state.levels, group.id),
    );
    const levels: AgentAccessLevel[] =
      group.unavailableReason !== null
        ? ['off']
        : group.minimum === 'read'
          ? ['read']
          : ['off', 'read'];
    if (group.unavailableReason === null && group.writable) {
      levels.push('write');
    }

    const tools: AgentAccessToolRow[] = group.tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      access: tool.access,
      defaultOff: tool.defaultOff,
      markers: markerList(tool),
      enabled:
        !disabled.has(tool.name) &&
        (!tool.defaultOff || enabledDefaultOff.has(tool.name)) &&
        levelRank(level) >= accessRank(tool.access),
      available:
        group.unavailableReason === null &&
        levelRank(level) >= accessRank(tool.access),
    }));

    const destructiveCopy = DESTRUCTIVE_GROUP_COPY[group.id];

    return {
      id: group.id,
      label: group.label,
      description: group.description,
      level,
      levels,
      ...(group.writeUnavailableReason === null
        ? {}
        : { writeUnavailableReason: group.writeUnavailableReason }),
      ...(group.unavailableReason === null
        ? {}
        : { unavailableReason: group.unavailableReason }),
      ...(group.destructive &&
      level === 'write' &&
      destructiveCopy !== undefined
        ? {
            destructive: {
              ...destructiveCopy,
              enabled: state.destructiveGroups.includes(group.id),
              ...(options.verified === false
                ? { warning: UNVERIFIED_DESTRUCTIVE_WARNING }
                : {}),
            },
          }
        : {}),
      tools,
    };
  });
}

export function showsAccessOrganizations(
  source: AccessModelSource,
  state: AccessFormState,
): boolean {
  return (
    source.server === 'account' &&
    source.groups.some(
      (group) =>
        ORGANIZATION_GROUPS.includes(group.id) &&
        group.unavailableReason === null &&
        effectiveGroupLevel(
          group,
          groupLevel(source, state.levels, group.id),
        ) !== 'off',
    )
  );
}

function remoteGroup(
  source: AccessModelSource,
): ExternalAgentAccessGroup | undefined {
  return source.groups.find((group) => group.id === 'remote');
}

export function showsAccessDesktops(
  source: AccessModelSource,
  state: AccessFormState,
  remoteControlEnabled: boolean,
): boolean {
  const group = remoteGroup(source);
  return (
    source.server === 'tasks' &&
    remoteControlEnabled &&
    group !== undefined &&
    group.unavailableReason === null &&
    groupLevel(source, state.levels, group.id) !== 'off'
  );
}

export function desktopsWriteAccess(
  source: AccessModelSource,
  state: AccessFormState,
  remoteControlEnabled: boolean,
): boolean {
  const group = remoteGroup(source);
  return (
    source.server === 'tasks' &&
    remoteControlEnabled &&
    group !== undefined &&
    group.unavailableReason === null &&
    groupLevel(source, state.levels, group.id) === 'write'
  );
}

/** `remotes.remoteIds` holds at most this many desktops (connection policy bound). */
export const MAX_ACCESS_DESKTOPS = 500;

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Switches between "Selected desktops" and "All my desktops". The checked
 * desktops stay in the draft while "All" is chosen, so switching back
 * restores them; `buildAccess` sends an empty list for "All".
 */
export function setAccessDesktopMode(
  state: AccessFormState,
  mode: 'all' | 'selected',
): AccessFormState {
  return { ...state, remotes: { ...state.remotes, mode } };
}

/**
 * Checks or unchecks one desktop. Checking is a no-op once the selection
 * holds `MAX_ACCESS_DESKTOPS`; unchecking also removes a desktop that is no
 * longer paired.
 */
export function setAccessDesktopSelected(
  state: AccessFormState,
  remoteId: string,
  selected: boolean,
): AccessFormState {
  const remaining = uniqueIds(
    state.remotes.remoteIds.filter((candidate) => candidate !== remoteId),
  );
  if (selected && remaining.length >= MAX_ACCESS_DESKTOPS) return state;
  return {
    ...state,
    remotes: {
      ...state.remotes,
      remoteIds: selected ? [...remaining, remoteId] : remaining,
    },
  };
}

/** The selection is full: no further desktop can be checked. */
export function desktopSelectionFull(state: AccessFormState): boolean {
  return uniqueIds(state.remotes.remoteIds).length >= MAX_ACCESS_DESKTOPS;
}

export interface DesktopAccessRow {
  readonly desktop: ExternalAgentDesktop;
  readonly selected: boolean;
}

export interface DesktopAccessRows {
  /** Every paired desktop, in list order, with whether it is checked. */
  readonly available: readonly DesktopAccessRow[];
  /**
   * Checked `remoteId`s that are not paired anymore, in selection order.
   * They stay in the policy until the person removes them. Empty while the
   * list has not loaded (`desktops === null`).
   */
  readonly unavailableIds: readonly string[];
}

export function desktopAccessRows(
  desktops: readonly ExternalAgentDesktop[] | null,
  remoteIds: readonly string[],
): DesktopAccessRows {
  const selected = new Set(remoteIds);
  if (desktops === null) return { available: [], unavailableIds: [] };
  const paired = new Set(desktops.map((desktop) => desktop.remoteId));
  return {
    available: desktops.map((desktop) => ({
      desktop,
      selected: selected.has(desktop.remoteId),
    })),
    unavailableIds: uniqueIds(remoteIds).filter((id) => !paired.has(id)),
  };
}

export function buildAccess(
  source: AccessModelSource,
  state: AccessFormState,
  options: {
    /**
     * Editing an existing connection keeps its organization and desktop
     * selection while no group uses it, so turning groups off and on again
     * does not reset (or widen) that scope. Consent starts fresh instead.
     */
    keepUnusedScope?: boolean;
  } = {},
): ExternalAgentAccess {
  const groups: ExternalAgentAccess['groups'] = {};
  for (const group of source.groups) {
    if (group.unavailableReason !== null) continue;
    const level = effectiveGroupLevel(
      group,
      groupLevel(source, state.levels, group.id),
    );
    if (level !== 'off') {
      groups[group.id] =
        level === 'write' &&
        group.destructive &&
        state.destructiveGroups.includes(group.id)
          ? 'destructive'
          : level;
    }
  }

  const toolNames = availableToolNames(source);
  const disabledTools = state.disabledTools.filter((name) =>
    toolNames.has(name),
  );
  const enabledDefaultOff = state.enabledDefaultOff.filter((name) =>
    toolNames.has(name),
  );
  const organizationAccess = showsAccessOrganizations(source, state);
  const group = remoteGroup(source);
  const remoteAccess =
    source.server === 'tasks' &&
    group !== undefined &&
    group.unavailableReason === null &&
    groupLevel(source, state.levels, group.id) !== 'off';

  const keep = options.keepUnusedScope === true;
  return {
    groups,
    disabledTools,
    enabledDefaultOff,
    // An edit keeps the stored organization scope on either server; only a
    // shown picker (Account and organizations) may change it.
    organizations:
      (organizationAccess && source.server === 'account') || keep
        ? {
            mode: state.organizations.mode,
            organizationIds:
              state.organizations.mode === 'all'
                ? []
                : [...state.organizations.organizationIds],
          }
        : { mode: 'all', organizationIds: [] },
    remotes:
      (remoteAccess || keep) && source.server === 'tasks'
        ? {
            mode: state.remotes.mode,
            remoteIds:
              state.remotes.mode === 'all'
                ? []
                : uniqueIds(state.remotes.remoteIds),
          }
        : { mode: 'selected', remoteIds: [] },
  };
}

export function accessFormStateFromDetail(
  detail: ExternalAgentConnectionDetail,
): AccessFormState {
  const levels: Partial<Record<ExternalAgentToolGroup, AgentAccessLevel>> = {};
  const destructiveGroups: ExternalAgentToolGroup[] = [];
  for (const group of detail.groups) {
    const currentAccess = detail.current.groups[group.id] ?? 'off';
    if (currentAccess === 'destructive') destructiveGroups.push(group.id);
    levels[group.id] = effectiveGroupLevel(
      group,
      currentAccess === 'destructive' ? 'write' : currentAccess,
    );
  }

  const model: AccessModelSource = {
    server: detail.server,
    groups: detail.groups,
  };
  const preset =
    detail.current.disabledTools.length > 0 ||
    detail.current.enabledDefaultOff.length > 0
      ? 'custom'
      : matchingPreset(
          model,
          levels,
          accessPresets(detail.groups),
          destructiveGroups,
        );

  return {
    preset,
    levels,
    destructiveGroups,
    disabledTools: [...detail.current.disabledTools],
    enabledDefaultOff: [...detail.current.enabledDefaultOff],
    organizations: {
      mode: detail.current.organizations.mode,
      organizationIds: [...detail.current.organizations.organizationIds],
    },
    remotes: {
      mode: detail.current.remotes.mode,
      remoteIds: [...detail.current.remotes.remoteIds],
    },
  };
}

export function isExternalAgentToolGroup(
  value: string,
): value is ExternalAgentToolGroup {
  return EXTERNAL_AGENT_TOOL_GROUP_SET.has(value);
}
