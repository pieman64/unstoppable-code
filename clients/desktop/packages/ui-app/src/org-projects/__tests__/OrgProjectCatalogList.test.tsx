/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { OrgProjectSummary } from '@canopy/protocol/org-projects';
import {
  orgProjectCatalogOption,
  OrgProjectCatalogList,
  type OrgProjectCatalogListProps,
} from '../OrgProjectCatalogList';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const ORG = 'org-a';

function project(
  id: string,
  overrides: Partial<OrgProjectSummary> = {},
): OrgProjectSummary {
  return {
    id,
    organizationId: ORG,
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
      name: `${id}-repo`,
      providerRepoId: id,
      defaultBranch: 'main',
      verification: 'VERIFIED',
    },
    state: 'ACTIVE',
    revision: 1,
    authorizationVersion: 1,
    defaultListed: false,
    preference: 'FOLLOW_DEFAULTS',
    listed: false,
    capabilities: { use: true, administer: false, manageCloud: false },
    instance: null,
    ...overrides,
  };
}

function withRepository(
  id: string,
  repository: Partial<NonNullable<OrgProjectSummary['repository']>>,
  overrides: Partial<OrgProjectSummary> = {},
): OrgProjectSummary {
  const base = project(id, overrides);
  return base.repository === null
    ? base
    : { ...base, repository: { ...base.repository, ...repository } };
}

describe('OrgProjectCatalogList', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onAdd = jest.fn();

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onAdd.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(props: Partial<OrgProjectCatalogListProps> = {}): void {
    act(() => {
      root.render(
        <OrgProjectCatalogList
          organizationId={ORG}
          organizationName="Acme"
          projects={[]}
          stale={false}
          unauthorized={false}
          addedProjectIds={new Set()}
          addAvailable
          onAdd={onAdd}
          {...props}
        />,
      );
    });
  }

  function byTestId(id: string): HTMLElement | null {
    return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  }

  function rowIds(): string[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid^="add-workspace-org-catalog-row-"]',
      ),
    ).map((row) =>
      (row.dataset.testid ?? '').replace('add-workspace-org-catalog-row-', ''),
    );
  }

  function typeSearch(value: string): void {
    const input = byTestId('add-workspace-org-catalog-search');
    if (!(input instanceof HTMLInputElement)) throw new Error('no search');
    const setter = Reflect.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    act(() => {
      if (setter) Reflect.apply(setter, input, [value]);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('lists one ungrouped catalog: to add first, added last, newest first', () => {
    render({
      projects: [
        withRepository('old', { updatedAt: '2026-01-01T00:00:00.000Z' }),
        withRepository('added', { updatedAt: '2026-09-01T00:00:00.000Z' }),
        withRepository('new', { updatedAt: '2026-08-01T00:00:00.000Z' }),
        project('other-org', { organizationId: 'org-b' }),
        project('archived', { state: 'ARCHIVED' }),
        project('no-use', {
          capabilities: { use: false, administer: false, manageCloud: false },
        }),
        project('chats', { purpose: 'default-chats' }),
      ],
      addedProjectIds: new Set(['added']),
    });
    expect(rowIds()).toEqual(['new', 'old', 'added']);
    expect(byTestId('add-workspace-org-catalog-name-new')?.textContent).toBe(
      'new-repo',
    );
    expect(byTestId('add-workspace-org-catalog-add-new')).not.toBeNull();
    const added = byTestId('add-workspace-org-catalog-added-added');
    expect(added?.textContent).toBe('Added');
    expect(added).toHaveProperty('disabled', true);
    expect(byTestId('add-workspace-org-catalog-add-added')).toBeNull();
  });

  it('lists a multi-repo project only where the host already has it (CAN-3532)', () => {
    const multi = { topology: 'multi-repo' as const, memberOwned: true };
    render({ projects: [project('platform', multi), project('web')] });
    expect(rowIds()).toEqual(['web']);
    render({
      projects: [project('platform', multi), project('web')],
      addedProjectIds: new Set(['platform']),
    });
    expect(rowIds()).toEqual(['web', 'platform']);
    expect(byTestId('add-workspace-org-catalog-add-platform')).toBeNull();
  });

  it('counts a ready Code instance as added without a host binding', () => {
    render({
      projects: [project('ready', { instance: { id: 'i', state: 'READY' } })],
    });
    expect(byTestId('add-workspace-org-catalog-added-ready')).not.toBeNull();
  });

  it('searches the project and repository names, never the owner', () => {
    render({
      projects: [
        project('payments', { name: 'Payments' }),
        project('web', { name: 'Website' }),
      ],
    });
    typeSearch('PAY');
    expect(rowIds()).toEqual(['payments']);
    typeSearch('web-repo');
    expect(rowIds()).toEqual(['web']);
    typeSearch('acme');
    expect(rowIds()).toEqual([]);
    expect(
      byTestId('add-workspace-org-catalog-no-match')?.textContent,
    ).toContain('No matching projects');
  });

  it('hands Add the project and its derived state', () => {
    const target = project('payments');
    render({ projects: [target] });
    act(() => {
      byTestId('add-workspace-org-catalog-add-payments')?.click();
    });
    expect(onAdd).toHaveBeenCalledWith(target, 'ready-to-set-up');
  });

  describe('with a cloud host (REG-3091)', () => {
    const onCloudAdd = jest.fn();
    const onCloudOpen = jest.fn();

    function renderCloud(
      projects: readonly OrgProjectSummary[],
      cloud: Partial<NonNullable<OrgProjectCatalogListProps['cloud']>> = {},
      props: Partial<OrgProjectCatalogListProps> = {},
    ): void {
      render({
        projects,
        cloud: {
          available: true,
          copies: new Set(),
          onAdd: onCloudAdd,
          onOpen: onCloudOpen,
          ...cloud,
        },
        ...props,
      });
    }

    beforeEach(() => {
      onCloudAdd.mockClear();
      onCloudOpen.mockClear();
    });

    it('offers Add to Cloud beside Add on a single-repository Code project', () => {
      const target = project('payments');
      renderCloud([target]);
      const add = byTestId('add-workspace-org-catalog-add-cloud-payments');
      expect(add?.textContent).toBe('Add to Cloud');
      expect(byTestId('add-workspace-org-catalog-add-payments')).not.toBeNull();
      act(() => add?.click());
      expect(onCloudAdd).toHaveBeenCalledWith(target);
      expect(onAdd).not.toHaveBeenCalled();
    });

    it('offers Open instead once the host has a cloud copy', () => {
      const target = project('payments');
      renderCloud([target], { copies: new Set(['payments']) });
      expect(
        byTestId('add-workspace-org-catalog-add-cloud-payments'),
      ).toBeNull();
      const open = byTestId('add-workspace-org-catalog-open-cloud-payments');
      expect(open?.textContent).toBe('Open');
      act(() => open?.click());
      expect(onCloudOpen).toHaveBeenCalledWith(target);
    });

    it('disables Add to Cloud while unavailable or offline', () => {
      renderCloud([project('payments')], { available: false });
      expect(
        byTestId('add-workspace-org-catalog-add-cloud-payments'),
      ).toHaveProperty('disabled', true);
      renderCloud([project('payments')], {}, { stale: true });
      expect(
        byTestId('add-workspace-org-catalog-add-cloud-payments'),
      ).toHaveProperty('disabled', true);
    });

    it('offers nothing for Cowork, repository-less or multi-repo projects', () => {
      renderCloud(
        [
          project('notes', { kind: 'COWORK', repository: null }),
          project('local', { repository: null, memberOwned: true }),
          project('platform', { topology: 'multi-repo', memberOwned: true }),
        ],
        {},
        { addedProjectIds: new Set(['platform']) },
      );
      expect(rowIds()).toEqual(expect.arrayContaining(['notes', 'local']));
      expect(
        container.querySelector(
          '[data-testid^="add-workspace-org-catalog-add-cloud-"]',
        ),
      ).toBeNull();
    });

    it('offers no cloud action without a cloud host', () => {
      render({ projects: [project('payments')] });
      expect(
        byTestId('add-workspace-org-catalog-add-cloud-payments'),
      ).toBeNull();
    });
  });

  it('allows adding a repository-less Code project by choosing its folder', () => {
    const target = project('local-code', {
      repository: null,
      memberOwned: true,
      visibility: 'private',
    });
    render({ projects: [target] });
    const add = byTestId('add-workspace-org-catalog-add-local-code');
    expect(add).toHaveProperty('disabled', false);
    act(() => add?.click());
    expect(onAdd).toHaveBeenCalledWith(target, 'choose-folder');
  });

  it('keeps Add disabled while the host is busy or the list is stale', () => {
    render({ projects: [project('payments')], addAvailable: false });
    expect(byTestId('add-workspace-org-catalog-add-payments')).toHaveProperty(
      'disabled',
      true,
    );
    render({ projects: [project('payments')], stale: true });
    expect(byTestId('add-workspace-org-catalog-add-payments')).toHaveProperty(
      'disabled',
      true,
    );
    expect(container.textContent).toContain('Offline');
  });

  it('shows only states that change what Add does', () => {
    render({
      projects: [
        project('ready'),
        withRepository('needs-access', { verification: 'STALE' }),
        project('cloud', { location: 'CLOUD' }),
      ],
    });
    expect(byTestId('add-workspace-org-catalog-row-ready')?.textContent).toBe(
      'ready-repoAdd',
    );
    expect(
      byTestId('add-workspace-org-catalog-row-needs-access')?.textContent,
    ).toContain('Needs GitHub access');
    expect(
      byTestId('add-workspace-org-catalog-add-needs-access'),
    ).toHaveProperty('disabled', false);
    expect(byTestId('add-workspace-org-catalog-add-cloud')).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('replaces Add with a setup the host reports in progress', () => {
    render({
      projects: [project('payments')],
      setupMessage: (id) => (id === 'payments' ? 'Cloning 40%' : null),
    });
    expect(byTestId('add-workspace-org-catalog-add-payments')).toBeNull();
    expect(container.textContent).toContain('Cloning 40%');
  });

  it('renders the host destination slot under the search', () => {
    render({
      projects: [project('payments')],
      destination: <div data-testid="host-destination">Clones into /code</div>,
    });
    expect(byTestId('host-destination')).not.toBeNull();
  });

  it('separates loading, empty, and lost access', () => {
    render({ projects: undefined });
    expect(container.textContent).toContain('Loading projects');
    render({ projects: [] });
    expect(container.textContent).toContain('Nothing in Acme yet');
    render({ projects: [project('payments')], unauthorized: true });
    expect(container.textContent).toContain('Access changed');
    expect(rowIds()).toEqual([]);
  });

  it('reports a failed GitHub re-read and the host error', () => {
    render({
      projects: [project('payments')],
      githubRefreshFailed: true,
      error: 'Failed to add project',
    });
    expect(
      byTestId('add-workspace-org-catalog-github-refresh-failed'),
    ).not.toBeNull();
    expect(container.textContent).toContain('Failed to add project');
  });

  describe('setup for an owner or admin (CAN-3984)', () => {
    const onConnectGithub = jest.fn();
    const onChooseProjects = jest.fn();

    beforeEach(() => {
      onConnectGithub.mockClear();
      onChooseProjects.mockClear();
    });

    function renderManaged(
      connection: 'checking' | 'connected' | 'not-connected' | 'unavailable',
      props: Partial<OrgProjectCatalogListProps> = {},
    ): void {
      render({
        management: { connection, onConnectGithub, onChooseProjects },
        ...props,
      });
    }

    it('shows a loading placeholder while GitHub is checked', () => {
      renderManaged('checking');
      expect(byTestId('add-workspace-org-catalog-setup-checking')).not.toBe(
        null,
      );
      expect(container.textContent).toContain('Checking GitHub connection');
      expect(container.querySelector('button')).toBeNull();
    });

    it('offers Connect GitHub when the organization is not connected', () => {
      renderManaged('not-connected');
      expect(container.textContent).toContain('Connect GitHub to add projects');
      expect(container.textContent).toContain(
        'Connect Acme to GitHub, then pick the repos your team can add here.',
      );
      const button = byTestId('add-workspace-org-catalog-connect-github');
      expect(button?.textContent).toBe('Connect GitHub');
      act(() => button?.click());
      expect(onConnectGithub).toHaveBeenCalledTimes(1);
      expect(onChooseProjects).not.toHaveBeenCalled();
    });

    it.each(['connected', 'unavailable'] as const)(
      'offers Choose projects when the connection is %s',
      (connection) => {
        renderManaged(connection);
        expect(container.textContent).toContain('No projects in Acme yet');
        expect(container.textContent).toContain(
          'Choose which repos your team can add as projects.',
        );
        const button = byTestId('add-workspace-org-catalog-choose-projects');
        expect(button?.textContent).toBe('Choose projects');
        act(() => button?.click());
        expect(onChooseProjects).toHaveBeenCalledTimes(1);
        expect(onConnectGithub).not.toHaveBeenCalled();
      },
    );

    it('keeps the member copy without management', () => {
      render({ projects: [] });
      expect(container.textContent).toContain('Nothing in Acme yet');
      expect(byTestId('add-workspace-org-catalog-setup')).toBeNull();
    });

    it('lets loading, offline, and lost access take precedence', () => {
      renderManaged('not-connected', { projects: undefined });
      expect(container.textContent).toContain('Loading projects');
      expect(byTestId('add-workspace-org-catalog-setup')).toBeNull();
      renderManaged('not-connected', { stale: true });
      expect(container.textContent).toContain('Offline');
      expect(byTestId('add-workspace-org-catalog-setup')).toBeNull();
      renderManaged('not-connected', { unauthorized: true });
      expect(container.textContent).toContain('Access changed');
      expect(byTestId('add-workspace-org-catalog-setup')).toBeNull();
    });

    it('keeps a catalog error ahead of setup actions', () => {
      renderManaged('not-connected', {
        error: 'Could not update project preference',
      });
      expect(container.textContent).toContain(
        'Could not update project preference',
      );
      expect(byTestId('add-workspace-org-catalog-setup')).toBeNull();
    });

    it('lists projects instead of setup once the catalog has any', () => {
      renderManaged('not-connected', { projects: [project('payments')] });
      expect(rowIds()).toEqual(['payments']);
      expect(byTestId('add-workspace-org-catalog-setup')).toBeNull();
    });
  });
});

describe('orgProjectCatalogOption', () => {
  it('names the organization and what the option adds', () => {
    expect(orgProjectCatalogOption('Acme')).toEqual({
      label: 'From my org',
      summary: 'Add a project from Acme',
      scopedSummary: 'Team projects',
    });
  });
});
