/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/require-await -- act() callbacks stay async so React flushes the settled promises they trigger. */
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
import { act, useState, type ComponentProps, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  OrgProjectDetail,
  OrgProjectSummary,
  OrgProjectPreference,
} from '@canopy/protocol/org-projects';
import { parseDesktopOrgProjectDeepLink } from '@canopy/protocol/share-deep-link';
import type { OrganizationDetail } from '@canopy/protocol/settings/organization';
import {
  createFakeSettingsClient,
  createTestSettingsHost,
  TestSettingsHost,
} from '../../__tests__/helpers/test-settings-host';
import {
  chooseSettingsOption,
  settingsSelectOptionLabels,
  settingsSelectTrigger,
} from '../../__tests__/helpers/settings-select';

jest.mock('../team-api', () => {
  const actual = jest.requireActual<typeof TeamApi>('../team-api');
  return {
    ...actual,
    listOrganizationGitHubRepositories: jest.fn(),
    createOrganizationProjects: jest.fn(),
    listOrganizationProjects: jest.fn(),
    setOrganizationProjectPreference: jest.fn(),
    getOrganizationProject: jest.fn(),
    updateOrganizationProject: jest.fn(),
    replaceOrganizationProjectGrants: jest.fn(),
    applyOrganizationProjectLifecycle: jest.fn(),
    listOrganizationRepositories: jest.fn(),
    refreshOrganizationProjectsFromGitHub: jest.fn(),
    setOrganizationRepositoryHidden: jest.fn(),
  };
});
jest.mock('../desktop-handoff', () => ({ openDesktopDeepLink: jest.fn() }));
import { openDesktopDeepLink } from '../desktop-handoff';
import type * as TeamApi from '../team-api';
import {
  TeamProjectsHeaderActions,
  TeamProjectsSection,
  teamProjectsRepositoriesAvailable,
} from '../team-projects-section';
import {
  OrganizationSettingsSlotsProvider,
  type OrganizationSettingsSlots,
  type OrgProjectLocalSetupSlot,
  type OrgProjectLocalStatus,
} from '../organization-settings-slots';
import {
  listOrganizationGitHubRepositories,
  createOrganizationProjects,
  listOrganizationProjects,
  setOrganizationProjectPreference,
  getOrganizationProject,
  updateOrganizationProject,
  replaceOrganizationProjectGrants,
  applyOrganizationProjectLifecycle,
  listOrganizationRepositories,
  refreshOrganizationProjectsFromGitHub,
  setOrganizationRepositoryHidden,
  TeamApiError,
} from '../team-api';
import type { OrganizationRepository } from '@canopy/protocol/settings/organization-repositories';

const settingsClient = createFakeSettingsClient();
const testBrand = {
  id: 'test-brand',
  displayName: 'Test Brand',
  internalName: 'test-brand',
};
let settingsHost = createTestSettingsHost({
  client: settingsClient,
  brand: testBrand,
}).host;

const project: OrgProjectDetail = {
  id: 'p1',
  organizationId: 'org-1',
  name: 'Website',
  description: 'Public site',
  kind: 'CODE',
  purpose: 'project',
  visibility: 'organization',
  memberOwned: false,
  location: 'LOCAL',
  repository: {
    provider: 'github',
    host: 'github.com',
    owner: 'acme',
    name: 'website',
    providerRepoId: '1',
    defaultBranch: 'main',
    verification: 'STALE',
  },
  state: 'ACTIVE',
  revision: 7,
  authorizationVersion: 11,
  defaultListed: true,
  preference: 'FOLLOW_DEFAULTS',
  listed: true,
  capabilities: { administer: true, manageCloud: true, use: true },
  instance: null,
  grants: [
    { principal: { type: 'team', teamId: 't1' }, defaultListed: true },
    { principal: { type: 'user', userId: 'u1' }, defaultListed: false },
  ],
  createdBy: { id: 'u1', name: 'Alice' },
  createdAt: '2026-09-01',
  updatedAt: '2026-09-01',
};
const detail: OrganizationDetail = {
  id: 'org-1',
  name: 'Acme',
  viewerRole: 'OWNER',
  logoUrl: null,
  usageStatsMinRole: 'ADMIN',
  canViewUsageStats: true,
  githubConnection: { connected: false, accountLogin: null },
  members: [
    {
      id: 'u1',
      name: 'Alice',
      email: 'alice@example.com',
      image: null,
      role: 'OWNER',
      subTeamIds: ['t1'],
    },
    {
      id: 'u2',
      name: 'Bob',
      email: 'bob@example.com',
      image: null,
      role: 'MEMBER',
      subTeamIds: ['t1'],
    },
    {
      id: 'u3',
      name: 'Carol',
      email: 'carol@example.com',
      image: null,
      role: 'MEMBER',
      subTeamIds: [],
    },
  ],
  subTeams: [
    { id: 't1', name: 'Engineering', memberCount: 2 },
    { id: 't2', name: 'Design', memberCount: 0 },
  ],
};
let root: Root;
let container: HTMLDivElement;
beforeEach((): void => {
  // The web Jest config this suite came from resets mocks between tests.
  jest.resetAllMocks();
  // Admins load both scopes; by default the member scope adds nothing.
  jest
    .mocked(listOrganizationProjects)
    .mockImplementation(
      async (_client, _orgId, scope: 'management' | 'member') => ({
        data: scope === 'management' ? [project] : [],
        revision: 'page1',
        nextCursor: null,
      }),
    );
  jest.mocked(getOrganizationProject).mockResolvedValue(project);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach((): void => {
  act((): void => root.unmount());
  container.remove();
  settingsHost = createTestSettingsHost({
    client: settingsClient,
    brand: testBrand,
  }).host;
});
type SectionOverrides = Partial<
  Pick<
    ComponentProps<typeof TeamProjectsSection>,
    'detail' | 'orgLapsed' | 'projectsEnabled'
  >
>;
/** The section under the page header's actions, as the team page mounts it. */
function ProjectsPage({
  detail: pageDetail = detail,
  orgLapsed = false,
  projectsEnabled = true,
}: SectionOverrides): JSX.Element {
  const [creating, setCreating] = useState(false);
  const [repositoriesOpen, setRepositoriesOpen] = useState(false);
  const [addAvailable, setAddAvailable] = useState(false);
  return (
    <>
      <TeamProjectsHeaderActions
        repositoriesAvailable={teamProjectsRepositoriesAvailable(
          pageDetail,
          projectsEnabled,
          orgLapsed,
        )}
        addAvailable={addAvailable}
        onAdd={(): void => setCreating(true)}
        onRepositories={(): void => setRepositoriesOpen(true)}
      />
      <TeamProjectsSection
        detail={pageDetail}
        onDetailChange={(): void => {}}
        orgLapsed={orgLapsed}
        projectsEnabled={projectsEnabled}
        creating={creating}
        onCreatingChange={setCreating}
        repositoriesOpen={repositoriesOpen}
        onRepositoriesOpenChange={setRepositoriesOpen}
        onAddAvailableChange={setAddAvailable}
      />
    </>
  );
}
async function renderSection(
  overrides: SectionOverrides = {},
  slots: OrganizationSettingsSlots = {},
): Promise<void> {
  await act(async (): Promise<void> => {
    root.render(
      <TestSettingsHost host={settingsHost}>
        <OrganizationSettingsSlotsProvider slots={slots}>
          <ProjectsPage {...overrides} />
        </OrganizationSettingsSlotsProvider>
      </TestSettingsHost>,
    );
  });
}
function el(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}
function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find(
    (entry): boolean => entry.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function click(element: HTMLElement): Promise<void> {
  await act(async (): Promise<void> => element.click());
}
async function action(label: string): Promise<void> {
  await click(el('[aria-label="Actions for Website"]'));
  await click(button(label));
}
async function input(label: string, value: string): Promise<void> {
  const element = el(`[aria-label="${label}"]`);
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- the native setter is invoked with `.call` on the element below.
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (!setter) throw new Error('Missing native value setter');
  await act(async (): Promise<void> => {
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
it('loads management rows with repository, access, verification and state', async (): Promise<void> => {
  await renderSection();
  expect(listOrganizationProjects).toHaveBeenCalledWith(
    settingsClient,
    'org-1',
    'management',
    {
      limit: 500,
    },
  );
  expect(listOrganizationProjects).toHaveBeenCalledWith(
    settingsClient,
    'org-1',
    'member',
    { limit: 50 },
  );
  expect(el('[data-testid="team-projects-description-p1"]').textContent).toBe(
    'acme/website',
  );
  expect(el('[data-testid="team-projects-count"]').textContent).toBe('1');
  // Active is the routine state: only Archived gets a badge.
  expect(
    container.querySelector('[data-testid="team-projects-archived-p1"]'),
  ).toBeNull();
  expect(container.textContent).not.toContain('Active');
  expect(el('[data-testid="team-projects-row-p1"]').textContent).toContain(
    'Stale',
  );
  expect(el('[data-testid="team-projects-access-p1"]').textContent).toBe(
    '1 team · 1 person',
  );
  expect(container.textContent).not.toContain('Listed by default');
  expect(container.textContent).not.toContain('Grants');
});

it.each([
  [[{ principal: { type: 'organization' } }], 'Everyone in Acme'],
  [
    [
      { principal: { type: 'team', teamId: 't1' } },
      { principal: { type: 'team', teamId: 't2' } },
    ],
    '2 teams',
  ],
  [
    [
      { principal: { type: 'user', userId: 'u1' } },
      { principal: { type: 'user', userId: 'u2' } },
    ],
    '2 people',
  ],
  [[], 'No access yet'],
] satisfies Array<
  [Array<Pick<OrgProjectDetail['grants'][number], 'principal'>>, string]
>)('summarizes access %j as %s', async (grants, label): Promise<void> => {
  const projectWithGrants: OrgProjectDetail = {
    ...project,
    grants: grants.map((grant) => ({ ...grant, defaultListed: false })),
  };
  jest.mocked(listOrganizationProjects).mockImplementationOnce(() =>
    Promise.resolve({
      data: [projectWithGrants],
      revision: 'grants',
      nextCursor: null,
    }),
  );
  await renderSection();
  expect(el('[data-testid="team-projects-access-p1"]').textContent).toBe(label);
});

it('names the project and opens the editor from the row', async (): Promise<void> => {
  await renderSection();
  expect(el('[data-testid="team-projects-name-p1"]').textContent).toBe(
    'Website',
  );
  const row = el('[data-testid="team-projects-row-p1"]');
  expect(row.getAttribute('role')).toBe('button');
  // No button nests inside another.
  expect(row.querySelector('button button')).toBeNull();
  await click(row);
  expect(el('[aria-label="Name"]')).toHaveProperty('value', 'Website');
});

it('opens actions from an icon button without activating the row', async (): Promise<void> => {
  await renderSection();
  const trigger = el('[aria-label="Actions for Website"]');
  expect(trigger.textContent).toBe('');
  expect(trigger.querySelector('svg')).not.toBeNull();
  expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
  await click(trigger);
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(
    document.querySelector('[data-testid="team-projects-detail"]'),
  ).toBeNull();
  const rows = Array.from(
    document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  );
  // Edit and Access, the viewer's own list, then Archive and Delete in
  // their own last group; every row leads with an icon.
  expect(rows.map((entry) => entry.textContent?.trim())).toEqual([
    'Edit',
    'Access',
    'Hide from my list',
    'Archive',
    'Delete',
  ]);
  for (const entry of rows) expect(entry.querySelector('svg')).not.toBeNull();
  const separators = Array.from(
    document.querySelectorAll('[role="separator"]'),
  );
  expect(
    separators.map((separator) => separator.nextElementSibling?.textContent),
  ).toEqual(['Hide from my list', 'Archive']);
});

it('shows an Archived badge on archived projects and sorts them last', async (): Promise<void> => {
  jest.mocked(listOrganizationProjects).mockResolvedValueOnce({
    data: [
      { ...project, id: 'old', name: 'Alpha', state: 'ARCHIVED' },
      { ...project, id: 'p2', name: 'Zed' },
      project,
    ],
    revision: 'archived',
    nextCursor: null,
  });
  await renderSection();
  expect(el('[data-testid="team-projects-archived-old"]').textContent).toBe(
    'Archived',
  );
  expect(
    Array.from(
      container.querySelectorAll('[data-testid^="team-projects-row-"]'),
      (row): string | null => row.getAttribute('data-testid'),
    ),
  ).toEqual([
    'team-projects-row-p1',
    'team-projects-row-p2',
    'team-projects-row-old',
  ]);
});

it('searches projects by project and repository name, never the owner', async (): Promise<void> => {
  jest.mocked(listOrganizationProjects).mockResolvedValueOnce({
    data: [
      project,
      {
        ...project,
        id: 'p2',
        name: 'Handbook',
        repository: project.repository && {
          ...project.repository,
          name: 'docs',
          providerRepoId: '2',
        },
      },
      { ...project, id: 'p3', name: 'Scratch', repository: null },
    ],
    revision: 'three',
    nextCursor: null,
  });
  await renderSection();
  expect(el('[data-testid="team-projects-count"]').textContent).toBe('3');

  await input('Search projects', 'acm');
  expect(visibleRows()).toEqual([]);
  expect(el('[data-testid="team-projects-no-results"]').textContent).toBe(
    'No projects match your search.',
  );

  await input('Search projects', 'DOC');
  expect(visibleRows()).toEqual(['p2']);

  await input('Search projects', 'hand');
  expect(visibleRows()).toEqual(['p2']);

  await input('Search projects', 'scr');
  expect(visibleRows()).toEqual(['p3']);
  // The count stays the organization total while searching.
  expect(el('[data-testid="team-projects-count"]').textContent).toBe('3');

  await input('Search projects', '');
  expect(visibleRows()).toHaveLength(3);
});

function visibleRows(): string[] {
  return Array.from(
    container.querySelectorAll('[data-testid^="team-projects-row-"]'),
    (row): string =>
      row.getAttribute('data-testid')?.replace('team-projects-row-', '') ?? '',
  );
}
function memberProject(
  overrides: Partial<OrgProjectSummary> = {},
): OrgProjectSummary {
  return {
    ...project,
    capabilities: { administer: false, manageCloud: false, use: true },
    ...overrides,
  };
}
async function renderMember(
  rows: OrgProjectSummary[] = [memberProject()],
  nextCursor: string | null = null,
  slots: OrganizationSettingsSlots = {},
): Promise<void> {
  jest
    .mocked(listOrganizationProjects)
    .mockResolvedValueOnce({ data: rows, revision: 'member', nextCursor });
  await renderSection({ detail: { ...detail, viewerRole: 'MEMBER' } }, slots);
}
function row(id = 'p1'): HTMLElement {
  return el(`[data-testid="team-projects-row-${id}"]`);
}
async function filterBy(bucket: string): Promise<void> {
  await click(el(`[data-testid="team-projects-filter-${bucket}"]`));
}

it('lists a member’s projects in one list with only Hide from my list', async (): Promise<void> => {
  await renderMember([
    memberProject({ id: 'p1', preference: 'ADDED' }),
    memberProject({ id: 'p2', name: 'Docs', preference: 'DISMISSED' }),
  ]);
  expect(listOrganizationProjects).toHaveBeenCalledTimes(1);
  expect(listOrganizationProjects).toHaveBeenCalledWith(
    settingsClient,
    'org-1',
    'member',
    { limit: 50 },
  );
  expect(visibleRows()).toEqual(['p2', 'p1']);
  expect(container.querySelector('h3')).toBeNull();
  // A member's rows open nothing and summarize no access.
  expect(row().getAttribute('role')).toBeNull();
  expect(
    container.querySelector('[data-testid="team-projects-access-p1"]'),
  ).toBeNull();
  expect(el('[data-testid="team-projects-hidden-p2"]').textContent).toBe(
    'Hidden',
  );
  for (const removed of ['Manage', 'Follow defaults', 'Dismiss', 'Add'])
    expect(
      Array.from(container.querySelectorAll('button')).some(
        (entry): boolean => entry.textContent?.trim() === removed,
      ),
    ).toBe(false);
  await click(el('[data-testid="team-projects-actions-p1"]'));
  expect(el('[data-testid="team-projects-hide-p1"]').textContent).toBe(
    'Hide from my list',
  );
  expect(document.body.textContent).not.toContain('Edit');
  expect(
    container.querySelector('[data-testid="team-projects-create"]'),
  ).toBeNull();
});

it.each([
  ['hide', 'ADDED', 'DISMISSED', true],
  ['hide', 'FOLLOW_DEFAULTS', 'DISMISSED', true],
  ['show', 'DISMISSED', 'ADDED', false],
] satisfies Array<
  [string, OrgProjectPreference, OrgProjectPreference, boolean]
>)(
  'member %s from %s updates optimistically and reconciles the response',
  async (actionName, preference, target, hidden): Promise<void> => {
    let resolve: ((value: OrgProjectSummary) => void) | undefined;
    jest.mocked(setOrganizationProjectPreference).mockImplementationOnce(
      (): Promise<OrgProjectSummary> =>
        new Promise((done): void => {
          resolve = done;
        }),
    );
    await renderMember([memberProject({ preference })]);
    await click(el('[data-testid="team-projects-actions-p1"]'));
    await click(el(`[data-testid="team-projects-${actionName}-p1"]`));
    expect(setOrganizationProjectPreference).toHaveBeenCalledWith(
      settingsClient,
      'org-1',
      'p1',
      target,
    );
    expect(
      container.querySelector('[data-testid="team-projects-hidden-p1"]') !==
        null,
    ).toBe(hidden);
    expect(row().getAttribute('aria-busy')).toBe('true');
    expect(el('[data-testid="team-projects-actions-p1"]')).toHaveProperty(
      'disabled',
      true,
    );
    await act(async (): Promise<void> => {
      resolve?.(memberProject({ preference: target, name: 'Server name' }));
    });
    expect(row().textContent).toContain('Server name');
    expect(row().getAttribute('aria-busy')).toBe('false');
  },
);

it.each([500, 404])(
  'member preference failure %s reverts or removes access',
  async (status): Promise<void> => {
    let reject: ((reason: Error) => void) | undefined;
    jest.mocked(setOrganizationProjectPreference).mockImplementationOnce(
      (): Promise<OrgProjectSummary> =>
        new Promise((_resolve, fail): void => {
          reject = fail;
        }),
    );
    await renderMember([memberProject({ preference: 'ADDED' })]);
    await click(el('[data-testid="team-projects-actions-p1"]'));
    await click(el('[data-testid="team-projects-hide-p1"]'));
    expect(el('[data-testid="team-projects-hidden-p1"]')).toBeTruthy();
    await act(async (): Promise<void> => {
      reject?.(new TeamApiError(status, 'Preference failed'));
    });
    if (status === 404) {
      expect(
        container.querySelector('[data-testid="team-projects-row-p1"]'),
      ).toBeNull();
      expect(container.textContent).toContain(
        'You no longer have access to this project.',
      );
      expect(container.textContent).not.toContain('Preference failed');
    } else {
      expect(
        container.querySelector('[data-testid="team-projects-hidden-p1"]'),
      ).toBeNull();
      expect(container.textContent).toContain(
        "Couldn't update this project. Try again.",
      );
      expect(container.textContent).not.toContain('Preference failed');
      expect(el('[data-testid="team-projects-actions-p1"]')).toHaveProperty(
        'disabled',
        false,
      );
    }
  },
);

it('offers no menu or action on a member’s archived rows', async (): Promise<void> => {
  await renderMember([
    memberProject({ id: 'archived', state: 'ARCHIVED', preference: 'ADDED' }),
  ]);
  expect(row('archived').textContent).toContain('Archived');
  expect(row('archived').querySelectorAll('button')).toHaveLength(0);
});

it('never shows desktop setup state from the server instance', async (): Promise<void> => {
  await renderMember([
    memberProject({ instance: { id: 'i1', state: 'READY' } }),
  ]);
  expect(container.textContent).not.toContain('Not set up on this desktop');
  expect(container.textContent).not.toContain('Ready on this desktop');
  expect(container.textContent).not.toContain('Set this project up from');
  expect(container.querySelector('a[href^="test-brand://"]')).toBeNull();
});

it('hands a project to the desktop app without a local setup slot', async (): Promise<void> => {
  const projectId = '11111111-1111-4111-8111-111111111111';
  const organizationId = '22222222-2222-4222-8222-222222222222';
  jest.mocked(listOrganizationProjects).mockResolvedValueOnce({
    data: [memberProject({ id: projectId })],
    revision: 'member',
    nextCursor: null,
  });
  await renderSection({
    detail: { ...detail, id: organizationId, viewerRole: 'MEMBER' },
  });
  const open = el(`[data-testid="team-projects-open-${projectId}"]`);
  expect(open.tagName).toBe('BUTTON');
  expect(open.textContent).toBe('Open in Test Brand');
  await click(open);
  const href = String(jest.mocked(openDesktopDeepLink).mock.calls[0]?.[0]);
  expect(parseDesktopOrgProjectDeepLink(href, 'test-brand')).toEqual({
    destination: 'org-project',
    projectId,
    organizationId,
  });
  expect(
    container.querySelector(
      `[data-testid="team-projects-set-up-${projectId}"]`,
    ),
  ).toBeNull();
});

it('lists a hidden project before handing it to the desktop app', async (): Promise<void> => {
  let listed: ((project: OrgProjectSummary) => void) | undefined;
  jest.mocked(setOrganizationProjectPreference).mockImplementationOnce(
    (): Promise<OrgProjectSummary> =>
      new Promise((resolve): void => {
        listed = resolve;
      }),
  );
  await renderMember([
    memberProject({ preference: 'DISMISSED', listed: false }),
  ]);
  await click(el('[data-testid="team-projects-open-p1"]'));
  expect(setOrganizationProjectPreference).toHaveBeenCalledWith(
    settingsClient,
    'org-1',
    'p1',
    'ADDED',
  );
  // Held while listing runs, so a second click cannot silently do nothing.
  expect(el('[data-testid="team-projects-open-p1"]')).toHaveProperty(
    'disabled',
    true,
  );
  expect(openDesktopDeepLink).not.toHaveBeenCalled();
  await act(async (): Promise<void> => {
    listed?.(memberProject({ preference: 'ADDED' }));
  });
  expect(openDesktopDeepLink).toHaveBeenCalledTimes(1);
});

it('keeps an unlisted project here when listing it fails', async (): Promise<void> => {
  jest
    .mocked(setOrganizationProjectPreference)
    .mockRejectedValueOnce(new Error('offline'));
  await renderMember([
    memberProject({ preference: 'DISMISSED', listed: false }),
  ]);
  await click(el('[data-testid="team-projects-open-p1"]'));
  expect(openDesktopDeepLink).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Couldn't update this project.");
});

it('offers no desktop handoff for a cloud project', async (): Promise<void> => {
  await renderMember([memberProject({ location: 'CLOUD' })]);
  expect(
    container.querySelector('[data-testid="team-projects-open-p1"]'),
  ).toBeNull();
});

it('shows a member with nothing the empty state', async (): Promise<void> => {
  await renderMember([]);
  const empty = el('[data-testid="team-projects-empty"]');
  expect(empty.textContent).toContain('Nothing shared with you yet');
  expect(empty.textContent).toContain('Ask an admin of Acme to add projects.');
  expect(container.querySelector('[aria-label="Search projects"]')).toBeNull();
  expect(
    container.querySelector('[data-testid="team-projects-setup"]'),
  ).toBeNull();
});

it('member all-hidden list is not empty', async (): Promise<void> => {
  await renderMember([memberProject({ preference: 'DISMISSED' })]);
  expect(container.textContent).not.toContain('Nothing shared with you yet');
  expect(visibleRows()).toEqual(['p1']);
});

it('member pagination retains rows, deduplicates and passes the cursor', async (): Promise<void> => {
  await renderMember([memberProject()], 'next-member');
  expect(el('[data-testid="team-projects-count"]').textContent).toBe('1+');
  jest.mocked(listOrganizationProjects).mockResolvedValueOnce({
    data: [memberProject(), memberProject({ id: 'p2', name: 'Zed' })],
    revision: 'two',
    nextCursor: null,
  });
  await click(el('[data-testid="team-projects-load-more"]'));
  expect(listOrganizationProjects).toHaveBeenLastCalledWith(
    settingsClient,
    'org-1',
    'member',
    {
      cursor: 'next-member',
      limit: 50,
    },
  );
  expect(visibleRows()).toEqual(['p1', 'p2']);
  expect(
    container.querySelector('[data-testid="team-projects-load-more"]'),
  ).toBeNull();
});

it('member loading and read failure are distinct from an empty list', async (): Promise<void> => {
  let reject: ((reason: Error) => void) | undefined;
  jest.mocked(listOrganizationProjects).mockImplementationOnce(
    (): Promise<never> =>
      new Promise((_resolve, fail): void => {
        reject = fail;
      }),
  );
  await renderSection({ detail: { ...detail, viewerRole: 'MEMBER' } });
  expect(
    container.querySelector('[data-testid="settings-skeleton-list"]'),
  ).not.toBeNull();
  expect(container.textContent).not.toContain('Nothing shared with you yet');
  await act(async (): Promise<void> => {
    reject?.(new TeamApiError(500, 'Catalog failed'));
  });
  expect(container.textContent).toContain("Couldn't load this.");
  expect(container.textContent).not.toContain('Catalog failed');
  expect(container.textContent).not.toContain('Nothing shared with you yet');
});

it('does not render or load a member list with projects disabled', async (): Promise<void> => {
  await renderSection({
    detail: { ...detail, viewerRole: 'MEMBER' },
    projectsEnabled: false,
  });
  expect(listOrganizationProjects).not.toHaveBeenCalled();
  expect(
    container.querySelector('[data-testid^="team-projects-row-"]'),
  ).toBeNull();
});

const ADMINISTER = { administer: true, manageCloud: false, use: true };
function privateMemberProject(
  overrides: Partial<OrgProjectDetail> = {},
): OrgProjectDetail {
  return {
    ...project,
    kind: 'COWORK',
    repository: null,
    visibility: 'private',
    memberOwned: true,
    capabilities: ADMINISTER,
    grants: [
      { principal: { type: 'user', userId: 'u2' }, defaultListed: true },
    ],
    createdBy: { id: 'u2', name: 'Bob' },
    ...overrides,
  };
}
function shareDialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-testid="team-projects-share-confirm"]',
  );
}
function mockScopes(
  management: OrgProjectDetail[],
  members: OrgProjectSummary[],
  memberCursor: string | null = null,
): void {
  jest
    .mocked(listOrganizationProjects)
    .mockImplementation(
      (_client, _organizationId, view: 'management' | 'member') =>
        Promise.resolve(
          view === 'management'
            ? { data: management, revision: 'management', nextCursor: null }
            : { data: members, revision: 'member', nextCursor: memberCursor },
        ),
    );
}

it('merges an admin’s management and member rows into one list', async (): Promise<void> => {
  const owned = privateMemberProject({ id: 'private-owned', name: 'Mine' });
  const otherPrivate = privateMemberProject({
    id: 'private-other',
    capabilities: { administer: false, manageCloud: false, use: true },
    createdBy: { id: 'u3', name: 'Carol' },
  });
  mockScopes(
    [project],
    [{ ...project, preference: 'DISMISSED' }, owned, otherPrivate],
  );
  await renderSection({ detail: { ...detail, viewerRole: 'ADMIN' } });

  expect(visibleRows()).toEqual(['private-owned', 'p1']);
  // The management row keeps its definition and takes the member preference.
  expect(el('[data-testid="team-projects-access-p1"]')).toBeTruthy();
  expect(el('[data-testid="team-projects-hidden-p1"]')).toBeTruthy();
  // A private row says "Only you" once, with no access column.
  expect(
    el('[data-testid="team-projects-private-private-owned"]').textContent,
  ).toBe('Only you');
  expect(
    container.querySelector(
      '[data-testid="team-projects-access-private-owned"]',
    ),
  ).toBeNull();
  expect(el('[data-testid="team-projects-count"]').textContent).toBe('2');
});

it('shows one error and no partial list when either scope fails', async (): Promise<void> => {
  jest
    .mocked(listOrganizationProjects)
    .mockImplementation(
      (_client, _organizationId, view: 'management' | 'member') =>
        view === 'management'
          ? Promise.resolve({
              data: [project],
              revision: 'management',
              nextCursor: null,
            })
          : Promise.reject(new TeamApiError(500, 'Member scope failed')),
    );
  await renderSection({
    detail: {
      ...detail,
      githubConnection: { connected: true, accountLogin: 'acme' },
    },
  });
  expect(container.textContent).toContain("Couldn't load this.");
  expect(container.textContent).not.toContain('Member scope failed');
  expect(visibleRows()).toEqual([]);
  expect(
    container.querySelector('[data-testid="team-projects-setup"]'),
  ).toBeNull();
  // A failed load never strands a connected admin without Add projects.
  expect(button('Add projects')).toBeTruthy();
});

it('filters by Only you, Hidden and Archived with counts, combined with search', async (): Promise<void> => {
  const owned = privateMemberProject({ id: 'mine', name: 'Mine' });
  mockScopes(
    [
      project,
      { ...project, id: 'p2', name: 'Docs' },
      { ...project, id: 'old', name: 'Old', state: 'ARCHIVED' },
    ],
    [{ ...project, id: 'p2', name: 'Docs', preference: 'DISMISSED' }, owned],
  );
  await renderSection();
  const filter = el('[data-testid="team-projects-filter"]');
  expect(filter.textContent).toContain('All4');
  expect(filter.textContent).toContain('Only you1');
  expect(filter.textContent).toContain('Hidden1');
  expect(filter.textContent).toContain('Archived1');

  await filterBy('private');
  expect(visibleRows()).toEqual(['mine']);
  await filterBy('hidden');
  expect(visibleRows()).toEqual(['p2']);
  await filterBy('archived');
  expect(visibleRows()).toEqual(['old']);
  // The count stays the total under a filter.
  expect(el('[data-testid="team-projects-count"]').textContent).toBe('4');

  await filterBy('all');
  await input('Search projects', 'o');
  expect(visibleRows()).toEqual(['p2', 'old']);
  await filterBy('archived');
  expect(visibleRows()).toEqual(['old']);
  await input('Search projects', 'docs');
  expect(visibleRows()).toEqual([]);
  expect(el('[data-testid="team-projects-no-results"]')).toBeTruthy();
});

it('shows a filter only when it splits the list', async (): Promise<void> => {
  mockScopes(
    [],
    [privateMemberProject({ id: 'a' }), privateMemberProject({ id: 'b' })],
  );
  await renderSection();
  // Every row is "Only you" and nothing else is set: no filter.
  expect(
    container.querySelector('[data-testid="team-projects-filter"]'),
  ).toBeNull();
});

it('resets the filter to All when its bucket disappears', async (): Promise<void> => {
  jest
    .mocked(applyOrganizationProjectLifecycle)
    .mockResolvedValueOnce({ ...project, id: 'old', state: 'ACTIVE' });
  mockScopes(
    [project, { ...project, id: 'old', name: 'Old', state: 'ARCHIVED' }],
    [],
  );
  await renderSection();
  await filterBy('archived');
  expect(visibleRows()).toEqual(['old']);
  await click(el('[data-testid="team-projects-actions-old"]'));
  await click(button('Restore'));
  expect(
    container.querySelector('[data-testid="team-projects-filter"]'),
  ).toBeNull();
  expect(visibleRows()).toEqual(['p1', 'old']);
});

it('offers an admin’s own private project no Hide, and a shared one Hide', async (): Promise<void> => {
  mockScopes([project], [privateMemberProject({ id: 'mine', name: 'Mine' })]);
  await renderSection();
  await click(el('[data-testid="team-projects-actions-mine"]'));
  expect(button('Edit')).toBeTruthy();
  expect(
    document.querySelector('[data-testid="team-projects-hide-mine"]'),
  ).toBeNull();
  await click(el('[data-testid="team-projects-actions-mine"]'));
  await click(el('[data-testid="team-projects-actions-p1"]'));
  expect(el('[data-testid="team-projects-hide-p1"]')).toBeTruthy();
});

it('opens a member-scope row’s editor after loading its definition', async (): Promise<void> => {
  const owned = privateMemberProject({ id: 'p2' });
  jest.mocked(getOrganizationProject).mockResolvedValueOnce(owned);
  await renderMember([memberProject(), memberProject({ ...owned })]);
  expect(row('p1').getAttribute('role')).toBeNull();
  expect(
    container.querySelector('[data-testid="team-projects-actions-p1"]'),
  ).toBeTruthy();
  expect(getOrganizationProject).not.toHaveBeenCalled();
  await click(row('p2'));
  expect(getOrganizationProject).toHaveBeenCalledWith(
    settingsClient,
    'org-1',
    'p2',
  );
  const editor = el('[data-testid="team-projects-detail"]');
  expect(editor.textContent).toContain('Who can use it');
  expect(el('[aria-label="Name"]')).toHaveProperty('value', 'Website');
});

it('deletes a member-owned project through the confirmation', async (): Promise<void> => {
  const owned = privateMemberProject({ id: 'p2', name: 'Mine' });
  jest
    .mocked(applyOrganizationProjectLifecycle)
    .mockResolvedValueOnce({ ...owned, state: 'DELETED' });
  await renderMember([memberProject(), memberProject({ ...owned })]);
  await click(el('[aria-label="Actions for Mine"]'));
  await click(button('Delete'));
  expect(applyOrganizationProjectLifecycle).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('Delete this project?');
  await click(button('Delete project'));
  expect(applyOrganizationProjectLifecycle).toHaveBeenCalledWith(
    settingsClient,
    'org-1',
    'p2',
    { revision: 7, action: 'delete' },
  );
  expect(visibleRows()).toEqual(['p1']);
});

it('asks before sharing a private project and sends confirmShare only once confirmed', async (): Promise<void> => {
  const owned = privateMemberProject();
  jest.mocked(getOrganizationProject).mockResolvedValue(owned);
  jest.mocked(replaceOrganizationProjectGrants).mockResolvedValue({
    ...owned,
    visibility: 'organization',
    authorizationVersion: 12,
  });
  await renderMember([memberProject({ ...owned })]);
  await click(row());
  await select('Add member', 'u3');
  await click(button('Save access'));
  expect(replaceOrganizationProjectGrants).not.toHaveBeenCalled();
  const dialog = shareDialog();
  expect(dialog?.textContent).toContain('Share Website?');
  expect(dialog?.textContent).toContain(
    "People you add, and Acme's admins, will be able to see it.",
  );

  await click(el('[data-testid="confirm-dialog-cancel"]'));
  expect(shareDialog()).toBeNull();
  expect(replaceOrganizationProjectGrants).not.toHaveBeenCalled();

  await click(button('Save access'));
  await click(el('[data-testid="confirm-dialog-confirm"]'));
  expect(replaceOrganizationProjectGrants).toHaveBeenCalledTimes(1);
  expect(replaceOrganizationProjectGrants).toHaveBeenCalledWith(
    settingsClient,
    'org-1',
    'p1',
    {
      authorizationVersion: 11,
      grants: [
        ...owned.grants,
        { principal: { type: 'user', userId: 'u3' }, defaultListed: false },
      ],
      confirmShare: true,
    },
  );
  expect(shareDialog()).toBeNull();
  expect(
    container.querySelector('[data-testid="team-projects-private-p1"]'),
  ).toBeNull();
});

it('keeps an admin’s private project in place after sharing it', async (): Promise<void> => {
  const owned = privateMemberProject({ id: 'private-owned' });
  const shared = {
    ...owned,
    visibility: 'organization' as const,
    authorizationVersion: 12,
    grants: [
      ...owned.grants,
      {
        principal: { type: 'user' as const, userId: 'u3' },
        defaultListed: false,
      },
    ],
  };
  mockScopes([], [owned]);
  jest.mocked(getOrganizationProject).mockResolvedValue(owned);
  jest.mocked(replaceOrganizationProjectGrants).mockResolvedValue(shared);

  await renderSection({ detail: { ...detail, viewerRole: 'ADMIN' } });
  await click(row('private-owned'));
  await select('Add member', 'u3');
  await click(button('Save access'));
  await click(el('[data-testid="confirm-dialog-confirm"]'));

  expect(visibleRows()).toEqual(['private-owned']);
  expect(
    container.querySelector(
      '[data-testid="team-projects-private-private-owned"]',
    ),
  ).toBeNull();
  // No reload: the row just changes its chip.
  expect(listOrganizationProjects).toHaveBeenCalledTimes(2);
});

it('saves a private project kept to its creator without asking', async (): Promise<void> => {
  const owned = privateMemberProject();
  jest.mocked(getOrganizationProject).mockResolvedValue(owned);
  jest.mocked(replaceOrganizationProjectGrants).mockResolvedValue(owned);
  await renderMember([memberProject({ ...owned })]);
  await click(row());
  await click(button('Save access'));
  expect(shareDialog()).toBeNull();
  expect(replaceOrganizationProjectGrants).toHaveBeenCalledWith(
    settingsClient,
    'org-1',
    'p1',
    {
      authorizationVersion: 11,
      grants: owned.grants,
    },
  );
});

it('asks when the server requires share confirmation instead of treating it as a conflict', async (): Promise<void> => {
  jest
    .mocked(replaceOrganizationProjectGrants)
    .mockRejectedValueOnce(
      new TeamApiError(
        409,
        'Confirm sharing this private project',
        'share_confirmation_required',
      ),
    )
    .mockResolvedValueOnce(project);
  await renderSection();
  await action('Access');
  await select('Add member', 'u3');
  await click(button('Save access'));
  expect(shareDialog()).not.toBeNull();
  expect(document.body.textContent).not.toContain(
    'This project changed in another tab.',
  );
  expect(getOrganizationProject).not.toHaveBeenCalled();
  await click(el('[data-testid="confirm-dialog-confirm"]'));
  expect(replaceOrganizationProjectGrants).toHaveBeenCalledTimes(2);
  expect(
    jest.mocked(replaceOrganizationProjectGrants).mock.calls[0]?.[3],
  ).not.toHaveProperty('confirmShare');
  expect(
    jest.mocked(replaceOrganizationProjectGrants).mock.calls[1]?.[3],
  ).toHaveProperty('confirmShare', true);
  expect(shareDialog()).toBeNull();
});

describe('setup checklist', (): void => {
  const connected: OrganizationDetail = {
    ...detail,
    githubConnection: { connected: true, accountLogin: 'acme-org' },
  };
  function step(name: string): HTMLElement {
    return el(`[data-testid="team-projects-setup-${name}"]`);
  }

  it('leads a disconnected admin to Connect GitHub through the host link', async (): Promise<void> => {
    const links: string[] = [];
    settingsHost = {
      ...settingsHost,
      Link: ({ href, children, ...rest }): JSX.Element => {
        links.push(href);
        return (
          <a href={href} data-host-link="" {...rest}>
            {children}
          </a>
        );
      },
    };
    mockScopes([], [privateMemberProject({ id: 'mine' })]);
    await renderSection();
    expect(el('[data-testid="team-projects-setup"]').textContent).toContain(
      "Get your organization's projects set up",
    );
    // Says why: share once, and members set up in one click.
    expect(el('[data-testid="team-projects-setup"]').textContent).toContain(
      "Add your team's repositories once and manage sharing. Everyone you share with finds them here and can set them up in one click, already connected to the organization.",
    );
    const connect = el('[data-testid="team-projects-connect-github"]');
    expect(connect.hasAttribute('data-host-link')).toBe(true);
    expect(connect.textContent).toBe('Connect GitHub');
    expect(links).toContain('/organization/org-1/settings?tab=integrations');
    expect(step('connect').textContent).toContain(
      'Each repository the GitHub App can access can become a project.',
    );
    expect(step('add').querySelector('button')).toBeNull();
    // Private rows don't count as the organization's projects.
    expect(visibleRows()).toEqual(['mine']);
    // A heading sets them apart from the checklist, so rows drop the pill.
    expect(
      el('[data-testid="team-projects-private-heading"]').textContent,
    ).toBe("Only visible to youProjects you've added for yourself.");
    expect(
      container.querySelector('[data-testid="team-projects-private-mine"]'),
    ).toBeNull();
    // The checklist owns the one primary action, and no slot means no step 3.
    expect(
      container.querySelector('[data-testid="team-projects-create"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="team-projects-setup-local"]'),
    ).toBeNull();
    expect(listOrganizationGitHubRepositories).not.toHaveBeenCalled();
  });

  it('offers a connected admin Add projects as the next step', async (): Promise<void> => {
    mockScopes([], []);
    await renderSection({ detail: connected });
    expect(step('connect').textContent).toContain('Connected to acme-org.');
    // Each step names its state for screen readers; the icon shows it.
    expect(step('connect').textContent).toContain('Done');
    expect(step('add').textContent).toContain('Not done');
    expect(step('add').getAttribute('data-step-status')).toBe('pending');
    expect(
      container.querySelector('[data-testid="team-projects-connect-github"]'),
    ).toBeNull();
    const add = step('add').querySelector('button');
    expect(add?.textContent).toBe('Add projects');
    expect(
      container.querySelectorAll('[data-testid="team-projects-create"]'),
    ).toHaveLength(1);
    expect(el('[data-testid="team-projects-repositories-open"]')).toBeTruthy();
    expect(
      container.querySelector('[aria-label="Search projects"]'),
    ).toBeNull();
    jest.mocked(listOrganizationGitHubRepositories).mockResolvedValue({
      repositories: [],
      nextCursor: null,
      repositorySelection: 'all',
    });
    await click(el('[data-testid="team-projects-create"]'));
    expect(el('[data-testid="team-projects-create-dialog"]')).toBeTruthy();
  });

  it('tracks this desktop when the host has a local setup slot', async (): Promise<void> => {
    mockScopes([], []);
    const statuses = new Map<string, OrgProjectLocalStatus>();
    await renderSection(
      { detail: connected },
      { orgProjectLocalSetup: localSlot(statuses) },
    );
    expect(step('local').textContent).toContain(
      'Clone a project here so you can start chats in it.',
    );
    expect(step('local').querySelector('button')).toBeNull();
  });

  it('ignores setup running for a project outside this list', async (): Promise<void> => {
    mockScopes([], []);
    const statuses = new Map<string, OrgProjectLocalStatus>([
      ['other-org-project', { state: 'setting-up', message: 'Cloning' }],
    ]);
    await renderSection(
      { detail: connected },
      { orgProjectLocalSetup: localSlot(statuses) },
    );
    expect(step('local').textContent).toContain(
      'Clone a project here so you can start chats in it.',
    );
  });

  it('ignores a private project that is ready on this desktop', async (): Promise<void> => {
    mockScopes([privateMemberProject({ id: 'mine' })], []);
    const statuses = new Map<string, OrgProjectLocalStatus>([
      ['mine', { state: 'ready' }],
    ]);
    await renderSection(
      { detail: connected },
      { orgProjectLocalSetup: localSlot(statuses) },
    );
    expect(visibleRows()).toEqual(['mine']);
    expect(step('local').getAttribute('data-step-status')).toBe('pending');
  });

  it('hides once an archived org-visible project exists', async (): Promise<void> => {
    mockScopes(
      [{ ...project, state: 'ARCHIVED' }, privateMemberProject({ id: 'mine' })],
      [],
    );
    await renderSection({ detail: connected });
    expect(
      container.querySelector('[data-testid="team-projects-setup"]'),
    ).toBeNull();
    // Without the checklist, the list is mixed: the pill marks private rows.
    expect(
      container.querySelector('[data-testid="team-projects-private-heading"]'),
    ).toBeNull();
    expect(el('[data-testid="team-projects-private-mine"]').textContent).toBe(
      'Only you',
    );
    expect(button('Add projects')).toBeTruthy();
  });

  it('never shows with projects disabled, and Add projects stays hidden', async (): Promise<void> => {
    mockScopes([], []);
    await renderSection({ detail: connected, projectsEnabled: false });
    expect(
      container.querySelector('[data-testid="team-projects-setup"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="team-projects-create"]'),
    ).toBeNull();
  });

  it('never shows on a load error, where a connected admin keeps Add projects', async (): Promise<void> => {
    jest
      .mocked(listOrganizationProjects)
      .mockRejectedValue(new TeamApiError(503, 'Service unavailable'));
    await renderSection({ detail: connected });
    expect(container.textContent).toContain("Couldn't load this.");
    expect(container.textContent).not.toContain('Service unavailable');
    expect(
      container.querySelector('[data-testid="team-projects-setup"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="team-projects-empty"]'),
    ).toBeNull();
    expect(
      container.querySelectorAll('[data-testid="team-projects-create"]'),
    ).toHaveLength(1);
  });

  it('hides Add projects while loading', async (): Promise<void> => {
    jest
      .mocked(listOrganizationProjects)
      .mockImplementation((): Promise<never> => new Promise(() => {}));
    await renderSection({ detail: connected });
    expect(
      container.querySelector('[data-testid="team-projects-create"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="team-projects-setup"]'),
    ).toBeNull();
  });
});

describe('local setup slot', (): void => {
  it('offers Set up, Open without a Ready label, and the slot’s progress', async (): Promise<void> => {
    const statuses = new Map<string, OrgProjectLocalStatus>([
      ['p2', { state: 'ready' }],
      ['p3', { state: 'setting-up', message: 'Cloning 40%' }],
    ]);
    await renderMember(
      [
        memberProject(),
        memberProject({ id: 'p2', name: 'Docs' }),
        memberProject({ id: 'p3', name: 'Infra' }),
      ],
      null,
      { orgProjectLocalSetup: localSlot(statuses) },
    );
    expect(el('[data-testid="team-projects-set-up-p1"]').textContent).toBe(
      'Set up',
    );
    expect(
      container.querySelector('[data-testid="team-projects-local-p1"]'),
    ).toBeNull();
    // Open already says the project is set up here.
    expect(
      container.querySelector('[data-testid="team-projects-local-p2"]'),
    ).toBeNull();
    expect(el('[data-testid="team-projects-open-p2"]').textContent).toBe(
      'Open',
    );
    expect(el('[data-testid="team-projects-local-p3"]').textContent).toBe(
      'Cloning 40%',
    );
    expect(
      container.querySelector('[data-testid="team-projects-set-up-p3"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain('Open in Test Brand');
  });

  it('offers no Set up for projects this device cannot set up', async (): Promise<void> => {
    await renderMember(
      [
        memberProject({ id: 'cloud', name: 'Cloud', location: 'CLOUD' }),
        memberProject({ id: 'multi', name: 'Multi', topology: 'multi-repo' }),
      ],
      null,
      { orgProjectLocalSetup: localSlot(new Map()) },
    );
    expect(
      container.querySelector('[data-testid="team-projects-set-up-cloud"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="team-projects-set-up-multi"]'),
    ).toBeNull();
  });

  it('shows a rejected Set up on the row, holds the button while running, and clears on retry', async (): Promise<void> => {
    const slot = localSlot(new Map());
    let reject: ((reason: Error) => void) | undefined;
    jest.mocked(slot.setUp).mockImplementationOnce(
      (): Promise<void> =>
        new Promise((_resolve, fail): void => {
          reject = fail;
        }),
    );
    await renderMember([memberProject()], null, {
      orgProjectLocalSetup: slot,
    });
    await click(el('[data-testid="team-projects-set-up-p1"]'));
    expect(slot.setUp).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ id: 'p1' }),
      expect.any(AbortSignal),
    );
    expect(el('[data-testid="team-projects-set-up-p1"]')).toHaveProperty(
      'disabled',
      true,
    );
    // No double submit while the first is running.
    await click(el('[data-testid="team-projects-set-up-p1"]'));
    expect(slot.setUp).toHaveBeenCalledTimes(1);
    await act(async (): Promise<void> => {
      reject?.(new Error('Disk full'));
    });
    // The host's failure text never renders; the row shows local copy.
    expect(el('[data-testid="team-projects-local-p1"]').textContent).toBe(
      "Couldn't set up this project. Try again.",
    );
    await click(el('[data-testid="team-projects-set-up-p1"]'));
    expect(
      container.querySelector('[data-testid="team-projects-local-p1"]'),
    ).toBeNull();
    expect(slot.setUp).toHaveBeenCalledTimes(2);
  });

  it('ignores an aborted Set up and re-reads the row after a successful one', async (): Promise<void> => {
    const slot = localSlot(new Map());
    jest
      .mocked(slot.setUp)
      .mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'));
    await renderMember([memberProject()], null, {
      orgProjectLocalSetup: slot,
    });
    await click(el('[data-testid="team-projects-set-up-p1"]'));
    expect(
      container.querySelector('[data-testid="team-projects-local-p1"]'),
    ).toBeNull();
    expect(getOrganizationProject).not.toHaveBeenCalled();
    jest
      .mocked(getOrganizationProject)
      .mockResolvedValueOnce({ ...project, name: 'Fresh name' });
    await click(el('[data-testid="team-projects-set-up-p1"]'));
    expect(getOrganizationProject).toHaveBeenCalledWith(
      settingsClient,
      'org-1',
      'p1',
    );
    expect(row().textContent).toContain('Fresh name');
  });

  it('shows a rejected Open on the row', async (): Promise<void> => {
    const slot = localSlot(new Map([['p1', { state: 'ready' }]]));
    jest
      .mocked(slot.open)
      .mockRejectedValueOnce(new Error('Project not available'));
    await renderMember([memberProject()], null, {
      orgProjectLocalSetup: slot,
    });
    await click(el('[data-testid="team-projects-open-p1"]'));
    expect(el('[data-testid="team-projects-local-p1"]').textContent).toBe(
      "Couldn't open this project. Try again.",
    );
  });
});

function localSlot(
  statuses: ReadonlyMap<string, OrgProjectLocalStatus>,
): OrgProjectLocalSetupSlot {
  return {
    subscribe: (): (() => void) => (): void => {},
    getLocalStatuses: (): ReadonlyMap<string, OrgProjectLocalStatus> =>
      statuses,
    setUp: jest.fn((): Promise<void> => Promise.resolve()),
    open: jest.fn((): Promise<void> => Promise.resolve()),
  };
}
it('loads every management page so the count and search cover all projects', async (): Promise<void> => {
  jest
    .mocked(listOrganizationProjects)
    .mockImplementation((_client, _organizationId, view, options) =>
      Promise.resolve(
        view === 'member'
          ? { data: [], revision: 'member', nextCursor: null }
          : options?.cursor
            ? {
                data: [project, { ...project, id: 'p2', name: 'Second' }],
                revision: 'two',
                nextCursor: null,
              }
            : {
                data: [project],
                revision: 'one',
                nextCursor: 'cursor',
              },
      ),
    );
  await renderSection();
  expect(listOrganizationProjects).toHaveBeenLastCalledWith(
    settingsClient,
    'org-1',
    'management',
    { cursor: 'cursor', limit: 500 },
  );
  expect(
    container.querySelectorAll('[data-testid^="team-projects-row-"]'),
  ).toHaveLength(2);
  expect(el('[data-testid="team-projects-count"]').textContent).toBe('2');
  expect(
    container.querySelector('[data-testid="team-projects-load-more"]'),
  ).toBeNull();
});
it('edits with the current revision and replaces the row', async (): Promise<void> => {
  jest
    .mocked(updateOrganizationProject)
    .mockResolvedValue({ ...project, name: 'Renamed', revision: 8 });
  await renderSection();
  await action('Edit');
  await input('Name', 'Renamed');
  await click(button('Save changes'));
  expect(updateOrganizationProject).toHaveBeenCalledWith(
    settingsClient,
    'org-1',
    'p1',
    {
      revision: 7,
      name: 'Renamed',
      description: 'Public site',
    },
  );
  expect(el('[data-testid="team-projects-row-p1"]').textContent).toContain(
    'Renamed',
  );
});
it('turns Private memory on for a definition with the approved explanation (CAN-3562)', async (): Promise<void> => {
  jest
    .mocked(updateOrganizationProject)
    .mockResolvedValue({ ...project, privateMemory: true, revision: 8 });
  await renderSection();
  await action('Edit');
  const toggle = el('[data-testid="team-projects-private-memory-toggle"]');
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(
    el('[data-testid="team-projects-private-memory"]').textContent,
  ).toContain(
    "Agents won't use memory from other projects or your organization. New memories stay here.",
  );
  await click(toggle);
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  await click(button('Save changes'));
  expect(updateOrganizationProject).toHaveBeenCalledWith(
    settingsClient,
    'org-1',
    'p1',
    {
      revision: 7,
      name: 'Website',
      description: 'Public site',
      privateMemory: true,
    },
  );
});
it('turns Private memory off with an explicit false, and omits an unchanged value (CAN-3562)', async (): Promise<void> => {
  const privateProject = { ...project, privateMemory: true };
  jest.mocked(listOrganizationProjects).mockResolvedValue({
    data: [privateProject],
    revision: 'one',
    nextCursor: null,
  });
  jest
    .mocked(updateOrganizationProject)
    .mockResolvedValueOnce({ ...privateProject, name: 'Renamed', revision: 8 })
    .mockResolvedValueOnce({
      ...privateProject,
      name: 'Renamed',
      privateMemory: false,
      revision: 9,
    });
  await renderSection();
  await action('Edit');
  const toggle = el('[data-testid="team-projects-private-memory-toggle"]');
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  await input('Name', 'Renamed');
  await click(button('Save changes'));
  expect(updateOrganizationProject).toHaveBeenLastCalledWith(
    settingsClient,
    'org-1',
    'p1',
    {
      revision: 7,
      name: 'Renamed',
      description: 'Public site',
    },
  );
  await click(toggle);
  await click(button('Save changes'));
  expect(updateOrganizationProject).toHaveBeenLastCalledWith(
    settingsClient,
    'org-1',
    'p1',
    {
      revision: 8,
      name: 'Renamed',
      description: 'Public site',
      privateMemory: false,
    },
  );
});
it('refetches on 409 without blindly retrying and preserves the draft', async (): Promise<void> => {
  jest
    .mocked(updateOrganizationProject)
    .mockRejectedValue(new TeamApiError(409, 'Conflict'));
  jest
    .mocked(getOrganizationProject)
    .mockResolvedValue({ ...project, name: 'Remote', revision: 8 });
  await renderSection();
  await action('Edit');
  await input('Name', 'My draft');
  await click(button('Save changes'));
  expect(document.body.textContent).toContain(
    'This project changed in another tab.',
  );
  expect(document.body.textContent).toContain('Reload and try again.');
  expect(getOrganizationProject).toHaveBeenCalledWith(
    settingsClient,
    'org-1',
    'p1',
  );
  expect(updateOrganizationProject).toHaveBeenCalledTimes(1);
  expect(el('[aria-label="Name"]')).toHaveProperty('value', 'My draft');
});
it('deduplicates team and direct grants and previews members losing access', async (): Promise<void> => {
  await renderSection();
  await action('Access');
  expect(
    el('[data-testid="team-projects-grants-editor"]').textContent,
  ).toContain('2 members will see this project');
  await click(el('[aria-label="Remove Engineering"]'));
  expect(document.body.textContent).toContain('1 member will see this project');
  expect(document.body.textContent).toContain('Members losing access: Bob');
  expect(document.body.textContent).not.toContain(
    'Members losing access: Alice',
  );
});
it('saves grants with the current authorization version', async (): Promise<void> => {
  const grants = [project.grants[1]].filter(
    (grant): grant is NonNullable<typeof grant> => grant !== undefined,
  );
  jest
    .mocked(replaceOrganizationProjectGrants)
    .mockResolvedValue({ ...project, grants, authorizationVersion: 12 });
  await renderSection();
  await action('Access');
  await click(el('[aria-label="Remove Engineering"]'));
  await click(button('Save access'));
  expect(replaceOrganizationProjectGrants).toHaveBeenCalledWith(
    settingsClient,
    'org-1',
    'p1',
    {
      authorizationVersion: 11,
      grants,
    },
  );
});
it('keeps each draft paired with the token it was started from', async (): Promise<void> => {
  // A grants save refreshes the selected project. If that refresh carries a
  // newer revision (someone else edited the definition), the metadata draft
  // that was typed against revision 7 must still be submitted with revision 7
  // so the server rejects it instead of silently overwriting the other edit.
  const grants = [project.grants[1]].filter(
    (grant): grant is NonNullable<typeof grant> => grant !== undefined,
  );
  jest.mocked(replaceOrganizationProjectGrants).mockResolvedValue({
    ...project,
    name: 'Renamed elsewhere',
    grants,
    revision: 9,
    authorizationVersion: 12,
  });
  jest
    .mocked(updateOrganizationProject)
    .mockRejectedValue(new TeamApiError(409, 'Conflict'));
  jest
    .mocked(getOrganizationProject)
    .mockResolvedValue({ ...project, name: 'Renamed elsewhere', revision: 9 });
  await renderSection();
  await action('Edit');
  await input('Name', 'My draft');
  await click(el('[aria-label="Remove Engineering"]'));
  await click(button('Save access'));
  expect(replaceOrganizationProjectGrants).toHaveBeenCalledWith(
    settingsClient,
    'org-1',
    'p1',
    {
      authorizationVersion: 11,
      grants,
    },
  );
  await click(button('Save changes'));
  expect(updateOrganizationProject).toHaveBeenCalledWith(
    settingsClient,
    'org-1',
    'p1',
    {
      revision: 7,
      name: 'My draft',
      description: 'Public site',
    },
  );
});
it.each(['archive', 'restore', 'delete'] as const)(
  'runs %s with revision; delete requires confirmation',
  async (actionName): Promise<void> => {
    const initial: OrgProjectDetail = {
      ...project,
      state: actionName === 'restore' ? 'ARCHIVED' : 'ACTIVE',
    };
    jest.mocked(listOrganizationProjects).mockResolvedValue({
      data: [initial],
      revision: 'one',
      nextCursor: null,
    });
    jest.mocked(applyOrganizationProjectLifecycle).mockResolvedValue({
      ...initial,
      state:
        actionName === 'delete'
          ? 'DELETED'
          : actionName === 'archive'
            ? 'ARCHIVED'
            : 'ACTIVE',
      revision: 8,
    });
    await renderSection();
    await action(
      actionName === 'archive'
        ? 'Archive'
        : actionName === 'restore'
          ? 'Restore'
          : 'Delete',
    );
    if (actionName === 'delete') {
      expect(applyOrganizationProjectLifecycle).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain('Delete this project?');
      await click(el('[data-testid="confirm-dialog-confirm"]'));
      expect(
        container.querySelector('[data-testid="team-projects-row-p1"]'),
      ).toBeNull();
    }
    expect(applyOrganizationProjectLifecycle).toHaveBeenCalledWith(
      settingsClient,
      'org-1',
      'p1',
      { revision: 7, action: actionName },
    );
  },
);
it.each([{ orgLapsed: true }, { projectsEnabled: false }])(
  'blocks growth but permits grant removal and deletion: %s',
  async (overrides): Promise<void> => {
    jest.mocked(listOrganizationProjects).mockResolvedValue({
      data: [{ ...project, state: 'ARCHIVED' }],
      revision: 'one',
      nextCursor: null,
    });
    await renderSection(overrides);
    await click(el('[aria-label="Actions for Website"]'));
    expect(button('Restore').disabled).toBe(true);
    expect(button('Delete').disabled).toBe(false);
    await click(button('Access'));
    expect(el('[aria-label="Add member"]')).toHaveProperty('disabled', true);
    expect(el('[aria-label="Add team"]')).toHaveProperty('disabled', true);
    expect(el('[aria-label="Remove Engineering"]')).toHaveProperty(
      'disabled',
      false,
    );
  },
);
it('shows load errors without claiming the list is empty', async (): Promise<void> => {
  jest
    .mocked(listOrganizationProjects)
    .mockRejectedValue(new TeamApiError(503, 'SENTINEL-SERVER-BODY'));
  await renderSection();
  expect(container.textContent).toContain("Couldn't load this.");
  expect(container.textContent).not.toContain('SENTINEL-SERVER-BODY');
  expect(container.textContent).not.toContain(
    'Create your first organization project',
  );
});
it('reloads the list on Retry after the first load failed', async (): Promise<void> => {
  jest
    .mocked(listOrganizationProjects)
    .mockImplementation((_client, _orgId, scope: 'management' | 'member') =>
      scope === 'management'
        ? Promise.reject(new TeamApiError(503, 'SENTINEL-SERVER-BODY'))
        : Promise.resolve({ data: [], revision: 'one', nextCursor: null }),
    );
  await renderSection();
  expect(container.textContent).toContain("Couldn't load this.");
  expect(container.textContent).not.toContain('SENTINEL-SERVER-BODY');
  jest.mocked(listOrganizationProjects).mockResolvedValue({
    data: [project],
    revision: 'two',
    nextCursor: null,
  });
  await click(button('Try again'));
  expect(el('[data-testid="team-projects-row-p1"]')).not.toBeNull();
  expect(container.textContent).not.toContain("Couldn't load this.");
});

async function select(label: string, value: string): Promise<void> {
  await chooseSettingsOption(
    settingsSelectTrigger(document, `[aria-label="${label}"]`),
    value,
  );
}
function optionText(label: string): string {
  return settingsSelectOptionLabels(
    settingsSelectTrigger(document, `[aria-label="${label}"]`),
  ).join('\n');
}

it('adds only ungranted principals and saves the per-grant listing preference', async (): Promise<void> => {
  jest.mocked(replaceOrganizationProjectGrants).mockResolvedValue(project);
  await renderSection();
  await action('Access');
  expect(optionText('Add member')).not.toContain('Alice');
  expect(optionText('Add team')).not.toContain('Engineering');
  await select('Add member', 'u3');
  await select('Add team', 't2');
  expect(document.body.textContent).toContain(
    '3 members will see this project',
  );
  const checkboxes = document.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  const carolCheckbox = checkboxes.item(2);
  await click(carolCheckbox);
  await click(button('Save access'));
  expect(replaceOrganizationProjectGrants).toHaveBeenCalledWith(
    settingsClient,
    'org-1',
    'p1',
    {
      authorizationVersion: 11,
      grants: [
        ...project.grants,
        { principal: { type: 'user', userId: 'u3' }, defaultListed: true },
        { principal: { type: 'team', teamId: 't2' }, defaultListed: false },
      ],
    },
  );
});

it('shows the everyone grant as one row for every member, with no default listing, and removes it', async (): Promise<void> => {
  const everyone = {
    principal: { type: 'organization' as const },
    defaultListed: false,
  };
  const seeded: OrgProjectDetail = { ...project, grants: [everyone] };
  jest.mocked(listOrganizationProjects).mockResolvedValue({
    data: [seeded],
    revision: 'page1',
    nextCursor: null,
  });
  jest.mocked(getOrganizationProject).mockResolvedValue(seeded);
  jest
    .mocked(replaceOrganizationProjectGrants)
    .mockResolvedValue({ ...seeded, grants: [], authorizationVersion: 12 });
  await renderSection();
  expect(el('[data-testid="team-projects-access-p1"]').textContent).toBe(
    'Everyone in Acme',
  );
  await action('Access');
  const editor = el('[data-testid="team-projects-grants-editor"]');
  const row = el('[data-testid="team-projects-grant-organization"]');
  expect(row.textContent).toContain('Everyone in Acme');
  expect(row.textContent).toContain('Includes people who join later');
  expect(row.querySelector('input[type="checkbox"]')).toBeNull();
  expect(editor.textContent).toContain('3 members will see this project');
  expect(optionText('Add member')).not.toContain('Everyone in Acme');

  await click(el('[aria-label="Remove Everyone in Acme"]'));
  expect(document.body.textContent).toContain(
    '0 members will see this project',
  );
  expect(document.body.textContent).toContain(
    'Members losing access: Alice, Bob, Carol',
  );
  await click(button('Save access'));
  expect(replaceOrganizationProjectGrants).toHaveBeenCalledWith(
    settingsClient,
    'org-1',
    'p1',
    {
      authorizationVersion: 11,
      grants: [],
    },
  );
});

it('adds the everyone grant from the member picker, never listed by default', async (): Promise<void> => {
  jest.mocked(replaceOrganizationProjectGrants).mockResolvedValue(project);
  await renderSection();
  await action('Access');
  expect(optionText('Add member')).toContain('Everyone in Acme');
  await select('Add member', 'organization');
  expect(document.body.textContent).toContain(
    '3 members will see this project',
  );
  await click(button('Save access'));
  expect(replaceOrganizationProjectGrants).toHaveBeenCalledWith(
    settingsClient,
    'org-1',
    'p1',
    {
      authorizationVersion: 11,
      grants: [
        ...project.grants,
        { principal: { type: 'organization' }, defaultListed: false },
      ],
    },
  );
});

it('handles grant conflicts and uses the refreshed authorization version after explicit reload', async (): Promise<void> => {
  jest
    .mocked(replaceOrganizationProjectGrants)
    .mockRejectedValueOnce(new TeamApiError(409, 'Conflict'))
    .mockResolvedValueOnce({ ...project, authorizationVersion: 13 });
  jest
    .mocked(getOrganizationProject)
    .mockResolvedValue({ ...project, authorizationVersion: 12 });
  await renderSection();
  await action('Access');
  await click(el('[aria-label="Remove Engineering"]'));
  await click(button('Save access'));
  expect(replaceOrganizationProjectGrants).toHaveBeenCalledTimes(1);
  expect(getOrganizationProject).toHaveBeenCalledWith(
    settingsClient,
    'org-1',
    'p1',
  );
  expect(button('Save access').disabled).toBe(true);
  await click(button('Reload project'));
  await click(button('Save access'));
  expect(replaceOrganizationProjectGrants).toHaveBeenLastCalledWith(
    settingsClient,
    'org-1',
    'p1',
    { authorizationVersion: 12, grants: project.grants },
  );
});

it('refetches lifecycle conflicts without retrying the action', async (): Promise<void> => {
  jest
    .mocked(applyOrganizationProjectLifecycle)
    .mockRejectedValue(new TeamApiError(409, 'Conflict'));
  jest
    .mocked(getOrganizationProject)
    .mockResolvedValue({ ...project, revision: 9, state: 'ARCHIVED' });
  await renderSection();
  await action('Archive');
  expect(applyOrganizationProjectLifecycle).toHaveBeenCalledTimes(1);
  expect(getOrganizationProject).toHaveBeenCalledWith(
    settingsClient,
    'org-1',
    'p1',
  );
  expect(container.textContent).toContain(
    'This project changed in another tab.',
  );
  expect(container.textContent).toContain('Archived');
});

it('caps additions at 500 grants while preserving removal', async (): Promise<void> => {
  const grants: OrgProjectDetail['grants'] = Array.from(
    { length: 500 },
    (_, index) => ({
      principal: { type: 'user', userId: `limit-${index}` },
      defaultListed: false,
    }),
  );
  const fullProject: OrgProjectDetail = { ...project, grants };
  jest.mocked(listOrganizationProjects).mockResolvedValue({
    data: [fullProject],
    revision: 'one',
    nextCursor: null,
  });
  await renderSection();
  await action('Access');
  expect(el('[aria-label="Add member"]')).toHaveProperty('disabled', true);
  expect(el('[aria-label="Add team"]')).toHaveProperty('disabled', true);
  await click(el('[aria-label="Remove limit-0"]'));
  expect(el('[aria-label="Add member"]')).toHaveProperty('disabled', false);
});

it('shows one error and no partial list when a later management page fails', async (): Promise<void> => {
  jest
    .mocked(listOrganizationProjects)
    .mockImplementation((_client, _organizationId, view, options) => {
      if (String(view) === 'member')
        return Promise.resolve({
          data: [],
          revision: 'member',
          nextCursor: null,
        });
      return options?.cursor
        ? Promise.reject(new TeamApiError(503, 'Try later'))
        : Promise.resolve({
            data: [project],
            revision: 'one',
            nextCursor: 'next',
          });
    });
  await renderSection();
  expect(container.textContent).toContain("Couldn't load this.");
  expect(container.textContent).not.toContain('Try later');
  expect(
    container.querySelector('[data-testid="team-projects-row-p1"]'),
  ).toBeNull();
  expect(
    container.querySelector('[data-testid="team-projects-setup"]'),
  ).toBeNull();
});
it('opens the row with bounded inputs and a read-only GitHub link', async (): Promise<void> => {
  await renderSection();
  await click(el('[data-testid="team-projects-row-p1"]'));
  expect(el('[aria-label="Name"]')).toHaveProperty('maxLength', 256);
  expect(el('[aria-label="Description"]')).toHaveProperty('maxLength', 1024);
  expect(
    el('[data-testid="team-projects-detail"] a').getAttribute('href'),
  ).toBe('https://github.com/acme/website');
  expect(document.body.textContent).toContain('Default branch: main');
});

type Repository = Awaited<
  ReturnType<typeof listOrganizationGitHubRepositories>
>['repositories'][number];
function repository(id: number): Repository {
  return {
    id,
    fullName: `acme/repo-${id}`,
    owner: 'acme',
    name: `repo-${id}`,
    defaultBranch: 'main',
    private: true,
    archived: true,
    htmlUrl: `https://github.com/acme/repo-${id}`,
  };
}
async function openCreate(
  repositories: Repository[] = [repository(1)],
): Promise<void> {
  jest.mocked(listOrganizationGitHubRepositories).mockResolvedValue({
    repositories,
    nextCursor: null,
    repositorySelection: 'all',
  });
  await renderSection({
    detail: {
      ...detail,
      githubConnection: { connected: true, accountLogin: 'acme' },
    },
  });
  await click(button('Add projects'));
}

it.each([{ orgLapsed: true }, { projectsEnabled: false }])(
  'offers no Add projects when growth is disabled: %s',
  async (overrides): Promise<void> => {
    await renderSection({
      ...overrides,
      detail: {
        ...detail,
        githubConnection: { connected: true, accountLogin: 'acme' },
      },
    });
    expect(
      container.querySelector('[data-testid="team-projects-create"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="team-projects-refresh"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="team-projects-setup"]'),
    ).toBeNull();
  },
);

it('pages, debounces search, preserves selection and displays repository metadata', async (): Promise<void> => {
  jest.useFakeTimers();
  try {
    await openCreate();
    expect(
      el('[data-testid="team-projects-repo-picker"]').textContent,
    ).toContain('acme/repo-1');
    expect(document.body.textContent).toContain('Default branch: main');
    expect(document.body.textContent).toContain('Private');
    expect(document.body.textContent).toContain('Archived');
    await click(el('[data-testid="team-projects-repo-1"]'));
    jest.mocked(listOrganizationGitHubRepositories).mockResolvedValueOnce({
      repositories: [repository(2)],
      nextCursor: 'next',
      repositorySelection: 'selected',
    });
    await input('Search repositories', 'repo');
    expect(el('[aria-label="Search repositories"]')).toHaveProperty(
      'maxLength',
      100,
    );
    await act(async (): Promise<void> => {
      jest.advanceTimersByTime(299);
    });
    expect(listOrganizationGitHubRepositories).toHaveBeenCalledTimes(1);
    await act(async (): Promise<void> => {
      jest.advanceTimersByTime(1);
    });
    expect(listOrganizationGitHubRepositories).toHaveBeenLastCalledWith(
      settingsClient,
      'org-1',
      { query: 'repo' },
    );
    expect(document.body.textContent).toContain(
      'Only repositories the installation was granted show here. Manage access on GitHub to add more.',
    );
    jest.mocked(listOrganizationGitHubRepositories).mockResolvedValueOnce({
      repositories: [repository(3)],
      nextCursor: null,
      repositorySelection: 'selected',
    });
    await click(el('[data-testid="team-projects-repo-load-more"]'));
    expect(listOrganizationGitHubRepositories).toHaveBeenLastCalledWith(
      settingsClient,
      'org-1',
      { query: 'repo', cursor: 'next' },
    );
    expect(el('[data-testid="team-projects-repo-2"]')).toBeTruthy();
    expect(el('[data-testid="team-projects-repo-3"]')).toBeTruthy();
    expect(document.body.textContent).toContain('1 selected');
    await click(button('Next'));
    expect(el('[data-testid="team-projects-name-1"]')).toBeTruthy();
  } finally {
    jest.useRealTimers();
  }
});

it('filters the picker by visibility and archived state', async (): Promise<void> => {
  await openCreate([
    repository(1),
    { ...repository(2), private: false, archived: false },
    { ...repository(3), archived: false },
    { ...repository(4), private: false },
  ]);
  const shown = (): number[] =>
    Array.from(
      document.querySelectorAll<HTMLInputElement>(
        '[data-testid^="team-projects-repo-"][type="checkbox"]',
      ),
    ).map((box): number =>
      Number(
        box.getAttribute('data-testid')?.replace('team-projects-repo-', ''),
      ),
    );
  expect(shown()).toEqual([1, 2, 3, 4]);
  const trigger = el('[data-testid="team-projects-repo-filter-trigger"]');
  expect(trigger.getAttribute('aria-label')).toBe('Filter repositories');
  expect(trigger.getAttribute('data-active')).toBe('false');

  await click(trigger);
  await click(el('[data-testid="team-projects-repo-filter-private"]'));
  expect(shown()).toEqual([1, 3]);
  expect(trigger.getAttribute('data-active')).toBe('true');
  expect(
    el('[data-testid="team-projects-repo-filter-private"]').getAttribute(
      'aria-checked',
    ),
  ).toBe('true');

  await click(el('[data-testid="team-projects-repo-filter-archived"]'));
  expect(shown()).toEqual([1]);

  await click(el('[data-testid="team-projects-repo-filter-public"]'));
  expect(shown()).toEqual([4]);

  await click(el('[data-testid="team-projects-repo-filter-active"]'));
  expect(shown()).toEqual([2]);

  await click(el('[data-testid="team-projects-repo-filter-any-visibility"]'));
  await click(el('[data-testid="team-projects-repo-filter-any-status"]'));
  expect(shown()).toEqual([1, 2, 3, 4]);
  expect(trigger.getAttribute('data-active')).toBe('false');
});

it('keeps selected repositories when a filter hides them and explains an empty result', async (): Promise<void> => {
  await openCreate([repository(1)]);
  await click(el('[data-testid="team-projects-repo-1"]'));
  await click(el('[data-testid="team-projects-repo-filter-trigger"]'));
  await click(el('[data-testid="team-projects-repo-filter-public"]'));
  expect(
    document.querySelector('[data-testid="team-projects-repo-1"]'),
  ).toBeNull();
  expect(document.body.textContent).toContain(
    'No repositories match these filters.',
  );
  expect(document.body.textContent).toContain('1 selected');
});

it('caps repository selection at 32 and allows deselection', async (): Promise<void> => {
  await openCreate(
    Array.from({ length: 33 }, (_, index): Repository => repository(index + 1)),
  );
  for (let id = 1; id <= 32; id++)
    await click(el(`[data-testid="team-projects-repo-${id}"]`));
  expect(document.body.textContent).toContain('32 selected');
  expect(document.body.textContent).toContain('Select up to 32 repositories.');
  expect(el('[data-testid="team-projects-repo-33"]')).toHaveProperty(
    'disabled',
    true,
  );
  await click(el('[data-testid="team-projects-repo-1"]'));
  expect(el('[data-testid="team-projects-repo-33"]')).toHaveProperty(
    'disabled',
    false,
  );
});

it.each([
  [409, 'github-not-connected', 'Connect GitHub first.', true],
  [
    409,
    'github-installation-suspended',
    'The GitHub installation is suspended. Reconnect GitHub first.',
    true,
  ],
  [
    409,
    'github-installation-unavailable',
    "Couldn't use the GitHub installation. Reconnect GitHub first.",
    false,
  ],
  [
    429,
    'github-rate-limited',
    'GitHub rate limit reached. Try again in a minute.',
    false,
  ],
  [502, 'github-unavailable', "Couldn't reach GitHub. Try again.", false],
  [
    403,
    undefined,
    'Only organization owners and admins can pick repositories.',
    false,
  ],
  // Unmapped refusals (a bad cursor, an over-long search) get load copy.
  [400, undefined, "Couldn't load this. Try again.", false],
] satisfies Array<[number, string | undefined, string, boolean]>)(
  'renders typed picker error %s %s as local copy, never the server text',
  async (status, code, copy, connect): Promise<void> => {
    await openCreate();
    await click(el('[aria-label="Close"]'));
    jest
      .mocked(listOrganizationGitHubRepositories)
      .mockRejectedValueOnce(
        new TeamApiError(status, 'SENTINEL-SERVER-BODY', code),
      );
    await click(button('Add projects'));
    expect(
      el('[data-testid="team-projects-repo-picker"]').textContent,
    ).toContain(copy);
    expect(
      el('[data-testid="team-projects-repo-picker"]').textContent,
    ).not.toContain('SENTINEL-SERVER-BODY');
    expect(
      document.querySelector(
        'a[href="/organization/org-1/settings?tab=integrations"]',
      ) !== null,
    ).toBe(connect);
  },
);

it('creates definitions with Private memory when the admin turns it on (CAN-3562)', async (): Promise<void> => {
  await openCreate([repository(1)]);
  await click(el('[data-testid="team-projects-repo-1"]'));
  await click(button('Next'));
  // An off-by-default choice waits behind Advanced instead of leading the step.
  const advanced = el('[data-testid="team-projects-create-advanced-toggle"]');
  expect(advanced.textContent).toBe('Advanced');
  expect(
    document.querySelector(
      '[data-testid="team-projects-create-private-memory-toggle"]',
    ),
  ).toBeNull();
  await click(advanced);
  const toggle = el(
    '[data-testid="team-projects-create-private-memory-toggle"]',
  );
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(
    el('[data-testid="team-projects-create-private-memory"]').textContent,
  ).toContain(
    "Agents won't use memory from other projects or your organization. New memories stay here.",
  );
  await click(toggle);
  jest.mocked(createOrganizationProjects).mockResolvedValue({
    results: [
      {
        providerRepoId: '1',
        outcome: 'created',
        project: { ...project, id: 'created', privateMemory: true },
      },
    ],
  });
  await click(el('[data-testid="team-projects-create-submit"]'));
  expect(createOrganizationProjects).toHaveBeenCalledWith(
    settingsClient,
    'org-1',
    {
      repositories: [
        {
          providerRepoId: '1',
          owner: 'acme',
          name: 'repo-1',
          defaultBranch: 'main',
        },
      ],
      grants: [],
      privateMemory: true,
    },
  );
});
it('creates definitions with shared grants, preserves drafts on Back and renders all outcomes', async (): Promise<void> => {
  await openCreate([
    repository(1),
    repository(2),
    repository(3),
    repository(4),
  ]);
  for (let id = 1; id <= 4; id++)
    await click(el(`[data-testid="team-projects-repo-${id}"]`));
  await click(button('Next'));
  expect(el('[data-testid="team-projects-name-1"]')).toHaveProperty(
    'placeholder',
    'repo-1',
  );
  expect(el('[data-testid="team-projects-name-1"]')).toHaveProperty(
    'maxLength',
    256,
  );
  await input('Name for acme/repo-1', 'New name');
  await select('Add team', 't1');
  await select('Add member', 'u1');
  expect(document.body.textContent).toContain(
    '2 members will see this project',
  );
  await click(
    el('[data-testid="team-projects-grants-editor"] input[type="checkbox"]'),
  );
  await click(button('Back'));
  expect(el('[data-testid="team-projects-repo-1"]')).toHaveProperty(
    'checked',
    true,
  );
  await click(button('Next'));
  const created = { ...project, id: 'created', name: 'New name' };
  jest.mocked(createOrganizationProjects).mockResolvedValue({
    results: [
      { providerRepoId: '1', outcome: 'created', project: created },
      { providerRepoId: '2', outcome: 'exists', project },
      {
        providerRepoId: '3',
        outcome: 'error',
        error: 'repository-not-in-installation',
      },
      { providerRepoId: '4', outcome: 'error', error: 'Server row message' },
    ],
  });
  await click(el('[data-testid="team-projects-create-submit"]'));
  expect(createOrganizationProjects).toHaveBeenCalledWith(
    settingsClient,
    'org-1',
    {
      repositories: [1, 2, 3, 4].map((id) => ({
        providerRepoId: String(id),
        owner: 'acme',
        name: `repo-${id}`,
        defaultBranch: 'main',
        ...(id === 1 ? { displayName: 'New name' } : {}),
      })),
      grants: [
        { principal: { type: 'team', teamId: 't1' }, defaultListed: true },
        { principal: { type: 'user', userId: 'u1' }, defaultListed: false },
      ],
    },
  );
  for (const [id, label] of [
    [1, 'Created'],
    [2, 'Already exists'],
    [3, 'Not in your GitHub installation'],
    // A per-repository reason is server text, so it never renders.
    [4, "Couldn't create this project."],
  ]) {
    expect(
      el(`[data-testid="team-projects-create-outcome-${id}"]`).textContent,
    ).toContain(label);
  }
  expect(document.body.textContent).not.toContain('Server row message');
  expect(document.body.textContent).toContain(
    '1 created, 1 already existed, 2 failed',
  );
  await click(button('Done'));
  expect(
    container
      .querySelector('[data-testid^="team-projects-row-"]')
      ?.getAttribute('data-testid'),
  ).toBe('team-projects-row-created');
  expect(
    jest
      .mocked(listOrganizationProjects)
      .mock.calls.filter(([, , view]) => String(view) === 'management'),
  ).toHaveLength(1);
});

it.each([502, 409, 429])(
  'preserves selection and permits retry after request-level %s',
  async (status): Promise<void> => {
    await openCreate();
    await click(el('[data-testid="team-projects-repo-1"]'));
    await click(button('Next'));
    jest
      .mocked(createOrganizationProjects)
      .mockRejectedValueOnce(
        new TeamApiError(
          status,
          'Server request message',
          'github-not-connected',
        ),
      )
      .mockResolvedValueOnce({
        results: [{ providerRepoId: '1', outcome: 'exists' }],
      });
    await click(el('[data-testid="team-projects-create-submit"]'));
    expect(
      el('[data-testid="team-projects-create-dialog"]').textContent,
    ).not.toContain('Server request message');
    expect(el('[data-testid="team-projects-name-1"]')).toBeTruthy();
    await click(el('[data-testid="team-projects-create-submit"]'));
    expect(createOrganizationProjects).toHaveBeenCalledTimes(2);
    expect(jest.mocked(createOrganizationProjects).mock.calls[0]).toEqual(
      jest.mocked(createOrganizationProjects).mock.calls[1],
    );
  },
);

it('ignores a stale search response and debounces clearing the query', async (): Promise<void> => {
  jest.useFakeTimers();
  try {
    await openCreate();
    expect(button('Next').disabled).toBe(true);
    let resolveOld:
      | ((
          page: Awaited<ReturnType<typeof listOrganizationGitHubRepositories>>,
        ) => void)
      | undefined;
    jest.mocked(listOrganizationGitHubRepositories).mockImplementationOnce(
      () =>
        new Promise((resolve): void => {
          resolveOld = resolve;
        }),
    );
    await input('Search repositories', 'old');
    await act(async (): Promise<void> => {
      jest.advanceTimersByTime(300);
    });
    expect(
      document.body.querySelector('[data-testid="settings-skeleton-list"]'),
    ).not.toBeNull();
    jest.mocked(listOrganizationGitHubRepositories).mockResolvedValueOnce({
      repositories: [repository(3)],
      nextCursor: null,
      repositorySelection: 'all',
    });
    await input('Search repositories', 'new');
    await act(async (): Promise<void> => {
      jest.advanceTimersByTime(300);
    });
    await act(async (): Promise<void> => {
      resolveOld?.({
        repositories: [repository(2)],
        nextCursor: 'stale',
        repositorySelection: 'selected',
      });
    });
    expect(
      document.querySelector('[data-testid="team-projects-repo-2"]'),
    ).toBeNull();
    expect(el('[data-testid="team-projects-repo-3"]')).toBeTruthy();
    await input('Search repositories', '');
    const callsBeforeClear = jest.mocked(listOrganizationGitHubRepositories)
      .mock.calls.length;
    await act(async (): Promise<void> => {
      jest.advanceTimersByTime(299);
    });
    expect(listOrganizationGitHubRepositories).toHaveBeenCalledTimes(
      callsBeforeClear,
    );
    await act(async (): Promise<void> => {
      jest.advanceTimersByTime(1);
    });
    expect(listOrganizationGitHubRepositories).toHaveBeenLastCalledWith(
      settingsClient,
      'org-1',
      { query: '' },
    );
  } finally {
    jest.useRealTimers();
  }
});

it('keeps loaded repositories and selection when pagination fails, then retries the cursor', async (): Promise<void> => {
  await openCreate();
  await click(el('[aria-label="Close"]'));
  jest.mocked(listOrganizationGitHubRepositories).mockResolvedValueOnce({
    repositories: [repository(1)],
    nextCursor: 'next',
    repositorySelection: 'all',
  });
  await click(button('Add projects'));
  await click(el('[data-testid="team-projects-repo-1"]'));
  jest
    .mocked(listOrganizationGitHubRepositories)
    .mockRejectedValueOnce(
      new TeamApiError(502, 'Page failed', 'github-unavailable'),
    );
  await click(el('[data-testid="team-projects-repo-load-more"]'));
  expect(el('[data-testid="team-projects-repo-1"]')).toHaveProperty(
    'checked',
    true,
  );
  expect(document.body.textContent).toContain(
    "Couldn't reach GitHub. Try again.",
  );
  expect(document.body.textContent).not.toContain('Page failed');
  jest.mocked(listOrganizationGitHubRepositories).mockResolvedValueOnce({
    repositories: [repository(1), repository(2)],
    nextCursor: null,
    repositorySelection: 'all',
  });
  await click(el('[data-testid="team-projects-repo-load-more"]'));
  expect(listOrganizationGitHubRepositories).toHaveBeenLastCalledWith(
    settingsClient,
    'org-1',
    {
      query: '',
      cursor: 'next',
    },
  );
  expect(
    document.querySelectorAll('[data-testid="team-projects-repo-1"]'),
  ).toHaveLength(1);
  expect(el('[data-testid="team-projects-repo-2"]')).toBeTruthy();
});

// ---------------------------------------------------------------------------
// Repositories: Refresh from GitHub and hide/unhide (CAN-3414)
// ---------------------------------------------------------------------------

const connectedDetail: OrganizationDetail = {
  ...detail,
  githubConnection: { connected: true, accountLogin: 'acme' },
};
function repositoryRow(
  overrides: Partial<OrganizationRepository> = {},
): OrganizationRepository {
  return {
    id: 1,
    fullName: 'acme/website',
    owner: 'acme',
    name: 'website',
    defaultBranch: 'main',
    private: true,
    archived: false,
    htmlUrl: 'https://github.com/acme/website',
    hidden: false,
    project: { id: 'p1', name: 'Website', state: 'ACTIVE', seeded: true },
    ...overrides,
  };
}
const docsRepository = repositoryRow({
  id: 2,
  fullName: 'acme/docs',
  name: 'docs',
  htmlUrl: 'https://github.com/acme/docs',
  project: null,
});
const secretRepository = repositoryRow({
  id: 3,
  fullName: 'acme/secret',
  name: 'secret',
  htmlUrl: 'https://github.com/acme/secret',
  hidden: true,
  project: null,
});
function mockRepositories(repositories: OrganizationRepository[]): void {
  jest.mocked(listOrganizationRepositories).mockResolvedValueOnce({
    repositories,
    repositorySelection: 'all',
    nextCursor: null,
  });
}
function repositoryItem(id: number): HTMLElement {
  return el(`[data-testid="team-projects-repository-${id}"]`);
}
function hideBox(id: number): HTMLInputElement {
  const box = el(`[data-testid="team-projects-repository-hide-${id}"]`);
  if (!(box instanceof HTMLInputElement)) throw new Error('Not a checkbox');
  return box;
}

describe('repositories', (): void => {
  beforeEach((): void => {
    jest.mocked(listOrganizationRepositories).mockReset();
    jest.mocked(refreshOrganizationProjectsFromGitHub).mockReset();
    jest.mocked(setOrganizationRepositoryHidden).mockReset();
  });

  async function openRepositories(): Promise<void> {
    await click(el('[data-testid="team-projects-repositories-open"]'));
  }

  it('lists repositories only in a dialog, with their hidden state and project', async (): Promise<void> => {
    mockRepositories([
      repositoryRow(),
      docsRepository,
      secretRepository,
      repositoryRow({
        id: 5,
        fullName: 'acme/legacy',
        name: 'legacy',
        htmlUrl: 'https://github.com/acme/legacy',
        archived: true,
        project: null,
      }),
    ]);
    await renderSection({ detail: connectedDetail });

    // The page shows projects; repositories wait for the dialog.
    expect(listOrganizationRepositories).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="team-projects-repositories"]'),
    ).toBeNull();
    expect(
      el('[data-testid="team-projects-repositories-open"]').textContent,
    ).toBe('GitHub repositories');

    await openRepositories();

    expect(listOrganizationRepositories).toHaveBeenCalledWith(
      settingsClient,
      'org-1',
      {},
    );
    const dialog = el('[data-testid="team-projects-repositories"]');
    expect(dialog.textContent).toContain('GitHub repositories');
    expect(repositoryItem(1).textContent).toContain('acme/website');
    expect(
      el('[data-testid="team-projects-repository-label-repo-1"]').className,
    ).toContain('font-mono');
    expect(repositoryItem(1).textContent).toContain('Project: Website');
    expect(repositoryItem(2).textContent).toContain('Refresh to add a project');
    expect(repositoryItem(3).textContent).toContain('Skipped by refresh');
    // Seeding skips archived GitHub repositories, so refresh cannot add one.
    expect(repositoryItem(5).textContent).toContain(
      'Skipped by refresh: archived on GitHub',
    );
    expect(hideBox(1).checked).toBe(false);
    expect(hideBox(3).checked).toBe(true);
    expect(hideBox(1).getAttribute('aria-label')).toBe('Hide acme/website');
  });

  it('searches repositories by repository and project name, never the owner', async (): Promise<void> => {
    mockRepositories([
      repositoryRow(),
      docsRepository,
      repositoryRow({
        id: 4,
        fullName: 'acme/handbook',
        name: 'handbook',
        htmlUrl: 'https://github.com/acme/handbook',
        project: { id: 'p4', name: 'Guides', state: 'ACTIVE', seeded: false },
      }),
    ]);
    await renderSection({ detail: connectedDetail });
    await openRepositories();
    const visible = (): string[] =>
      Array.from(
        document.querySelectorAll(
          '[data-testid^="team-projects-repository-"][aria-busy]',
        ),
      ).map((row): string => row.getAttribute('data-testid') ?? '');

    await input('Search repositories', 'acm');
    expect(visible()).toEqual([]);
    expect(
      el('[data-testid="team-projects-repositories-no-results"]').textContent,
    ).toBe('No repositories match your search.');

    await input('Search repositories', 'DOC');
    expect(visible()).toEqual(['team-projects-repository-2']);

    await input('Search repositories', 'guide');
    expect(visible()).toEqual(['team-projects-repository-4']);

    await input('Search repositories', '');
    expect(visible()).toHaveLength(3);
  });

  it('refreshes from GitHub, reports the counts, and updates both lists', async (): Promise<void> => {
    mockRepositories([repositoryRow(), docsRepository, secretRepository]);
    await renderSection({ detail: connectedDetail });
    await openRepositories();
    await click(el('[aria-label="Close"]'));
    expect(listOrganizationRepositories).toHaveBeenCalledTimes(1);
    const docsProject: OrgProjectDetail = {
      ...project,
      id: 'p2',
      name: 'docs',
      repository: project.repository && {
        ...project.repository,
        name: 'docs',
        providerRepoId: '2',
        verification: 'VERIFIED',
      },
    };
    jest.mocked(refreshOrganizationProjectsFromGitHub).mockResolvedValueOnce({
      added: 1,
      skippedHidden: 1,
      skippedExisting: 1,
      failed: 0,
    });
    jest.mocked(listOrganizationProjects).mockResolvedValueOnce({
      data: [project, docsProject],
      revision: 'page2',
      nextCursor: null,
    });
    mockRepositories([
      repositoryRow(),
      {
        ...docsRepository,
        project: { id: 'p2', name: 'docs', state: 'ACTIVE', seeded: true },
      },
      secretRepository,
    ]);

    await click(el('[data-testid="team-projects-refresh"]'));

    expect(refreshOrganizationProjectsFromGitHub).toHaveBeenCalledWith(
      settingsClient,
      'org-1',
    );
    expect(el('[data-testid="team-projects-refresh-result"]').textContent).toBe(
      '1 project added, 1 hidden repository skipped',
    );
    expect(
      container.querySelector('[data-testid="team-projects-row-p2"]'),
    ).not.toBeNull();
    expect(el('[data-testid="team-projects-count"]').textContent).toBe('2');
    expect(
      el('[data-testid="team-projects-refresh"]').hasAttribute('disabled'),
    ).toBe(false);

    await openRepositories();
    expect(listOrganizationRepositories).toHaveBeenCalledTimes(2);
    // The list after a refresh must not come from a cached GitHub page.
    expect(listOrganizationRepositories).toHaveBeenLastCalledWith(
      settingsClient,
      'org-1',
      {
        fresh: true,
      },
    );
    expect(repositoryItem(2).textContent).toContain('Project: docs');
  });

  it('reports failed repositories and plural counts', async (): Promise<void> => {
    await renderSection({ detail: connectedDetail });
    jest.mocked(refreshOrganizationProjectsFromGitHub).mockResolvedValueOnce({
      added: 0,
      skippedHidden: 2,
      skippedExisting: 1,
      failed: 3,
    });

    await click(el('[data-testid="team-projects-refresh"]'));

    expect(el('[data-testid="team-projects-refresh-result"]').textContent).toBe(
      "0 projects added, 2 hidden repositories skipped, 3 couldn't be added. Refresh again to retry.",
    );
  });

  it('shows a GitHub rate limit and lets the admin try again', async (): Promise<void> => {
    await renderSection({ detail: connectedDetail });
    jest
      .mocked(refreshOrganizationProjectsFromGitHub)
      .mockRejectedValueOnce(
        new TeamApiError(
          429,
          'GitHub rate limit reached. Try again in a minute.',
          'github-rate-limited',
        ),
      );

    await click(el('[data-testid="team-projects-refresh"]'));

    expect(container.textContent).toContain(
      'GitHub rate limit reached. Try again in a minute.',
    );
    expect(
      container.querySelector('[data-testid="team-projects-refresh-result"]'),
    ).toBeNull();
    expect(
      el('[data-testid="team-projects-refresh"]').hasAttribute('disabled'),
    ).toBe(false);
    expect(listOrganizationRepositories).not.toHaveBeenCalled();
  });

  it('hides a repository and shows its seeded project as archived', async (): Promise<void> => {
    mockRepositories([repositoryRow(), docsRepository]);
    await renderSection({ detail: connectedDetail });
    await openRepositories();
    jest.mocked(setOrganizationRepositoryHidden).mockResolvedValueOnce({
      providerRepoId: '1',
      hidden: true,
      changed: true,
      project: { ...project, state: 'ARCHIVED', revision: 8 },
    });

    await click(hideBox(1));

    expect(setOrganizationRepositoryHidden).toHaveBeenCalledWith(
      settingsClient,
      'org-1',
      '1',
      {
        hidden: true,
        owner: 'acme',
        name: 'website',
      },
    );
    expect(hideBox(1).checked).toBe(true);
    expect(repositoryItem(1).textContent).toContain(
      'Project: Website (archived)',
    );
    expect(el('[data-testid="team-projects-archived-p1"]').textContent).toBe(
      'Archived',
    );
  });

  it('unhides a repository and shows its restored project as active', async (): Promise<void> => {
    jest.mocked(listOrganizationProjects).mockResolvedValueOnce({
      data: [{ ...project, state: 'ARCHIVED' }],
      revision: 'archived',
      nextCursor: null,
    });
    mockRepositories([
      repositoryRow({
        hidden: true,
        project: { id: 'p1', name: 'Website', state: 'ARCHIVED', seeded: true },
      }),
    ]);
    await renderSection({ detail: connectedDetail });
    await openRepositories();
    expect(el('[data-testid="team-projects-archived-p1"]').textContent).toBe(
      'Archived',
    );
    jest.mocked(setOrganizationRepositoryHidden).mockResolvedValueOnce({
      providerRepoId: '1',
      hidden: false,
      changed: true,
      project: { ...project, state: 'ACTIVE', revision: 9 },
    });

    await click(hideBox(1));

    expect(setOrganizationRepositoryHidden).toHaveBeenCalledWith(
      settingsClient,
      'org-1',
      '1',
      {
        hidden: false,
      },
    );
    expect(hideBox(1).checked).toBe(false);
    expect(repositoryItem(1).textContent).toContain('Project: Website');
    expect(repositoryItem(1).textContent).not.toContain('archived');
    expect(
      document.querySelector('[data-testid="team-projects-archived-p1"]'),
    ).toBeNull();
  });

  it('shows the requested state and locks the row while hiding', async (): Promise<void> => {
    mockRepositories([repositoryRow()]);
    await renderSection({ detail: connectedDetail });
    await openRepositories();
    let resolve:
      | ((
          value: Awaited<ReturnType<typeof setOrganizationRepositoryHidden>>,
        ) => void)
      | undefined;
    jest.mocked(setOrganizationRepositoryHidden).mockImplementationOnce(
      () =>
        new Promise((done): void => {
          resolve = done;
        }),
    );

    await click(hideBox(1));

    expect(hideBox(1).checked).toBe(true);
    expect(hideBox(1).disabled).toBe(true);
    expect(repositoryItem(1).getAttribute('aria-busy')).toBe('true');
    await act(async (): Promise<void> => {
      resolve?.({
        providerRepoId: '1',
        hidden: true,
        changed: true,
        project: null,
      });
    });
    expect(hideBox(1).checked).toBe(true);
    expect(hideBox(1).disabled).toBe(false);
    expect(repositoryItem(1).getAttribute('aria-busy')).toBe('false');
  });

  it('keeps the checkbox unchanged and shows the error when hiding fails', async (): Promise<void> => {
    mockRepositories([repositoryRow()]);
    await renderSection({ detail: connectedDetail });
    await openRepositories();
    jest
      .mocked(setOrganizationRepositoryHidden)
      .mockRejectedValueOnce(new Error('network'));

    await click(hideBox(1));

    expect(hideBox(1).checked).toBe(false);
    expect(hideBox(1).disabled).toBe(false);
    expect(document.body.textContent).toContain(
      "Couldn't update this repository. Try again.",
    );
  });

  it.each([
    ['a member', { detail: { ...connectedDetail, viewerRole: 'MEMBER' } }],
    ['the flag is off', { detail: connectedDetail, projectsEnabled: false }],
    ['the organization lapsed', { detail: connectedDetail, orgLapsed: true }],
    ['GitHub is not connected', { detail }],
  ] satisfies Array<
    [string, Partial<ComponentProps<typeof TeamProjectsSection>>]
  >)('hides the controls when %s', async (_label, overrides): Promise<void> => {
    await renderSection(overrides);
    expect(
      container.querySelector(
        '[data-testid="team-projects-repositories-open"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="team-projects-refresh"]'),
    ).toBeNull();
    expect(listOrganizationRepositories).not.toHaveBeenCalled();
  });
});

describe('replay privacy', (): void => {
  it('blocks project and repository names from session replay', async (): Promise<void> => {
    settingsHost = createTestSettingsHost({
      client: settingsClient,
      brand: testBrand,
      privacy: { blockClassName: 'replay-block', maskClassName: 'replay-mask' },
    }).host;
    await renderSection();
    const name = el('[data-testid="team-projects-name-p1"]');
    expect(name.textContent).toBe('Website');
    expect(name.classList).toContain('replay-block');
    const repository = el('[data-testid="team-projects-description-p1"]');
    expect(repository.textContent).toBe('acme/website');
    expect(repository.classList).toContain('replay-block');
  });

  it('adds no class token for replay privacy when the host has none', async (): Promise<void> => {
    await renderSection();
    expect(el('[data-testid="team-projects-name-p1"]').className).toBe(
      'truncate text-s fg-primary',
    );
    expect(el('[data-testid="team-projects-description-p1"]').className).toBe(
      'line-clamp-2 text-xs fg-secondary',
    );
  });
});
