/**
 * @jest-environment jsdom
 *
 * Fork dialog (CAN-2552).
 *
 * The cases here are the ones where being wrong is expensive rather than
 * merely ugly:
 *
 * - The request shape. `fork` copies a whole repository checkout; a destination
 *   assembled wrong sends that work at the wrong place.
 * - The failure landing. Every refusal main returns is about the destination,
 *   so a failure that leaves the user on the disclosure step hides the only
 *   control that fixes it, and a failure that flattens main's message strips
 *   the only guidance for choosing again.
 * - The disclosures gate. The short statements are the whole reason the
 *   dialog is two steps; forking without passing through them is the
 *   regression that matters. The longer explanations and the full script list
 *   stay one Show details click away.
 * - The owning context (CAN-4781). An organization share's copy belongs to
 *   that organization with no Personal fallback; both steps name it and the
 *   payload carries it.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WorkspaceContext } from '@canopy/desktop-shared/types';

const openForkedContainer = jest.fn<
  Promise<{ switchedTo: WorkspaceContext | null }>,
  unknown[]
>(() => Promise.resolve({ switchedTo: null }));
jest.mock('@/lib/shared-containers/open-forked-container', () => ({
  openForkedContainer: (
    ...args: unknown[]
  ): Promise<{ switchedTo: WorkspaceContext | null }> =>
    openForkedContainer(...args),
}));

let projects: Array<{
  id: string;
  name: string;
  type: string;
  owner?: {
    type: 'organization';
    organizationId: string;
    projectId: string;
    instanceId: string;
    bindingGeneration: number;
  };
}> = [];
jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: (selector: (state: unknown) => unknown): unknown =>
    selector({ projects }),
}));

import { useGitHubStore } from '@/stores/githubStore';
import { useLinkedPersonalWorkspacesStore } from '@/stores/linkedPersonalWorkspacesStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { SharedContainerForkModal } from '../SharedContainerForkModal';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { outermostReplayBlock } from '@/test-utils/replay';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let fork: jest.Mock;
let readForkProvenance: jest.Mock;
let getReplicaState: jest.Mock;
let onClose: jest.Mock;

const REVISION_1 = {
  status: 'available' as const,
  revisionId: 'revision-1',
  revisionCreatedAt: '2026-09-08T12:00:00.000Z',
};

function replica(
  revisionId: string,
  revisionCreatedAt: string,
): Record<string, unknown> {
  return {
    containerId: 'container-1',
    organizationId: 'org-1',
    containerType: 'CODE_WORKTREE',
    updatedAt: revisionCreatedAt,
    status: 'available',
    revisionId,
    revision: 1,
    revisionCreatedAt,
  };
}

const PROVENANCE = {
  sourceContainerId: 'container-1',
  sourceRevisionId: 'revision-1',
  sourceOwnerDisplayName: 'Dana',
  organizationId: 'org-1',
  forkedAt: '2026-09-09T10:00:00.000Z',
};

function response(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    containerType: 'CODE_WORKTREE',
    projectId: 'workspace-1',
    worktreeId: 'worktree-1',
    warnings: [],
    provenance: PROVENANCE,
    ...overrides,
  };
}

function render(overrides: Record<string, unknown> = {}): void {
  act(() => {
    root.render(
      <SharedContainerForkModal
        containerId="container-1"
        organizationId="org-1"
        access="organization"
        revision={REVISION_1}
        containerType="CODE_WORKTREE"
        title="Checkout flow"
        ownerName="Dana"
        onClose={onClose}
        {...overrides}
      />,
    );
  });
}

function query(testId: string): HTMLElement | null {
  return document.body.querySelector(`[data-testid="${testId}"]`);
}

function click(testId: string): void {
  const element = query(testId);
  if (element === null) throw new Error(`missing ${testId}`);
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  const snapshot = getDefaultFeatureFlagSnapshot();
  snapshot.values[CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key] = true;
  useFeatureFlagsStore.setState({ snapshot });
  projects = [
    {
      id: 'workspace-1',
      name: 'Storefront',
      type: 'single-repo',
      owner: {
        type: 'organization',
        organizationId: 'org-1',
        projectId: 'project-1',
        instanceId: 'instance-1',
        bindingGeneration: 1,
      },
    },
    {
      id: 'cowork-1',
      name: 'Notes',
      type: 'cowork',
      owner: {
        type: 'organization',
        organizationId: 'org-1',
        projectId: 'project-2',
        instanceId: 'instance-2',
        bindingGeneration: 1,
      },
    },
  ];
  useLinkedPersonalWorkspacesStore.setState({ ids: [] });
  useWorkspaceContextStore.setState({
    hydrated: true,
    state: {
      context: { kind: 'personal' },
      revision: 1,
      organizations: [{ id: 'org-1', name: 'Acme', role: 'MEMBER' }],
    },
  });
  fork = jest.fn(() => Promise.resolve(response()));
  readForkProvenance = jest.fn(() => Promise.resolve(null));
  getReplicaState = jest.fn(() =>
    Promise.resolve(replica('revision-1', REVISION_1.revisionCreatedAt)),
  );
  onClose = jest.fn();
  openForkedContainer.mockReset();
  openForkedContainer.mockImplementation(() =>
    Promise.resolve({ switchedTo: null }),
  );
  useNavigationStore.setState({ forkedContainerFocusHolds: 0 });
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: {
      getDefaultCloneDirectory: jest.fn(() =>
        Promise.resolve('/home/me/repos'),
      ),
      browseForCloneDirectory: jest.fn(() =>
        Promise.resolve({ canceled: false, directoryPath: '/picked' }),
      ),
      sharedContainers: { fork, readForkProvenance, getReplicaState },
    },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SharedContainerForkModal', () => {
  it('sends the default new-workspace destination with the resolved clone directory', async () => {
    render();
    await flush();

    click('shared-container-fork-continue');
    click('shared-container-fork-confirm');
    await flush();

    expect(fork).toHaveBeenCalledWith({
      containerId: 'container-1',
      organizationId: 'org-1',
      revisionId: 'revision-1',
      sourceOwnerDisplayName: 'Dana',
      destination: {
        kind: 'new-workspace',
        owner: { kind: 'organization', organizationId: 'org-1' },
        parentDirectory: '/home/me/repos',
      },
    });
  });

  it('names the organization a new copy belongs to, on both steps', async () => {
    render();
    await flush();

    expect(
      query('shared-container-fork-destination-context')?.textContent,
    ).toBe('Belongs to Acme');
    click('shared-container-fork-continue');

    expect(
      query('shared-container-fork-disclosures-destination')?.textContent,
    ).toBe('Your copy will be made in Acme.');
  });

  it('keeps an organization share in the organization when it is not the active context', async () => {
    // The active context is Personal and has no bearing on the destination.
    render();
    await flush();
    click('shared-container-fork-continue');
    click('shared-container-fork-confirm');
    await flush();

    expect(fork).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: {
          kind: 'new-workspace',
          owner: { kind: 'organization', organizationId: 'org-1' },
          parentDirectory: '/home/me/repos',
        },
      }),
    );
  });

  it('keeps the share owner when navigation and switcher availability change while the modal is open', async () => {
    render();
    await flush();
    click('shared-container-fork-continue');
    act(() => {
      useWorkspaceContextStore.setState({
        state: {
          context: { kind: 'organization', organizationId: 'other-org' },
          revision: 2,
          organizations: [{ id: 'org-1', name: 'Acme', role: 'MEMBER' }],
        },
      });
      const snapshot = getDefaultFeatureFlagSnapshot();
      snapshot.values[CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key] =
        false;
      useFeatureFlagsStore.setState({ snapshot });
    });
    click('shared-container-fork-confirm');
    await flush();

    expect(fork).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: {
          kind: 'new-workspace',
          owner: { kind: 'organization', organizationId: 'org-1' },
          parentDirectory: '/home/me/repos',
        },
      }),
    );
  });

  it('says the organization when its name is unknown, never Personal', async () => {
    useWorkspaceContextStore.setState({
      state: { context: { kind: 'personal' }, revision: 1, organizations: [] },
    });
    render();
    await flush();

    expect(
      query('shared-container-fork-destination-context')?.textContent,
    ).toBe('Belongs to the organization');
  });

  it('names Personal for a direct share and sends a Personal owner', async () => {
    render({ access: 'direct', organizationId: undefined });
    await flush();

    expect(
      query('shared-container-fork-destination-context')?.textContent,
    ).toBe('Belongs to Personal');
    click('shared-container-fork-continue');
    expect(
      query('shared-container-fork-disclosures-destination')?.textContent,
    ).toBe('Your copy will be made in Personal.');
    click('shared-container-fork-confirm');
    await flush();

    expect(fork).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: {
          kind: 'new-workspace',
          owner: { kind: 'personal' },
          parentDirectory: '/home/me/repos',
        },
      }),
    );
  });

  it('refuses an organization share whose organization is unknown instead of defaulting to Personal', async () => {
    render({ organizationId: undefined });
    await flush();

    expect(query('shared-container-fork-context-unavailable')).not.toBeNull();
    expect(query('shared-container-fork-destination-context')).toBeNull();
    expect(
      query('shared-container-fork-continue')?.hasAttribute('disabled'),
    ).toBe(true);
    expect(
      query('shared-container-fork-destination-existing')?.hasAttribute(
        'disabled',
      ),
    ).toBe(true);
  });

  it('says there are no compatible workspaces in the context rather than none at all', async () => {
    projects = [];
    render();
    await flush();

    expect(
      query('shared-container-fork-destination-existing')?.closest('label')
        ?.textContent,
    ).toContain('No compatible workspaces in Acme.');
  });

  it('shows main’s typed refusal and returns to the destination step', async () => {
    fork.mockResolvedValueOnce({
      ok: false,
      code: 'organization-creation-unavailable',
      message:
        "You can't create projects in Acme right now, so the copy wasn't made.",
    });
    render();
    await flush();

    click('shared-container-fork-continue');
    click('shared-container-fork-confirm');
    await flush();

    expect(query('shared-container-fork-error')?.textContent).toBe(
      "You can't create projects in Acme right now, so the copy wasn't made.",
    );
    expect(query('shared-container-fork-destination')).not.toBeNull();
    expect(openForkedContainer).not.toHaveBeenCalled();
    // The failure leaves the owner where it was.
    expect(
      query('shared-container-fork-destination-context')?.textContent,
    ).toBe('Belongs to Acme');
  });

  it('does not reach the fork call without passing through the disclosures', async () => {
    render();
    await flush();

    expect(query('shared-container-fork-disclosures')).toBeNull();
    expect(query('shared-container-fork-confirm')).toBeNull();
    expect(fork).not.toHaveBeenCalled();

    click('shared-container-fork-continue');

    expect(query('shared-container-fork-disclosures')).not.toBeNull();
  });

  it("blocks the owner's name in the disclosures, not the statements or buttons", async () => {
    render();
    await flush();
    click('shared-container-fork-continue');

    const disclosures = query('shared-container-fork-disclosures');
    expect(outermostReplayBlock(disclosures)).toBeNull();
    const items = Array.from(disclosures?.querySelectorAll('li') ?? []);
    expect(items[0]?.textContent).toBe(
      "Your copy is independent, and Dana can't take it back.",
    );
    for (const item of items) expect(outermostReplayBlock(item)).toBeNull();
    expect(
      Array.from(
        disclosures?.querySelectorAll(`.${POSTHOG_REPLAY_BLOCK_CLASS}`) ?? [],
        (block) => block.textContent,
      ),
    ).toEqual(['Dana', 'Dana']);
    expect(
      outermostReplayBlock(query('shared-container-fork-confirm')),
    ).toBeNull();
  });

  it('adds no capability item when the revision carries no package', async () => {
    render();
    await flush();
    click('shared-container-fork-continue');

    expect(query('shared-container-fork-capabilities')).toBeNull();
    expect(query('shared-container-fork-scripts')).toBeNull();
  });

  it('keeps the longer explanations behind Show details', async () => {
    render();
    await flush();
    click('shared-container-fork-continue');

    const toggle = query('shared-container-fork-details-toggle');
    expect(toggle?.textContent).toBe('Show details');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(query('shared-container-fork-details')).toBeNull();

    click('shared-container-fork-details-toggle');

    expect(toggle?.textContent).toBe('Hide details');
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    const details = query('shared-container-fork-details');
    expect(details?.id).toBe(toggle?.getAttribute('aria-controls'));
    expect(details?.textContent).toContain(
      "Changes don't sync between your copy and theirs.",
    );
    expect(details?.textContent).toContain('The key for this version stays');
    expect(details?.textContent).toContain(
      "You can read past chats but can't continue them.",
    );
  });

  it('discloses the pinned revision package, naming runnable scripts', async () => {
    render({
      revision: {
        ...REVISION_1,
        capabilityPackage: {
          digest: `pp:v1:${'b'.repeat(43)}`,
          counts: {
            skills: 1,
            pipelines: 0,
            agents: 1,
            automations: 1,
            hooks: 0,
          },
          executableFiles: ['skill-a/scripts/setup.sh'],
        },
      },
    });
    await flush();
    click('shared-container-fork-continue');

    const item = query('shared-container-fork-capabilities');
    expect(item?.tagName).toBe('LI');
    expect(item?.textContent).toBe(
      'Installs 1 skill, 1 Agent and 1 automation, plus 1 script that can run on this computer.',
    );
    expect(query('shared-container-fork-scripts')).toBeNull();

    click('shared-container-fork-details-toggle');

    const details = query('shared-container-fork-details');
    expect(details?.textContent).toContain(
      'New chats in the copy start with this skill turned on.',
    );
    expect(details?.textContent).toContain('The automation starts turned off.');
    expect(query('shared-container-fork-scripts')?.textContent).toBe(
      'Scripts that can run on this computer:skill-a/scripts/setup.sh',
    );
    expect(query('shared-container-fork-confirm')).not.toBeNull();
  });

  it('keeps the originally disclosed revision and package when publication changes while confirming', async () => {
    const capabilityPackage = {
      digest: `pp:v1:${'a'.repeat(43)}`,
      counts: { skills: 1, pipelines: 0, agents: 0, automations: 0, hooks: 0 },
      executableFiles: ['original/scripts/run.sh'],
    };
    render({ revision: { ...REVISION_1, capabilityPackage } });
    await flush();
    click('shared-container-fork-continue');
    render({
      revision: {
        ...REVISION_1,
        revisionId: 'revision-2',
        capabilityPackage: {
          ...capabilityPackage,
          digest: `pp:v1:${'b'.repeat(43)}`,
          executableFiles: ['new/scripts/undisclosed.sh'],
        },
      },
    });
    click('shared-container-fork-details-toggle');
    expect(query('shared-container-fork-scripts')?.textContent).toContain(
      'original/scripts/run.sh',
    );
    expect(query('shared-container-fork-scripts')?.textContent).not.toContain(
      'undisclosed.sh',
    );
    click('shared-container-fork-confirm');
    await flush();
    expect(fork).not.toHaveBeenCalled();
    click('shared-container-fork-revision-accept');
    expect(query('shared-container-fork-scripts')?.textContent).toContain(
      'new/scripts/undisclosed.sh',
    );
    expect(query('shared-container-fork-scripts')?.textContent).not.toContain(
      'original/scripts/run.sh',
    );
    getReplicaState.mockResolvedValue({
      ...replica('revision-2', REVISION_1.revisionCreatedAt),
      package: {
        ...capabilityPackage,
        digest: `pp:v1:${'b'.repeat(43)}`,
        executableFiles: ['new/scripts/undisclosed.sh'],
      },
    });
    click('shared-container-fork-confirm');
    await flush();
    // Consent now covers the explicitly adopted revision and its disclosed package.
    expect(fork).toHaveBeenCalledWith(
      expect.objectContaining({
        revisionId: 'revision-2',
        expectedPackageDigest: `pp:v1:${'b'.repeat(43)}`,
      }),
    );
  });

  it('omits the capability item for an empty package', async () => {
    render({
      revision: {
        ...REVISION_1,
        capabilityPackage: {
          digest: `pp:v1:${'b'.repeat(43)}`,
          counts: {
            skills: 0,
            pipelines: 0,
            agents: 0,
            automations: 0,
            hooks: 0,
          },
          executableFiles: [],
        },
      },
    });
    await flush();
    click('shared-container-fork-continue');

    expect(query('shared-container-fork-capabilities')).toBeNull();
  });

  it('records the generic owner fallback in the disclosures', async () => {
    render({ ownerName: undefined });
    await flush();
    click('shared-container-fork-continue');

    const disclosures = query('shared-container-fork-disclosures');
    expect(disclosures?.textContent).toContain(
      "Your copy is independent, and a teammate can't take it back.",
    );
    expect(
      disclosures?.querySelector(`.${POSTHOG_REPLAY_BLOCK_CLASS}`),
    ).toBeNull();
  });

  it('sends the chosen existing workspace and omits the clone directory', async () => {
    render();
    await flush();

    const radio = query('shared-container-fork-destination-existing');
    act(() => {
      radio?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const select = query(
      'shared-container-fork-workspace',
    ) as HTMLSelectElement;
    act(() => {
      select.value = 'workspace-1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(query('shared-container-fork-workspace-context')?.textContent).toBe(
      'Projects in Acme',
    );
    click('shared-container-fork-continue');
    expect(
      query('shared-container-fork-disclosures-destination')?.textContent,
    ).toBe('Your copy will be added to Storefront in Acme.');
    click('shared-container-fork-confirm');
    await flush();

    expect(fork).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: {
          kind: 'existing-workspace',
          workspaceId: 'workspace-1',
        },
      }),
    );
  });

  it('goes back to the destination step when the chosen workspace disappears', async () => {
    render();
    await flush();
    click('shared-container-fork-destination-existing');
    const select = query(
      'shared-container-fork-workspace',
    ) as HTMLSelectElement;
    act(() => {
      select.value = 'workspace-1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    click('shared-container-fork-continue');
    expect(query('shared-container-fork-disclosures')).not.toBeNull();

    // The workspace changed owner while the dialog was open.
    projects = projects.map((item) =>
      item.id === 'workspace-1' ? { ...item, owner: undefined } : item,
    );
    render();
    await flush();

    expect(query('shared-container-fork-disclosures')).toBeNull();
    expect(
      query('shared-container-fork-continue')?.hasAttribute('disabled'),
    ).toBe(true);
    expect(fork).not.toHaveBeenCalled();
  });

  it('offers only Cowork workspaces for a Cowork share and never a clone directory', async () => {
    render({ containerType: 'COWORK_WORK_ENTRY' });
    await flush();

    expect(query('shared-container-fork-location')).toBeNull();

    const radio = query('shared-container-fork-destination-existing');
    act(() => {
      radio?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const select = query('shared-container-fork-workspace');
    expect(
      Array.from(select?.querySelectorAll('option') ?? []).map((option) =>
        option.getAttribute('value'),
      ),
    ).toEqual(['', 'cowork-1']);
  });

  it('starts existing destinations on an explicit placeholder', async () => {
    render();
    await flush();

    click('shared-container-fork-destination-existing');

    expect(
      (query('shared-container-fork-workspace') as HTMLSelectElement).value,
    ).toBe('');
    expect(
      query('shared-container-fork-continue')?.hasAttribute('disabled'),
    ).toBe(true);
  });

  it('filters organization forks to workspaces the organization owns', async () => {
    projects = [
      ...projects,
      { id: 'linked', name: 'Linked checkout', type: 'single-repo' },
      { id: 'personal', name: 'Personal', type: 'single-repo' },
      {
        id: 'other-org',
        name: 'Other org',
        type: 'single-repo',
        owner: {
          type: 'organization',
          organizationId: 'org-2',
          projectId: 'project-3',
          instanceId: 'instance-3',
          bindingGeneration: 1,
        },
      },
    ];
    useLinkedPersonalWorkspacesStore.setState({ ids: ['linked'] });
    render();
    await flush();
    click('shared-container-fork-destination-existing');

    expect(
      Array.from(
        query('shared-container-fork-workspace')?.querySelectorAll('option') ??
          [],
      ).map((option) => option.getAttribute('value')),
      // Main rejects a linked Personal checkout as an organization destination.
    ).toEqual(['', 'workspace-1']);
  });

  it('filters direct forks to Personal workspaces', async () => {
    projects = [
      ...projects,
      { id: 'personal', name: 'Personal', type: 'single-repo' },
    ];
    render({ access: 'direct', organizationId: undefined });
    await flush();
    click('shared-container-fork-destination-existing');

    expect(
      Array.from(
        query('shared-container-fork-workspace')?.querySelectorAll('option') ??
          [],
      ).map((option) => option.getAttribute('value')),
    ).toEqual(['', 'personal']);
  });

  it('returns to the destination step and shows main’s own refusal message', async () => {
    fork.mockRejectedValueOnce(
      new Error('Fork destination does not contain the shared repository'),
    );
    render();
    await flush();

    click('shared-container-fork-continue');
    click('shared-container-fork-confirm');
    await flush();

    expect(query('shared-container-fork-error')?.textContent).toBe(
      'Fork destination does not contain the shared repository',
    );
    expect(query('shared-container-fork-destination')).not.toBeNull();
    expect(query('shared-container-fork-disclosures')).toBeNull();
  });

  it('unwraps the Electron IPC envelope around main’s refusal message', async () => {
    // What main throws is not what the renderer catches: Electron rewraps a
    // rejected `ipcRenderer.invoke` as
    // `Error invoking remote method '<channel>': Error: <message>`. Rendering
    // that verbatim buries the one sentence the user can act on behind a
    // channel name.
    fork.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'shared-containers:fork': Error: " +
          'Fork destination does not contain the shared repository',
      ),
    );
    render();
    await flush();

    click('shared-container-fork-continue');
    click('shared-container-fork-confirm');
    await flush();

    expect(query('shared-container-fork-error')?.textContent).toBe(
      'Fork destination does not contain the shared repository',
    );
  });

  type AddToastArgs = Parameters<
    ReturnType<typeof useGitHubStore.getState>['addToast']
  >;
  type AddToastMock = jest.Mock<void, AddToastArgs>;

  /** Run the fork through to its toast with `addToast` captured. */
  async function makeCopy(): Promise<AddToastMock> {
    const addToast = jest.fn<void, AddToastArgs>();
    useGitHubStore.setState({ addToast });
    render();
    await flush();
    click('shared-container-fork-continue');
    click('shared-container-fork-confirm');
    await flush();
    return addToast;
  }

  /** The message, type, and Open copy toast fields of one `addToast` call. */
  function toastCall(
    addToast: AddToastMock,
    index = 0,
  ): {
    message: string | undefined;
    type: string | undefined;
    actionLabel: string | undefined;
    forceInApp: boolean | undefined;
    suppressOsNotification: boolean | undefined;
  } {
    const call = addToast.mock.calls[index];
    const meta = call?.[3];
    return {
      message: call?.[0],
      type: call?.[1],
      actionLabel: meta?.action?.label,
      forceInApp: meta?.forceInApp,
      suppressOsNotification: meta?.suppressOsNotification,
    };
  }

  function toastAction(addToast: AddToastMock, index = 0): () => void {
    const action = addToast.mock.calls[index]?.[3]?.action;
    if (action === undefined) throw new Error('toast has no action');
    return (): void => {
      void action.onClick();
    };
  }

  describe('completion', () => {
    let originalAddToast: ReturnType<
      typeof useGitHubStore.getState
    >['addToast'];
    let originalContextState: ReturnType<
      typeof useWorkspaceContextStore.getState
    >['state'];

    beforeEach(() => {
      originalAddToast = useGitHubStore.getState().addToast;
      originalContextState = useWorkspaceContextStore.getState().state;
      useWorkspaceContextStore.setState({
        state: {
          ...originalContextState,
          organizations: [{ id: 'org-1', name: 'Acme', role: 'MEMBER' }],
        },
      });
    });

    afterEach(() => {
      useGitHubStore.setState({ addToast: originalAddToast });
      useWorkspaceContextStore.setState({ state: originalContextState });
    });

    it('keeps destination metadata on success and retry toasts', async () => {
      const addToast = await makeCopy();
      expect(addToast.mock.calls[0]?.[3]).toMatchObject({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
      });
      openForkedContainer.mockRejectedValueOnce(new Error('gone'));
      await act(async () => {
        toastAction(addToast)();
        await Promise.resolve();
      });
      expect(addToast.mock.calls[1]?.[3]).toMatchObject({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
      });
    });

    it('opens the copy as soon as it is made and closes, with no Cancel or done screen', async () => {
      render();
      await flush();
      expect(
        Array.from(document.querySelectorAll('button')).some(
          (button) => button.textContent === 'Cancel',
        ),
      ).toBe(false);
      act(() => root.unmount());
      root = createRoot(container);

      const addToast = await makeCopy();

      expect(openForkedContainer).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'workspace-1' }),
      );
      expect(query('shared-container-fork-success')).toBeNull();
      expect(toastCall(addToast)).toEqual({
        message: 'Copy made.',
        type: 'success',
        actionLabel: 'Open copy',
        forceInApp: true,
        suppressOsNotification: true,
      });
      expect(onClose).toHaveBeenCalled();
    });

    it.each([
      [{ kind: 'personal' } as const, 'Copy made in Personal.'],
      [
        { kind: 'organization', organizationId: 'org-1' } as const,
        'Copy made in Acme.',
      ],
      [
        { kind: 'organization', organizationId: 'org-9' } as const,
        'Copy made in your organization.',
      ],
    ])('names the context it switched to: %j', async (switchedTo, message) => {
      openForkedContainer.mockResolvedValueOnce({ switchedTo });

      const addToast = await makeCopy();

      expect(toastCall(addToast)).toMatchObject({
        message,
        type: 'success',
        actionLabel: 'Open copy',
      });
    });

    it('says when the copy could not bring everything across', async () => {
      fork.mockResolvedValueOnce(
        response({ warnings: ['Skipped an unreadable attachment'] }),
      );

      const addToast = await makeCopy();

      const toast = toastCall(addToast);
      expect(toast.message).toMatch(
        /^Copy made\. .+ could not bring everything across\.$/,
      );
      expect(toast).toMatchObject({
        type: 'warning',
        actionLabel: 'Open copy',
      });
      expect(onClose).toHaveBeenCalled();
    });

    it('keeps the partial-copy note when the context changed', async () => {
      fork.mockResolvedValueOnce(
        response({ warnings: ['Skipped an unreadable attachment'] }),
      );
      openForkedContainer.mockResolvedValueOnce({
        switchedTo: { kind: 'personal' },
      });

      const addToast = await makeCopy();

      const toast = toastCall(addToast);
      expect(toast.message).toMatch(
        /^Copy made in Personal\. .+ could not bring everything across\.$/,
      );
      expect(toast.type).toBe('warning');
    });

    it('reopens the same copy from the toast after the dialog is gone, with no second toast', async () => {
      const addToast = await makeCopy();
      const openCopy = toastAction(addToast);
      act(() => root.unmount());
      root = createRoot(container);

      await act(async () => {
        openCopy();
        await Promise.resolve();
      });

      expect(fork).toHaveBeenCalledTimes(1);
      expect(openForkedContainer).toHaveBeenCalledTimes(2);
      expect(openForkedContainer).toHaveBeenLastCalledWith(
        expect.objectContaining({
          projectId: 'workspace-1',
          worktreeId: 'worktree-1',
        }),
      );
      expect(addToast).toHaveBeenCalledTimes(1);
    });

    it('reports a failed reopen from the toast instead of leaving a rejection', async () => {
      const addToast = await makeCopy();
      openForkedContainer.mockRejectedValueOnce(new Error('gone'));

      await act(async () => {
        toastAction(addToast)();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(addToast).toHaveBeenCalledTimes(2);
      expect(toastCall(addToast, 1)).toMatchObject({
        message: "The copy couldn't be opened.",
        type: 'error',
        actionLabel: 'Open copy',
      });
      expect(fork).toHaveBeenCalledTimes(1);
    });

    it('tells the user when opening the copy fails, offers a retry, and still closes', async () => {
      openForkedContainer.mockRejectedValueOnce(
        new Error('Chat project not found'),
      );

      const addToast = await makeCopy();

      expect(toastCall(addToast)).toEqual({
        message: "Copy made, but it couldn't be opened.",
        type: 'error',
        actionLabel: 'Open copy',
        forceInApp: true,
        suppressOsNotification: true,
      });
      // The fork succeeded and the copy exists on disk, so pinning the dialog
      // open would misrepresent the outcome; the toast's retry is the recovery.
      expect(onClose).toHaveBeenCalled();

      await act(async () => {
        toastAction(addToast)();
        await Promise.resolve();
      });
      expect(fork).toHaveBeenCalledTimes(1);
      expect(openForkedContainer).toHaveBeenCalledTimes(2);
      expect(addToast).toHaveBeenCalledTimes(1);
    });

    it('keeps the partial-copy note when opening fails', async () => {
      fork.mockResolvedValueOnce(
        response({ warnings: ['Skipped an unreadable attachment'] }),
      );
      openForkedContainer.mockRejectedValueOnce(new Error('gone'));

      const addToast = await makeCopy();

      const toast = toastCall(addToast);
      expect(toast.message).toMatch(
        /^Copy made, but it couldn't be opened\. .+ could not bring everything across\.$/,
      );
      expect(toast.type).toBe('error');
    });
  });

  describe('reviewed revision (CAN-4908)', () => {
    const REVISION_2 = {
      status: 'available' as const,
      revisionId: 'revision-2',
      revisionCreatedAt: '2026-09-09T15:30:00.000Z',
    };
    const REVISION_3 = {
      status: 'available' as const,
      revisionId: 'revision-3',
      revisionCreatedAt: '2026-09-10T09:15:00.000Z',
    };

    function versionLine(): HTMLElement | null {
      return query('shared-container-fork-revision');
    }

    function confirmButton(): HTMLButtonElement {
      const button = query('shared-container-fork-confirm');
      if (!(button instanceof HTMLButtonElement))
        throw new Error('missing confirm');
      return button;
    }

    async function openConfirmation(
      overrides: Record<string, unknown> = {},
    ): Promise<void> {
      render(overrides);
      await flush();
      click('shared-container-fork-continue');
    }

    it('names the reviewed version and its publication time above the disclosures', async () => {
      await openConfirmation();

      const line = versionLine();
      expect(line?.textContent).toMatch(
        /^Copies Dana’s latest available version \(updated .+\)\.$/,
      );
      expect(line?.dataset.revisionId).toBe('revision-1');
      const time = line?.querySelector('time');
      expect(time?.getAttribute('dateTime')).toBe(REVISION_1.revisionCreatedAt);
      expect(time?.getAttribute('title')).toBeTruthy();
      expect(
        line?.querySelector(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)?.textContent,
      ).toBe('Dana');
      expect(
        query('shared-container-fork-disclosures')?.firstElementChild,
      ).toBe(line);
    });

    it('says the update time is unavailable instead of rendering an invalid date', async () => {
      await openConfirmation({
        revision: { ...REVISION_1, revisionCreatedAt: 'not a time' },
      });

      expect(versionLine()?.textContent).toBe(
        'Copies Dana’s latest available version (update time unavailable).',
      );
      expect(versionLine()?.textContent).not.toContain('Invalid');
    });

    it('waits for a row menu to resolve the revision before allowing a copy', async () => {
      await openConfirmation({ revision: { status: 'loading' } });

      expect(versionLine()?.textContent).toBe(
        'Checking which version this copies…',
      );
      expect(confirmButton().disabled).toBe(true);

      render({ revision: REVISION_2 });
      await flush();

      expect(versionLine()?.dataset.revisionId).toBe('revision-2');
      expect(query('shared-container-fork-revision-update')).toBeNull();
      expect(confirmButton().disabled).toBe(false);
    });

    it('discloses a newer version on the confirmation and blocks the copy until it is accepted', async () => {
      await openConfirmation();
      render({ revision: REVISION_2 });
      await flush();

      const notice = query('shared-container-fork-revision-update');
      expect(notice?.textContent).toMatch(
        /^Dana published a newer version at .+ while this was open\. Review it before making your copy\.Use updated version$/,
      );
      expect(notice?.closest('[role="status"]')).not.toBeNull();
      expect(
        notice?.querySelector(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)?.textContent,
      ).toBe('Dana');
      expect(versionLine()?.dataset.revisionId).toBe('revision-1');
      expect(confirmButton().disabled).toBe(true);

      getReplicaState.mockResolvedValue(
        replica('revision-2', REVISION_2.revisionCreatedAt),
      );
      click('shared-container-fork-revision-accept');

      expect(query('shared-container-fork-revision-update')).toBeNull();
      expect(versionLine()?.dataset.revisionId).toBe('revision-2');
      expect(
        versionLine()?.querySelector('time')?.getAttribute('dateTime'),
      ).toBe(REVISION_2.revisionCreatedAt);
      expect(confirmButton().disabled).toBe(false);

      click('shared-container-fork-confirm');
      await flush();
      expect(fork).toHaveBeenCalledTimes(1);
      expect(fork).toHaveBeenCalledWith(
        expect.objectContaining({ revisionId: 'revision-2' }),
      );
    });

    it('discloses an update on the destination step and returns to confirmation with the choices kept', async () => {
      render();
      await flush();
      const radio = query('shared-container-fork-destination-existing');
      act(() => {
        radio?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      const select = query('shared-container-fork-workspace');
      if (!(select instanceof HTMLSelectElement))
        throw new Error('missing select');
      act(() => {
        select.value = 'workspace-1';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });

      render({ revision: REVISION_2 });
      await flush();
      expect(query('shared-container-fork-destination')).not.toBeNull();
      expect(query('shared-container-fork-revision-update')).not.toBeNull();

      click('shared-container-fork-revision-accept');

      expect(query('shared-container-fork-disclosures')).not.toBeNull();
      expect(versionLine()?.dataset.revisionId).toBe('revision-2');
      expect(
        query('shared-container-fork-disclosures-destination')?.textContent,
      ).toContain('Storefront');
    });

    it('asks for review again after each further update', async () => {
      await openConfirmation();
      render({ revision: REVISION_2 });
      render({ revision: REVISION_3 });
      await flush();

      expect(
        query('shared-container-fork-revision-update')
          ?.querySelector('time')
          ?.getAttribute('dateTime'),
      ).toBe(REVISION_3.revisionCreatedAt);
      click('shared-container-fork-revision-accept');
      expect(versionLine()?.dataset.revisionId).toBe('revision-3');

      render({
        revision: {
          status: 'available',
          revisionId: 'revision-4',
          revisionCreatedAt: '2026-09-11T09:15:00.000Z',
        },
      });
      await flush();
      expect(query('shared-container-fork-revision-update')).not.toBeNull();
      expect(confirmButton().disabled).toBe(true);
    });

    it('treats a new time for the same revision as a refresh, not an update', async () => {
      await openConfirmation();
      render({
        revision: {
          ...REVISION_1,
          revisionCreatedAt: REVISION_2.revisionCreatedAt,
        },
      });
      await flush();

      expect(query('shared-container-fork-revision-update')).toBeNull();
      expect(versionLine()?.dataset.revisionId).toBe('revision-1');
      expect(confirmButton().disabled).toBe(false);

      render({ revision: REVISION_3 });
      await flush();
      expect(versionLine()?.dataset.revisionId).toBe('revision-1');
      expect(
        versionLine()?.querySelector('time')?.getAttribute('dateTime'),
      ).toBe(REVISION_2.revisionCreatedAt);
    });

    it('blocks the copy while the share is unreadable without calling it an update', async () => {
      await openConfirmation();
      render({ revision: { status: 'unavailable' } });
      await flush();

      expect(
        query('shared-container-fork-revision-unavailable')?.textContent,
      ).toBe(
        "This share can't be copied right now. Open it again, then make your copy.",
      );
      expect(query('shared-container-fork-revision-update')).toBeNull();
      expect(confirmButton().disabled).toBe(true);
    });

    it('re-reads main before submitting and shows an update it missed instead of copying', async () => {
      getReplicaState.mockResolvedValue(
        replica('revision-2', REVISION_2.revisionCreatedAt),
      );
      await openConfirmation();

      click('shared-container-fork-confirm');
      await flush();

      expect(getReplicaState).toHaveBeenCalledWith({
        containerId: 'container-1',
      });
      expect(fork).not.toHaveBeenCalled();
      expect(query('shared-container-fork-revision-update')).not.toBeNull();
      expect(confirmButton().disabled).toBe(true);
    });

    it('ignores an older pre-submit read after a newer host update', async () => {
      let finish: (value: unknown) => void = () => {};
      getReplicaState.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      await openConfirmation();
      click('shared-container-fork-confirm');
      render({ revision: REVISION_2 });
      await act(async () => {
        finish(replica('revision-1', REVISION_1.revisionCreatedAt));
        await Promise.resolve();
      });
      await flush();
      expect(fork).not.toHaveBeenCalled();
      expect(query('shared-container-fork-revision-update')).not.toBeNull();
      expect(confirmButton().disabled).toBe(true);
    });

    it('does not submit a delayed pre-submit read after the dialog closes', async () => {
      let finish: (value: unknown) => void = () => {};
      getReplicaState.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      await openConfirmation();
      click('shared-container-fork-confirm');
      act(() => root.render(null));
      await act(async () => {
        finish(replica('revision-1', REVISION_1.revisionCreatedAt));
        await Promise.resolve();
      });
      await flush();
      expect(fork).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('starts a fresh review when switching containers during a pending refresh', async () => {
      let finish: (value: unknown) => void = () => {};
      getReplicaState.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      await openConfirmation();
      click('shared-container-fork-confirm');
      render({ containerId: 'container-2', revision: REVISION_2 });
      await flush();
      expect(query('shared-container-fork-destination')).not.toBeNull();
      await act(async () => {
        finish(replica('revision-1', REVISION_1.revisionCreatedAt));
        await Promise.resolve();
      });
      await flush();
      expect(fork).not.toHaveBeenCalled();
      click('shared-container-fork-continue');
      expect(versionLine()?.dataset.revisionId).toBe('revision-2');
      expect(confirmButton().disabled).toBe(false);
    });

    it('blocks submission while an existing selection is being refreshed', async () => {
      await openConfirmation();
      render({ revision: { status: 'loading' } });
      await flush();
      expect(confirmButton().disabled).toBe(true);
    });

    it('keeps the submitted revision fixed while an update lands mid-copy', async () => {
      let finish: (value: unknown) => void = () => {};
      fork.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      await openConfirmation();

      click('shared-container-fork-confirm');
      await flush();
      expect(confirmButton().textContent).toBe('Copying…');

      render({ revision: REVISION_2 });
      await flush();
      expect(confirmButton().disabled).toBe(true);
      click('shared-container-fork-confirm');
      await flush();

      expect(fork).toHaveBeenCalledTimes(1);
      expect(fork).toHaveBeenCalledWith(
        expect.objectContaining({ revisionId: 'revision-1' }),
      );
      await act(async () => {
        finish(response());
        await Promise.resolve();
      });
      await flush();
      expect(fork).toHaveBeenCalledTimes(1);
    });

    it('stays on the confirmation after a superseded refusal and offers the newer version for review', async () => {
      fork.mockResolvedValueOnce({
        ok: false,
        code: 'source-unavailable',
        message:
          'Dana published a newer version of this share. Open it again, then make your copy.',
      });
      getReplicaState
        .mockResolvedValueOnce(
          replica('revision-1', REVISION_1.revisionCreatedAt),
        )
        .mockResolvedValue(replica('revision-2', REVISION_2.revisionCreatedAt));
      await openConfirmation();

      click('shared-container-fork-confirm');
      await flush();

      const error = query('shared-container-fork-error');
      expect(error?.textContent).toBe(
        'Dana published a newer version of this share. Open it again, then make your copy.',
      );
      expect(error?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(true);
      expect(query('shared-container-fork-disclosures')).not.toBeNull();
      expect(query('shared-container-fork-revision-update')).not.toBeNull();
      expect(fork).toHaveBeenCalledTimes(1);
    });
  });

  it("holds the copy's focus request while the dialog is open", () => {
    render();
    expect(useNavigationStore.getState().forkedContainerFocusHolds).toBe(1);

    act(() => root.unmount());
    root = createRoot(container);

    expect(useNavigationStore.getState().forkedContainerFocusHolds).toBe(0);
  });
});
