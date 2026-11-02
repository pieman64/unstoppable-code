import type {
  ExternalAgentAccess,
  ExternalAgentAccessGroup,
  ExternalAgentAccessTool,
  ExternalAgentConnectionDetail,
  ExternalAgentDesktop,
  ExternalAgentToolGroup,
} from '@canopy/protocol/external-agents';
import {
  accessFormStateFromDetail,
  accessPresets,
  applyAccessPreset,
  buildAccess,
  countAccessTools,
  countEnabledAccessTools,
  desktopAccessRows,
  deviceSelectionFull,
  devicesWriteAccess,
  accessHostsMissing,
  initialAccessHostsState,
  NEW_TASKS_HOSTS,
  isExternalAgentToolGroup,
  matchingPreset,
  organizationChoiceUnavailable,
  setAccessDeviceChoice,
  setAccessDeviceSelected,
  setAccessExposeNames,
  setAccessManagedHost,
  setAccessDestructive,
  setAccessGroupLevel,
  setAccessToolEnabled,
  showsAccessDevices,
  showsAccessHosts,
  showsAccessOrganizations,
  MAX_ACCESS_DESKTOPS,
  toAccessEditorGroups,
  type AccessFormState,
  type AccessModelSource,
} from '../access-model';

describe('organizationChoiceUnavailable', () => {
  const unavailableOrganization = {
    unavailableReason: 'Outside agents are not allowed.',
  };

  it('only blocks adding an unavailable organization that is not already selected', () => {
    expect(
      organizationChoiceUnavailable(unavailableOrganization, {
        selected: false,
        initiallySelected: false,
      }),
    ).toBe(true);
    expect(
      organizationChoiceUnavailable(unavailableOrganization, {
        selected: true,
        initiallySelected: false,
      }),
    ).toBe(false);
    expect(
      organizationChoiceUnavailable(unavailableOrganization, {
        selected: false,
        initiallySelected: true,
      }),
    ).toBe(false);
    expect(
      organizationChoiceUnavailable(
        { unavailableReason: null },
        { selected: false, initiallySelected: false },
      ),
    ).toBe(false);
  });
});

interface GroupOptions {
  readonly destructive?: boolean;
  readonly destructiveTools?: readonly string[];
  readonly writable?: boolean;
  readonly minimum?: 'off' | 'read';
  readonly unavailableReason?: string | null;
  readonly writeUnavailableReason?: string | null;
  readonly tools?: readonly ExternalAgentAccessTool[];
}

const MANAGED_ONLY = { managed: true, connected: false } as const;
const CONNECTED_ONLY = { managed: false, connected: true } as const;
const BOTH_HOSTS = { managed: true, connected: true } as const;

function tool(
  name: string,
  access: 'read' | 'write' = 'read',
  defaultOff = false,
  hosts: ExternalAgentAccessTool['hosts'] = null,
): ExternalAgentAccessTool {
  return {
    name,
    title: name,
    access,
    defaultOff,
    markers: {
      spendsCredits: false,
      sendsEmail: false,
      publicEffect: false,
      actsOnRemote: false,
    },
    hosts,
  };
}

function group(
  id: ExternalAgentToolGroup,
  options: GroupOptions = {},
): ExternalAgentAccessGroup {
  return {
    id,
    label: id,
    description: `Access to ${id}`,
    destructive: options.destructive ?? false,
    destructiveTools: [...(options.destructiveTools ?? [])],
    writable: options.writable ?? true,
    writeUnavailableReason: options.writeUnavailableReason ?? null,
    minimum: options.minimum ?? (id === 'account' ? 'read' : 'off'),
    unavailableReason: options.unavailableReason ?? null,
    tools: [...(options.tools ?? [])],
  };
}

function source(
  server: 'account' | 'tasks',
  groups: readonly ExternalAgentAccessGroup[],
  initialLevels: AccessModelSource['initialLevels'] = {},
): AccessModelSource {
  return { server, groups, initialLevels };
}

function state(overrides: Partial<AccessFormState> = {}): AccessFormState {
  return {
    preset: 'custom',
    levels: {},
    destructiveGroups: [],
    disabledTools: [],
    enabledDefaultOff: [],
    organizations: { mode: 'selected', organizationIds: [] },
    hosts: initialAccessHostsState(),
    ...overrides,
  };
}

function detail(
  groups: ExternalAgentAccessGroup[],
  current: ExternalAgentAccess,
  server: 'account' | 'tasks' = 'account',
): ExternalAgentConnectionDetail {
  return {
    id: 'connection-id',
    server,
    clientName: 'Example agent',
    verified: true,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: null,
    expiresAt: null,
    access: {
      read: [],
      write: [],
      destructive: [],
      organizations: server === 'tasks' ? null : 'all',
      desktops: null,
      managed: server === 'tasks' ? current.hosts.managed : null,
    },
    revision: 1,
    from: null,
    returnsTo: 'agent.example/callback',
    loopback: false,
    groups,
    current,
    organizations: [
      {
        id: 'organization-id',
        name: 'Personal',
        roleLine: 'You are the owner.',
        unavailableReason: null,
        personal: true,
      },
    ],
    remoteControlEnabled: server === 'tasks',
    maxTools: 80,
    activity: [],
    confirmationClasses: [
      'profile',
      'settings',
      'membership',
      'sharing',
      'content',
    ],
    confirmation: {
      profile: 'act',
      settings: 'act',
      membership: 'act',
      sharing: 'act',
      content: 'act',
      task: 'act',
      pipeline: 'act',
    },
    waiting: [],
    textContentCompatibility: false,
  };
}

function desktop(remoteId: string, name: string): ExternalAgentDesktop {
  return {
    remoteId,
    hostCode: '7k3q9x2m4p',
    name,
    hostname: null,
    connection: 'active',
    lastSeenAt: null,
  };
}

describe('external-agent access model', () => {
  it('builds read and write presets for available groups only', () => {
    const groups = [
      group('account', { writable: false }),
      group('digests'),
      group('tasks', { unavailableReason: 'Not available yet' }),
    ];

    expect(accessPresets(groups)).toEqual({
      read: { account: 'read', digests: 'read' },
      write: { account: 'read', digests: 'write' },
    });
  });

  it('matches presets using effective levels, with missing levels off', () => {
    const groups = [group('account'), group('digests'), group('tasks')];
    const model = source('tasks', groups);
    const presets = accessPresets(groups);

    expect(
      matchingPreset(
        model,
        { account: 'read', digests: 'read', tasks: 'read' },
        presets,
      ),
    ).toBe('read');
    expect(
      matchingPreset(
        model,
        { account: 'read', digests: 'write', tasks: 'write' },
        presets,
      ),
    ).toBe('custom');
    expect(matchingPreset(model, {}, presets)).toBe('custom');
  });

  it('uses source levels only when the state has no group level', () => {
    const model = source('tasks', [group('tasks')], {
      tasks: 'write',
    });

    expect(buildAccess(model, state()).groups).toEqual({
      tasks: 'write',
    });
    expect(
      buildAccess(model, state({ levels: { tasks: 'read' } })).groups,
    ).toEqual({
      tasks: 'read',
    });
  });

  it('applies presets to available groups and clears tool overrides', () => {
    const groups = [
      group('tasks', { tools: [tool('task_list', 'read', false, BOTH_HOSTS)] }),
    ];
    const model = source('tasks', groups);
    const presets = accessPresets(groups);
    const changed = state({
      disabledTools: ['task_list'],
      enabledDefaultOff: ['file_list'],
    });

    expect(applyAccessPreset(changed, model, presets, 'read')).toEqual({
      ...changed,
      preset: 'read',
      levels: { tasks: 'read' },
      destructiveGroups: [],
      disabledTools: [],
      enabledDefaultOff: [],
    });
    expect(applyAccessPreset(changed, model, presets, 'custom')).toBe(changed);
  });

  it('clamps group changes and marks them custom', () => {
    const model = source('account', [
      group('account'),
      group('billing', { writable: false }),
      group('tasks', { unavailableReason: 'Not available yet' }),
    ]);
    const start = state();
    const account = setAccessGroupLevel(start, model, 'account', 'off');
    const billing = setAccessGroupLevel(account, model, 'billing', 'write');
    const remote = setAccessGroupLevel(billing, model, 'tasks', 'write');

    expect(account.levels.account).toBe('read');
    expect(billing.levels.billing).toBe('read');
    expect(remote.levels.tasks).toBe('off');
    expect(remote.preset).toBe('custom');
    expect(setAccessGroupLevel(start, model, 'digests', 'write')).toBe(start);
  });

  it('keeps destructive access separate from levels, tools and presets', () => {
    const groups = [
      group('org', {
        destructive: true,
        destructiveTools: ['org_member_remove', 'org_team_remove'],
        tools: [tool('org.list'), tool('org.update', 'write')],
      }),
      group('library', {
        destructive: true,
        destructiveTools: ['library_item_remove'],
        tools: [tool('library.list')],
      }),
    ];
    const model = source('account', groups);
    const presets = accessPresets(groups);
    const start = state({ levels: { org: 'write', library: 'write' } });
    const orgEnabled = setAccessDestructive(start, model, 'org', true);
    const bothEnabled = setAccessDestructive(
      orgEnabled,
      model,
      'library',
      true,
    );

    expect(orgEnabled.destructiveGroups).toEqual(['org']);
    expect(bothEnabled.preset).toBe('custom');
    expect(bothEnabled.levels).toEqual({ org: 'write', library: 'write' });
    expect(countEnabledAccessTools(model, bothEnabled)).toBe(6);
    expect(countAccessTools(model)).toBe(6);
    expect(buildAccess(model, bothEnabled).groups).toEqual({
      org: 'destructive',
      library: 'destructive',
    });
    expect(matchingPreset(model, bothEnabled.levels, presets, ['org'])).toBe(
      'custom',
    );

    const rows = toAccessEditorGroups(model, bothEnabled, { verified: false });
    expect(rows.find((row) => row.id === 'org')?.destructive).toEqual({
      label: 'Allow removing members and teams',
      description: 'Each removal still asks you to confirm it.',
      enabled: true,
      warning: "This agent isn't verified. Allow this only if you trust it.",
    });
    expect(rows.find((row) => row.id === 'library')?.destructive).toEqual({
      label: 'Allow deleting library items',
      description: 'Each deletion still asks you to confirm it.',
      enabled: true,
      warning: "This agent isn't verified. Allow this only if you trust it.",
    });
    expect(
      rows.find((row) => row.id === 'org')?.tools.map(({ name }) => name),
    ).toEqual(['org.list', 'org.update']);

    const orgRead = setAccessGroupLevel(bothEnabled, model, 'org', 'read');
    expect(orgRead.destructiveGroups).toEqual(['library']);
    expect(buildAccess(model, orgRead).groups).toEqual({
      org: 'read',
      library: 'destructive',
    });
    expect(
      applyAccessPreset(orgRead, model, presets, 'write').destructiveGroups,
    ).toEqual([]);
    expect(setAccessDestructive(orgRead, model, 'org', true)).toBe(orgRead);
  });

  it('only offers destructive switches while the corresponding group is writable', () => {
    const model = source('account', [
      group('org', {
        destructive: true,
        destructiveTools: ['org_member_remove', 'org_team_remove'],
        tools: [tool('org.list')],
      }),
    ]);
    const readState = state({ levels: { org: 'read' } });

    expect(
      toAccessEditorGroups(model, readState)[0]?.destructive,
    ).toBeUndefined();
    expect(setAccessDestructive(readState, model, 'org', true)).toBe(readState);
    expect(countEnabledAccessTools(model, readState)).toBe(1);
  });

  it('toggles regular and default-off tools with new arrays', () => {
    const regular = tool('task_list', 'read', false, BOTH_HOSTS);
    const defaultOff = tool('file_read', 'read', true, BOTH_HOSTS);
    const start = state();
    const enabled = setAccessToolEnabled(start, defaultOff, true);
    const disabled = setAccessToolEnabled(enabled, regular, false);
    const defaultOffAgain = setAccessToolEnabled(disabled, defaultOff, false);

    expect(enabled.enabledDefaultOff).toEqual([defaultOff.name]);
    expect(disabled.disabledTools).toEqual([regular.name]);
    expect(defaultOffAgain.enabledDefaultOff).toEqual([]);
    expect(start.disabledTools).toEqual([]);
  });

  it('counts and displays only tools enabled by available group levels', () => {
    const groups = [
      group('account', {
        tools: [tool('profile-read'), tool('profile-update', 'write')],
      }),
      group('tasks', {
        tools: [
          tool('task_list', 'read', false, BOTH_HOSTS),
          tool('file_list', 'read', true, BOTH_HOSTS),
        ],
      }),
    ];
    const model = source('tasks', groups, { account: 'read', tasks: 'read' });
    const current = state({ enabledDefaultOff: ['file_list'] });
    const editor = toAccessEditorGroups(model, current);

    expect(countEnabledAccessTools(model, current)).toBe(3);
    expect(editor.find((row) => row.id === 'account')).toMatchObject({
      level: 'read',
      levels: ['read', 'write'],
    });
    expect(
      editor
        .find((row) => row.id === 'tasks')
        ?.tools.find((item) => item.name === 'file_list'),
    ).toMatchObject({ enabled: true, available: true });
  });

  it('shows organizations only when an available organization group is on', () => {
    const organizations = [
      group('digests'),
      group('usage', { unavailableReason: 'Unavailable' }),
    ];
    const model = source('account', organizations);

    expect(
      showsAccessOrganizations(model, state({ levels: { digests: 'read' } })),
    ).toBe(true);
    expect(
      showsAccessOrganizations(model, state({ levels: { usage: 'read' } })),
    ).toBe(false);
    expect(
      showsAccessOrganizations(
        source('tasks', [group('digests')]),
        state({ levels: { digests: 'read' } }),
      ),
    ).toBe(false);
  });

  it('builds an access payload using only this server’s available tools and scopes', () => {
    const groups = [
      group('account', {
        tools: [tool('profile-read'), tool('profile-default', 'read', true)],
      }),
      group('digests', { tools: [tool('digest-list')] }),
      group('usage', {
        unavailableReason: 'Unavailable',
        tools: [tool('usage-read')],
      }),
    ];
    const model = source('account', groups);
    const current = state({
      levels: { account: 'read', digests: 'read', usage: 'write' },
      disabledTools: ['digest-list', 'not-a-tool', 'usage-read'],
      enabledDefaultOff: ['profile-default', 'not-a-tool'],
      organizations: { mode: 'selected', organizationIds: ['organization-id'] },
      hosts: {
        managed: true,
        devices: 'all',
        remoteIds: ['ignored-id'],
        exposeNames: true,
      },
    });

    expect(buildAccess(model, current)).toEqual({
      groups: { account: 'read', digests: 'read' },
      disabledTools: ['digest-list'],
      enabledDefaultOff: ['profile-default'],
      organizations: { mode: 'selected', organizationIds: ['organization-id'] },
      hosts: {
        managed: false,
        connected: { mode: 'selected', remoteIds: [] },
        exposeNames: false,
      },
    });
  });

  it('keeps unused organization and host scopes when editing, but uses the Tasks consent default', () => {
    const account = source('account', [group('account'), group('org')]);
    const orgsOff = state({
      levels: { account: 'read', org: 'off' },
      organizations: { mode: 'selected', organizationIds: ['organization-a'] },
    });
    expect(buildAccess(account, orgsOff).organizations).toEqual({
      mode: 'all',
      organizationIds: [],
    });
    expect(
      buildAccess(account, orgsOff, { keepUnusedScope: true }).organizations,
    ).toEqual({ mode: 'selected', organizationIds: ['organization-a'] });

    const tasks = source('tasks', [group('tasks')]);
    const hostsOff = state({
      levels: { tasks: 'off' },
      hosts: {
        managed: false,
        devices: 'all',
        remoteIds: ['device-id'],
        exposeNames: true,
      },
    });
    expect(buildAccess(tasks, hostsOff).hosts).toEqual(NEW_TASKS_HOSTS);
    expect(
      buildAccess(tasks, hostsOff, { keepUnusedScope: true }).hosts,
    ).toEqual({
      managed: false,
      connected: { mode: 'all', remoteIds: [] },
      exposeNames: true,
    });
  });

  it('keeps a Tasks connection’s selected organizations when editing', () => {
    const tasks = source('tasks', [group('tasks')]);
    const selected = state({
      levels: { tasks: 'write' },
      organizations: { mode: 'selected', organizationIds: ['organization-a'] },
    });
    expect(
      buildAccess(tasks, selected, { keepUnusedScope: true }).organizations,
    ).toEqual({ mode: 'selected', organizationIds: ['organization-a'] });
    // Consent offers no organization picker on Tasks and starts from all.
    expect(buildAccess(tasks, selected).organizations).toEqual({
      mode: 'all',
      organizationIds: [],
    });
  });

  it('builds all, selected, and none host choices and deduplicates selected device ids', () => {
    const tasks = source('tasks', [group('tasks')]);
    const firstId = 'c0ffee00-0000-4000-8000-000000000001';
    const secondId = 'c0ffee00-0000-4000-8000-000000000002';
    const selected = state({
      levels: { tasks: 'read' },
      hosts: {
        managed: true,
        devices: 'selected',
        remoteIds: [firstId, secondId, firstId],
        exposeNames: true,
      },
    });

    expect(buildAccess(tasks, selected).hosts).toEqual({
      managed: true,
      connected: { mode: 'selected', remoteIds: [firstId, secondId] },
      exposeNames: true,
    });
    const all = setAccessDeviceChoice(selected, 'all');
    expect(all.hosts.remoteIds).toEqual([firstId, secondId, firstId]);
    expect(buildAccess(tasks, all).hosts).toEqual({
      managed: true,
      connected: { mode: 'all', remoteIds: [] },
      exposeNames: true,
    });
    expect(setAccessDeviceChoice(all, 'selected').hosts.devices).toBe(
      'selected',
    );
    expect(
      buildAccess(tasks, setAccessDeviceChoice(selected, 'none')).hosts,
    ).toEqual({
      managed: true,
      connected: { mode: 'selected', remoteIds: [] },
      exposeNames: true,
    });
  });

  it('shows Hosts for active Tasks access and reports when a Tasks grant reaches no host', () => {
    const tasks = source('tasks', [group('tasks')]);
    const active = state({ levels: { tasks: 'read' } });
    expect(showsAccessHosts(tasks, active)).toBe(true);
    expect(showsAccessHosts(tasks, state({ levels: { tasks: 'write' } }))).toBe(
      true,
    );

    const existingHost = state({
      levels: { tasks: 'off' },
      hosts: {
        managed: true,
        devices: 'none',
        remoteIds: [],
        exposeNames: false,
      },
    });
    expect(showsAccessHosts(tasks, existingHost)).toBe(false);

    const noHost = state({
      levels: { tasks: 'read' },
      hosts: {
        managed: false,
        devices: 'none',
        remoteIds: [],
        exposeNames: false,
      },
    });
    expect(accessHostsMissing(tasks, noHost)).toBe(true);
    expect(showsAccessHosts(tasks, noHost)).toBe(true);
    expect(
      accessHostsMissing(
        tasks,
        state({
          levels: { tasks: 'read' },
          hosts: {
            managed: false,
            devices: 'selected',
            remoteIds: [],
            exposeNames: false,
          },
        }),
      ),
    ).toBe(true);
    expect(accessHostsMissing(tasks, setAccessManagedHost(noHost, true))).toBe(
      false,
    );
    expect(
      accessHostsMissing(tasks, setAccessDeviceChoice(noHost, 'all')),
    ).toBe(false);
    expect(
      accessHostsMissing(
        tasks,
        state({
          levels: { tasks: 'read' },
          hosts: {
            managed: false,
            devices: 'selected',
            remoteIds: ['device-id'],
            exposeNames: false,
          },
        }),
      ),
    ).toBe(false);
    expect(accessHostsMissing(source('account', []), noHost)).toBe(false);
    expect(showsAccessHosts(source('account', []), noHost)).toBe(false);
  });

  it('shows device choice only for Tasks with Remote Control and flags device write access', () => {
    const tasks = source('tasks', [group('tasks')]);
    const account = source('account', [group('tasks')]);
    const write = state({ levels: { tasks: 'write' } });
    expect(showsAccessDevices(tasks, true)).toBe(true);
    expect(showsAccessDevices(tasks, false)).toBe(false);
    expect(showsAccessDevices(account, true)).toBe(false);
    expect(devicesWriteAccess(tasks, write, true)).toBe(true);
    expect(
      devicesWriteAccess(tasks, setAccessDeviceChoice(write, 'none'), true),
    ).toBe(false);
    expect(
      devicesWriteAccess(tasks, state({ levels: { tasks: 'read' } }), true),
    ).toBe(false);
    expect(devicesWriteAccess(tasks, write, false)).toBe(false);
  });

  it('updates host switches, device choices, and expose-names state immutably', () => {
    const start = state();
    expect(setAccessManagedHost(start, false).hosts.managed).toBe(false);
    expect(setAccessExposeNames(start, true).hosts.exposeNames).toBe(true);
    expect(setAccessDeviceChoice(start, 'all').hosts.devices).toBe('all');
    expect(start.hosts.managed).toBe(true);
    expect(start.hosts.exposeNames).toBe(false);
  });

  it('deduplicates device ids, removes unavailable selections, and enforces the selection cap', () => {
    const selectedId = 'c0ffee00-0000-4000-8000-000000000004';
    const selected = state({
      hosts: {
        managed: true,
        devices: 'selected',
        remoteIds: [selectedId, selectedId],
        exposeNames: false,
      },
    });
    expect(
      setAccessDeviceSelected(selected, selectedId, true).hosts.remoteIds,
    ).toEqual([selectedId]);
    expect(
      setAccessDeviceSelected(selected, selectedId, false).hosts.remoteIds,
    ).toEqual([]);

    const fullIds = Array.from(
      { length: MAX_ACCESS_DESKTOPS },
      (_, index) =>
        `c0ffee00-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    );
    const full = state({
      hosts: {
        managed: true,
        devices: 'selected',
        remoteIds: fullIds,
        exposeNames: false,
      },
    });
    expect(deviceSelectionFull(full)).toBe(true);
    expect(
      setAccessDeviceSelected(
        full,
        'c0ffee00-0000-4000-8000-ffffffffffff',
        true,
      ),
    ).toBe(full);
    expect(deviceSelectionFull(state())).toBe(false);

    const distinctIds = fullIds.slice(0, MAX_ACCESS_DESKTOPS - 1);
    const duplicateId = distinctIds[0];
    if (duplicateId === undefined) throw new Error('Expected a selected ID');
    const withDuplicate = state({
      hosts: {
        managed: true,
        devices: 'selected',
        remoteIds: [...distinctIds, duplicateId],
        exposeNames: false,
      },
    });
    expect(deviceSelectionFull(withDuplicate)).toBe(false);
    const newId = 'c0ffee00-0000-4000-8000-fffffffffffe';
    const next = setAccessDeviceSelected(withDuplicate, newId, true);
    expect(next).not.toBe(withDuplicate);
    expect(next.hosts.remoteIds).toHaveLength(MAX_ACCESS_DESKTOPS);
    expect(new Set(next.hosts.remoteIds).size).toBe(MAX_ACCESS_DESKTOPS);
    expect(next.hosts.remoteIds[MAX_ACCESS_DESKTOPS - 1]).toBe(newId);
    expect(deviceSelectionFull(next)).toBe(true);
  });

  it('maps paired and unavailable devices and leaves unavailable empty while loading', () => {
    const selectedId = 'c0ffee00-0000-4000-8000-000000000005';
    const unavailableId = 'c0ffee00-0000-4000-8000-000000000006';
    const availableDesktop = desktop(selectedId, 'Work desktop');
    const unselectedDesktop = desktop(
      'c0ffee00-0000-4000-8000-000000000007',
      'Home desktop',
    );

    expect(
      desktopAccessRows(
        [availableDesktop, unselectedDesktop],
        [selectedId, unavailableId],
      ),
    ).toEqual({
      available: [
        { desktop: availableDesktop, selected: true },
        { desktop: unselectedDesktop, selected: false },
      ],
      unavailableIds: [unavailableId],
    });
    expect(desktopAccessRows(null, [unavailableId])).toEqual({
      available: [],
      unavailableIds: [],
    });
  });

  it('builds editor state from account detail and makes tool overrides custom', () => {
    const groups = [
      group('account'),
      group('digests'),
      group('usage', { unavailableReason: 'Not available yet' }),
    ];
    const current: ExternalAgentAccess = {
      groups: { account: 'read', digests: 'read', usage: 'write' },
      disabledTools: [],
      enabledDefaultOff: [],
      organizations: { mode: 'selected', organizationIds: ['organization-id'] },
      hosts: {
        managed: false,
        connected: { mode: 'selected', remoteIds: [] },
        exposeNames: false,
      },
    };
    const fromDetail = accessFormStateFromDetail(detail(groups, current));

    expect(fromDetail).toEqual({
      preset: 'read',
      levels: { account: 'read', digests: 'read', usage: 'off' },
      destructiveGroups: [],
      disabledTools: [],
      enabledDefaultOff: [],
      organizations: { mode: 'selected', organizationIds: ['organization-id'] },
      hosts: {
        managed: false,
        devices: 'none',
        remoteIds: [],
        exposeNames: false,
      },
    });
    expect(
      accessFormStateFromDetail(
        detail(groups, { ...current, disabledTools: ['account-tool'] }),
      ).preset,
    ).toBe('custom');
    expect(
      accessFormStateFromDetail(
        detail(groups, { ...current, enabledDefaultOff: ['account-tool'] }),
      ).preset,
    ).toBe('custom');
  });

  it('maps stored all and selected host scopes into the editor draft', () => {
    const groups = [group('tasks')];
    const current: ExternalAgentAccess = {
      groups: { tasks: 'write' },
      disabledTools: [],
      enabledDefaultOff: [],
      organizations: { mode: 'all', organizationIds: [] },
      hosts: {
        managed: true,
        connected: { mode: 'all', remoteIds: [] },
        exposeNames: true,
      },
    };
    const all = accessFormStateFromDetail(detail(groups, current, 'tasks'));
    expect(all.hosts).toEqual({
      managed: true,
      devices: 'all',
      remoteIds: [],
      exposeNames: true,
    });

    const selectedId = 'c0ffee00-0000-4000-8000-000000000008';
    const selected = accessFormStateFromDetail(
      detail(
        groups,
        {
          ...current,
          hosts: {
            managed: false,
            connected: { mode: 'selected', remoteIds: [selectedId] },
            exposeNames: false,
          },
        },
        'tasks',
      ),
    );
    expect(selected.hosts).toEqual({
      managed: false,
      devices: 'selected',
      remoteIds: [selectedId],
      exposeNames: false,
    });
  });

  it('maps destructive grants from detail to write plus an enabled switch', () => {
    const groups = [
      group('org', {
        destructive: true,
        destructiveTools: ['org_member_remove', 'org_team_remove'],
      }),
    ];
    const current: ExternalAgentAccess = {
      groups: { org: 'destructive' },
      disabledTools: [],
      enabledDefaultOff: [],
      organizations: { mode: 'all', organizationIds: [] },
      hosts: {
        managed: false,
        connected: { mode: 'selected', remoteIds: [] },
        exposeNames: false,
      },
    };

    expect(accessFormStateFromDetail(detail(groups, current))).toMatchObject({
      preset: 'custom',
      levels: { org: 'write' },
      destructiveGroups: ['org'],
    });
  });

  it('keeps a disabled destructive tool when an unrelated change is saved', () => {
    const model = source('account', [
      group('account', { tools: [tool('account-tool')] }),
      group('org', {
        destructive: true,
        destructiveTools: ['org_member_remove', 'org_team_remove'],
        tools: [tool('org-write', 'write')],
      }),
    ]);
    const access = buildAccess(
      model,
      state({
        levels: { account: 'read', org: 'write' },
        destructiveGroups: ['org'],
        disabledTools: ['org_team_remove', 'account-tool'],
      }),
    );

    expect(access.groups.org).toBe('destructive');
    expect(access.disabledTools).toEqual(['org_team_remove', 'account-tool']);
  });

  it('recognizes only protocol tool group identifiers', () => {
    expect(isExternalAgentToolGroup('tasks')).toBe(true);
    expect(isExternalAgentToolGroup('cloud')).toBe(false);
    expect(isExternalAgentToolGroup('remote')).toBe(false);
    expect(isExternalAgentToolGroup('other')).toBe(false);
  });
});

describe('host-gated tools', () => {
  const tasksSource = source('tasks', [
    group('tasks', {
      tools: [
        tool('project_list', 'read', false, BOTH_HOSTS),
        tool('model_list', 'read', false, MANAGED_ONLY),
        tool('plan_list', 'read', false, CONNECTED_ONLY),
        tool('host_list'),
        tool('connection_get'),
      ],
    }),
  ]);
  const readTasks = state({ levels: { tasks: 'read' } });
  const managedOnly = readTasks;
  const devicesOnly = setAccessManagedHost(
    setAccessDeviceChoice(readTasks, 'all'),
    false,
  );
  const selectedDeviceOnly = setAccessDeviceSelected(
    setAccessManagedHost(readTasks, false),
    'device-1',
    true,
  );
  const neither = setAccessDeviceChoice(
    setAccessManagedHost(readTasks, false),
    'none',
  );

  function enabledToolNames(draft: AccessFormState): string[] {
    return toAccessEditorGroups(tasksSource, draft)
      .flatMap((row) => row.tools)
      .filter((row) => row.enabled)
      .map((row) => row.name);
  }

  it('counts a tool for both host kinds with only Cloud agents on', () => {
    expect(enabledToolNames(managedOnly)).toEqual([
      'project_list',
      'model_list',
      'host_list',
      'connection_get',
    ]);
    expect(countEnabledAccessTools(tasksSource, managedOnly)).toBe(4);
  });

  it('counts a tool for both host kinds with only devices on', () => {
    const expected = [
      'project_list',
      'plan_list',
      'host_list',
      'connection_get',
    ];
    expect(enabledToolNames(devicesOnly)).toEqual(expected);
    expect(countEnabledAccessTools(tasksSource, devicesOnly)).toBe(4);
    expect(enabledToolNames(selectedDeviceOnly)).toEqual(expected);
    expect(countEnabledAccessTools(tasksSource, selectedDeviceOnly)).toBe(4);
  });

  it('counts every host tool with both host kinds on', () => {
    const both = setAccessDeviceSelected(readTasks, 'device-1', true);
    expect(countEnabledAccessTools(tasksSource, both)).toBe(5);
  });

  it('counts only tools that take no host with neither host kind on', () => {
    expect(enabledToolNames(neither)).toEqual(['host_list', 'connection_get']);
    expect(countEnabledAccessTools(tasksSource, neither)).toBe(2);
  });

  it('does not count a managed-only tool with Cloud agents off', () => {
    expect(enabledToolNames(devicesOnly)).not.toContain('model_list');
  });

  it('does not count a connected-only tool with devices None', () => {
    expect(
      enabledToolNames(setAccessDeviceChoice(readTasks, 'none')),
    ).not.toContain('plan_list');
  });

  it('ignores tool names and reads only the hosts field', () => {
    // An old-style name must not change the decision.
    const renamed = source('tasks', [
      group('tasks', {
        tools: [tool('cloud_project_list', 'read', false, CONNECTED_ONLY)],
      }),
    ]);
    expect(countEnabledAccessTools(renamed, managedOnly)).toBe(0);
    expect(countEnabledAccessTools(renamed, devicesOnly)).toBe(1);
  });

  it('marks a tool for an unchosen host unavailable', () => {
    const rows = toAccessEditorGroups(tasksSource, devicesOnly).flatMap(
      (row) => row.tools,
    );
    expect(rows.find((row) => row.name === 'model_list')).toEqual(
      expect.objectContaining({ enabled: false, available: false }),
    );
    expect(rows.find((row) => row.name === 'host_list')).toEqual(
      expect.objectContaining({ enabled: true, available: true }),
    );
  });
});
