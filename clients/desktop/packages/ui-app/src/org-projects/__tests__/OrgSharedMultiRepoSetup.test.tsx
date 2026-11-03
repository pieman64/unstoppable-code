/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CanopyClientProvider } from '@canopy/app-state';
import { createFakeClient } from '../../../../app-state/src/__tests__/fake-org-projects-client';
import type {
  PreparedSharedMultiRepo,
  SharedMultiRepoCreationStatus,
  OrgProjectSummary,
  PrepareSharedMultiRepoParams,
} from '@canopy/protocol/org-projects';
import { OrgSharedMultiRepoSetup } from '../OrgSharedMultiRepoSetup';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
const preview: PreparedSharedMultiRepo = {
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  sourceProjects: [
    { projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', expectedRevision: 2 },
  ],
  repositories: ['one', 'two'].map((name) => ({
    provider: 'github',
    host: 'github.com',
    owner: 'org',
    name,
    providerRepoId: name,
    defaultBranch: 'main',
    verification: 'VERIFIED',
  })),
  lockedProjectIds: [],
  suggestedName: 'One + Two',
  canCreate: true,
};
const progress: SharedMultiRepoCreationStatus = {
  creationKey: 'key',
  organizationId: preview.organizationId,
  deviceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  state: 'completion-pending',
  projectId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  updatedAt: '2026-10-26T19:00:00.000Z',
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const sources = [
  { kind: 'workspace' as const, id: 'source', name: 'Original' },
];
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}
function button(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (item) => item.textContent === text,
  );
}
function mount(
  canCreate = true,
  discoveryFails = false,
  recent: readonly SharedMultiRepoCreationStatus[] = [],
  mode: 'convert' | 'add-repositories' = 'convert',
): {
  create: jest.Mock;
  resume: jest.Mock;
  getCreation: jest.Mock;
  onReady: jest.Mock;
} {
  const { client } = createFakeClient();
  const create = jest.fn().mockResolvedValue(progress);
  const resume = jest.fn().mockResolvedValue(progress);
  const getCreation = jest.fn().mockResolvedValue(progress);
  const onReady = jest.fn();
  act(() =>
    root.render(
      <CanopyClientProvider
        client={{
          ...client,
          capabilities: { ...client.capabilities, sharedMultiRepo: true },
          sharedMultiRepo: {
            prepare: jest.fn().mockResolvedValue({ ...preview, canCreate }),
            create,
            resume,
            getCreation,
            listCreations: discoveryFails
              ? jest
                  .fn()
                  .mockRejectedValue(new Error('Saved progress unavailable'))
              : jest.fn().mockResolvedValue(recent),
            catalog: jest.fn().mockResolvedValue({ projects: [] }),
            cancelSetup: jest.fn(),
          },
        }}
      >
        <div role="dialog" aria-labelledby="setup-title">
          <h2 id="setup-title">New shared multi-repo project</h2>
          <OrgSharedMultiRepoSetup
            sources={sources}
            mode={mode}
            onReady={onReady}
          />
        </div>
      </CanopyClientProvider>,
    ),
  );
  return { create, resume, getCreation, onReady };
}

test('previews every repository and locks original selections without consuming source work', async () => {
  const { create } = mount();
  await flush();
  expect(container.textContent).toContain('org/one');
  expect(container.textContent).toContain('org/two');
  expect(
    container.querySelector<HTMLInputElement>('input[type="checkbox"]')
      ?.disabled,
  ).toBe(true);
  expect(container.textContent).toContain(
    'Your original projects and their work stay unchanged.',
  );
  expect(create).not.toHaveBeenCalled();
  expect(button('Try the same project again')).toBeUndefined();
});
test('completion-pending never opens new work; submitted fields stay immutable', async () => {
  const { create, onReady } = mount();
  await flush();
  act(() => {
    button('Create shared project')?.click();
  });
  await flush();
  expect(create).toHaveBeenCalledTimes(1);
  expect(
    container.querySelector<HTMLInputElement>('input[type="text"]')?.disabled,
  ).toBe(true);
  expect(button('Open project repositories')).toBeUndefined();
  expect(onReady).not.toHaveBeenCalled();
  expect(container.textContent).toContain('waiting for confirmation');
});
test('a server permission refusal keeps a visible explanation and disables creation', async () => {
  const { create } = mount(false);
  await flush();
  expect(button('Create shared project')?.disabled).toBe(true);
  expect(container.textContent).toContain('organization owner or admin');
  expect(create).not.toHaveBeenCalled();
});
test('an unavailable client shows a capability explanation and sends nothing', () => {
  act(() =>
    root.render(<OrgSharedMultiRepoSetup sources={sources} mode="convert" />),
  );
  expect(container.textContent).toContain('Reconnect to a desktop');
  expect(button('Create shared project')).toBeUndefined();
});

test('missing saved-attempt discovery keeps new creation disabled', async () => {
  const { create } = mount(true, true);
  await flush();
  expect(button('Create shared project')?.disabled).toBe(true);
  expect(container.textContent).toContain('Saved progress unavailable');
  expect(create).not.toHaveBeenCalled();
});
test('saved progress exposes an explicit same-key retry after losing the original form', async () => {
  const { create, resume } = mount(true, false, [progress]);
  await flush();
  act(() => button('Check saved progress')?.click());
  await flush();
  expect(button('Try the same project again')).toBeDefined();
  expect(resume).not.toHaveBeenCalled();
  act(() => button('Try the same project again')?.click());
  await flush();
  expect(resume).toHaveBeenCalledWith(progress.creationKey);
  expect(create).not.toHaveBeenCalled();
});

test('an Add draft cannot bypass its required addition through Retry', async () => {
  const { create } = mount(true, false, [], 'add-repositories');
  await flush();
  expect(button('Create shared project')?.disabled).toBe(true);
  const retry = button('Try the same project again');
  act(() => retry?.click());
  await flush();
  expect(create).not.toHaveBeenCalled();
  expect(retry).toBeUndefined();
});

test('reopening a completed source form does not navigate back to its old destination', async () => {
  const { client } = createFakeClient();
  const create = jest.fn().mockResolvedValue({ ...progress, state: 'ready' });
  const onReady = jest.fn().mockResolvedValue(undefined);
  const onSubmitted = jest.fn();
  const hostClient = {
    ...client,
    capabilities: { ...client.capabilities, sharedMultiRepo: true },
    sharedMultiRepo: {
      prepare: jest.fn().mockResolvedValue(preview),
      create,
      getCreation: jest.fn().mockResolvedValue(null),
      listCreations: jest.fn().mockResolvedValue([]),
      catalog: jest.fn().mockResolvedValue({ projects: [] }),
      cancelSetup: jest.fn(),
    },
  };
  const render = (visible: boolean): void => {
    act(() =>
      root.render(
        <CanopyClientProvider client={hostClient}>
          {visible && (
            <OrgSharedMultiRepoSetup
              sources={sources}
              mode="convert"
              onReady={onReady}
              onSubmitted={onSubmitted}
            />
          )}
        </CanopyClientProvider>,
      ),
    );
  };
  render(true);
  await flush();
  act(() => button('Create shared project')?.click());
  await flush();
  expect(onReady).toHaveBeenCalledTimes(1);
  onSubmitted.mockClear();
  render(false);
  render(true);
  await flush();
  expect(onReady).toHaveBeenCalledTimes(1);
  expect(onSubmitted).not.toHaveBeenCalled();
  act(() => button('Open project repositories')?.click());
  await flush();
  expect(onReady).toHaveBeenCalledTimes(2);
  expect(create).toHaveBeenCalledTimes(1);
});

test('Add repository dialog has exactly one heading', async () => {
  mount();
  await flush();
  expect(container.querySelectorAll('h1, h2, h3, h4, h5, h6')).toHaveLength(1);
});

function mountMultiRepoSource(): {
  prepare: jest.Mock;
  create: jest.Mock;
  openExternalUrl: jest.Mock;
} {
  const { client } = createFakeClient();
  const openExternalUrl = jest.fn();
  const repositories = ['setup-repo', 'second-repo'].map((name) => ({
    ...preview.repositories[0],
    name,
    providerRepoId: name,
  }));
  const prepare = jest
    .fn()
    .mockImplementation((params: PrepareSharedMultiRepoParams) =>
      Promise.resolve({
        ...preview,
        repositories:
          params.selections.length > 1
            ? [
                ...repositories,
                {
                  ...repositories[0],
                  name: 'extra-repo',
                  providerRepoId: 'extra',
                },
              ]
            : repositories,
        suggestedName: 'Acme + second + repositories',
      }),
    );
  const create = jest.fn().mockResolvedValue(progress);
  const projects: OrgProjectSummary[] = [
    ...repositories,
    {
      ...repositories[0],
      name: 'extra-repo',
      providerRepoId: 'extra',
    },
  ].map((repository, index) => ({
    id: `repo-${index}`,
    organizationId: preview.organizationId,
    name: index === 2 ? 'Extra repository' : repository.name,
    description: null,
    kind: 'CODE',
    purpose: 'project',
    visibility: 'organization',
    memberOwned: false,
    location: 'LOCAL',
    repository,
    topology: 'single-repo',
    state: 'ACTIVE',
    revision: 1,
    authorizationVersion: 1,
    defaultListed: true,
    preference: 'FOLLOW_DEFAULTS',
    listed: true,
    capabilities: { use: true, administer: true, manageCloud: true },
    instance: null,
  }));
  act(() =>
    root.render(
      <CanopyClientProvider
        client={{
          ...client,
          openExternalUrl,
          capabilities: { ...client.capabilities, sharedMultiRepo: true },
          sharedMultiRepo: {
            prepare,
            create,
            getCreation: jest.fn().mockResolvedValue(null),
            listCreations: jest.fn().mockResolvedValue([]),
            catalog: jest.fn().mockResolvedValue({ projects }),
            cancelSetup: jest.fn(),
          },
        }}
      >
        <OrgSharedMultiRepoSetup
          sources={[
            {
              kind: 'workspace',
              id: 'multi-source',
              name: 'Acme + second',
            },
          ]}
          mode="add-repositories"
        />
      </CanopyClientProvider>,
    ),
  );
  return { prepare, create, openExternalUrl };
}

test('multi-repo source repositories are included once and cannot be selected as additions', async () => {
  const { prepare, create } = mountMultiRepoSource();
  await flush();
  for (const name of ['setup-repo', 'second-repo']) {
    const rows = Array.from(container.querySelectorAll('label')).filter(
      (label) => label.textContent?.includes(name),
    );
    expect(rows).toHaveLength(1);
    const checkbox = rows[0].querySelector('input');
    expect(checkbox?.checked).toBe(true);
    expect(checkbox?.disabled).toBe(true);
    expect(rows[0].textContent).toContain('Included');
    act(() => checkbox?.click());
  }
  expect(prepare).toHaveBeenCalledTimes(1);
  const extra = Array.from(container.querySelectorAll('label'))
    .find((label) => label.textContent?.startsWith('org/extra-repo'))
    ?.querySelector('input');
  expect(extra?.disabled).toBe(false);
  expect(extra?.checked).toBe(false);
  act(() => extra?.click());
  await flush();
  expect(extra?.checked).toBe(true);
  expect(prepare).toHaveBeenLastCalledWith({
    mode: 'add-repositories',
    selections: [
      { kind: 'workspace', id: 'multi-source' },
      { kind: 'project', id: 'repo-2' },
    ],
  });
  for (const name of ['setup-repo', 'second-repo']) {
    const included = Array.from(container.querySelectorAll('label'))
      .find((label) => label.textContent?.startsWith(`org/${name}`))
      ?.querySelector('input');
    expect(included?.checked).toBe(true);
    expect(included?.disabled).toBe(true);
  }
  act(() => extra?.click());
  await flush();
  expect(extra?.checked).toBe(false);
  expect(extra?.disabled).toBe(false);
  expect(create).not.toHaveBeenCalled();
});

test('multi-repo source default name preserves distinct name parts without piling up repositories', async () => {
  mountMultiRepoSource();
  await flush();
  expect(
    container.querySelector<HTMLInputElement>('input[type="text"]')?.value,
  ).toBe('Acme + second');
});

test('repository rows replace the project row and count only checked repositories', async () => {
  mountMultiRepoSource();
  await flush();
  expect(container.querySelector('legend')?.textContent).toBe('Repositories');
  const checkboxes = container.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  expect(checkboxes).toHaveLength(3);
  for (const name of ['setup-repo', 'second-repo']) {
    const checkbox = container.querySelector<HTMLInputElement>(
      `input[aria-label="org/${name}"]`,
    );
    expect(checkbox?.checked).toBe(true);
    expect(checkbox?.disabled).toBe(true);
    const row = checkbox?.closest('label')?.parentElement;
    expect(row?.textContent).toContain('Included');
    expect(row?.querySelector('.fg-tertiary')?.textContent).toBe(
      'Acme + second',
    );
  }
  expect(container.textContent).toContain('2 repositories in the new project');
  const extra = container.querySelector<HTMLInputElement>(
    'input[aria-label="org/extra-repo"]',
  );
  expect(extra).not.toBeNull();
  act(() => extra?.click());
  expect(container.textContent).toContain('3 repositories in the new project');
  await flush();
  expect(
    container.querySelectorAll('input[type="checkbox"]:checked'),
  ).toHaveLength(3);
  act(() => extra?.click());
  expect(container.textContent).toContain('2 repositories in the new project');
  await flush();
});

test('GitHub buttons open each repository through the host without toggling selection', async () => {
  const { openExternalUrl, prepare } = mountMultiRepoSource();
  await flush();
  const buttons = container.querySelectorAll<HTMLButtonElement>(
    'button[aria-label="Open on GitHub"]',
  );
  expect(buttons).toHaveLength(3);
  for (let index = 0; index < buttons.length; index++) {
    const name = ['setup-repo', 'second-repo', 'extra-repo'][index];
    expect(buttons[index].title).toBe('Open on GitHub');
    expect(buttons[index].closest('label')).toBeNull();
    act(() => buttons[index].click());
    expect(openExternalUrl).toHaveBeenLastCalledWith(
      `https://github.com/org/${name}`,
    );
  }
  expect(
    container.querySelector<HTMLInputElement>(
      'input[aria-label="org/extra-repo"]',
    )?.checked,
  ).toBe(false);
  expect(prepare).toHaveBeenCalledTimes(1);
});
