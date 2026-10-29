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
  desktopSelectionFull,
  desktopsWriteAccess,
  isExternalAgentToolGroup,
  matchingPreset,
  organizationChoiceUnavailable,
  setAccessDesktopMode,
  setAccessDesktopSelected,
  setAccessDestructive,
  setAccessGroupLevel,
  setAccessToolEnabled,
  showsAccessDesktops,
  showsAccessOrganizations,
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

function tool(
  name: string,
  access: 'read' | 'write' = 'read',
  defaultOff = false,
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
    remotes: { mode: 'selected', remoteIds: [] },
    ...overrides,
  };
}

function detail(
  groups: ExternalAgentAccessGroup[],
  current: ExternalAgentAccess,
): ExternalAgentConnectionDetail {
  return {
    id: 'connection-id',
    server: 'account',
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
      organizations: 'all',
      desktops: null,
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
    remoteControlEnabled: true,
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
  };
}

function desktop(remoteId: string, name: string): ExternalAgentDesktop {
  return {
    remoteId,
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
      group('remote', { unavailableReason: 'Not available yet' }),
    ];

    expect(accessPresets(groups)).toEqual({
      read: { account: 'read', digests: 'read' },
      write: { account: 'read', digests: 'write' },
    });
  });

  it('matches presets using effective levels, with missing levels off', () => {
    const groups = [group('account'), group('digests'), group('remote')];
    const model = source('tasks', groups);
    const presets = accessPresets(groups);

    expect(
      matchingPreset(
        model,
        { account: 'read', digests: 'read', remote: 'read' },
        presets,
      ),
    ).toBe('read');
    expect(
      matchingPreset(
        model,
        { account: 'read', digests: 'write', remote: 'write' },
        presets,
      ),
    ).toBe('custom');
    expect(matchingPreset(model, {}, presets)).toBe('custom');
  });

  it('uses source levels only when the state has no group level', () => {
    const model = source('tasks', [group('cloud'), group('remote')], {
      cloud: 'write',
      remote: 'read',
    });

    expect(buildAccess(model, state()).groups).toEqual({
      cloud: 'write',
      remote: 'read',
    });
    expect(
      buildAccess(model, state({ levels: { cloud: 'read' } })).groups,
    ).toEqual({
      cloud: 'read',
      remote: 'read',
    });
  });

  it('applies presets to available groups and clears tool overrides', () => {
    const groups = [
      group('cloud', { tools: [tool('cloud-list')] }),
      group('remote', { unavailableReason: 'Not available yet' }),
    ];
    const model = source('tasks', groups);
    const presets = accessPresets(groups);
    const changed = state({
      disabledTools: ['cloud-list'],
      enabledDefaultOff: ['cloud-file-list'],
    });

    expect(applyAccessPreset(changed, model, presets, 'read')).toEqual({
      ...changed,
      preset: 'read',
      levels: { cloud: 'read', remote: 'off' },
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
      group('remote', { unavailableReason: 'Not available yet' }),
    ]);
    const start = state();
    const account = setAccessGroupLevel(start, model, 'account', 'off');
    const billing = setAccessGroupLevel(account, model, 'billing', 'write');
    const remote = setAccessGroupLevel(billing, model, 'remote', 'write');

    expect(account.levels.account).toBe('read');
    expect(billing.levels.billing).toBe('read');
    expect(remote.levels.remote).toBe('off');
    expect(remote.preset).toBe('custom');
    expect(setAccessGroupLevel(start, model, 'cloud', 'write')).toBe(start);
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
    const regular = tool('cloud-list');
    const defaultOff = tool('remote-file-list', 'read', true);
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
      group('cloud', {
        tools: [tool('cloud-list'), tool('cloud-file-list', 'read', true)],
      }),
      group('remote', {
        unavailableReason: 'Not available yet',
        tools: [tool('remote-list')],
      }),
    ];
    const model = source('tasks', groups, { account: 'read', cloud: 'read' });
    const current = state({ enabledDefaultOff: ['cloud-file-list'] });
    const editor = toAccessEditorGroups(model, current);

    expect(countEnabledAccessTools(model, current)).toBe(3);
    expect(editor.find((row) => row.id === 'account')).toMatchObject({
      level: 'read',
      levels: ['read', 'write'],
    });
    expect(editor.find((row) => row.id === 'remote')).toMatchObject({
      level: 'off',
      unavailableReason: 'Not available yet',
    });
    expect(
      editor
        .find((row) => row.id === 'cloud')
        ?.tools.find((item) => item.name === 'cloud-file-list'),
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
      remotes: { mode: 'all', remoteIds: ['ignored-id'] },
    });

    expect(buildAccess(model, current)).toEqual({
      groups: { account: 'read', digests: 'read' },
      disabledTools: ['digest-list'],
      enabledDefaultOff: ['profile-default'],
      organizations: { mode: 'selected', organizationIds: ['organization-id'] },
      remotes: { mode: 'selected', remoteIds: [] },
    });
  });

  it('keeps an unused organization and desktop scope when editing, and resets it for consent', () => {
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

    const tasks = source('tasks', [group('cloud'), group('remote')]);
    const remoteOff = state({
      levels: { remote: 'off' },
      remotes: { mode: 'all', remoteIds: [] },
    });
    expect(buildAccess(tasks, remoteOff).remotes).toEqual({
      mode: 'selected',
      remoteIds: [],
    });
    expect(
      buildAccess(tasks, remoteOff, { keepUnusedScope: true }).remotes,
    ).toEqual({ mode: 'all', remoteIds: [] });
  });

  it('keeps a Tasks connection’s selected organizations when editing', () => {
    const tasks = source('tasks', [group('cloud'), group('remote')]);
    const selected = state({
      levels: { cloud: 'write' },
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

  it('sends chosen desktops only when the available task remote group is on', () => {
    const groups = [group('cloud'), group('remote')];
    const model = source('tasks', groups);
    const selected = state({
      levels: { remote: 'write' },
      remotes: { mode: 'selected', remoteIds: ['desktop-id'] },
    });
    const all = state({
      levels: { remote: 'read' },
      remotes: { mode: 'all', remoteIds: [] },
    });

    expect(showsAccessDesktops(model, selected, true)).toBe(true);
    expect(desktopsWriteAccess(model, selected, true)).toBe(true);
    expect(buildAccess(model, selected).remotes).toEqual({
      mode: 'selected',
      remoteIds: ['desktop-id'],
    });
    expect(buildAccess(model, all).remotes).toEqual({
      mode: 'all',
      remoteIds: [],
    });
    expect(showsAccessDesktops(model, selected, false)).toBe(false);
    expect(
      showsAccessDesktops(
        source('tasks', [
          group('remote', { unavailableReason: 'Not available yet' }),
        ]),
        selected,
        true,
      ),
    ).toBe(false);
  });

  it('serializes selected and all desktop modes while retaining the draft', () => {
    const model = source('tasks', [group('remote')]);
    const firstId = 'c0ffee00-0000-4000-8000-000000000001';
    const secondId = 'c0ffee00-0000-4000-8000-000000000002';
    const selected = state({
      levels: { remote: 'read' },
      remotes: { mode: 'selected', remoteIds: [firstId, secondId] },
    });

    expect(buildAccess(model, selected).remotes).toEqual({
      mode: 'selected',
      remoteIds: [firstId, secondId],
    });

    const all = setAccessDesktopMode(selected, 'all');
    expect(all.remotes.remoteIds).toEqual([firstId, secondId]);
    expect(buildAccess(model, all).remotes).toEqual({
      mode: 'all',
      remoteIds: [],
    });
    expect(setAccessDesktopMode(all, 'selected').remotes).toEqual({
      mode: 'selected',
      remoteIds: [firstId, secondId],
    });
  });

  it('keeps an unavailable selected desktop until it is removed', () => {
    const model = source('tasks', [group('remote')]);
    const unavailableId = 'c0ffee00-0000-4000-8000-000000000003';
    const selected = state({
      levels: { remote: 'read' },
      remotes: { mode: 'selected', remoteIds: [unavailableId] },
    });

    expect(buildAccess(model, selected).remotes.remoteIds).toEqual([
      unavailableId,
    ]);
    expect(
      buildAccess(
        model,
        setAccessDesktopSelected(selected, unavailableId, false),
      ).remotes.remoteIds,
    ).toEqual([]);
  });

  it('deduplicates desktop ids when building access and checking an id', () => {
    const model = source('tasks', [group('remote')]);
    const selectedId = 'c0ffee00-0000-4000-8000-000000000004';
    const selected = state({
      levels: { remote: 'read' },
      remotes: {
        mode: 'selected',
        remoteIds: [selectedId, selectedId],
      },
    });

    expect(buildAccess(model, selected).remotes.remoteIds).toEqual([
      selectedId,
    ]);
    expect(
      setAccessDesktopSelected(selected, selectedId, true).remotes.remoteIds,
    ).toEqual([selectedId]);
  });

  it('reports full desktop selections and refuses to add beyond the cap', () => {
    const fullIds = Array.from(
      { length: 500 },
      (_, index) =>
        `c0ffee00-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    );
    const full = state({
      remotes: { mode: 'selected', remoteIds: fullIds },
    });

    expect(desktopSelectionFull(full)).toBe(true);
    expect(
      setAccessDesktopSelected(
        full,
        'c0ffee00-0000-4000-8000-ffffffffffff',
        true,
      ),
    ).toBe(full);
    expect(desktopSelectionFull(state())).toBe(false);
  });

  it('counts unique desktops, not duplicate entries, against the cap', () => {
    const distinctIds = Array.from(
      { length: 499 },
      (_, index) =>
        `c0ffee00-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    );
    const duplicateId = 'c0ffee00-0000-4000-8000-000000000000';
    const newId = 'c0ffee00-0000-4000-8000-fffffffffffe';
    // 500 entries, but only 499 distinct desktops.
    const withDuplicate = state({
      remotes: { mode: 'selected', remoteIds: [...distinctIds, duplicateId] },
    });

    expect(desktopSelectionFull(withDuplicate)).toBe(false);
    const next = setAccessDesktopSelected(withDuplicate, newId, true);
    expect(next).not.toBe(withDuplicate);
    expect(next.remotes.remoteIds).toHaveLength(500);
    expect(new Set(next.remotes.remoteIds).size).toBe(500);
    expect(next.remotes.remoteIds[499]).toBe(newId);
    expect(desktopSelectionFull(next)).toBe(true);
  });

  it('maps paired and unavailable desktops and leaves unavailable empty while loading', () => {
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

  it('builds editor state from current detail and makes tool overrides custom', () => {
    const groups = [
      group('account'),
      group('digests'),
      group('remote', { unavailableReason: 'Not available yet' }),
    ];
    const current: ExternalAgentAccess = {
      groups: { account: 'read', digests: 'read', remote: 'write' },
      disabledTools: [],
      enabledDefaultOff: [],
      organizations: { mode: 'selected', organizationIds: ['organization-id'] },
      remotes: { mode: 'all', remoteIds: [] },
    };
    const connection = detail(groups, current);
    const fromDetail = accessFormStateFromDetail(connection);

    expect(fromDetail).toEqual({
      preset: 'read',
      levels: { account: 'read', digests: 'read', remote: 'off' },
      destructiveGroups: [],
      disabledTools: [],
      enabledDefaultOff: [],
      organizations: { mode: 'selected', organizationIds: ['organization-id'] },
      remotes: { mode: 'all', remoteIds: [] },
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
      remotes: { mode: 'selected', remoteIds: [] },
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
    expect(isExternalAgentToolGroup('cloud')).toBe(true);
    expect(isExternalAgentToolGroup('other')).toBe(false);
  });
});
