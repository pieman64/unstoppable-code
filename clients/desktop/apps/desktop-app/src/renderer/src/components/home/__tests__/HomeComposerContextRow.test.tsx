/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { HomeComposerContextRow } from '../HomeComposerContextRow';
import { HomeLinkTargetChip } from '../HomeLinkTargetChip';
import { useHomeComposerStore } from '@/stores/homeComposerStore';
import { switchContextForWorkspace } from '@/lib/contextScope';
import { resolveHomeLink, type HomeLinkAction } from '../homeLinkTarget';
import type * as HomeLinkTargetModule from '../homeLinkTarget';
import type * as ExperimentalFeaturesModule from '@/stores/labsExperimentsStore';

let mockEarlyAccess = false;
jest.mock('@/stores/labsExperimentsStore', () => ({
  ...jest.requireActual<typeof ExperimentalFeaturesModule>(
    '@/stores/labsExperimentsStore',
  ),
  useLabsExperimentEnabled: (): boolean => mockEarlyAccess,
}));

jest.mock('../homeSend', () => ({ cancelHomeLinkSubmission: jest.fn() }));
jest.mock('../homeLinkTargetHost', () => ({
  currentHomeLinkResolveContext: (): {
    projects: { id: string; type: string; name: string }[];
    otherScopeProjects: never[];
  } => ({
    projects: [{ id: 'project-b', type: 'single-repo', name: 'B' }],
    otherScopeProjects: [],
  }),
  createHomeLinkResolveDeps: (): Record<string, never> => ({}),
}));
jest.mock('../homeLinkTargetSync', () => ({
  currentHomeLinkFingerprint: (): string => 'current',
  syncHomeLinkTarget: jest.fn(),
}));
jest.mock('@/lib/contextScope', () => ({
  switchContextForWorkspace: jest.fn(() => Promise.resolve(true)),
}));
jest.mock('../homeLinkTarget', () => ({
  ...jest.requireActual<typeof HomeLinkTargetModule>('../homeLinkTarget'),
  resolveHomeLink: jest.fn(() =>
    Promise.resolve({
      status: 'ready',
      plan: {
        kind: 'existing-project',
        workspaceId: 'project-b',
        workspaceName: 'B',
        branchTarget: { kind: 'new-worktree' },
      },
    }),
  ),
}));

describe('HomeComposerContextRow', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
    mockEarlyAccess = false;
    useHomeComposerStore.getState().reset();
    useHomeComposerStore.setState({
      loadBranchTargets: jest.fn(() => Promise.resolve()),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('contributes no layout element when no context picker is visible', () => {
    act(() =>
      root.render(
        createElement(HomeComposerContextRow, {
          visible: false,
          children: createElement('button', null, 'Workspace'),
        }),
      ),
    );

    expect(container.firstElementChild).toBeNull();
  });

  function renderPickers(): HTMLElement {
    act(() =>
      root.render(
        createElement(HomeComposerContextRow, {
          visible: true,
          children: [
            createElement('div', {
              'data-testid': 'home-workspace-picker',
            }),
            createElement('div', { 'data-testid': 'home-branch-picker' }),
            createElement('div', {
              'data-testid': 'home-base-branch-picker',
            }),
          ],
        }),
      ),
    );
    const row = container.querySelector<HTMLElement>(
      '[data-testid="home-composer-context"]',
    );
    if (!row) throw new Error('context row not rendered');
    return row;
  }

  it('keeps pickers on one line without a Labs opt-in', () => {
    const classes = renderPickers().className.split(/\s+/);

    expect(classes).toContain('flex-nowrap');
    expect(classes.some((name) => name.includes('shrink'))).toBe(true);
  });

  it('keeps its pickers on one line under early access, shrinking only the project', () => {
    mockEarlyAccess = true;
    const classes = renderPickers().className.split(/\s+/);

    expect(classes).not.toContain('flex-wrap');
    expect(classes).toEqual(
      expect.arrayContaining([
        'flex-nowrap',
        '*:shrink-0',
        "[&>[data-testid='home-workspace-picker']]:min-w-0",
        "[&>[data-testid='home-workspace-picker']]:shrink",
        "[&_[data-testid='home-workspace-select']]:max-w-full",
      ]),
    );
    // The cap is on the picker, not only its trigger: a percentage cap on the
    // trigger does not limit the picker's own width, which then keeps the
    // full name's width and leaves a gap after the truncated label.
    expect(classes).toContain(
      "[&>[data-testid='home-workspace-picker']]:max-w-52",
    );
    expect(classes.some((name) => name.includes('max-w-[min('))).toBe(false);
  });

  it('binds an attachment action to the issue displayed by that chip', () => {
    useHomeComposerStore.setState({
      text: 'CAN-1',
      linkTarget: {
        status: 'blocked',
        key: 'linear:CAN-1',
        fingerprint: 'current',
        message: 'Choose attachment',
        actions: [
          {
            kind: 'choose-attachment',
            key: 'github.com/acme/b/pull/7',
            label: 'PR 7',
          },
        ],
      },
    });
    act(() =>
      root.render(
        createElement(HomeLinkTargetChip, { onChooseProject: jest.fn() }),
      ),
    );
    const button = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === 'PR 7',
    );
    act(() => button?.click());
    expect(
      useHomeComposerStore.getState().chosenLinkAttachmentReferenceKey,
    ).toBe('linear:CAN-1');
  });

  it('removes cancellation during an irreversible schedule mutation', () => {
    useHomeComposerStore.setState({
      linkTarget: {
        status: 'submitting',
        key: 'github.com/acme/b',
        fingerprint: 'current',
        progress: 'Scheduling task…',
        canCancel: false,
        plan: {
          kind: 'existing-project',
          workspaceId: 'project-b',
          workspaceName: 'B',
          branchTarget: { kind: 'new-worktree' },
        },
      },
    });
    act(() =>
      root.render(
        createElement(HomeLinkTargetChip, { onChooseProject: jest.fn() }),
      ),
    );
    expect(container.textContent).toContain('Scheduling task');
    expect(
      Array.from(container.querySelectorAll('button')).some(
        (button) => button.textContent === 'Cancel creation',
      ),
    ).toBe(false);
  });

  it.each(['use-project', 'switch-context'] as const)(
    'keeps file mentions in their source project when accepting %s',
    async (kind) => {
      const action: HomeLinkAction = {
        kind,
        workspaceId: 'project-b',
        label: 'Use B',
      };
      useHomeComposerStore.setState({
        workspaceId: 'project-a',
        text: 'Check @src/config.ts https://github.com/acme/b',
        fileReferences: [
          {
            kind: 'file',
            displayPath: 'src/config.ts',
            absolutePath: '/project-a/src/config.ts',
          },
        ],
        linkTarget: {
          status: 'blocked',
          key: 'github.com/acme/b',
          fingerprint: 'current',
          message: 'Choose a project',
          actions: [action],
        },
      });
      const draft = useHomeComposerStore.getState();
      act(() =>
        root.render(
          createElement(HomeLinkTargetChip, { onChooseProject: jest.fn() }),
        ),
      );
      const button = Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent === 'Use B',
      );
      expect(button).toBeDefined();
      await act(async () => {
        button?.click();
        await Promise.resolve();
      });
      expect(useHomeComposerStore.getState().workspaceId).toBe('project-a');
      expect(useHomeComposerStore.getState().fileReferences).toBe(
        draft.fileReferences,
      );
      expect(switchContextForWorkspace).not.toHaveBeenCalled();
      expect(useHomeComposerStore.getState().sendError).toMatch(
        /Remove.*file mentions/,
      );
    },
  );

  it.each(['use-project', 'switch-context'] as const)(
    'keeps saved prompt mentions in their source project when accepting %s',
    async (kind) => {
      const action: HomeLinkAction = {
        kind,
        workspaceId: 'project-b',
        label: 'Use B',
      };
      useHomeComposerStore.setState({
        workspaceId: 'project-a',
        text: 'Check @src/config.ts https://github.com/acme/b',
        fileReferences: [
          {
            kind: 'prompt',
            displayPath: 'src/config.ts',
            absolutePath: '/project-a/src/config.ts',
          },
        ],
        linkTarget: {
          status: 'blocked',
          key: 'github.com/acme/b',
          fingerprint: 'current',
          message: 'Choose a project',
          actions: [action],
        },
      });
      const draft = useHomeComposerStore.getState();
      act(() =>
        root.render(
          createElement(HomeLinkTargetChip, { onChooseProject: jest.fn() }),
        ),
      );
      const button = Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent === 'Use B',
      );
      expect(button).toBeDefined();
      await act(async () => {
        button?.click();
        await Promise.resolve();
      });
      expect(useHomeComposerStore.getState().workspaceId).toBe('project-a');
      expect(useHomeComposerStore.getState().fileReferences).toBe(
        draft.fileReferences,
      );
      expect(switchContextForWorkspace).not.toHaveBeenCalled();
      expect(useHomeComposerStore.getState().sendError).toMatch(
        /saved prompt mentions/,
      );
    },
  );

  it.each(['edit', 'mention', 'dismiss', 'branch'] as const)(
    'ignores a pending context switch after a newer %s change',
    async (change) => {
      let finishSwitch: (ok: boolean) => void = (): void => undefined;
      jest.mocked(switchContextForWorkspace).mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            finishSwitch = resolve;
          }),
      );
      useHomeComposerStore.setState({
        workspaceId: 'project-a',
        text: 'https://github.com/acme/b',
        linkTarget: {
          status: 'blocked',
          key: 'github.com/acme/b',
          fingerprint: 'current',
          message: 'Choose a project',
          actions: [
            {
              kind: 'switch-context',
              workspaceId: 'project-b',
              label: 'Switch to B',
            },
          ],
        },
      });
      act(() =>
        root.render(
          createElement(HomeLinkTargetChip, { onChooseProject: jest.fn() }),
        ),
      );
      const button = Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent === 'Switch to B',
      );
      await act(async () => {
        button?.click();
        await Promise.resolve();
      });
      expect(useHomeComposerStore.getState().linkContextSwitchPending).toBe(
        true,
      );
      act(() => {
        const store = useHomeComposerStore.getState();
        if (change === 'edit') store.setText('a newer draft');
        if (change === 'mention')
          store.setFileReferences([
            {
              kind: 'file',
              displayPath: 'src/config.ts',
              absolutePath: '/project-a/src/config.ts',
            },
          ]);
        if (change === 'dismiss')
          store.dismissLinkReferences(['github.com/acme/b']);
        if (change === 'branch')
          store.setBranchTarget({
            kind: 'branch',
            branchName: 'newer-branch',
            isRemote: false,
          });
      });
      await act(async () => {
        finishSwitch(true);
        await Promise.resolve();
      });
      expect(useHomeComposerStore.getState().linkContextSwitchPending).toBe(
        false,
      );
      expect(useHomeComposerStore.getState().workspaceId).toBe('project-a');
      if (change === 'branch')
        expect(useHomeComposerStore.getState().branchTarget).toEqual({
          kind: 'branch',
          branchName: 'newer-branch',
          isRemote: false,
        });
    },
  );

  it('accepts a validated project switch without project-relative file mentions', async () => {
    useHomeComposerStore.setState({
      workspaceId: 'project-a',
      text: 'https://github.com/acme/b',
      linkTarget: {
        status: 'blocked',
        key: 'github.com/acme/b',
        fingerprint: 'current',
        message: 'Choose a project',
        actions: [
          { kind: 'use-project', workspaceId: 'project-b', label: 'Use B' },
        ],
      },
    });
    act(() =>
      root.render(
        createElement(HomeLinkTargetChip, { onChooseProject: jest.fn() }),
      ),
    );
    const button = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === 'Use B',
    );
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    expect(resolveHomeLink).toHaveBeenCalledTimes(1);
    expect(useHomeComposerStore.getState().workspaceId).toBe('project-b');
  });
});
