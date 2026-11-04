/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import {
  CanopyClientProvider,
  useOrgProjectsStore,
  type OrgProjectsStoreState,
} from '@canopy/app-state';
import { createFakeClient } from '@canopy/app-state/__tests__/fake-org-projects-client';
import type {
  OrgProjectLinksListResult,
  OrgProjectRelationship,
  DesktopOrgProjectCatalogSnapshot,
} from '@canopy/desktop-shared/types';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { useLinkedPersonalWorkspacesStore } from '@/stores/linkedPersonalWorkspacesStore';
import { OrgProjectSetupDialog } from '../../worktree/OrgProjectSetupDialog';
import { OrgProjectPlaceholderRow } from '../../worktree/OrgProjectPlaceholderRow';
import { useSidebarWorkspaces } from '../useSidebarWorkspaces';
import { RELATIONSHIP_RETRY_DELAYS_MS } from '../useSidebarOrgProjectPlaceholders';
import { refreshPrivateMemoryRows } from '@/lib/privateMemory';
jest.mock('@/lib/privateMemory', () => ({
  refreshPrivateMemoryRows: jest.fn(),
}));
const mockRefreshPrivateMemoryRows = jest.mocked(refreshPrivateMemoryRows);
jest.mock('@/hooks/useCanopyOrgProjectsEnabled', () => ({
  useCanopyOrgProjectsEnabled: (): boolean => true,
}));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

it('lists no catalog project the member has not set up, only setups they started (CAN-3386)', async (): Promise<void> => {
  const originalContext = useWorkspaceContextStore.getState();
  const originalProjects = useProjectsStore.getState();
  const fake = createFakeClient();
  const originalApi = Object.getOwnPropertyDescriptor(window, 'api');
  let onPrivateMemoryChanged: (() => void) | undefined;
  mockRefreshPrivateMemoryRows.mockResolvedValue(undefined);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      onWorkspacePrivateMemoryChanged: (callback: () => void): (() => void) => {
        onPrivateMemoryChanged = callback;
        return (): void => {
          onPrivateMemoryChanged = undefined;
        };
      },
      orgProjects: {
        linksList: (): Promise<OrgProjectLinksListResult> =>
          Promise.resolve({ status: 'resolved', links: [] }),
      },
    },
  });
  // Sixty listed projects: every one used to become a sidebar row.
  const snapshot: DesktopOrgProjectCatalogSnapshot = {
    context: 'org:org-a',
    revision: 'r1',
    fetchedAt: '',
    stale: false,
    error: null,
    projects: Array.from({ length: 60 }, (_, index) => ({
      id: `catalog-${index}`,
      organizationId: 'org-a',
      name: `Catalog ${index}`,
      description: null,
      kind: 'CODE' as const,
      purpose: 'project' as const,
      visibility: 'organization' as const,
      memberOwned: false,
      location: 'LOCAL' as const,
      repository: {
        provider: 'github' as const,
        host: 'github.com',
        owner: 'acme',
        name: `repo-${index}`,
        providerRepoId: `${index}`,
        defaultBranch: 'main',
        verification: 'VERIFIED' as const,
      },
      state: 'ACTIVE' as const,
      revision: 1,
      authorizationVersion: 1,
      defaultListed: true,
      preference: 'FOLLOW_DEFAULTS' as const,
      listed: true,
      capabilities: { administer: false, manageCloud: false, use: true },
      instance: null,
    })),
  };
  fake.query.mockResolvedValue(snapshot);
  let model: ReturnType<typeof useSidebarWorkspaces> | undefined;
  function Probe(): JSX.Element {
    model = useSidebarWorkspaces();
    return <div />;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  useProjectsStore.setState({ projects: [] });
  useWorkspaceContextStore.setState({
    hydrated: true,
    state: {
      context: { kind: 'organization', organizationId: 'org-a' },
      organizations: [{ id: 'org-a', name: 'Org', role: 'MEMBER' }],
      revision: 1,
    },
  });
  const progress = (
    projectId: string,
    state: 'claiming' | 'materializing' | 'failed' | 'cancelled',
  ): void => {
    fake.emit('org-projects.setup-progress', {
      progress: {
        projectId,
        instanceId: null,
        state,
        message: state,
        percent: null,
        updatedAt: `${projectId}-${state}`,
      },
      occurredAt: `${projectId}-${state}`,
    });
  };
  try {
    await act(async (): Promise<void> => {
      root.render(
        <CanopyClientProvider client={fake.client}>
          <Probe />
        </CanopyClientProvider>,
      );
      await Promise.resolve();
    });
    await act(async (): Promise<void> => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onPrivateMemoryChanged).toBeDefined();
    await act(async (): Promise<void> => {
      onPrivateMemoryChanged?.();
      await Promise.resolve();
    });
    expect(mockRefreshPrivateMemoryRows).toHaveBeenCalledTimes(1);
    expect(fake.query).toHaveBeenCalled();
    expect(model?.placeholderRows).toEqual([]);
    // A setup the member started shows its progress until it resolves.
    for (const state of ['claiming', 'materializing', 'failed'] as const) {
      await act(async (): Promise<void> => {
        progress('catalog-7', state);
        await Promise.resolve();
      });
      expect(model?.placeholderRows.map((row) => row.project.id)).toEqual([
        'catalog-7',
      ]);
    }
    // Cancelling returns the project to the + dialog only.
    await act(async (): Promise<void> => {
      progress('catalog-7', 'cancelled');
      await Promise.resolve();
    });
    expect(model?.placeholderRows).toEqual([]);
  } finally {
    act((): void => root.unmount());
    useWorkspaceContextStore.setState(originalContext);
    useProjectsStore.setState(originalProjects);
    if (originalApi) Object.defineProperty(window, 'api', originalApi);
    else Reflect.deleteProperty(window, 'api');
  }
});

it('loads only the active organization and keeps placeholders outside real project arrays', async (): Promise<void> => {
  const originalContext = useWorkspaceContextStore.getState();
  const originalProjects = useProjectsStore.getState();
  const fake = createFakeClient();
  const originalApi = Object.getOwnPropertyDescriptor(window, 'api');
  const loadPreferences = jest
    .fn<Promise<{ orgProjectDefaultDestinationRoot: string }>, []>()
    .mockResolvedValue({ orgProjectDefaultDestinationRoot: '/default' });
  const savePreferences = jest
    .fn<Promise<void>, []>()
    .mockResolvedValue(undefined);
  const browseForCloneDirectory = jest
    .fn<Promise<{ canceled: boolean; directoryPath: string }>, []>()
    .mockResolvedValue({ canceled: false, directoryPath: '/chosen' });
  const linksList = jest.fn(
    (): Promise<OrgProjectLinksListResult> =>
      Promise.resolve({ status: 'resolved', links }),
  );
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadPreferences,
      savePreferences,
      browseForCloneDirectory,
      orgProjects: {
        linksList,
      },
    },
  });
  let links: OrgProjectRelationship[] = [
    { projectId: 'catalog', personalWorkspaceId: 'private-personal' },
  ];
  const snapshot: DesktopOrgProjectCatalogSnapshot = {
    context: 'org:org-a',
    revision: 'r1',
    fetchedAt: '',
    stale: false,
    error: null,
    projects: ['catalog', 'bound'].map((id) => ({
      id,
      organizationId: 'org-a',
      name: id,
      description: null,
      kind: 'CODE',
      purpose: 'project',
      visibility: 'organization',
      memberOwned: false,
      location: 'LOCAL',
      repository: {
        provider: 'github',
        host: 'github.com',
        owner: 'acme',
        name: 'repo',
        providerRepoId: '1',
        defaultBranch: 'main',
        verification: 'VERIFIED',
      },
      state: 'ACTIVE',
      revision: 1,
      authorizationVersion: 1,
      defaultListed: true,
      preference: 'FOLLOW_DEFAULTS',
      listed: true,
      capabilities: { administer: false, manageCloud: false, use: true },
      instance: null,
    })),
  };
  fake.query.mockResolvedValue(snapshot);
  let catalogStore: OrgProjectsStoreState | undefined;
  let model: ReturnType<typeof useSidebarWorkspaces> | undefined;
  function Probe(): JSX.Element {
    catalogStore = useOrgProjectsStore((store): OrgProjectsStoreState => store);
    const sidebar = useSidebarWorkspaces();
    model = sidebar;
    return (
      <div>
        <button data-testid="sidebar-context-row">Acme</button>
        <button data-testid="sidebar-account-row">Account</button>
        {sidebar.setupDialog}
        {sidebar.placeholderRows.map((row) => (
          <OrgProjectPlaceholderRow
            key={row.project.id}
            {...row}
            onSetup={sidebar.startPlaceholderSetup}
            onCancel={sidebar.cancelPlaceholderSetup}
          />
        ))}
      </div>
    );
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  useProjectsStore.setState({
    projects: [
      {
        id: 'private-personal',
        name: 'Personal checkout',
        type: 'single-repo',
        repoPath: '/personal',
        color: '',
        collapsed: false,
        order: 1,
        worktrees: [],
      },
      {
        id: 'real',
        name: 'Bound',
        type: 'single-repo',
        repoPath: '/repo',
        color: '',
        collapsed: false,
        order: 0,
        worktrees: [],
        owner: {
          type: 'organization',
          organizationId: 'org-a',
          projectId: 'bound',
          instanceId: 'instance',
          bindingGeneration: 1,
        },
      },
    ],
  });
  useWorkspaceContextStore.setState({
    hydrated: true,
    state: { context: { kind: 'personal' }, organizations: [], revision: 1 },
  });
  try {
    await act(async (): Promise<void> => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      root.render(
        <CanopyClientProvider client={fake.client}>
          <Probe />
        </CanopyClientProvider>,
      );
    });
    expect(fake.query).not.toHaveBeenCalled();
    await act(async (): Promise<void> => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(linksList).not.toHaveBeenCalled();
    await act(async (): Promise<void> => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      useWorkspaceContextStore.setState({
        state: {
          context: { kind: 'organization', organizationId: 'org-a' },
          organizations: [{ id: 'org-a', name: 'Org', role: 'MEMBER' }],
          revision: 2,
        },
      });
    });
    expect(fake.query).toHaveBeenCalledWith('orgProjects.catalog', {
      context: { kind: 'organization', organizationId: 'org-a' },
    });
    expect(model?.placeholderRows).toEqual([]);
    expect(
      container.querySelector(
        '[data-testid="sidebar-org-project-placeholder-catalog"]',
      ),
    ).toBeNull();
    expect(model?.visibleProjects.map((row) => row.id)).toEqual([
      'real',
      'private-personal',
    ]);
    expect(
      useProjectsStore
        .getState()
        .projects.find((row) => row.id === 'private-personal')?.owner,
    ).toBeUndefined();

    // Repointing a remote leaves workspace identity/path and catalog unchanged.
    const matchesBeforeFocus = linksList.mock.calls.length;
    const matchedLinks = links;
    links = [];
    await act(async (): Promise<void> => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(linksList).toHaveBeenCalledTimes(matchesBeforeFocus + 1);
    expect(model?.visibleProjects.map((row) => row.id)).toEqual(['real']);
    // An unlinked catalog project is added from the + dialog, never listed
    // here (CAN-3386).
    expect(model?.placeholderRows).toEqual([]);
    expect(
      container.querySelector(
        '[data-testid="sidebar-org-project-placeholder-catalog"]',
      ),
    ).toBeNull();
    links = matchedLinks;
    // A second focus inside the throttle window is deliberately ignored: the
    // match spawns git per Personal workspace and alt-tabbing is cheap.
    await act(async (): Promise<void> => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(linksList).toHaveBeenCalledTimes(matchesBeforeFocus + 1);
    const realNow = Date.now;
    jest.spyOn(Date, 'now').mockReturnValue(realNow() + 60_000);
    await act(async (): Promise<void> => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    jest.spyOn(Date, 'now').mockRestore();
    expect(linksList).toHaveBeenCalledTimes(matchesBeforeFocus + 2);
    expect(model?.placeholderRows).toEqual([]);
    expect(model?.visibleProjects.map((row) => row.id)).toEqual([
      'real',
      'private-personal',
    ]);

    // Two focus refreshes overlap: the newer empty result must win even when
    // the older match arrives last, or it would hide the offer and admit Personal.
    // CLAUDE.md bans the `!` operator, so these stay nullable and are narrowed
    // at the call site rather than asserted away at the declaration.
    let resolveOlder: ((value: OrgProjectLinksListResult) => void) | null =
      null;
    let resolveNewer: ((value: OrgProjectLinksListResult) => void) | null =
      null;
    linksList
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOlder = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveNewer = resolve;
          }),
      );
    const focusClock = jest.spyOn(Date, 'now');
    try {
      for (const offset of [120_000, 180_000]) {
        focusClock.mockReturnValue(realNow() + offset);
        await act(async (): Promise<void> => {
          window.dispatchEvent(new Event('focus'));
          await Promise.resolve();
        });
      }
      expect(resolveNewer).not.toBeNull();
      await act(async (): Promise<void> => {
        resolveNewer?.({ status: 'resolved', links: [] });
        await Promise.resolve();
      });
      expect(model?.visibleProjects.map((row) => row.id)).toEqual(['real']);
      expect(model?.placeholderRows).toEqual([]);
      expect(resolveOlder).not.toBeNull();
      await act(async (): Promise<void> => {
        resolveOlder?.({ status: 'resolved', links: matchedLinks });
        await Promise.resolve();
      });
      expect(model?.visibleProjects.map((row) => row.id)).toEqual(['real']);
      expect(model?.placeholderRows).toEqual([]);
      // Restore the match for the remaining linked-project flows.
      focusClock.mockReturnValue(realNow() + 240_000);
      await act(async (): Promise<void> => {
        window.dispatchEvent(new Event('focus'));
        await Promise.resolve();
      });
    } finally {
      focusClock.mockRestore();
    }

    // A linked project has no row to receive focus when separate setup closes.
    expect(
      container.querySelector(
        '[data-testid="sidebar-org-project-placeholder-catalog"]',
      ),
    ).toBeNull();

    // A READY instance makes the Personal relationship ineligible. If the
    // cached answer resolves empty there, returning to a placeholder must
    // refresh immediately instead of flashing a stale Set up row.
    links = [];
    await act(async (): Promise<void> => {
      await Promise.resolve();
      fake.query.mockResolvedValue({
        ...snapshot,
        projects: snapshot.projects.map((project) =>
          project.id === 'catalog'
            ? { ...project, instance: { id: 'ready', state: 'READY' } }
            : project,
        ),
      });
      fake.emit('org-projects.changed', {
        context: { kind: 'organization', organizationId: 'org-a' },
        reason: 'instance',
        occurredAt: 'ready-instance',
      });
    });
    const readyClock = jest
      .spyOn(Date, 'now')
      .mockReturnValue(realNow() + 300_000);
    try {
      await act(async (): Promise<void> => {
        window.dispatchEvent(new Event('focus'));
        await Promise.resolve();
      });
    } finally {
      readyClock.mockRestore();
    }
    expect(model?.visibleProjects.map((row) => row.id)).toEqual(['real']);
    const matchesAfterReady = linksList.mock.calls.length;

    links = matchedLinks;
    await act(async (): Promise<void> => {
      await Promise.resolve();
      fake.query.mockResolvedValue(snapshot);
      fake.emit('org-projects.changed', {
        context: { kind: 'organization', organizationId: 'org-a' },
        reason: 'catalog',
        occurredAt: 'placeholder-restored',
      });
    });
    expect(linksList).toHaveBeenCalledTimes(matchesAfterReady + 1);
    expect(model?.visibleProjects.map((row) => row.id)).toEqual([
      'real',
      'private-personal',
    ]);
    expect(model?.placeholderRows).toEqual([]);

    const setupOpener = document.createElement('button');
    container.append(setupOpener);
    setupOpener.focus();
    await act(async (): Promise<void> => {
      await model?.startPlaceholderSetup('catalog');
    });
    setupOpener.remove();
    expect(
      document.querySelector('[data-testid="org-project-setup-dialog"]'),
    ).not.toBeNull();
    await act(async (): Promise<void> => {
      await Promise.resolve();
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="org-project-setup-cancel"]',
        )
        ?.click();
    });

    // With no Add button, focus returns to the footer scope switcher that
    // selected the organization (CAN-3522).
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="sidebar-context-row"]'),
    );

    // Cached offline rows retain the link; access loss must invalidate it.
    for (const error of [
      'offline',
      'access-changed',
      'unavailable',
      null,
    ] as const) {
      await act(async (): Promise<void> => {
        await Promise.resolve();
        fake.query.mockResolvedValue({ ...snapshot, error });
        fake.emit('org-projects.changed', {
          context: { kind: 'organization', organizationId: 'org-a' },
          reason: 'catalog',
          occurredAt: error ?? 'restored',
        });
      });
      const admitted = error === 'offline' || error === null;
      expect(
        model?.visibleProjects
          .map((row) => row.id)
          .includes('private-personal'),
      ).toBe(admitted);
      // No catalog state brings back a row for a project not set up.
      expect(model?.placeholderRows).toEqual([]);
    }

    // Withdrawing the offer removes admission, but never the Personal checkout.
    for (const listed of [false, true]) {
      await act(async (): Promise<void> => {
        await Promise.resolve();
        fake.query.mockResolvedValue({
          ...snapshot,
          projects: snapshot.projects.map((project) => ({
            ...project,
            listed,
            preference: listed ? 'LISTED' : 'DISMISSED',
          })),
        });
        fake.emit('org-projects.changed', {
          context: { kind: 'organization', organizationId: 'org-a' },
          reason: 'preference',
          occurredAt: `listed-${listed}`,
        });
      });
      expect(
        model?.visibleProjects.some((row) => row.id === 'private-personal'),
      ).toBe(listed);
      expect(model?.placeholderRows).toEqual([]);
      await act(async (): Promise<void> => {
        await Promise.resolve();
        useWorkspaceContextStore.setState({
          state: {
            ...useWorkspaceContextStore.getState().state,
            context: { kind: 'personal' },
          },
        });
      });
      expect(model?.visibleProjects.map((row) => row.id)).toEqual([
        'private-personal',
      ]);
      const matchesInPersonal = linksList.mock.calls.length;
      await act(async (): Promise<void> => {
        window.dispatchEvent(new Event('focus'));
        await Promise.resolve();
      });
      expect(linksList).toHaveBeenCalledTimes(matchesInPersonal);
      await act(async (): Promise<void> => {
        await Promise.resolve();
        useWorkspaceContextStore.setState({
          state: {
            ...useWorkspaceContextStore.getState().state,
            context: { kind: 'organization', organizationId: 'org-a' },
          },
        });
      });
    }

    // A separate setup must stay actionable even while Personal is admitted.
    for (const state of ['claiming', 'materializing', 'failed'] as const) {
      await act(async (): Promise<void> => {
        await Promise.resolve();
        fake.emit('org-projects.setup-progress', {
          progress: {
            projectId: 'catalog',
            instanceId: null,
            state,
            message: state === 'failed' ? 'Clone failed' : 'Cloning repository',
            percent: 42,
            updatedAt: state,
          },
          occurredAt: state,
        });
      });
      expect(model?.placeholderRows).toHaveLength(1);
      expect(container.textContent).toContain(
        state === 'failed' ? 'Clone failed' : '42%',
      );
      expect(
        container.querySelector(
          `[data-testid="sidebar-org-project-${state === 'failed' ? 'retry' : 'cancel'}-catalog"]`,
        ),
      ).not.toBeNull();
      expect(model?.visibleProjects.map((row) => row.id)).toContain(
        'private-personal',
      );
    }
    // Dismissal must not take active/failing setup information away.
    await act(async (): Promise<void> => {
      await Promise.resolve();
      fake.query.mockResolvedValue({
        ...snapshot,
        projects: snapshot.projects.map((project) => ({
          ...project,
          listed: false,
          preference: 'DISMISSED',
        })),
      });
      fake.emit('org-projects.changed', {
        context: { kind: 'organization', organizationId: 'org-a' },
        reason: 'preference',
        occurredAt: 'dismissed-during-setup',
      });
    });
    const dismissedSetupRows = [];
    for (const state of ['claiming', 'materializing', 'failed'] as const) {
      await act(async (): Promise<void> => {
        await Promise.resolve();
        fake.emit('org-projects.setup-progress', {
          progress: {
            projectId: 'catalog',
            instanceId: null,
            state,
            message: state,
            percent: 42,
            updatedAt: `dismissed-${state}`,
          },
          occurredAt: `dismissed-${state}`,
        });
      });
      expect(container.textContent).toContain(state);
      expect(
        container.querySelector(
          '[data-testid="sidebar-org-project-retry-catalog"]',
        ),
      ).toBeNull();
      if (state !== 'failed') {
        expect(container.textContent).toContain('42%');
        expect(
          container.querySelector(
            '[data-testid="sidebar-org-project-cancel-catalog"]',
          ),
        ).not.toBeNull();
      }
      dismissedSetupRows.push({
        state,
        rows: model?.placeholderRows.map((row) => row.project.id),
        hasRelationship: model?.placeholderRows[0]?.relationship !== undefined,
      });
      expect(model?.visibleProjects.map((row) => row.id)).not.toContain(
        'private-personal',
      );
    }
    expect(dismissedSetupRows).toEqual(
      ['claiming', 'materializing', 'failed'].map((state) => ({
        state,
        rows: ['catalog'],
        hasRelationship: true,
      })),
    );
    await act(async (): Promise<void> => {
      await Promise.resolve();
      fake.query.mockResolvedValue(snapshot);
      fake.emit('org-projects.changed', {
        context: { kind: 'organization', organizationId: 'org-a' },
        reason: 'preference',
        occurredAt: 'relisted-after-setup',
      });
    });
    await act(async (): Promise<void> => {
      await Promise.resolve();
      fake.emit('org-projects.setup-progress', {
        progress: {
          projectId: 'catalog',
          instanceId: null,
          state: 'cancelled',
          message: 'Cancelled',
          percent: null,
          updatedAt: 'cancelled',
        },
        occurredAt: 'cancelled',
      });
    });
    expect(model?.placeholderRows).toEqual([]);

    // Removing the Personal checkout refreshes relationships; the project is
    // again only in the + dialog.
    links = [];
    await act(async (): Promise<void> => {
      await Promise.resolve();
      useProjectsStore.setState({
        projects: useProjectsStore
          .getState()
          .projects.filter((row) => row.id !== 'private-personal'),
      });
    });
    expect(model?.placeholderRows).toEqual([]);
    expect(model?.visibleProjects.map((row) => row.id)).toEqual(['real']);
    expect(
      JSON.stringify(useCurrentUiStateStore.getState().getEnvelope()),
    ).not.toContain('private-personal');

    fake.command.mockResolvedValue({
      projectId: 'catalog',
      instanceId: null,
      state: 'claiming',
      message: 'Claiming a setup slot',
      percent: null,
      updatedAt: new Date().toISOString(),
    });
    await act(async (): Promise<void> => {
      await Promise.resolve();
      if (catalogStore === undefined) throw new Error('Missing catalog store');
      catalogStore.requestSetup('org-b', 'catalog');
    });
    expect(catalogStore?.setupRequest).toBeNull();
    expect(model?.setupDialog).toBeNull();
    await act(async (): Promise<void> => {
      if (catalogStore === undefined) throw new Error('Missing catalog store');
      catalogStore.requestSetup('org-a', 'catalog');
      await Promise.resolve();
    });
    expect(catalogStore?.setupRequest).toBeNull();
    expect(fake.command).not.toHaveBeenCalled();
    const dialog = document.querySelector(
      '[data-testid="org-project-setup-dialog"]',
    );
    expect(dialog?.textContent).toContain('Set up catalog');
    expect(dialog?.textContent).toContain('acme/repo');
    expect(dialog?.textContent).toContain('main');
    expect(dialog?.textContent).toContain(
      'Cloned with your Git credentials. No scripts run until you open a task.',
    );
    const destination = dialog?.querySelector(
      '[data-testid="org-project-setup-destination"]',
    );
    if (!(destination instanceof HTMLButtonElement))
      throw new Error('Missing destination');
    expect(destination.textContent).toBe('/defaultChange');
    // The truncated path, not the button, carries the full value.
    expect(destination.hasAttribute('title')).toBe(false);
    expect(
      destination.querySelector('[dir="rtl"]')?.getAttribute('title'),
    ).toBe('/default');
    expect(destination.querySelector('bdi')?.getAttribute('dir')).toBe('ltr');
    expect(destination.querySelector('[dir="rtl"]')?.className).toContain(
      'truncate',
    );
    await act(async (): Promise<void> => {
      await Promise.resolve();
      destination.click();
    });
    expect(browseForCloneDirectory).toHaveBeenCalledTimes(1);
    expect(destination.textContent).toBe('/chosenChange');
    expect(savePreferences).toHaveBeenLastCalledWith({
      orgProjectDefaultDestinationRoot: '/chosen',
    });
    const startButton = dialog?.querySelector(
      '[data-testid="org-project-setup-start"]',
    );
    if (!(startButton instanceof HTMLButtonElement))
      throw new Error('Missing start');
    await act(async (): Promise<void> => {
      await Promise.resolve();
      startButton.click();
    });
    expect(fake.command).toHaveBeenCalledWith('orgProjects.setupStart', {
      projectId: 'catalog',
      destinationRoot: '/chosen',
    });
    expect(
      document.querySelector('[data-testid="org-project-setup-dialog"]'),
    ).toBeNull();
    expect(container.textContent).toContain('Claiming a setup slot');
    expect(
      container.querySelector(
        '[data-testid="sidebar-org-project-cancel-catalog"]',
      ),
    ).not.toBeNull();
    await act(async (): Promise<void> => {
      await Promise.resolve();
      const updatedAt = new Date().toISOString();
      fake.emit('org-projects.setup-progress', {
        progress: {
          projectId: 'catalog',
          instanceId: null,
          state: 'failed',
          errorCode: 'needs-credentials',
          message: 'GitHub access is needed to clone this repository',
          percent: null,
          updatedAt,
        },
        occurredAt: updatedAt,
      });
    });
    expect(container.textContent).toContain(
      'GitHub access is needed to clone this repository',
    );
    const retry = container.querySelector(
      '[data-testid="sidebar-org-project-retry-catalog"]',
    );
    if (!(retry instanceof HTMLButtonElement)) throw new Error('Missing retry');
    expect(retry.textContent).toBe('Try again');
    await act(async (): Promise<void> => {
      await Promise.resolve();
      retry.click();
    });
    expect(
      document.querySelector('[data-testid="org-project-setup-start"]')
        ?.textContent,
    ).toBe('Start');
    await act(async (): Promise<void> => {
      await Promise.resolve();
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="org-project-setup-cancel"]',
        )
        ?.click();
    });

    await act(async (): Promise<void> => {
      await Promise.resolve();
      await model?.cancelPlaceholderSetup('catalog');
    });
    expect(fake.command).toHaveBeenCalledWith('orgProjects.setupCancel', {
      projectId: 'catalog',
    });
    await act(async (): Promise<void> => {
      await Promise.resolve();
      await Promise.resolve();
      fake.query.mockResolvedValue({
        ...snapshot,
        projects: snapshot.projects.map((project) => ({
          ...project,
          instance: { id: 'ready-instance', state: 'READY' },
        })),
      });
      fake.emit('org-projects.changed', {
        context: { kind: 'organization', organizationId: 'org-a' },
        reason: 'catalog',
        occurredAt: new Date().toISOString(),
      });
    });
    expect(model?.placeholderRows).toEqual([]);
    expect(
      document.querySelector('[data-testid="org-project-setup-dialog"]'),
    ).toBeNull();
    expect(model?.visibleProjects.map((row) => row.id)).toEqual(['real']);

    expect(useProjectsStore.getState().projects.map((row) => row.id)).toEqual([
      'real',
    ]);
    const loadProjects = jest.fn((): Promise<void> => {
      useProjectsStore.setState({
        projects: [
          ...useProjectsStore.getState().projects,
          {
            id: 'materialized',
            name: 'Catalog',
            type: 'single-repo',
            repoPath: '/materialized',
            color: '',
            collapsed: false,
            order: 1,
            worktrees: [],
            owner: {
              type: 'organization',
              organizationId: 'org-a',
              projectId: 'catalog',
              instanceId: 'ready-instance',
              bindingGeneration: 1,
            },
          },
        ],
      });
      return Promise.resolve();
    });
    useProjectsStore.setState({ loadProjects });
    await act(async (): Promise<void> => {
      await Promise.resolve();
      await Promise.resolve();
      const updatedAt = new Date().toISOString();
      fake.emit('org-projects.setup-progress', {
        progress: {
          projectId: 'catalog',
          instanceId: 'ready-instance',
          state: 'ready',
          message: 'Ready',
          percent: null,
          updatedAt,
        },
        occurredAt: updatedAt,
      });
    });
    expect(loadProjects).toHaveBeenCalledWith({ silent: true });
    expect(
      document.querySelector('[data-testid="org-project-setup-dialog"]'),
    ).toBeNull();
    expect(model?.placeholderRows).toEqual([]);
    expect(model?.visibleProjects.map((row) => row.id)).toContain(
      'materialized',
    );

    await act(async (): Promise<void> => {
      useWorkspaceContextStore.setState({
        state: {
          ...useWorkspaceContextStore.getState().state,
          organizations: [],
        },
      });
      await Promise.resolve();
    });
    const matchesWithoutMembership = linksList.mock.calls.length;
    await act(async (): Promise<void> => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(linksList).toHaveBeenCalledTimes(matchesWithoutMembership);

    await act(async (): Promise<void> => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      useWorkspaceContextStore.setState({
        state: {
          context: { kind: 'personal' },
          organizations: [],
          revision: 3,
        },
      });
    });
    expect(model).toMatchObject({ placeholderRows: [] });
  } finally {
    act((): void => root.unmount());
    container.remove();
    useWorkspaceContextStore.setState(originalContext);
    useProjectsStore.setState(originalProjects);
    if (originalApi) Object.defineProperty(window, 'api', originalApi);
    else Reflect.deleteProperty(window, 'api');
  }
});

it('keeps the row of a bound project whose setup never finished', async (): Promise<void> => {
  // The workspace is written before the server confirms. A completion that
  // failed leaves a real workspace and an unfinished instance, and hiding the
  // catalog row then would take the failure and its Retry with it.
  const originalContext = useWorkspaceContextStore.getState();
  const originalProjects = useProjectsStore.getState();
  const fake = createFakeClient();
  const originalApi = Object.getOwnPropertyDescriptor(window, 'api');
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      orgProjects: {
        linksList: (): Promise<OrgProjectLinksListResult> =>
          Promise.resolve({
            status: 'resolved',
            links: [{ projectId: 'catalog', personalWorkspaceId: 'personal' }],
          }),
      },
    },
  });
  const owner = {
    type: 'organization' as const,
    organizationId: 'org-a',
    projectId: 'catalog',
    instanceId: 'instance',
    bindingGeneration: 1,
  };
  const project = (
    instanceState: 'CLAIMED' | 'READY',
  ): DesktopOrgProjectCatalogSnapshot['projects'][number] => ({
    id: 'catalog',
    organizationId: 'org-a',
    name: 'Catalog',
    description: null,
    kind: 'CODE',
    purpose: 'project',
    visibility: 'organization',
    memberOwned: false,
    location: 'LOCAL',
    repository: {
      provider: 'github',
      host: 'github.com',
      owner: 'acme',
      name: 'repo',
      providerRepoId: '1',
      defaultBranch: 'main',
      verification: 'VERIFIED',
    },
    state: 'ACTIVE',
    revision: 1,
    authorizationVersion: 1,
    defaultListed: true,
    preference: 'FOLLOW_DEFAULTS',
    listed: true,
    capabilities: { administer: false, manageCloud: false, use: true },
    instance: { id: 'instance', state: instanceState },
  });
  const snapshot = (
    instanceState: 'CLAIMED' | 'READY',
  ): DesktopOrgProjectCatalogSnapshot => ({
    context: 'org:org-a',
    revision: '1',
    fetchedAt: '2026-09-18T00:00:00.000Z',
    stale: false,
    error: null,
    projects: [project(instanceState)],
  });
  let model: ReturnType<typeof useSidebarWorkspaces> | undefined;
  function Probe(): JSX.Element {
    model = useSidebarWorkspaces();
    return <div />;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  useProjectsStore.setState({
    projects: [
      {
        id: 'personal',
        name: 'Personal',
        type: 'single-repo',
        repoPath: '/personal',
        color: '',
        collapsed: false,
        order: 1,
        worktrees: [],
      },
      {
        id: 'bound',
        name: 'Bound',
        type: 'single-repo',
        repoPath: '/repo',
        color: '',
        collapsed: false,
        order: 0,
        worktrees: [],
        owner,
      },
    ],
  });
  useWorkspaceContextStore.setState({
    hydrated: true,
    state: {
      context: { kind: 'organization', organizationId: 'org-a' },
      organizations: [{ id: 'org-a', name: 'Org', role: 'MEMBER' }],
      revision: 1,
    },
  });
  try {
    fake.query.mockResolvedValue(snapshot('CLAIMED'));
    await act(async (): Promise<void> => {
      root.render(
        <CanopyClientProvider client={fake.client}>
          <Probe />
        </CanopyClientProvider>,
      );
      await Promise.resolve();
    });
    await act(async (): Promise<void> => {
      await Promise.resolve();
    });
    expect(model?.placeholderRows.map((row) => row.project.id)).toEqual([
      'catalog',
    ]);

    expect(model?.placeholderRows[0]?.unfinished).toBe(true);
    expect(model?.visibleProjects.map((row) => row.id)).toContain('personal');

    fake.query.mockResolvedValue({
      ...snapshot('CLAIMED'),
      projects: [
        { ...project('CLAIMED'), listed: false, preference: 'DISMISSED' },
      ],
    });
    await act(async (): Promise<void> => {
      await Promise.resolve();
      fake.emit('org-projects.changed', {
        occurredAt: 'dismissed',
        context: { kind: 'organization', organizationId: 'org-a' },
        reason: 'preference',
      });
    });
    expect(model?.placeholderRows.map((row) => row.project.id)).toEqual([
      'catalog',
    ]);
    expect(model?.placeholderRows[0]?.unfinished).toBe(true);
    expect(model?.placeholderRows[0]?.relationship).toBeDefined();
    expect(model?.visibleProjects.map((row) => row.id)).not.toContain(
      'personal',
    );

    // Once the server confirms, the workspace row is the whole story.
    fake.query.mockResolvedValue(snapshot('READY'));
    await act(async (): Promise<void> => {
      fake.emit('org-projects.changed', {
        occurredAt: '2026-09-18T00:00:01.000Z',
        context: { kind: 'organization', organizationId: 'org-a' },
        reason: 'instance',
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(model?.placeholderRows).toEqual([]);
  } finally {
    act((): void => root.unmount());
    useWorkspaceContextStore.setState(originalContext);
    useProjectsStore.setState(originalProjects);
    if (originalApi) Object.defineProperty(window, 'api', originalApi);
    else Reflect.deleteProperty(window, 'api');
  }
});

it('does not re-match Personal repositories when a poll returns the same projects', async (): Promise<void> => {
  // Every match spawns `git remote get-url` per Personal workspace in the main
  // process. The catalog poll replaces the snapshot object every 30s even when
  // nothing changed (`fetchedAt` moves), so keying the effect on snapshot
  // identity turns this into an unbounded background subprocess loop.
  const originalContext = useWorkspaceContextStore.getState();
  const originalApi = Reflect.get(window, 'api');
  const linksList = jest.fn(
    (): Promise<OrgProjectLinksListResult> =>
      Promise.resolve({ status: 'resolved', links: [] }),
  );
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { orgProjects: { linksList } },
  });
  const fake = createFakeClient();
  const project = {
    id: 'catalog',
    organizationId: 'org-a',
    name: 'Catalog',
    description: null,
    kind: 'CODE',
    purpose: 'project',
    visibility: 'organization',
    memberOwned: false,
    location: 'LOCAL',
    repository: {
      provider: 'github',
      host: 'github.com',
      owner: 'acme',
      name: 'repo',
      providerRepoId: '1',
      defaultBranch: 'main',
      verification: 'VERIFIED',
    },
    state: 'ACTIVE',
    revision: 1,
    authorizationVersion: 1,
    defaultListed: true,
    preference: 'FOLLOW_DEFAULTS',
    listed: true,
    capabilities: { administer: false, manageCloud: false, use: true },
    instance: null,
  } as const;
  const snapshot: DesktopOrgProjectCatalogSnapshot = {
    context: 'org:org-a',
    revision: '1',
    fetchedAt: '2026-09-18T00:00:00.000Z',
    stale: false,
    error: null,
    projects: [project],
  };
  fake.query.mockResolvedValue(snapshot);
  let model: ReturnType<typeof useSidebarWorkspaces> | undefined;
  let catalog: OrgProjectsStoreState['snapshots'][string] | undefined;
  function Probe(): JSX.Element {
    model = useSidebarWorkspaces();
    catalog = useOrgProjectsStore(
      (store): OrgProjectsStoreState['snapshots'][string] | undefined =>
        store.snapshots['org:org-a'],
    );
    return <div />;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  useWorkspaceContextStore.setState({
    hydrated: true,
    state: {
      context: { kind: 'organization', organizationId: 'org-a' },
      organizations: [{ id: 'org-a', name: 'Org', role: 'MEMBER' }],
      revision: 1,
    },
  });
  try {
    await act(async (): Promise<void> => {
      root.render(
        <CanopyClientProvider client={fake.client}>
          <Probe />
        </CanopyClientProvider>,
      );
      await Promise.resolve();
    });
    await act(async (): Promise<void> => {
      await Promise.resolve();
    });
    // Idle catalog projects are not sidebar rows (CAN-3386); the loaded
    // catalog is what the Add project dialog lists.
    expect(model?.placeholderRows).toEqual([]);
    expect(catalog?.projects.map((project) => project.id)).toEqual(['catalog']);
    const matchesAfterMount = linksList.mock.calls.length;
    expect(matchesAfterMount).toBeGreaterThan(0);
    for (const fetchedAt of [
      '2026-09-18T00:00:30.000Z',
      '2026-09-18T00:01:00.000Z',
    ]) {
      await act(async (): Promise<void> => {
        await Promise.resolve();
        fake.query.mockResolvedValue({ ...snapshot, fetchedAt });
        fake.emit('org-projects.changed', {
          context: { kind: 'organization', organizationId: 'org-a' },
          reason: 'catalog',
          occurredAt: fetchedAt,
        });
        await Promise.resolve();
        await Promise.resolve();
      });
    }
    expect(linksList.mock.calls.length).toBe(matchesAfterMount);

    // ...but a repository that changed underneath a stable id MUST re-match.
    // A rename, a verification flip, an archive or a revoked capability all
    // change the answer while every id stays exactly the same.
    for (const [index, change] of [
      { repository: { ...project.repository, name: 'renamed' } },
      { repository: { ...project.repository, verification: 'UNVERIFIED' } },
      { state: 'ARCHIVED' },
      {
        capabilities: { administer: false, manageCloud: false, use: false },
      },
    ].entries()) {
      await act(async (): Promise<void> => {
        await Promise.resolve();
        fake.query.mockResolvedValue({
          ...snapshot,
          fetchedAt: `2026-09-18T00:0${index + 2}:00.000Z`,
          projects: [{ ...project, ...change }],
        });
        fake.emit('org-projects.changed', {
          context: { kind: 'organization', organizationId: 'org-a' },
          reason: 'catalog',
          occurredAt: `2026-09-18T00:0${index + 2}:00.000Z`,
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(linksList.mock.calls.length).toBe(matchesAfterMount + index + 1);
    }
    for (const error of ['access-changed', 'unavailable', 'offline'] as const) {
      // Change the match inputs while the catalog is blocked: neither the
      // effect nor focus may fetch a result to retain from this window.
      const blockedSnapshot: DesktopOrgProjectCatalogSnapshot = {
        ...snapshot,
        error,
        projects: [
          { ...project, repository: { ...project.repository, name: error } },
        ],
      };
      const matchesBeforeError = linksList.mock.calls.length;
      await act(async (): Promise<void> => {
        fake.query.mockResolvedValue(blockedSnapshot);
        fake.emit('org-projects.changed', {
          context: { kind: 'organization', organizationId: 'org-a' },
          reason: 'catalog',
          occurredAt: 'blocked',
        });
        await Promise.resolve();
      });
      expect(linksList).toHaveBeenCalledTimes(
        matchesBeforeError + (error === 'offline' ? 1 : 0),
      );
      await act(async (): Promise<void> => {
        window.dispatchEvent(new Event('focus'));
        await Promise.resolve();
      });
      expect(linksList).toHaveBeenCalledTimes(
        matchesBeforeError + (error === 'offline' ? 2 : 0),
      );

      // Recovery changes only error metadata, leaving the project set identical.
      const matchesBeforeRecovery = linksList.mock.calls.length;
      await act(async (): Promise<void> => {
        fake.query.mockResolvedValue({ ...blockedSnapshot, error: null });
        fake.emit('org-projects.changed', {
          context: { kind: 'organization', organizationId: 'org-a' },
          reason: 'catalog',
          occurredAt: 'recovered',
        });
        await Promise.resolve();
      });
      expect(linksList).toHaveBeenCalledTimes(
        matchesBeforeRecovery + (error === 'offline' ? 0 : 1),
      );
    }
  } finally {
    await act(async (): Promise<void> => {
      root.unmount();
      await Promise.resolve();
    });
    const matchesAfterUnmount = linksList.mock.calls.length;
    window.dispatchEvent(new Event('focus'));
    expect(linksList).toHaveBeenCalledTimes(matchesAfterUnmount);
    container.remove();
    useWorkspaceContextStore.setState(originalContext);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: originalApi,
    });
  }
});
it('reloads the catalog when the account changes under the same organization', async (): Promise<void> => {
  // The store clears its snapshots on an account change. If the new account is
  // in the same organization, the selected context does not change, so nothing
  // else would ask for the new account's catalog and the rows would stay gone.
  const originalContext = useWorkspaceContextStore.getState();
  const fake = createFakeClient();
  const snapshot: DesktopOrgProjectCatalogSnapshot = {
    context: 'org:org-a',
    revision: '1',
    fetchedAt: '2026-09-18T00:00:00.000Z',
    stale: false,
    error: null,
    projects: [
      {
        id: 'catalog',
        organizationId: 'org-a',
        name: 'Catalog',
        description: null,
        kind: 'CODE',
        purpose: 'project',
        visibility: 'organization',
        memberOwned: false,
        location: 'LOCAL',
        repository: {
          provider: 'github',
          host: 'github.com',
          owner: 'acme',
          name: 'repo',
          providerRepoId: '1',
          defaultBranch: 'main',
          verification: 'VERIFIED',
        },
        state: 'ACTIVE',
        revision: 1,
        authorizationVersion: 1,
        defaultListed: true,
        preference: 'FOLLOW_DEFAULTS',
        listed: true,
        capabilities: { administer: false, manageCloud: false, use: true },
        instance: null,
      },
    ],
  };
  fake.query.mockResolvedValue(snapshot);
  let model: ReturnType<typeof useSidebarWorkspaces> | undefined;
  let catalog: OrgProjectsStoreState['snapshots'][string] | undefined;
  function Probe(): JSX.Element {
    model = useSidebarWorkspaces();
    catalog = useOrgProjectsStore(
      (store): OrgProjectsStoreState['snapshots'][string] | undefined =>
        store.snapshots['org:org-a'],
    );
    return <div />;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  useWorkspaceContextStore.setState({
    hydrated: true,
    state: {
      context: { kind: 'organization', organizationId: 'org-a' },
      organizations: [],
      revision: 1,
    },
  });
  try {
    await act(async (): Promise<void> => {
      root.render(
        <CanopyClientProvider client={fake.client}>
          <Probe />
        </CanopyClientProvider>,
      );
      await Promise.resolve();
    });
    await act(async (): Promise<void> => {
      await Promise.resolve();
    });
    // Idle catalog projects are not sidebar rows (CAN-3386); the loaded
    // catalog is what the Add project dialog lists.
    expect(model?.placeholderRows).toEqual([]);
    expect(catalog?.projects.map((project) => project.id)).toEqual(['catalog']);
    const loadsBefore = fake.query.mock.calls.length;

    await act(async (): Promise<void> => {
      fake.emit('workspace-context.changed', {
        occurredAt: '2026-09-18T00:00:01.000Z',
        reason: 'account-change',
        state: {
          context: { kind: 'organization', organizationId: 'org-a' },
          revision: 2,
          organizations: [],
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fake.query.mock.calls.length).toBeGreaterThan(loadsBefore);
    // Idle catalog projects are not sidebar rows (CAN-3386); the loaded
    // catalog is what the Add project dialog lists.
    expect(model?.placeholderRows).toEqual([]);
    expect(catalog?.projects.map((project) => project.id)).toEqual(['catalog']);
  } finally {
    act((): void => root.unmount());
    useWorkspaceContextStore.setState(originalContext);
  }
});

it('renders labelled setup and retry links on the status line without a row menu', async (): Promise<void> => {
  const project: DesktopOrgProjectCatalogSnapshot['projects'][number] = {
    id: 'catalog',
    organizationId: 'org-a',
    name: 'Catalog',
    description: null,
    kind: 'CODE',
    purpose: 'project',
    visibility: 'organization',
    memberOwned: false,
    location: 'LOCAL',
    repository: null,
    state: 'ACTIVE',
    revision: 1,
    authorizationVersion: 1,
    defaultListed: true,
    preference: 'FOLLOW_DEFAULTS',
    listed: true,
    capabilities: { administer: false, manageCloud: false, use: true },
    instance: null,
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async (): Promise<void> => {
      await Promise.resolve();
      await Promise.resolve();
      root.render(
        <OrgProjectPlaceholderRow
          project={project}
          state="offline"
          onSetup={async (): Promise<void> => {}}
          onCancel={async (): Promise<void> => {}}
        />,
      );
    });
    expect(container.textContent).toContain('Offline');
    const setup = container.querySelector(
      '[data-testid="sidebar-org-project-setup-catalog"]',
    );
    expect(setup).toBeInstanceOf(HTMLButtonElement);
    expect(setup?.hasAttribute('disabled')).toBe(true);
    expect(setup?.getAttribute('title')).toBeNull();
    expect(container.querySelector('[data-testid="worktree-row"]')).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="sidebar-org-project-actions-catalog"]',
      ),
    ).toBeNull();
    const row = container.querySelector(
      '[data-testid="sidebar-org-project-placeholder-catalog"]',
    );
    act((): void => {
      row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    const start = jest.fn(async (): Promise<void> => {});
    const cancel = jest.fn(async (): Promise<void> => {});
    for (const state of [
      'ready-to-set-up',
      'needs-github-access',
      'offline',
      'access-changed',
    ]) {
      if (
        state !== 'ready-to-set-up' &&
        state !== 'needs-github-access' &&
        state !== 'offline' &&
        state !== 'access-changed'
      )
        throw new Error('Invalid test state');
      await act(async (): Promise<void> => {
        await Promise.resolve();
        root.render(
          <OrgProjectPlaceholderRow
            project={project}
            state={state}
            onSetup={start}
            onCancel={cancel}
          />,
        );
      });
      const button = container.querySelector(
        '[data-testid="sidebar-org-project-setup-catalog"]',
      );
      if (!(button instanceof HTMLButtonElement))
        throw new Error('Missing setup button');
      expect(button.getAttribute('aria-label')).toBe('Set up Catalog');
      expect(
        button.parentElement?.querySelector('[role="status"]'),
      ).not.toBeNull();
      expect(button.className).toContain('fg-accent');
      expect(button.disabled).toBe(
        state === 'offline' || state === 'access-changed',
      );
      if (!button.disabled)
        await act(async (): Promise<void> => {
          await Promise.resolve();
          button.click();
        });
    }
    expect(start).toHaveBeenCalledTimes(2);
    for (const state of ['claiming', 'materializing', 'failed']) {
      if (
        state !== 'claiming' &&
        state !== 'materializing' &&
        state !== 'failed'
      )
        throw new Error('Invalid progress state');
      await act(async (): Promise<void> => {
        await Promise.resolve();
        root.render(
          <OrgProjectPlaceholderRow
            project={project}
            state="ready-to-set-up"
            onSetup={start}
            onCancel={cancel}
            progress={{
              projectId: project.id,
              instanceId: null,
              state,
              message: 'Setting up the project',
              percent: 42,
              updatedAt: new Date().toISOString(),
            }}
          />,
        );
      });
      expect(container.textContent).toContain('Setting up the project');
      const action = state === 'failed' ? 'retry' : 'cancel';
      if (state !== 'failed') {
        expect(container.textContent).toContain('42%');
        expect(
          container.querySelector('[aria-label="Loading"]')?.className,
        ).toContain('fg-accent');
      }
      const button = container.querySelector(
        `[data-testid="sidebar-org-project-${action}-catalog"]`,
      );
      if (!(button instanceof HTMLButtonElement))
        throw new Error('Missing progress action');
      await act(async (): Promise<void> => {
        await Promise.resolve();
        button.click();
      });
    }
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledWith('catalog');
    expect(start).toHaveBeenCalledTimes(3);
  } finally {
    act((): void => root.unmount());
    container.remove();
  }
});

it('offers no action for a bound project whose setup never finished', async (): Promise<void> => {
  // After a restart there is no progress event to carry a reason, but the
  // workspace on disk says the same thing: the main process refuses setup for
  // a project that is already a workspace, so a button here could only fail.
  const project: DesktopOrgProjectCatalogSnapshot['projects'][number] = {
    id: 'catalog',
    organizationId: 'org-a',
    name: 'Catalog',
    description: null,
    kind: 'CODE',
    purpose: 'project',
    visibility: 'organization',
    memberOwned: false,
    location: 'LOCAL',
    repository: null,
    state: 'ACTIVE',
    revision: 1,
    authorizationVersion: 1,
    defaultListed: true,
    preference: 'FOLLOW_DEFAULTS',
    listed: true,
    capabilities: { administer: false, manageCloud: false, use: true },
    instance: null,
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async (): Promise<void> => {
    await Promise.resolve();
    root.render(
      <OrgProjectPlaceholderRow
        project={project}
        state="ready-to-set-up"
        onSetup={jest.fn()}
        onCancel={jest.fn()}
        unfinished
      />,
    );
  });
  expect(
    container.querySelector(
      '[data-testid="sidebar-org-project-setup-catalog"]',
    ),
  ).toBeNull();
  expect(
    container.querySelector(
      '[data-testid="sidebar-org-project-retry-catalog"]',
    ),
  ).toBeNull();
  // The row itself still reports the project, and says what state it is in
  // rather than claiming it is ready for an action it does not offer.
  expect(container.textContent).toContain('Catalog');
  expect(container.textContent).toContain('Setup did not finish');
  expect(container.textContent).not.toContain('Ready to set up');
  act((): void => root.unmount());
  container.remove();
});

it('offers no retry for an offline completion, and Retry for a lapsed claim (CAN-3129)', async (): Promise<void> => {
  // `completion-pending` lands once the checkout is bound: the files are there
  // and a retry only meets "already a workspace". A button that cannot do what
  // it says is worse than no button. A lapsed claim is different: Retry
  // reclaims it and finishes the setup without cloning again.
  const project: DesktopOrgProjectCatalogSnapshot['projects'][number] = {
    id: 'catalog',
    organizationId: 'org-a',
    name: 'Catalog',
    description: null,
    kind: 'CODE',
    purpose: 'project',
    visibility: 'organization',
    memberOwned: false,
    location: 'LOCAL',
    repository: null,
    state: 'ACTIVE',
    revision: 1,
    authorizationVersion: 1,
    defaultListed: true,
    preference: 'FOLLOW_DEFAULTS',
    listed: true,
    capabilities: { administer: false, manageCloud: false, use: true },
    instance: null,
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const start = jest.fn((): Promise<void> => Promise.resolve());
  const boundFailure = (
    errorCode: string,
  ): Parameters<typeof OrgProjectPlaceholderRow>[0]['progress'] => ({
    projectId: project.id,
    instanceId: null,
    state: 'failed',
    message: 'Your files are ready',
    percent: null,
    errorCode,
    updatedAt: new Date().toISOString(),
  });
  await act(async (): Promise<void> => {
    await Promise.resolve();
    root.render(
      <OrgProjectPlaceholderRow
        project={project}
        state="ready-to-set-up"
        onSetup={start}
        onCancel={jest.fn()}
        progress={boundFailure('completion-pending')}
        unfinished
      />,
    );
  });
  expect(
    container.querySelector(
      '[data-testid="sidebar-org-project-retry-catalog"]',
    ),
  ).toBeNull();

  await act(async (): Promise<void> => {
    await Promise.resolve();
    root.render(
      <OrgProjectPlaceholderRow
        project={project}
        state="ready-to-set-up"
        onSetup={start}
        onCancel={jest.fn()}
        progress={boundFailure('claim-expired')}
        unfinished
      />,
    );
  });
  const reclaim = container.querySelector<HTMLButtonElement>(
    '[data-testid="sidebar-org-project-retry-catalog"]',
  );
  expect(reclaim?.textContent).toBe('Try again');
  await act(async (): Promise<void> => {
    reclaim?.click();
    await Promise.resolve();
  });
  expect(start).toHaveBeenCalledWith('catalog', expect.anything());
  start.mockClear();

  // An ordinary failure still retries.
  await act(async (): Promise<void> => {
    await Promise.resolve();
    root.render(
      <OrgProjectPlaceholderRow
        project={project}
        state="ready-to-set-up"
        onSetup={start}
        onCancel={jest.fn()}
        progress={{
          projectId: project.id,
          instanceId: null,
          state: 'failed',
          message: 'Could not clone the repository',
          percent: null,
          errorCode: 'clone-failed',
          updatedAt: new Date().toISOString(),
        }}
      />,
    );
  });
  expect(
    container.querySelector(
      '[data-testid="sidebar-org-project-retry-catalog"]',
    ),
  ).not.toBeNull();
  act((): void => root.unmount());
  container.remove();
});

it.each(['needs-credentials', 'github-not-authenticated'])(
  'shows a %s clone failure with Retry (CAN-4466)',
  async (errorCode): Promise<void> => {
    const project: DesktopOrgProjectCatalogSnapshot['projects'][number] = {
      id: 'catalog',
      organizationId: 'org-a',
      name: 'Catalog',
      description: null,
      kind: 'CODE',
      purpose: 'project',
      visibility: 'organization',
      memberOwned: false,
      location: 'LOCAL',
      repository: null,
      state: 'ACTIVE',
      revision: 1,
      authorizationVersion: 1,
      defaultListed: true,
      preference: 'FOLLOW_DEFAULTS',
      listed: true,
      capabilities: { administer: false, manageCloud: false, use: true },
      instance: null,
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async (): Promise<void> => {
      await Promise.resolve();
      root.render(
        <OrgProjectPlaceholderRow
          project={project}
          state="ready-to-set-up"
          onSetup={jest.fn((): Promise<void> => Promise.resolve())}
          onCancel={jest.fn()}
          progress={{
            projectId: project.id,
            instanceId: null,
            state: 'failed',
            message: 'GitHub access is needed to clone this repository',
            percent: null,
            errorCode,
            updatedAt: new Date().toISOString(),
          }}
        />,
      );
    });
    expect(container.textContent).toContain(
      'GitHub access is needed to clone this repository',
    );
    expect(
      container.querySelector(
        '[data-testid="sidebar-org-project-retry-catalog"]',
      )?.textContent,
    ).toBe('Try again');
    act((): void => root.unmount());
    container.remove();
  },
);

it('keeps setup unstarted when picking is cancelled or saving fails', async (): Promise<void> => {
  const originalApi = Object.getOwnPropertyDescriptor(window, 'api');
  const browse = jest
    .fn<Promise<{ canceled: boolean; directoryPath: string }>, []>()
    .mockResolvedValue({ canceled: true, directoryPath: '/ignored' });
  const save = jest
    .fn<Promise<void>, []>()
    .mockRejectedValue(new Error('Could not save destination'));
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadPreferences: (): Promise<{
        orgProjectDefaultDestinationRoot: string;
      }> => Promise.resolve({ orgProjectDefaultDestinationRoot: '/saved' }),
      browseForCloneDirectory: browse,
      savePreferences: save,
    },
  });
  const project: DesktopOrgProjectCatalogSnapshot['projects'][number] = {
    id: 'catalog',
    organizationId: 'org-a',
    name: 'Catalog',
    description: null,
    kind: 'CODE',
    purpose: 'project',
    visibility: 'organization',
    memberOwned: false,
    location: 'LOCAL',
    repository: {
      provider: 'github',
      host: 'github.com',
      owner: 'acme',
      name: 'repo',
      providerRepoId: '1',
      defaultBranch: 'main',
      verification: 'VERIFIED',
    },
    state: 'ACTIVE',
    revision: 1,
    authorizationVersion: 1,
    defaultListed: true,
    preference: 'FOLLOW_DEFAULTS',
    listed: true,
    capabilities: { administer: false, manageCloud: false, use: true },
    instance: null,
  };
  const start = jest.fn(async (): Promise<void> => {});
  const close = jest.fn();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const button = (id: string): HTMLButtonElement => {
    const element = document.querySelector(`[data-testid="${id}"]`);
    if (!(element instanceof HTMLButtonElement))
      throw new Error(`Missing ${id}`);
    return element;
  };
  try {
    await act(async (): Promise<void> => {
      await Promise.resolve();
      root.render(
        <OrgProjectSetupDialog
          project={project}
          onStart={start}
          onStartFromFolder={jest.fn()}
          onClose={close}
        />,
      );
    });
    await act(async (): Promise<void> => {
      await Promise.resolve();
      button('org-project-setup-destination').click();
    });
    expect(button('org-project-setup-destination').textContent).toBe(
      '/savedChange',
    );
    expect(save).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    await act(async (): Promise<void> => {
      await Promise.resolve();
      button('org-project-setup-start').click();
    });
    expect(start).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not save destination',
    );
    await act(async (): Promise<void> => {
      await Promise.resolve();
      button('org-project-setup-cancel').click();
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  } finally {
    act((): void => root.unmount());
    container.remove();
    if (originalApi) Object.defineProperty(window, 'api', originalApi);
    else Reflect.deleteProperty(window, 'api');
  }
});

it('shows the project, repository, branch, destination, and save error in the setup dialog', async (): Promise<void> => {
  const originalApi = Object.getOwnPropertyDescriptor(window, 'api');
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadPreferences: (): Promise<{
        orgProjectDefaultDestinationRoot: string;
      }> =>
        Promise.resolve({ orgProjectDefaultDestinationRoot: '/private/root' }),
      savePreferences: jest
        .fn<Promise<void>, []>()
        .mockRejectedValue(new Error('Private save failure')),
    },
  });
  const project: DesktopOrgProjectCatalogSnapshot['projects'][number] = {
    id: 'catalog',
    organizationId: 'org-a',
    name: 'Private Project',
    description: null,
    kind: 'CODE',
    purpose: 'project',
    visibility: 'organization',
    memberOwned: false,
    location: 'LOCAL',
    repository: {
      provider: 'github',
      host: 'github.com',
      owner: 'private-owner',
      name: 'private-repo',
      providerRepoId: '1',
      defaultBranch: 'private-branch',
      verification: 'VERIFIED',
    },
    state: 'ACTIVE',
    revision: 1,
    authorizationVersion: 1,
    defaultListed: true,
    preference: 'FOLLOW_DEFAULTS',
    listed: true,
    capabilities: { administer: false, manageCloud: false, use: true },
    instance: null,
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const expectShown = (text: string): void => {
    expect(document.body.textContent).toContain(text);
  };
  try {
    await act(async (): Promise<void> => {
      await Promise.resolve();
      root.render(
        <OrgProjectSetupDialog
          project={project}
          onStart={jest.fn(async (): Promise<void> => {})}
          onStartFromFolder={jest.fn()}
          onClose={jest.fn()}
        />,
      );
    });
    await act(async (): Promise<void> => {
      await Promise.resolve();
    });
    const dialog = document.querySelector(
      '[data-testid="org-project-setup-dialog"]',
    );
    expect(dialog?.textContent).toContain('Set up Private Project');
    expectShown('private-owner');
    expectShown('private-branch');
    expectShown('/private/root');

    await act(async (): Promise<void> => {
      await Promise.resolve();
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="org-project-setup-start"]',
        )
        ?.click();
    });
    expectShown('Private save failure');
  } finally {
    act((): void => root.unmount());
    container.remove();
    if (originalApi) Object.defineProperty(window, 'api', originalApi);
    else Reflect.deleteProperty(window, 'api');
  }
});

it.each(['offline', 'unusable'])(
  'does not start after eligibility becomes %s during the preference save',
  async (change): Promise<void> => {
    const originalApi = Object.getOwnPropertyDescriptor(window, 'api');
    let resolveSave: (() => void) | null = null;
    const save = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadPreferences: () =>
          Promise.resolve({
            orgProjectDefaultDestinationRoot: '/saved',
          }),
        savePreferences: save,
      },
    });
    const project: DesktopOrgProjectCatalogSnapshot['projects'][number] = {
      id: 'catalog',
      organizationId: 'org-a',
      name: 'Catalog',
      description: null,
      kind: 'CODE',
      purpose: 'project',
      visibility: 'organization',
      memberOwned: false,
      location: 'LOCAL',
      repository: {
        provider: 'github',
        host: 'github.com',
        owner: 'acme',
        name: 'repo',
        providerRepoId: '1',
        defaultBranch: 'main',
        verification: 'VERIFIED',
      },
      state: 'ACTIVE',
      revision: 1,
      authorizationVersion: 1,
      defaultListed: true,
      preference: 'FOLLOW_DEFAULTS',
      listed: true,
      capabilities: { administer: false, manageCloud: false, use: true },
      instance: null,
    };

    const onStart = jest.fn(async (): Promise<void> => {});
    const onClose = jest.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        await Promise.resolve();
        root.render(
          <OrgProjectSetupDialog
            project={project}
            onStart={onStart}
            onStartFromFolder={jest.fn()}
            onClose={onClose}
          />,
        );
      });
      await act(async () => {
        await Promise.resolve();
        const start = document.querySelector<HTMLButtonElement>(
          '[data-testid="org-project-setup-start"]',
        );
        if (!start) throw new Error('Missing Start');
        start.click();
      });
      expect(save).toHaveBeenCalledWith({
        orgProjectDefaultDestinationRoot: '/saved',
      });
      expect(onStart).not.toHaveBeenCalled();
      await act(async () => {
        await Promise.resolve();
        root.render(
          <OrgProjectSetupDialog
            project={{
              ...project,
              capabilities: {
                ...project.capabilities,
                use: change !== 'unusable',
              },
            }}
            state={change === 'offline' ? 'offline' : 'access-changed'}
            onStart={onStart}
            onStartFromFolder={jest.fn()}
            onClose={onClose}
          />,
        );
      });
      await act(async () => {
        await Promise.resolve();
        if (!resolveSave) throw new Error('The preference save never started');
        resolveSave();
      });
      expect(onStart).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(
        document.querySelector('[data-testid="org-project-setup-dialog"]'),
      ).not.toBeNull();
      expect(
        document.querySelector('[data-testid="org-project-setup-start"]'),
      ).toBeNull();
      expect(save).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
      container.remove();
      if (originalApi) Object.defineProperty(window, 'api', originalApi);
      else Reflect.deleteProperty(window, 'api');
    }
  },
);

it('sets up a Cowork project with no repository, branch or destination', async (): Promise<void> => {
  const originalApi = Object.getOwnPropertyDescriptor(window, 'api');
  const save = jest.fn(async (): Promise<void> => {});
  const loadPreferences = jest.fn(() =>
    Promise.reject(new Error('preferences unavailable')),
  );
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadPreferences,
      savePreferences: save,
    },
  });
  const project: DesktopOrgProjectCatalogSnapshot['projects'][number] = {
    id: 'research',
    organizationId: 'org-a',
    name: 'Q4 research',
    description: null,
    kind: 'COWORK',
    purpose: 'project',
    visibility: 'private',
    memberOwned: true,
    location: 'LOCAL',
    repository: null,
    state: 'ACTIVE',
    revision: 1,
    authorizationVersion: 1,
    defaultListed: true,
    preference: 'FOLLOW_DEFAULTS',
    listed: true,
    capabilities: { administer: true, manageCloud: false, use: true },
    instance: null,
  };
  const onStart = jest.fn(async (): Promise<void> => {});
  const onClose = jest.fn();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async (): Promise<void> => {
      await Promise.resolve();
      root.render(
        <OrgProjectSetupDialog
          project={project}
          onStart={onStart}
          onStartFromFolder={jest.fn()}
          onClose={onClose}
        />,
      );
    });
    expect(
      document.querySelector('[data-testid="org-project-setup-destination"]'),
    ).toBeNull();
    expect(document.body.textContent).not.toContain('Repository');
    expect(document.body.textContent).not.toContain('Default branch');
    expect(loadPreferences).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(
      'Choose a destination folder to continue',
    );
    expect(
      document.querySelector(
        '[data-testid="org-project-setup-cowork-disclosure"]',
      )?.textContent,
    ).toBe(
      'Creates an empty Cowork project on this computer. Chats stay on this computer.',
    );
    await act(async (): Promise<void> => {
      await Promise.resolve();
      const start = document.querySelector<HTMLButtonElement>(
        '[data-testid="org-project-setup-start"]',
      );
      if (!start) throw new Error('Missing Start');
      expect(start.disabled).toBe(false);
      start.click();
    });
    expect(save).not.toHaveBeenCalled();
    expect(onStart).toHaveBeenCalledWith('research', undefined);
    expect(onClose).toHaveBeenCalledTimes(1);
  } finally {
    act((): void => root.unmount());
    container.remove();
    if (originalApi) Object.defineProperty(window, 'api', originalApi);
    else Reflect.deleteProperty(window, 'api');
  }
});

describe('a Code project with no GitHub repository (CAN-3534)', (): void => {
  const project: DesktopOrgProjectCatalogSnapshot['projects'][number] = {
    id: 'notes',
    organizationId: 'org-a',
    name: 'Field notes',
    description: null,
    kind: 'CODE',
    purpose: 'project',
    visibility: 'private',
    memberOwned: true,
    location: 'LOCAL',
    repository: null,
    state: 'ACTIVE',
    revision: 1,
    authorizationVersion: 1,
    defaultListed: true,
    preference: 'FOLLOW_DEFAULTS',
    listed: true,
    capabilities: { administer: true, manageCloud: false, use: true },
    instance: null,
  };
  let originalApi: PropertyDescriptor | undefined;
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const browseForRepo = jest.fn();
  const loadPreferences = jest.fn();
  const onStart = jest.fn(async (): Promise<void> => {});
  const onStartFromFolder = jest.fn(async (): Promise<void> => {});
  const onClose = jest.fn();
  const chooseFolder = (): HTMLButtonElement | null =>
    document.querySelector<HTMLButtonElement>(
      '[data-testid="org-project-setup-choose-folder"]',
    );
  const render = async (
    props: Partial<Parameters<typeof OrgProjectSetupDialog>[0]> = {},
  ): Promise<void> => {
    await act(async (): Promise<void> => {
      await Promise.resolve();
      root.render(
        <OrgProjectSetupDialog
          project={project}
          state="choose-folder"
          onStart={onStart}
          onStartFromFolder={onStartFromFolder}
          onClose={onClose}
          {...props}
        />,
      );
    });
  };

  beforeEach((): void => {
    originalApi = Object.getOwnPropertyDescriptor(window, 'api');
    browseForRepo.mockReset();
    loadPreferences.mockReset();
    onStart.mockClear();
    onStartFromFolder.mockClear();
    onClose.mockClear();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { browseForRepo, loadPreferences },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach((): void => {
    act((): void => root.unmount());
    container.remove();
    if (originalApi) Object.defineProperty(window, 'api', originalApi);
    else Reflect.deleteProperty(window, 'api');
  });

  it('asks for the folder instead of a clone destination', async (): Promise<void> => {
    await render();
    for (const testId of [
      'org-project-setup-destination',
      'org-project-setup-start',
    ])
      expect(document.querySelector(`[data-testid="${testId}"]`)).toBeNull();
    expect(document.body.textContent).not.toContain('Cloned with your Git');
    // Nothing is cloned, so the remembered destination is never read.
    expect(loadPreferences).not.toHaveBeenCalled();
    expect(
      document.querySelector(
        '[data-testid="org-project-setup-folder-disclosure"]',
      )?.textContent,
    ).toBe(
      'This project has no GitHub repository to clone. Choose its folder on this computer. Its files stay where they are.',
    );
    expect(chooseFolder()?.textContent).toBe('Choose the project folder');
    // The button says it once: the state is not repeated as a status line.
    expect(document.querySelector('[role="status"]')).toBeNull();
  });

  it('binds the chosen folder in place and closes', async (): Promise<void> => {
    browseForRepo.mockResolvedValue({
      name: 'field-notes',
      path: '/Users/me/field-notes',
    });
    await render();
    await act(async (): Promise<void> => {
      chooseFolder()?.click();
      await Promise.resolve();
    });
    // Git folders only: the picker is not asked to allow plain folders.
    expect(browseForRepo).toHaveBeenCalledWith();
    expect(onStartFromFolder).toHaveBeenCalledWith(
      'notes',
      '/Users/me/field-notes',
    );
    expect(onStart).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('starts nothing when the picker is cancelled', async (): Promise<void> => {
    browseForRepo.mockResolvedValue(null);
    await render();
    await act(async (): Promise<void> => {
      chooseFolder()?.click();
      await Promise.resolve();
    });
    expect(onStartFromFolder).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(chooseFolder()).not.toBeNull();
  });

  it('reports a folder the picker refuses and stays open', async (): Promise<void> => {
    browseForRepo.mockRejectedValue(new Error('Not a git repository'));
    await render();
    await act(async (): Promise<void> => {
      chooseFolder()?.click();
      await Promise.resolve();
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Not a git repository',
    );
    expect(onStartFromFolder).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('offers no folder choice for a project that is already a workspace', async (): Promise<void> => {
    await render({ unfinished: true });
    expect(chooseFolder()).toBeNull();
  });

  it('offers no folder choice while offline, and says why', async (): Promise<void> => {
    await render({ state: 'offline' });
    expect(chooseFolder()).toBeNull();
    expect(
      document.querySelector('[data-testid="org-project-setup-destination"]'),
    ).toBeNull();
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      'Offline',
    );
  });

  it('lets the sidebar row open setup for it', async (): Promise<void> => {
    const onSetup = jest.fn(async (): Promise<void> => {});
    await act(async (): Promise<void> => {
      await Promise.resolve();
      root.render(
        <OrgProjectPlaceholderRow
          project={project}
          state="choose-folder"
          onSetup={onSetup}
          onCancel={jest.fn()}
        />,
      );
    });
    const setup = document.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-org-project-setup-notes"]',
    );
    expect(setup?.disabled).toBe(false);
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      'Choose the project folder',
    );
    act((): void => setup?.click());
    expect(onSetup).toHaveBeenCalledWith('notes', expect.any(HTMLElement));
  });
});

describe('setup dialog live state regressions', (): void => {
  async function withDialog(
    check: (
      fake: ReturnType<typeof createFakeClient>,
      snapshot: DesktopOrgProjectCatalogSnapshot,
    ) => Promise<void>,
  ): Promise<void> {
    const originalContext = useWorkspaceContextStore.getState();
    const originalProjects = useProjectsStore.getState();
    const originalApi = Object.getOwnPropertyDescriptor(window, 'api');
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadPreferences: (): Promise<{
          orgProjectDefaultDestinationRoot: string;
        }> =>
          Promise.resolve({
            orgProjectDefaultDestinationRoot: '/private/destination',
          }),
        savePreferences: async (): Promise<void> => {},
      },
    });
    const fake = createFakeClient();
    const snapshot: DesktopOrgProjectCatalogSnapshot = {
      context: 'org:org-a',
      revision: 'r1',
      fetchedAt: '',
      stale: false,
      error: null,
      projects: ['catalog'].map((id) => ({
        id,
        organizationId: 'org-a',
        name: id,
        description: null,
        kind: 'CODE',
        purpose: 'project',
        visibility: 'organization',
        memberOwned: false,
        location: 'LOCAL',
        repository: {
          provider: 'github',
          host: 'github.com',
          owner: 'acme',
          name: 'repo',
          providerRepoId: '1',
          defaultBranch: 'main',
          verification: 'VERIFIED',
        },
        state: 'ACTIVE',
        revision: 1,
        authorizationVersion: 1,
        defaultListed: true,
        preference: 'FOLLOW_DEFAULTS',
        listed: true,
        capabilities: { administer: false, manageCloud: false, use: true },
        instance: null,
      })),
    };
    fake.query.mockResolvedValue(snapshot);
    useProjectsStore.setState({
      projects: [],
      loadProjects: async (): Promise<void> => {},
    });
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: {
        context: { kind: 'organization', organizationId: 'org-a' },
        organizations: [],
        revision: 1,
      },
    });
    let requestSetup: OrgProjectsStoreState['requestSetup'] | undefined;
    function Probe(): JSX.Element {
      const model = useSidebarWorkspaces();
      requestSetup = useOrgProjectsStore(
        (store): OrgProjectsStoreState['requestSetup'] => store.requestSetup,
      );
      return (
        <div>
          {/* The + that opens the Add project dialog. */}
          <button type="button" data-testid="sidebar-section-code-add">
            Add project
          </button>
          {model.setupDialog}
          {model.placeholderRows.map((row) => (
            <OrgProjectPlaceholderRow
              key={row.project.id}
              {...row}
              onSetup={model.startPlaceholderSetup}
              onCancel={model.cancelPlaceholderSetup}
            />
          ))}
        </div>
      );
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async (): Promise<void> => {
        await Promise.resolve();
        root.render(
          <CanopyClientProvider client={fake.client}>
            <Probe />
          </CanopyClientProvider>,
        );
      });
      await act(async (): Promise<void> => {
        await Promise.resolve();
        await Promise.resolve();
      });
      // CAN-3386: no idle row; setup is handed over by Add in the + dialog.
      expect(
        container.querySelector(
          '[data-testid="sidebar-org-project-placeholder-catalog"]',
        ),
      ).toBeNull();
      await act(async (): Promise<void> => {
        await Promise.resolve();
        requestSetup?.('org-a', 'catalog');
      });
      expect(
        document.querySelector('[data-testid="org-project-setup-dialog"]'),
      ).not.toBeNull();
      await check(fake, snapshot);
    } finally {
      act((): void => root.unmount());
      container.remove();
      useWorkspaceContextStore.setState(originalContext);
      useProjectsStore.setState(originalProjects);
      if (originalApi) Object.defineProperty(window, 'api', originalApi);
      else Reflect.deleteProperty(window, 'api');
    }
  }

  it.each([
    ['offline', 'Offline'],
    ['access-changed', 'Access changed'],
    ['not-local', 'Runs in the cloud'],
  ])(
    'blocks Start after catalog becomes %s and explains why',
    async (state, reason): Promise<void> => {
      await withDialog(async (fake, snapshot): Promise<void> => {
        const start = document.querySelector(
          '[data-testid="org-project-setup-start"]',
        );
        if (!(start instanceof HTMLButtonElement))
          throw new Error('Missing Start');
        expect(start.disabled).toBe(false);
        fake.query.mockResolvedValue({
          ...snapshot,
          error: state === 'not-local' ? null : state,
          projects: snapshot.projects.map((project) => ({
            ...project,
            location: state === 'not-local' ? 'CLOUD' : 'LOCAL',
          })),
        });
        await act(async (): Promise<void> => {
          await Promise.resolve();
          fake.emit('org-projects.changed', {
            context: { kind: 'organization', organizationId: 'org-a' },
            reason: 'catalog',
            occurredAt: 'later',
          });
        });
        const dialog = document.querySelector(
          '[data-testid="org-project-setup-dialog"]',
        );
        expect(dialog).not.toBeNull();
        expect(
          dialog?.querySelector('[data-testid="org-project-setup-start"]'),
        ).toBeNull();
        expect(dialog?.textContent).toContain(reason);
        expect(
          useCurrentUiStateStore.getState().slices['orgProjectSetup.modal'],
        ).toMatchObject({
          state,
          canStart: false,
        });
        expect(fake.command).not.toHaveBeenCalled();
      });
    },
  );

  it.each([true, false])(
    'offers Retry consent only for listed failed setup: listed=%s',
    async (listed): Promise<void> => {
      await withDialog(async (fake, snapshot): Promise<void> => {
        await act(async (): Promise<void> => {
          await Promise.resolve();
          document
            .querySelector<HTMLButtonElement>(
              '[data-testid="org-project-setup-cancel"]',
            )
            ?.click();
        });
        fake.query.mockResolvedValue({
          ...snapshot,
          projects: snapshot.projects.map((project) => ({
            ...project,
            listed,
          })),
        });
        await act(async (): Promise<void> => {
          await Promise.resolve();
          fake.emit('org-projects.changed', {
            context: { kind: 'organization', organizationId: 'org-a' },
            reason: 'preference',
            occurredAt: 'dismissed',
          });
        });
        // An idle catalog project is never a row, listed or not (CAN-3386).
        expect(
          document.querySelector(
            '[data-testid="sidebar-org-project-placeholder-catalog"]',
          ),
        ).toBeNull();
        await act(async (): Promise<void> => {
          await Promise.resolve();
          fake.emit('org-projects.setup-progress', {
            progress: {
              projectId: 'catalog',
              instanceId: null,
              state: 'failed',
              message: 'Clone failed',
              percent: null,
              updatedAt: 'failed',
            },
            occurredAt: 'failed',
          });
        });
        const retry = document.querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-org-project-retry-catalog"]',
        );
        expect(
          document.querySelector(
            '[data-testid="sidebar-org-project-placeholder-catalog"]',
          )?.textContent,
        ).toContain('Clone failed');
        expect(retry !== null).toBe(listed);
        await act(async (): Promise<void> => {
          await Promise.resolve();
          retry?.click();
        });
        expect(
          document.querySelector('[data-testid="org-project-setup-dialog"]') !==
            null,
        ).toBe(listed);
        expect(fake.command).not.toHaveBeenCalled();
      });
    },
  );

  // `multi-repo`: a converted multi-repo project (CAN-3532) cannot be set up
  // from the catalog anywhere.
  it.each(['removed', 'archived', 'unusable', 'dismissed', 'multi-repo'])(
    'closes and clears selection when the catalog project is %s',
    async (change): Promise<void> => {
      await withDialog(async (fake, snapshot): Promise<void> => {
        fake.query.mockResolvedValue({
          ...snapshot,
          projects:
            change === 'removed'
              ? []
              : snapshot.projects.map((project) => ({
                  ...project,
                  state: change === 'archived' ? 'ARCHIVED' : project.state,
                  listed: change !== 'dismissed',
                  capabilities: {
                    ...project.capabilities,
                    use: change !== 'unusable',
                  },
                  ...(change === 'multi-repo'
                    ? { topology: 'multi-repo' as const }
                    : {}),
                })),
        });
        await act(async (): Promise<void> => {
          await Promise.resolve();
          fake.emit('org-projects.changed', {
            context: { kind: 'organization', organizationId: 'org-a' },
            reason: 'catalog',
            occurredAt: 'later',
          });
        });
        expect(
          document.querySelector('[data-testid="org-project-setup-dialog"]'),
        ).toBeNull();
        fake.query.mockResolvedValue(snapshot);
        await act(async (): Promise<void> => {
          await Promise.resolve();
          fake.emit('org-projects.changed', {
            context: { kind: 'organization', organizationId: 'org-a' },
            reason: 'catalog',
            occurredAt: 'latest',
          });
        });
        expect(
          document.querySelector('[data-testid="org-project-setup-dialog"]'),
        ).toBeNull();
      });
    },
  );

  it.each(['access-removed', 'setup-failed'])(
    'reloads a bound workspace on terminal failure %s and suppresses Retry',
    async (errorCode): Promise<void> => {
      await withDialog(async (fake): Promise<void> => {
        const loadProjects = jest.fn((): Promise<void> => {
          useProjectsStore.setState({
            projects: [
              {
                id: 'bound',
                name: 'Catalog',
                type: 'single-repo',
                repoPath: '/private/repo',
                color: '',
                collapsed: false,
                order: 0,
                worktrees: [],
                owner: {
                  type: 'organization',
                  organizationId: 'org-a',
                  projectId: 'catalog',
                  instanceId: 'instance',
                  bindingGeneration: 1,
                },
              },
            ],
          });
          return Promise.resolve();
        });
        useProjectsStore.setState({ loadProjects });
        await act(async (): Promise<void> => {
          await Promise.resolve();
          fake.emit('org-projects.setup-progress', {
            progress: {
              projectId: 'catalog',
              instanceId: 'instance',
              state: 'failed',
              errorCode,
              message: 'Setup did not finish',
              percent: null,
              updatedAt: 'later',
            },
            occurredAt: 'later',
          });
        });
        expect(loadProjects).toHaveBeenCalledWith({ silent: true });
        expect(
          document.querySelector('[data-testid="org-project-setup-start"]'),
        ).toBeNull();
        expect(
          document.querySelector(
            '[data-testid="sidebar-org-project-retry-catalog"]',
          ),
        ).toBeNull();
      });
    },
  );

  it('returns focus to the + after Start and shows the running row', async (): Promise<void> => {
    await withDialog(async (fake): Promise<void> => {
      fake.command.mockImplementation(() => new Promise(() => {}));
      await act(async (): Promise<void> => {
        await Promise.resolve();
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="org-project-setup-start"]',
          )
          ?.click();
      });
      expect(
        document.querySelector('[data-testid="org-project-setup-dialog"]'),
      ).toBeNull();
      act((): void => {
        fake.emit('org-projects.setup-progress', {
          progress: {
            projectId: 'catalog',
            instanceId: null,
            state: 'claiming',
            message: 'Claiming a setup slot',
            percent: null,
            updatedAt: 'later',
          },
          occurredAt: 'later',
        });
      });
      expect(
        document.querySelector(
          '[data-testid="sidebar-org-project-setup-catalog"]',
        ),
      ).toBeNull();
      expect(
        document.querySelector(
          '[data-testid="sidebar-org-project-cancel-catalog"]',
        ),
      ).not.toBeNull();
      expect(document.activeElement).toBe(
        document.querySelector('[data-testid="sidebar-section-code-add"]'),
      );
      expect(document.activeElement?.isConnected).toBe(true);
      expect(fake.command).toHaveBeenCalledWith('orgProjects.setupStart', {
        projectId: 'catalog',
        destinationRoot: '/private/destination',
      });
    });
  });

  it('reports only safe modal state to App Advisor and clears it on close', async (): Promise<void> => {
    await withDialog(async (): Promise<void> => {
      // The allowlist is the point: a progress message can carry a filesystem
      // path, and the Advisor must never receive one.
      await act(async (): Promise<void> => {
        await Promise.resolve();
      });
      expect(
        useCurrentUiStateStore.getState().slices['orgProjectSetup.modal'],
      ).toEqual({
        open: true,
        projectId: 'catalog',
        name: 'catalog',
        kind: 'CODE',
        state: 'ready-to-set-up',
        canStart: true,
      });
    });
    expect(
      useCurrentUiStateStore.getState().slices['orgProjectSetup.modal'],
    ).toBeUndefined();
  });

  it('closes consent when another window starts claiming without calling onStart', async (): Promise<void> => {
    await withDialog(async (fake): Promise<void> => {
      expect(
        useCurrentUiStateStore.getState().slices['orgProjectSetup.modal'],
      ).toEqual({
        open: true,
        projectId: 'catalog',
        name: 'catalog',
        kind: 'CODE',
        state: 'ready-to-set-up',
        canStart: true,
      });
      await act(async (): Promise<void> => {
        await Promise.resolve();
        fake.emit('org-projects.setup-progress', {
          progress: {
            projectId: 'catalog',
            instanceId: 'instance',
            state: 'claiming',
            message: '/private/message',
            percent: 42,
            updatedAt: 'later',
          },
          occurredAt: 'later',
        });
      });
      expect(
        document.querySelector('[data-testid="org-project-setup-dialog"]'),
      ).toBeNull();
      expect(fake.command).not.toHaveBeenCalled();
      expect(
        useCurrentUiStateStore.getState().slices['orgProjectSetup.modal'],
      ).toBeUndefined();
    });
    expect(
      useCurrentUiStateStore.getState().slices['orgProjectSetup.modal'],
    ).toBeUndefined();
  });
});

it('keeps the last resolved links through unknown answers and retries with bounded backoff, never showing idle catalog rows', async (): Promise<void> => {
  // Main answers `unknown` when credentials, the catalog snapshot or a Git
  // remote lookup are transiently unusable. Treating that as "no links" turned
  // a linked Personal workspace into a Set up row until the next context switch.
  const originalContext = useWorkspaceContextStore.getState();
  const originalProjects = useProjectsStore.getState();
  const originalApi = Reflect.get(window, 'api');
  const LINK: OrgProjectRelationship = {
    projectId: 'catalog',
    personalWorkspaceId: 'private-personal',
  };
  type LinksAnswer =
    | OrgProjectLinksListResult
    | Error
    | Promise<OrgProjectLinksListResult>;
  const answers: LinksAnswer[] = [];
  let resolveFirst: ((value: OrgProjectLinksListResult) => void) | null = null;
  // Mount asks once before the catalog loads and again once it does; both
  // wait on the same first answer.
  let fallback: LinksAnswer = new Promise<OrgProjectLinksListResult>(
    (resolve) => {
      resolveFirst = resolve;
    },
  );
  const linksList = jest.fn((): Promise<OrgProjectLinksListResult> => {
    const next = answers.shift() ?? fallback;
    if (next instanceof Error) return Promise.reject(next);
    return next instanceof Promise ? next : Promise.resolve(next);
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { orgProjects: { linksList } },
  });
  const fake = createFakeClient();
  const catalogProject = (
    id: string,
    organizationId: string,
    withRepository: boolean,
  ): DesktopOrgProjectCatalogSnapshot['projects'][number] => ({
    id,
    organizationId,
    name: id,
    description: null,
    kind: 'CODE',
    purpose: 'project',
    visibility: 'organization',
    memberOwned: false,
    location: 'LOCAL',
    repository: withRepository
      ? {
          provider: 'github',
          host: 'github.com',
          owner: 'acme',
          name: id,
          providerRepoId: id,
          defaultBranch: 'main',
          verification: 'VERIFIED',
        }
      : null,
    state: 'ACTIVE',
    revision: 1,
    authorizationVersion: 1,
    defaultListed: true,
    preference: 'FOLLOW_DEFAULTS',
    listed: true,
    capabilities: { administer: false, manageCloud: false, use: true },
    instance: null,
  });
  fake.query.mockImplementation(
    (
      _name: string,
      request: { context: { organizationId: string } },
    ): Promise<DesktopOrgProjectCatalogSnapshot> => {
      const organizationId = request.context.organizationId;
      return Promise.resolve({
        context: `org:${organizationId}`,
        revision: 'r1',
        fetchedAt: '2026-09-26T00:00:00.000Z',
        stale: false,
        error: null,
        projects:
          organizationId === 'org-a'
            ? [
                catalogProject('catalog', 'org-a', true),
                // No repository: nothing can link it, so it never waits.
                catalogProject('no-repo', 'org-a', false),
              ]
            : [],
      });
    },
  );
  let model: ReturnType<typeof useSidebarWorkspaces> | undefined;
  function Probe(): JSX.Element {
    model = useSidebarWorkspaces();
    return <div />;
  }
  const placeholderIds = (): string[] =>
    (model?.placeholderRows ?? []).map((row) => row.project.id);
  const personalVisible = (): boolean =>
    (model?.visibleProjects ?? []).some((row) => row.id === 'private-personal');
  const flush = async (): Promise<void> => {
    await act(async (): Promise<void> => {
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
    });
  };
  const container = document.createElement('div');
  const root = createRoot(container);
  const organizations = [
    { id: 'org-a', name: 'Org A', role: 'MEMBER' as const },
    { id: 'org-b', name: 'Org B', role: 'MEMBER' as const },
  ];
  useProjectsStore.setState({
    projects: [
      {
        id: 'private-personal',
        name: 'Personal checkout',
        type: 'single-repo',
        repoPath: '/personal',
        color: '',
        collapsed: false,
        order: 0,
        worktrees: [],
      },
    ],
  });
  useWorkspaceContextStore.setState({
    hydrated: true,
    state: {
      context: { kind: 'organization', organizationId: 'org-a' },
      organizations,
      revision: 1,
    },
  });
  jest.useFakeTimers({ now: Date.parse('2026-09-26T00:00:00.000Z') });
  try {
    await act(async (): Promise<void> => {
      await Promise.resolve();
      root.render(
        <CanopyClientProvider client={fake.client}>
          <Probe />
        </CanopyClientProvider>,
      );
    });
    await flush();
    // Idle catalog projects are never rows (CAN-3386), linked or not; only
    // the linked Personal checkout waits for the first resolved answer.
    expect(linksList).toHaveBeenCalled();
    expect(placeholderIds()).toEqual([]);
    expect(personalVisible()).toBe(false);

    await act(async (): Promise<void> => {
      await Promise.resolve();
      resolveFirst?.({ status: 'resolved', links: [LINK] });
    });
    await flush();
    fallback = { status: 'unknown', reason: 'remote-unavailable' };
    const base = linksList.mock.calls.length;
    expect(placeholderIds()).toEqual([]);
    expect(personalVisible()).toBe(true);

    // A focus refresh that cannot tell keeps the link, then retries on the
    // bounded schedule: one rejected IPC, then unknown answers until the cap.
    answers.push(new Error('ipc failed'));
    await act(async (): Promise<void> => {
      await Promise.resolve();
      jest.advanceTimersByTime(60_000);
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(linksList).toHaveBeenCalledTimes(base + 1);
    expect(personalVisible()).toBe(true);
    expect(placeholderIds()).toEqual([]);
    expect(RELATIONSHIP_RETRY_DELAYS_MS).toEqual([1_000, 2_000, 5_000, 15_000]);
    for (
      let index = 0;
      index < RELATIONSHIP_RETRY_DELAYS_MS.length;
      index += 1
    ) {
      const delay: number = RELATIONSHIP_RETRY_DELAYS_MS[index] ?? 0;
      await act(async (): Promise<void> => {
        await Promise.resolve();
        jest.advanceTimersByTime(delay - 1);
      });
      await flush();
      expect(linksList).toHaveBeenCalledTimes(base + 1 + index);
      await act(async (): Promise<void> => {
        await Promise.resolve();
        jest.advanceTimersByTime(1);
      });
      await flush();
      expect(linksList).toHaveBeenCalledTimes(base + 2 + index);
      expect(personalVisible()).toBe(true);
      expect(placeholderIds()).toEqual([]);
    }
    // The schedule is spent: nothing more until the next focus.
    await act(async (): Promise<void> => {
      await Promise.resolve();
      jest.advanceTimersByTime(120_000);
    });
    await flush();
    expect(linksList).toHaveBeenCalledTimes(base + 5);

    // A later resolved answer that drops the link does remove it.
    answers.push({ status: 'resolved', links: [] });
    await act(async (): Promise<void> => {
      await Promise.resolve();
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(linksList).toHaveBeenCalledTimes(base + 6);
    expect(personalVisible()).toBe(false);
    expect(placeholderIds()).toEqual([]);
    // ...and a resolved answer stops the retry schedule.
    await act(async (): Promise<void> => {
      await Promise.resolve();
      jest.advanceTimersByTime(60_000);
    });
    await flush();
    expect(linksList).toHaveBeenCalledTimes(base + 6);

    answers.push({ status: 'resolved', links: [LINK] });
    await act(async (): Promise<void> => {
      await Promise.resolve();
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(personalVisible()).toBe(true);

    // An organization change clears the links: coming back waits for a fresh
    // resolved answer instead of reusing org A's last one.
    fallback = { status: 'resolved', links: [] };
    await act(async (): Promise<void> => {
      await Promise.resolve();
      useWorkspaceContextStore.setState({
        state: {
          context: { kind: 'organization', organizationId: 'org-b' },
          organizations,
          revision: 2,
        },
      });
    });
    await flush();
    expect(personalVisible()).toBe(false);
    let resolveReturn: ((value: OrgProjectLinksListResult) => void) | null =
      null;
    answers.push(
      new Promise<OrgProjectLinksListResult>((resolve) => {
        resolveReturn = resolve;
      }),
    );
    await act(async (): Promise<void> => {
      await Promise.resolve();
      useWorkspaceContextStore.setState({
        state: {
          context: { kind: 'organization', organizationId: 'org-a' },
          organizations,
          revision: 3,
        },
      });
    });
    await flush();
    expect(personalVisible()).toBe(false);
    expect(placeholderIds()).toEqual([]);
    await act(async (): Promise<void> => {
      await Promise.resolve();
      resolveReturn?.({ status: 'resolved', links: [LINK] });
    });
    await flush();
    expect(personalVisible()).toBe(true);
    expect(placeholderIds()).toEqual([]);

    // A new account can retain the same organization id. Its link answer is
    // still a different authority epoch, so the old account's link must clear
    // until the first resolved answer for the new account arrives.
    let resolveAccount: ((value: OrgProjectLinksListResult) => void) | null =
      null;
    fallback = new Promise<OrgProjectLinksListResult>((resolve) => {
      resolveAccount = resolve;
    });
    await act(async (): Promise<void> => {
      await Promise.resolve();
      fake.emit('workspace-context.changed', {
        occurredAt: '2026-09-26T00:01:00.000Z',
        reason: 'account-change',
        state: {
          context: { kind: 'organization', organizationId: 'org-a' },
          organizations,
          revision: 1,
        },
      });
    });
    await flush();
    expect(personalVisible()).toBe(false);
    expect(placeholderIds()).toEqual([]);
    await act(async (): Promise<void> => {
      await Promise.resolve();
      resolveAccount?.({ status: 'resolved', links: [LINK] });
    });
    await flush();
    expect(personalVisible()).toBe(true);
    expect(placeholderIds()).toEqual([]);
  } finally {
    await act(async (): Promise<void> => {
      await Promise.resolve();
      root.unmount();
    });
    jest.useRealTimers();
    useWorkspaceContextStore.setState(originalContext);
    useProjectsStore.setState(originalProjects);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: originalApi,
    });
  }
});

it('lists a repository once in the organization when several Personal checkouts link to it', async (): Promise<void> => {
  // CAN-3388: every Personal checkout of a catalog repository used to be
  // admitted, so two clones of one repository listed the project twice. The
  // first checkout in stored project order stands for it; the others stay
  // Personal.
  const originalContext = useWorkspaceContextStore.getState();
  const originalProjects = useProjectsStore.getState();
  const originalApi = Reflect.get(window, 'api');
  const links: OrgProjectRelationship[] = [
    { projectId: 'repo', personalWorkspaceId: 'checkout-b' },
    { projectId: 'repo', personalWorkspaceId: 'checkout-a' },
    // A second catalog definition of the same repository links the same
    // checkouts and must not bring the other one back.
    { projectId: 'repo-alias', personalWorkspaceId: 'checkout-b' },
    { projectId: 'repo-alias', personalWorkspaceId: 'checkout-a' },
    { projectId: 'other', personalWorkspaceId: 'checkout-other' },
  ];
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      orgProjects: {
        linksList: (): Promise<OrgProjectLinksListResult> =>
          Promise.resolve({ status: 'resolved', links }),
      },
    },
  });
  const fake = createFakeClient();
  const catalogProject = (
    id: string,
  ): DesktopOrgProjectCatalogSnapshot['projects'][number] => ({
    id,
    organizationId: 'org-a',
    name: id,
    description: null,
    kind: 'CODE',
    purpose: 'project',
    visibility: 'organization',
    memberOwned: false,
    location: 'LOCAL',
    repository: {
      provider: 'github',
      host: 'github.com',
      owner: 'acme',
      name: id === 'other' ? 'other' : 'repo',
      providerRepoId: id === 'other' ? '2' : '1',
      defaultBranch: 'main',
      verification: 'VERIFIED',
    },
    state: 'ACTIVE',
    revision: 1,
    authorizationVersion: 1,
    defaultListed: true,
    preference: 'FOLLOW_DEFAULTS',
    listed: true,
    capabilities: { administer: false, manageCloud: false, use: true },
    instance: null,
  });
  fake.query.mockResolvedValue({
    context: 'org:org-a',
    revision: 'r1',
    fetchedAt: '2026-09-26T00:00:00.000Z',
    stale: false,
    error: null,
    projects: ['repo', 'repo-alias', 'other'].map(catalogProject),
  });
  let model: ReturnType<typeof useSidebarWorkspaces> | undefined;
  function Probe(): JSX.Element {
    model = useSidebarWorkspaces();
    return <div />;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  const checkout = (
    id: string,
    order: number,
  ): ReturnType<typeof useProjectsStore.getState>['projects'][number] => ({
    id,
    name: id,
    type: 'single-repo',
    repoPath: `/${id}`,
    color: '',
    collapsed: false,
    order,
    worktrees: [],
  });
  useProjectsStore.setState({
    projects: [
      checkout('checkout-a', 0),
      checkout('checkout-b', 1),
      checkout('checkout-other', 2),
    ],
  });
  useWorkspaceContextStore.setState({
    hydrated: true,
    state: {
      context: { kind: 'organization', organizationId: 'org-a' },
      organizations: [{ id: 'org-a', name: 'Org A', role: 'MEMBER' }],
      revision: 1,
    },
  });
  try {
    await act(async (): Promise<void> => {
      await Promise.resolve();
      root.render(
        <CanopyClientProvider client={fake.client}>
          <Probe />
        </CanopyClientProvider>,
      );
    });
    await act(async (): Promise<void> => {
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });
    expect(model?.linkedPersonalWorkspaceIds).toEqual([
      'checkout-a',
      'checkout-other',
    ]);
    // Every linked project is on this computer, including one whose checkout
    // was skipped because another checkout already stands for it (CAN-3469).
    expect(useLinkedPersonalWorkspacesStore.getState().projectIds).toEqual([
      'other',
      'repo',
      'repo-alias',
    ]);
    // The dialog may offer Add only once links are in for this organization.
    expect(
      useLinkedPersonalWorkspacesStore.getState().resolvedOrganizationId,
    ).toBe('org-a');
    expect((model?.visibleProjects ?? []).map((row) => row.id)).toEqual([
      'checkout-a',
      'checkout-other',
    ]);
    expect((model?.placeholderRows ?? []).map((row) => row.project.id)).toEqual(
      [],
    );
  } finally {
    await act(async (): Promise<void> => {
      await Promise.resolve();
      root.unmount();
    });
    useWorkspaceContextStore.setState(originalContext);
    useProjectsStore.setState(originalProjects);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: originalApi,
    });
  }
});
