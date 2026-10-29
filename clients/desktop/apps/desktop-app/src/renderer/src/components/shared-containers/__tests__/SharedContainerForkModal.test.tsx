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
 * - The disclosures gate. The three statements are the whole reason the dialog
 *   is two steps; forking without passing through them is the regression that
 *   matters.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const openForkedContainer = jest.fn(() => Promise.resolve());
jest.mock('@/lib/shared-containers/open-forked-container', () => ({
  openForkedContainer: (...args: unknown[]): Promise<void> =>
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
let onClose: jest.Mock;

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
        revisionId="revision-1"
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
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
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
  fork = jest.fn(() => Promise.resolve(response()));
  readForkProvenance = jest.fn(() => Promise.resolve(null));
  onClose = jest.fn();
  openForkedContainer.mockClear();
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
      sharedContainers: { fork, readForkProvenance },
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
        parentDirectory: '/home/me/repos',
      },
    });
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
    expect(items[0]?.textContent).toContain('changes Dana makes later');
    expect(items[1]?.textContent).toContain('Dana cannot take the copy back');
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

  it('records the generic owner fallback in the disclosures', async () => {
    render({ ownerName: undefined });
    await flush();
    click('shared-container-fork-continue');

    const disclosures = query('shared-container-fork-disclosures');
    expect(disclosures?.textContent).toContain(
      'changes a teammate makes later',
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

    click('shared-container-fork-continue');
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

  it('filters organization forks to owned and linked Personal workspaces', async () => {
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
    ).toEqual(['', 'workspace-1', 'linked']);
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

  it('opens the copy as soon as it is made and closes, with no Cancel or done screen', async () => {
    const addToast = jest.fn();
    const originalAddToast = useGitHubStore.getState().addToast;
    useGitHubStore.setState({ addToast });
    try {
      render();
      await flush();

      expect(
        Array.from(document.querySelectorAll('button')).some(
          (button) => button.textContent === 'Cancel',
        ),
      ).toBe(false);
      click('shared-container-fork-continue');
      expect(openForkedContainer).not.toHaveBeenCalled();
      click('shared-container-fork-confirm');
      await flush();

      expect(openForkedContainer).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'workspace-1' }),
      );
      expect(query('shared-container-fork-success')).toBeNull();
      expect(addToast).toHaveBeenCalledWith('Copy made.', 'success');
      expect(onClose).toHaveBeenCalled();
    } finally {
      useGitHubStore.setState({ addToast: originalAddToast });
    }
  });

  it('says when the copy could not bring everything across', async () => {
    const addToast = jest.fn();
    const originalAddToast = useGitHubStore.getState().addToast;
    useGitHubStore.setState({ addToast });
    fork.mockResolvedValueOnce(
      response({ warnings: ['Skipped an unreadable attachment'] }),
    );
    try {
      render();
      await flush();

      click('shared-container-fork-continue');
      click('shared-container-fork-confirm');
      await flush();

      expect(addToast).toHaveBeenCalledWith(
        expect.stringMatching(
          /^Copy made\. .+ could not bring everything across\.$/,
        ),
        'warning',
      );
      expect(onClose).toHaveBeenCalled();
    } finally {
      useGitHubStore.setState({ addToast: originalAddToast });
    }
  });

  it('tells the user when opening the copy fails, and still closes', async () => {
    const addToast = jest.fn();
    const originalAddToast = useGitHubStore.getState().addToast;
    useGitHubStore.setState({ addToast });
    openForkedContainer.mockRejectedValueOnce(
      new Error('Chat project not found'),
    );

    try {
      render();
      await flush();

      click('shared-container-fork-continue');
      click('shared-container-fork-confirm');
      await flush();

      expect(addToast).toHaveBeenCalledWith(
        "Copy made, but it couldn't be opened. Open it from the sidebar.",
        'error',
      );
      // The fork succeeded and the copy exists on disk, so pinning the dialog
      // open would misrepresent the outcome; the sidebar row is the recovery.
      expect(onClose).toHaveBeenCalled();
    } finally {
      useGitHubStore.setState({ addToast: originalAddToast });
    }
  });
});
