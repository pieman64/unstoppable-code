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
  readonly hosts: AccessHostsState;
}

/** The device choice in the Hosts section. */
export type AccessDeviceChoice = 'all' | 'selected' | 'none';

/**
 * The Hosts section's draft on a Tasks connection. `remoteIds` keeps the
 * checked devices while another choice is made, so choosing Selected again
 * restores them; `buildAccess` sends only what the choice allows.
 */
export interface AccessHostsState {
  /** The Cloud agents switch: the managed host. */
  readonly managed: boolean;
  readonly devices: AccessDeviceChoice;
  readonly remoteIds: readonly string[];
  /** Show device names to this agent. */
  readonly exposeNames: boolean;
}

/** The host ID agents see for the managed cloud host. */
export const MANAGED_HOST_ID = 'linux-managed';

/** What an Account connection sends: it reaches no host. */
export const ACCOUNT_HOSTS: ExternalAgentAccess['hosts'] = {
  managed: false,
  connected: { mode: 'selected', remoteIds: [] },
  exposeNames: false,
};

/** Where a new Tasks connection starts: Cloud agents on, no devices. */
export const NEW_TASKS_HOSTS: ExternalAgentAccess['hosts'] = {
  managed: true,
  connected: { mode: 'selected', remoteIds: [] },
  exposeNames: false,
};

/** The Hosts draft a new Tasks connection starts from (consent). */
export function initialAccessHostsState(): AccessHostsState {
  return {
    managed: NEW_TASKS_HOSTS.managed,
    // Selected shows the device list; with nothing checked it grants none.
    devices: 'selected',
    remoteIds: [],
    exposeNames: NEW_TASKS_HOSTS.exposeNames,
  };
}

/** The Hosts draft for a stored connection's `hosts`. */
export function accessHostsStateFromAccess(
  hosts: ExternalAgentAccess['hosts'],
): AccessHostsState {
  return {
    managed: hosts.managed,
    devices:
      hosts.connected.mode === 'all'
        ? 'all'
        : hosts.connected.remoteIds.length > 0
          ? 'selected'
          : 'none',
    remoteIds: [...hosts.connected.remoteIds],
    exposeNames: hosts.exposeNames,
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

/**
 * The chosen hosts allow this tool. Matches the server's expansion: on the
 * Tasks server, a tool that takes a host is allowed when the choice includes at
 * least one host kind it supports (Cloud agents on for the managed host, or all
 * or at least one selected device for connected hosts). A tool with
 * `hosts: null` takes no host and is always allowed.
 */
function hostsAllowTool(
  source: AccessModelSource,
  state: AccessFormState,
  tool: ExternalAgentAccessTool,
): boolean {
  if (source.server !== 'tasks' || tool.hosts === null) return true;
  const hosts = buildHosts(source, state, true);
  const connected =
    hosts.connected.mode === 'all' || hosts.connected.remoteIds.length > 0;
  return (
    (tool.hosts.managed && hosts.managed) || (tool.hosts.connected && connected)
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
        if (!hostsAllowTool(source, state, tool)) return false;
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

    const tools: AgentAccessToolRow[] = group.tools.map((tool) => {
      // A tool for a host the agent can't reach stays off until it can.
      const hostAllowed = hostsAllowTool(source, state, tool);
      return {
        name: tool.name,
        title: tool.title,
        access: tool.access,
        defaultOff: tool.defaultOff,
        markers: markerList(tool),
        enabled:
          hostAllowed &&
          !disabled.has(tool.name) &&
          (!tool.defaultOff || enabledDefaultOff.has(tool.name)) &&
          levelRank(level) >= accessRank(tool.access),
        available:
          hostAllowed &&
          group.unavailableReason === null &&
          levelRank(level) >= accessRank(tool.access),
      };
    });

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

function tasksGroupLevel(
  source: AccessModelSource,
  state: AccessFormState,
): AgentAccessLevel {
  if (source.server !== 'tasks') return 'off';
  const group = source.groups.find((candidate) => candidate.id === 'tasks');
  if (group === undefined) return 'off';
  return effectiveGroupLevel(group, groupLevel(source, state.levels, group.id));
}

/** Tasks access is Read or Write, so the agent uses the hosts chosen here. */
function usesAccessHosts(
  source: AccessModelSource,
  state: AccessFormState,
): boolean {
  return tasksGroupLevel(source, state) !== 'off';
}

/**
 * The Hosts section shows while Tasks access is Read or Write, and also while
 * the draft has no host, so a blocked save can always be fixed.
 */
export function showsAccessHosts(
  source: AccessModelSource,
  state: AccessFormState,
  options: { readonly keepUnusedScope?: boolean } = {},
): boolean {
  return (
    usesAccessHosts(source, state) || accessHostsMissing(source, state, options)
  );
}

/**
 * Devices can be chosen on a Tasks connection while Remote Control is on;
 * while it is off they stay unavailable, and a stored choice is kept.
 */
export function showsAccessDevices(
  source: AccessModelSource,
  remoteControlEnabled: boolean,
): boolean {
  return remoteControlEnabled && source.server === 'tasks';
}

/** Tasks write access reaches the person's devices. */
export function devicesWriteAccess(
  source: AccessModelSource,
  state: AccessFormState,
  remoteControlEnabled: boolean,
): boolean {
  return (
    remoteControlEnabled &&
    tasksGroupLevel(source, state) === 'write' &&
    state.hosts.devices !== 'none'
  );
}

/** `hosts.connected.remoteIds` holds at most this many devices (connection policy bound). */
export const MAX_ACCESS_DESKTOPS = 500;

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/** Turns the Cloud agents switch (the managed host) on or off. */
export function setAccessManagedHost(
  state: AccessFormState,
  managed: boolean,
): AccessFormState {
  return { ...state, hosts: { ...state.hosts, managed } };
}

/** Turns Show device names to this agent on or off. */
export function setAccessExposeNames(
  state: AccessFormState,
  exposeNames: boolean,
): AccessFormState {
  return { ...state, hosts: { ...state.hosts, exposeNames } };
}

/**
 * Chooses All, Selected or None. The checked devices stay in the draft while
 * another choice is made, so choosing Selected again restores them;
 * `buildAccess` sends an empty list for All and None.
 */
export function setAccessDeviceChoice(
  state: AccessFormState,
  devices: AccessDeviceChoice,
): AccessFormState {
  return { ...state, hosts: { ...state.hosts, devices } };
}

/**
 * Checks or unchecks one device. Checking is a no-op once the selection holds
 * `MAX_ACCESS_DESKTOPS`; unchecking also removes a device that is no longer
 * paired.
 */
export function setAccessDeviceSelected(
  state: AccessFormState,
  remoteId: string,
  selected: boolean,
): AccessFormState {
  const remaining = uniqueIds(
    state.hosts.remoteIds.filter((candidate) => candidate !== remoteId),
  );
  if (selected && remaining.length >= MAX_ACCESS_DESKTOPS) return state;
  return {
    ...state,
    hosts: {
      ...state.hosts,
      remoteIds: selected ? [...remaining, remoteId] : remaining,
    },
  };
}

/** The selection is full: no further device can be checked. */
export function deviceSelectionFull(state: AccessFormState): boolean {
  return uniqueIds(state.hosts.remoteIds).length >= MAX_ACCESS_DESKTOPS;
}

function connectedHosts(
  hosts: AccessHostsState,
): ExternalAgentAccess['hosts']['connected'] {
  if (hosts.devices === 'all') return { mode: 'all', remoteIds: [] };
  if (hosts.devices === 'none') return { mode: 'selected', remoteIds: [] };
  return { mode: 'selected', remoteIds: uniqueIds(hosts.remoteIds) };
}

function buildHosts(
  source: AccessModelSource,
  state: AccessFormState,
  keepUnusedScope: boolean,
): ExternalAgentAccess['hosts'] {
  if (source.server !== 'tasks') return ACCOUNT_HOSTS;
  // Consent starts fresh: with Tasks off, the new-connection default.
  if (!usesAccessHosts(source, state) && !keepUnusedScope) {
    return NEW_TASKS_HOSTS;
  }
  return {
    managed: state.hosts.managed,
    connected: connectedHosts(state.hosts),
    exposeNames: state.hosts.exposeNames,
  };
}

/**
 * The Tasks access would reach no host: Cloud agents off and no devices.
 * Saving is blocked with "Choose at least one host." until one is chosen.
 */
export function accessHostsMissing(
  source: AccessModelSource,
  state: AccessFormState,
  options: { readonly keepUnusedScope?: boolean } = {},
): boolean {
  if (source.server !== 'tasks') return false;
  const hosts = buildHosts(source, state, options.keepUnusedScope === true);
  return (
    !hosts.managed &&
    hosts.connected.mode === 'selected' &&
    hosts.connected.remoteIds.length === 0
  );
}

export const HOSTS_REQUIRED_MESSAGE = 'Choose at least one host.';

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
    hosts: buildHosts(source, state, keep),
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
    hosts:
      detail.server === 'tasks'
        ? accessHostsStateFromAccess(detail.current.hosts)
        : accessHostsStateFromAccess(ACCOUNT_HOSTS),
  };
}

export function isExternalAgentToolGroup(
  value: string,
): value is ExternalAgentToolGroup {
  return EXTERNAL_AGENT_TOOL_GROUP_SET.has(value);
}
