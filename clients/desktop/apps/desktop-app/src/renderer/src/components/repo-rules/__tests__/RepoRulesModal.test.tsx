/**
 * @jest-environment jsdom
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { RepoRulesStatus } from '@canopy/protocol/repo-rules';
import type {
  RepoRulesOfferOutcome,
  RepoRulesProjectDecision,
  RepoRulesReviewOffer,
} from '@canopy/ui-app/repo-rules';

import {
  captureRepoRulesReviewOrigin,
  retargetHomeAfterRepoRulesApplied,
} from '@/lib/repoRulesHomeRetarget';
import {
  useRepoRulesModalStore,
  type RepoRulesModalTarget,
} from '@/stores/repoRulesModalStore';
import { RepoRulesModal } from '../RepoRulesModal';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

interface AppliedResult {
  readonly workspaceId: string;
  readonly status: RepoRulesStatus;
  readonly ruleCount: number;
}
interface ReviewProps {
  workspaces: Array<{ id: string; name: string }>;
  initialWorkspaceId?: string;
  onClose: () => void;
  offer?: RepoRulesReviewOffer;
  onApplied?: (result: AppliedResult) => void;
}
const reviewProps: ReviewProps[] = [];
jest.mock('@canopy/ui-app/repo-rules', () => ({
  // The real result copy, so assertions cover the shared helper.
  ...jest.requireActual<object>('@canopy/ui-app/repo-rules'),
  RepoRulesReview: (props: ReviewProps): null => {
    reviewProps.push(props);
    return null;
  },
}));
const mockAddToast = jest.fn<
  void,
  [
    message: string,
    type: string,
    onClick?: () => void,
    meta?: Record<string, unknown>,
  ]
>();
jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: {
    getState: (): { addToast: typeof mockAddToast } => ({
      addToast: mockAddToast,
    }),
  },
}));
jest.mock('@/components/shared/DialogModal', () => ({
  DialogModal: ({ children }: { children: ReactNode }): ReactNode => children,
}));

jest.mock('@/lib/repoRulesHomeRetarget', () => ({
  captureRepoRulesReviewOrigin: jest.fn((source: string) => ({ source })),
  retargetHomeAfterRepoRulesApplied: jest.fn(() => false),
}));
const ALL_PROJECTS = [
  { id: 'code-a', name: 'Alpha', type: 'single-repo' },
  { id: 'code-b', name: 'Beta', type: 'single-repo' },
  { id: 'code-c', name: 'Gamma', type: 'multi-repo' },
  { id: 'notes', name: 'Notes', type: 'cowork' },
];
let projects = ALL_PROJECTS;
let failedWorkspaceIds = new Set<string>();
jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: Object.assign(
    <T,>(selector: (state: { projects: typeof projects }) => T): T =>
      selector({ projects }),
    {
      getState: () => ({ projects, failedWorkspaceIds, isLoading: false }),
    },
  ),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  reviewProps.length = 0;
  projects = ALL_PROJECTS;
  failedWorkspaceIds = new Set();
  useRepoRulesModalStore.setState({
    target: null,
    openCount: 0,
    offer: null,
    offerMemberships: {},
  });
  jest.clearAllMocks();

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Opens through the store, as every entry point does, then renders. */
function openModal(
  target: RepoRulesModalTarget,
  onClose: () => void = jest.fn(),
): ReviewProps {
  act(() => useRepoRulesModalStore.getState().open(target));
  act(() => {
    root.render(<RepoRulesModal target={target} onClose={onClose} />);
  });
  const props = reviewProps.at(-1);
  if (!props) throw new Error('RepoRulesReview was not rendered');
  return props;
}

function lastWorkspaceIds(): string[] {
  const props = reviewProps.at(-1);
  if (!props) throw new Error('RepoRulesReview was not rendered');
  return props.workspaces.map((workspace) => workspace.id);
}

it('offers every Code project when the entry point names none', () => {
  act(() => {
    root.render(
      <RepoRulesModal target={{ source: 'settings' }} onClose={jest.fn()} />,
    );
  });
  expect(lastWorkspaceIds()).toEqual(['code-a', 'code-b', 'code-c']);
});

it('narrows the chooser to the projects an offer found rules in', () => {
  openModal({
    source: 'first-run-import',
    workspaceIds: ['code-c', 'code-a'],
  });
  expect(lastWorkspaceIds()).toEqual(['code-a', 'code-c']);
  expect(reviewProps.at(-1)?.initialWorkspaceId).toBeUndefined();
  expect(reviewProps.at(-1)?.offer?.decisions).toEqual({});
});

it('captures only eligible members when opening, even if unknown or cowork IDs later become code projects', () => {
  const target: RepoRulesModalTarget = {
    source: 'first-run-import',
    workspaceIds: ['code-a', 'notes', 'unknown', 'code-a'],
  };
  openModal(target);
  projects = [
    ...ALL_PROJECTS.filter((project) => project.id !== 'notes'),
    { id: 'notes', name: 'Now code', type: 'single-repo' },
    { id: 'unknown', name: 'New', type: 'single-repo' },
  ];
  act(() =>
    root.render(<RepoRulesModal target={target} onClose={jest.fn()} />),
  );
  expect(lastWorkspaceIds()).toEqual(['code-a']);
  expect(useRepoRulesModalStore.getState().offer?.memberIds).toEqual([
    'code-a',
  ]);
});

it('ignores the narrowed list when the entry point names a project', () => {
  act(() => {
    root.render(
      <RepoRulesModal
        target={{
          source: 'add-project',
          workspaceId: 'code-b',
          workspaceIds: ['code-a'],
        }}
        onClose={jest.fn()}
      />,
    );
  });
  expect(reviewProps.at(-1)?.initialWorkspaceId).toBe('code-b');
  expect(lastWorkspaceIds()).toEqual(['code-a', 'code-b', 'code-c']);
});

it('lists no unrelated projects when every offered project was removed', () => {
  openModal({ source: 'first-run-import', workspaceIds: ['removed'] });
  // The offer's empty state closes; offering every project would let an
  // unrelated save stand in for the offer.
  expect(lastWorkspaceIds()).toEqual([]);
  expect(reviewProps.at(-1)?.offer).toBeDefined();
});

describe('save result toast', () => {
  const ENABLED: RepoRulesStatus = {
    enabled: true,
    disabledRuleIds: [],
    revision: 2,
  };
  const DISABLED: RepoRulesStatus = {
    enabled: false,
    disabledRuleIds: [],
    revision: 3,
  };

  function renderModal(onClose: () => void = jest.fn()): ReviewProps {
    act(() => {
      root.render(
        <RepoRulesModal
          target={{ source: 'settings', workspaceId: 'code-b' }}
          onClose={onClose}
        />,
      );
    });
    const props = reviewProps.at(-1);
    if (!props) throw new Error('RepoRulesReview was not rendered');
    return props;
  }

  function apply(result: AppliedResult): void {
    const { onApplied } = renderModal();
    if (!onApplied) throw new Error('onApplied was not passed');
    act(() => onApplied(result));
  }

  it('confirms rules turned on with the saved project and plural count', () => {
    apply({ workspaceId: 'code-b', status: ENABLED, ruleCount: 2 });
    expect(mockAddToast).toHaveBeenCalledTimes(1);
    expect(mockAddToast).toHaveBeenCalledWith(
      '2 rules apply to new chats.',
      'success',
      undefined,
      {
        title: 'Cursor rules on',
        workspaceName: 'Beta',
        projectId: 'code-b',
        forceInApp: true,
        suppressOsNotification: true,
      },
    );
  });

  it('uses the singular for one rule and names the saved, not the targeted, project', () => {
    apply({ workspaceId: 'code-a', status: ENABLED, ruleCount: 1 });
    expect(mockAddToast).toHaveBeenCalledTimes(1);
    const [message, , , meta] = mockAddToast.mock.calls[0] ?? [];
    expect(message).toBe('1 rule applies to new chats.');
    expect(meta).toMatchObject({ workspaceName: 'Alpha', projectId: 'code-a' });
  });

  it('confirms rules turned off without completing onboarding', () => {
    apply({ workspaceId: 'code-b', status: DISABLED, ruleCount: 0 });
    expect(mockAddToast).toHaveBeenCalledWith(
      "New chats won't use this project's Cursor rules.",
      'success',
      undefined,
      expect.objectContaining({ title: 'Cursor rules off' }),
    );
  });

  it('completes onboarding for rules turned on and still confirms the save', () => {
    apply({ workspaceId: 'code-b', status: ENABLED, ruleCount: 2 });

    expect(mockAddToast).toHaveBeenCalledTimes(1);
  });

  it('confirms the save without waiting for onboarding completion', () => {
    // Completion is fire-and-forget and swallows its own failures, so the
    // toast follows it in the same callback rather than after it settles.
    apply({ workspaceId: 'code-b', status: ENABLED, ruleCount: 2 });
  });

  it('omits the project name when the saved project is no longer listed', () => {
    apply({ workspaceId: 'removed', status: ENABLED, ruleCount: 2 });
    expect(mockAddToast).toHaveBeenCalledTimes(1);
    expect(mockAddToast.mock.calls[0]?.[3]).toEqual({
      title: 'Cursor rules on',
      projectId: 'removed',
      forceInApp: true,
      suppressOsNotification: true,
    });
  });

  it('shows no result toast when the review closes without saving', () => {
    const onClose = jest.fn();
    const props = renderModal(onClose);
    act(() => props.onClose());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockAddToast).not.toHaveBeenCalled();
  });
});

describe('after a successful Apply (CAN-4674)', () => {
  function applied(enabled: boolean): AppliedResult {
    return {
      workspaceId: 'code-b',
      status: { enabled, disabledRuleIds: [], revision: 1 },
      ruleCount: 1,
    };
  }

  it('hands the applied project and the review origin to the Home retarget', () => {
    openModal({ source: 'import-results', workspaceIds: ['code-b'] });
    expect(captureRepoRulesReviewOrigin).toHaveBeenCalledTimes(1);
    expect(captureRepoRulesReviewOrigin).toHaveBeenCalledWith('import-results');
    act(() => {
      reviewProps.at(-1)?.offer?.onDecide('code-b', 'on');
      reviewProps.at(-1)?.onApplied?.(applied(true));
    });
    expect(retargetHomeAfterRepoRulesApplied).toHaveBeenCalledWith(
      { source: 'import-results' },
      applied(true),
    );
  });

  it('keeps the origin captured at open across re-renders', () => {
    const onClose = jest.fn();
    act(() => {
      root.render(
        <RepoRulesModal
          target={{ source: 'first-run-import' }}
          onClose={onClose}
        />,
      );
    });
    act(() => {
      root.render(
        <RepoRulesModal
          target={{ source: 'first-run-import' }}
          onClose={onClose}
        />,
      );
    });
    expect(captureRepoRulesReviewOrigin).toHaveBeenCalledTimes(1);
  });

  it('records completion only when rules turned on, whether or not Home retargets', () => {
    act(() => {
      root.render(
        <RepoRulesModal
          target={{ source: 'settings', workspaceId: 'code-b' }}
          onClose={jest.fn()}
        />,
      );
    });
    act(() => reviewProps.at(-1)?.onApplied?.(applied(false)));

    act(() => reviewProps.at(-1)?.onApplied?.(applied(true)));
  });
});

describe('multi-project offer completion (CAN-4980)', () => {
  const ENABLED: RepoRulesStatus = {
    enabled: true,
    disabledRuleIds: [],
    revision: 2,
  };
  const OFFER: RepoRulesModalTarget = {
    source: 'first-run-import',
    workspaceIds: ['code-a', 'code-b'],
  };

  function decide(
    workspaceId: string,
    decision: RepoRulesProjectDecision,
  ): RepoRulesOfferOutcome {
    const offer = reviewProps.at(-1)?.offer;
    if (!offer) throw new Error('the review has no offer');
    let outcome: RepoRulesOfferOutcome = 'continue';
    act(() => {
      outcome = offer.onDecide(workspaceId, decision);
    });
    return outcome;
  }

  async function settle(): Promise<void> {
    await act(async () => {
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
    });
  }

  function closeAndRender(target: RepoRulesModalTarget): ReviewProps {
    act(() => useRepoRulesModalStore.getState().close());
    act(() => root.unmount());
    root = createRoot(container);
    return openModal(target);
  }

  it('keeps the offer open after one decision and completes once after the last', async () => {
    openModal(OFFER);
    expect(decide('code-a', 'on')).toBe('continue');

    expect(reviewProps.at(-1)?.offer?.decisions).toEqual({ 'code-a': 'on' });
    expect(decide('code-b', 'on')).toBe('close');
    expect(decide('code-b', 'on')).toBe('close');
    await settle();
  });

  it.each([
    ['all skipped', 'skipped', 'skipped'],
    ['all off', 'off', 'off'],
    ['skipped and off', 'skipped', 'off'],
  ] as const)('completes an offer resolved %s', (_label, first, second) => {
    openModal(OFFER);
    decide('code-a', first);
    expect(decide('code-b', second)).toBe('close');
  });

  it('does not record a save in the offer flow twice', () => {
    openModal(OFFER);
    decide('code-a', 'on');
    act(() =>
      reviewProps.at(-1)?.onApplied?.({
        workspaceId: 'code-a',
        status: ENABLED,
        ruleCount: 1,
      }),
    );

    expect(mockAddToast).toHaveBeenCalledTimes(1);
  });

  it('resumes an unresolved offer from Settings with its decisions', () => {
    openModal(OFFER);
    decide('code-a', 'skipped');
    const resumed = closeAndRender({ source: 'settings' });
    expect(resumed.workspaces.map((workspace) => workspace.id)).toEqual([
      'code-a',
      'code-b',
    ]);
    expect(resumed.offer?.decisions).toEqual({ 'code-a': 'skipped' });
    expect(decide('code-b', 'on')).toBe('close');
  });

  it('opens Settings without the offer once it is resolved', () => {
    openModal(OFFER);
    decide('code-a', 'on');
    decide('code-b', 'off');
    const reopened = closeAndRender({ source: 'settings' });
    expect(reopened.offer).toBeUndefined();
    expect(reopened.workspaces).toHaveLength(3);
  });

  it('keeps an unrelated save from completing onboarding while the offer is pending', () => {
    openModal(OFFER);
    decide('code-a', 'on');
    const settings = closeAndRender({
      source: 'settings',
      workspaceId: 'code-c',
    });
    expect(settings.offer).toBeUndefined();
    act(() =>
      settings.onApplied?.({
        workspaceId: 'code-c',
        status: ENABLED,
        ruleCount: 1,
      }),
    );

    expect(mockAddToast).toHaveBeenCalledTimes(1);
  });

  it('counts a save of an offered project from another entry point', () => {
    openModal(OFFER);
    decide('code-a', 'on');
    const project = closeAndRender({
      source: 'project-settings',
      workspaceId: 'code-b',
    });
    act(() =>
      project.onApplied?.({
        workspaceId: 'code-b',
        status: { ...ENABLED, enabled: false },
        ruleCount: 0,
      }),
    );
    expect(useRepoRulesModalStore.getState().offer?.decisions).toEqual({
      'code-a': 'on',
      'code-b': 'off',
    });
  });

  it('keeps existing completion for ordinary saves without a pending offer', () => {
    const settings = openModal({ source: 'settings' });
    act(() =>
      settings.onApplied?.({
        workspaceId: 'code-c',
        status: ENABLED,
        ruleCount: 1,
      }),
    );
  });

  it('merges a later offer without losing decisions or repeating members', () => {
    openModal(OFFER);
    decide('code-a', 'skipped');
    const merged = closeAndRender({
      source: 'add-project',
      workspaceIds: ['code-b', 'code-c', 'code-c'],
    });
    expect(useRepoRulesModalStore.getState().offer?.memberIds).toEqual([
      'code-a',
      'code-b',
      'code-c',
    ]);
    expect(merged.offer?.decisions).toEqual({ 'code-a': 'skipped' });
    expect(decide('code-b', 'on')).toBe('continue');
  });

  it('does not reopen a resolved offer when its old toast is clicked again', () => {
    openModal(OFFER);
    decide('code-a', 'on');
    decide('code-b', 'skipped');
    const replayed = closeAndRender(OFFER);
    expect(replayed.offer?.decisions).toEqual({
      'code-a': 'on',
      'code-b': 'skipped',
    });
  });

  it('starts a distinct offer after resolution with only its own projects', () => {
    openModal(OFFER);
    decide('code-a', 'on');
    decide('code-b', 'skipped');
    const later = closeAndRender({
      source: 'add-project',
      workspaceIds: ['code-c'],
    });
    expect(later.workspaces.map((workspace) => workspace.id)).toEqual([
      'code-c',
    ]);
    expect(decide('code-c', 'on')).toBe('close');

    const replay = closeAndRender(OFFER);
    expect(replay.offer?.decisions['code-a']).toBe('on');
    expect(replay.offer?.decisions['code-b']).toBe('skipped');
  });

  it('does not admit a formerly ineligible project when an old resolved toast is clicked', () => {
    const target: RepoRulesModalTarget = {
      source: 'first-run-import',
      workspaceIds: ['code-a', 'notes'],
    };
    openModal(target);
    expect(decide('code-a', 'on')).toBe('close');
    projects = [
      ...ALL_PROJECTS.filter((project) => project.id !== 'notes'),
      { id: 'notes', name: 'Now code', type: 'single-repo' },
    ];
    const replay = closeAndRender(target);
    expect(replay.workspaces.map((workspace) => workspace.id)).toEqual([
      'code-a',
    ]);
  });

  it('ignores a decision for a project outside the offer', () => {
    openModal(OFFER);
    expect(decide('code-c', 'on')).toBe('continue');
    expect(useRepoRulesModalStore.getState().offer?.decisions).toEqual({});
  });
});
