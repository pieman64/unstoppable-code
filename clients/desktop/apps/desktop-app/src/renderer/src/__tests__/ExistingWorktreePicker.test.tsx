/**
 * @jest-environment jsdom
 */
import { act, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ExistingWorktreeJoinCandidate,
  ExistingWorktreeJoinRepoOverlap,
  ExistingWorktreeJoinWorkspaceGroup,
} from '@canopy/desktop-shared/types';
import {
  ExistingWorktreePicker,
  getCandidateDisabledReason,
  getCandidateWarnings,
  type ExistingWorktreeSelection,
} from '@/components/worktree/ExistingWorktreePicker';
import { useProjectsStore } from '@/stores/projectsStore';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function makeOverlap(
  overrides: Partial<ExistingWorktreeJoinRepoOverlap> = {},
): ExistingWorktreeJoinRepoOverlap {
  return {
    repoName: 'repo',
    sourceHasChanges: false,
    targetHasChanges: false,
    sourceBranch: 'main',
    targetBranch: 'main',
    ...overrides,
  };
}

function makeCandidate(
  overrides: Partial<ExistingWorktreeJoinCandidate> = {},
): ExistingWorktreeJoinCandidate {
  return {
    workspaceId: 'ws',
    worktreeId: 'wt',
    branchName: 'feature',
    repoOverlaps: [],
    addsNewRepo: true,
    ...overrides,
  };
}

function makeGroup(
  overrides: Partial<ExistingWorktreeJoinWorkspaceGroup> = {},
): ExistingWorktreeJoinWorkspaceGroup {
  return {
    workspaceId: 'ws',
    workspaceName: 'Workspace',
    color: '#2563eb',
    isMultiRepo: false,
    repoCount: 1,
    temporary: false,
    candidates: [],
    ...overrides,
  };
}

describe('getCandidateDisabledReason', () => {
  it('maps busy reasons to messages', () => {
    expect(
      getCandidateDisabledReason(makeCandidate({ busyReason: 'active-chat' })),
    ).toBe('This worktree has an active chat session.');
    expect(
      getCandidateDisabledReason(
        makeCandidate({ busyReason: 'running-pipeline' }),
      ),
    ).toBe('This worktree has a running workflow execution.');
    expect(
      getCandidateDisabledReason(
        makeCandidate({ busyReason: 'setup-pending' }),
      ),
    ).toBe('This worktree is still being set up.');
    expect(
      getCandidateDisabledReason(makeCandidate({ busyReason: 'health-issue' })),
    ).toBe('This worktree has a health issue.');
  });

  it('disables when any overlap is dirty on both sides', () => {
    const reason = getCandidateDisabledReason(
      makeCandidate({
        repoOverlaps: [
          makeOverlap({
            repoName: 'app',
            sourceHasChanges: true,
            targetHasChanges: true,
          }),
        ],
      }),
    );
    expect(reason).toBe(
      'Both worktrees have changes in app. Commit or discard changes on one side first.',
    );
  });

  it('returns null when joinable', () => {
    expect(getCandidateDisabledReason(makeCandidate())).toBeNull();
  });

  it('disables a no-op join when no new repos and the target is clean', () => {
    expect(
      getCandidateDisabledReason(
        makeCandidate({
          addsNewRepo: false,
          repoOverlaps: [
            makeOverlap({
              repoName: 'app',
              sourceHasChanges: true,
              targetHasChanges: false,
            }),
          ],
        }),
      ),
    ).toBe(
      'Joining this worktree would make no changes: its repos are already here with no changes to bring over.',
    );
  });

  it('allows a join that adds a new repo even when overlaps are clean', () => {
    expect(
      getCandidateDisabledReason(
        makeCandidate({
          addsNewRepo: true,
          repoOverlaps: [makeOverlap({ targetHasChanges: false })],
        }),
      ),
    ).toBeNull();
  });

  it('allows a join when an overlap target has changes to bring over', () => {
    expect(
      getCandidateDisabledReason(
        makeCandidate({
          addsNewRepo: false,
          repoOverlaps: [makeOverlap({ targetHasChanges: true })],
        }),
      ),
    ).toBeNull();
  });
});

describe('getCandidateWarnings', () => {
  it('warns which side will be preserved per repo', () => {
    expect(
      getCandidateWarnings(
        makeCandidate({
          repoOverlaps: [
            makeOverlap({ repoName: 'app', sourceHasChanges: true }),
            makeOverlap({ repoName: 'lib', targetHasChanges: true }),
          ],
        }),
      ),
    ).toEqual([
      'app: changes from this worktree will be kept.',
      'lib: changes from the selected worktree will be kept.',
    ]);
  });

  it('notes left-behind branches when both sides are clean but differ', () => {
    expect(
      getCandidateWarnings(
        makeCandidate({
          repoOverlaps: [
            makeOverlap({
              repoName: 'app',
              sourceBranch: 'feat-a',
              targetBranch: 'feat-b',
            }),
          ],
        }),
      ),
    ).toEqual([
      'app stays on feat-a; feat-b from the selected worktree is left behind.',
    ]);
  });

  it('emits no warning for identical clean branches or both-dirty conflicts', () => {
    expect(
      getCandidateWarnings(
        makeCandidate({
          repoOverlaps: [
            makeOverlap({ repoName: 'same' }),
            makeOverlap({
              repoName: 'conflict',
              sourceHasChanges: true,
              targetHasChanges: true,
            }),
          ],
        }),
      ),
    ).toEqual([]);
  });
});

interface RenderResult {
  container: HTMLDivElement;
  root: Root;
}

function renderPicker(element: JSX.Element): RenderResult {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return { container, root };
}

function getButton(container: HTMLElement, testId: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    `[data-testid="${testId}"]`,
  );
  if (!button) {
    throw new Error(`Missing button ${testId}`);
  }
  return button;
}

function getInput(container: HTMLElement, testId: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(
    `[data-testid="${testId}"]`,
  );
  if (!input) {
    throw new Error(`Missing input ${testId}`);
  }
  return input;
}

function queryTestId(container: HTMLElement, testId: string): Element | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

interface SearchHarnessProps {
  groups: ExistingWorktreeJoinWorkspaceGroup[];
  onSelect?: (candidate: ExistingWorktreeJoinCandidate) => void;
}

function SearchHarness({
  groups,
  onSelect = (): void => undefined,
}: SearchHarnessProps): JSX.Element {
  const [searchQuery, setSearchQuery] = useState('');
  return (
    <ExistingWorktreePicker
      groups={groups}
      selected={null}
      onSelect={onSelect}
      searchQuery={searchQuery}
      onSearchQueryChange={setSearchQuery}
    />
  );
}

function typeIntoSearch(container: HTMLElement, value: string): void {
  const searchInput = getInput(container, 'existing-worktree-picker-search');
  // Use the native prototype setter so React's controlled-input value tracker
  // sees the change and dispatches onChange.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const nativeValueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  if (!nativeValueSetter) {
    throw new Error('Missing native value setter');
  }
  act(() => {
    nativeValueSetter.call(searchInput, value);
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('ExistingWorktreePicker rendering', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    useProjectsStore.setState({ diffStats: {} });
  });

  function makeTwoGroups(): ExistingWorktreeJoinWorkspaceGroup[] {
    return [
      makeGroup({
        workspaceId: 'ws-one',
        workspaceName: 'Workspace One',
        candidates: [
          makeCandidate({
            workspaceId: 'ws-one',
            worktreeId: 'wt-alpha',
            branchName: 'feature/alpha',
          }),
        ],
      }),
      makeGroup({
        workspaceId: 'ws-two',
        workspaceName: 'Workspace Two',
        candidates: [
          makeCandidate({
            workspaceId: 'ws-two',
            worktreeId: 'wt-beta',
            branchName: 'feature/beta',
          }),
        ],
      }),
    ];
  }

  it('renders project group headers with worktree rows beneath', () => {
    // Diff badges read from the sidebar's cached diff-stats store, keyed
    // `${workspaceId}/${worktreeId}`.
    useProjectsStore.setState({
      diffStats: {
        'ws-one/wt-alpha': { insertions: 3, deletions: 1 },
        'ws-two/wt-beta': { insertions: 7, deletions: 2 },
      },
    });
    const { container, root } = renderPicker(
      <ExistingWorktreePicker
        groups={makeTwoGroups()}
        selected={null}
        onSelect={jest.fn()}
        searchQuery=""
        onSearchQueryChange={jest.fn()}
      />,
    );
    try {
      expect(
        queryTestId(container, 'existing-worktree-picker-group-ws-one'),
      ).not.toBeNull();
      expect(
        queryTestId(container, 'existing-worktree-picker-group-ws-two'),
      ).not.toBeNull();
      expect(container.textContent).toContain('Workspace One');
      expect(container.textContent).toContain('Workspace Two');

      const rowOne = getButton(
        container,
        'existing-worktree-picker-option-ws-one-wt-alpha',
      );
      expect(rowOne.textContent).toContain('feature/alpha');
      expect(rowOne.textContent).toContain('wt-alpha');
      expect(rowOne.textContent).toContain('+3');
      expect(rowOne.textContent).toContain('-1');

      const rowTwo = getButton(
        container,
        'existing-worktree-picker-option-ws-two-wt-beta',
      );
      expect(rowTwo.textContent).toContain('feature/beta');
      expect(rowTwo.textContent).toContain('wt-beta');
      expect(rowTwo.textContent).toContain('+7');
      expect(rowTwo.textContent).toContain('-2');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('hides the diff badge for worktrees with no line changes', () => {
    // No diff stats seeded for wt-alpha, and wt-beta has zeroed stats — both
    // should omit the badge entirely (matching the main worktree list) rather
    // than render "+0 -0".
    useProjectsStore.setState({
      diffStats: {
        'ws-two/wt-beta': { insertions: 0, deletions: 0 },
      },
    });
    const { container, root } = renderPicker(
      <ExistingWorktreePicker
        groups={makeTwoGroups()}
        selected={null}
        onSelect={jest.fn()}
        searchQuery=""
        onSearchQueryChange={jest.fn()}
      />,
    );
    try {
      const rowOne = getButton(
        container,
        'existing-worktree-picker-option-ws-one-wt-alpha',
      );
      const rowTwo = getButton(
        container,
        'existing-worktree-picker-option-ws-two-wt-beta',
      );
      expect(rowOne.textContent).not.toContain('+0');
      expect(rowOne.textContent).not.toContain('-0');
      expect(rowTwo.textContent).not.toContain('+0');
      expect(rowTwo.textContent).not.toContain('-0');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('shows "X repos" / "Temporary" subtitles for multi-repo projects', () => {
    const { container, root } = renderPicker(
      <ExistingWorktreePicker
        groups={[
          makeGroup({
            workspaceId: 'multi-ws',
            workspaceName: 'Multi',
            isMultiRepo: true,
            repoCount: 3,
            candidates: [makeCandidate({ workspaceId: 'multi-ws' })],
          }),
          makeGroup({
            workspaceId: 'temp-ws',
            workspaceName: 'Temp',
            isMultiRepo: true,
            repoCount: 2,
            temporary: true,
            candidates: [makeCandidate({ workspaceId: 'temp-ws' })],
          }),
          makeGroup({
            workspaceId: 'single-ws',
            workspaceName: 'Single',
            candidates: [makeCandidate({ workspaceId: 'single-ws' })],
          }),
        ]}
        selected={null}
        onSelect={jest.fn()}
        searchQuery=""
        onSearchQueryChange={jest.fn()}
      />,
    );
    try {
      const multi = queryTestId(
        container,
        'existing-worktree-picker-group-multi-ws',
      );
      const temp = queryTestId(
        container,
        'existing-worktree-picker-group-temp-ws',
      );
      const single = queryTestId(
        container,
        'existing-worktree-picker-group-single-ws',
      );
      expect(multi?.textContent).toContain('3 repos');
      expect(multi?.textContent).not.toContain('Temporary');
      expect(temp?.textContent).toContain('2 repos');
      expect(temp?.textContent).toContain('Temporary');
      // Single-repo workspaces carry no subtitle.
      expect(single?.textContent).not.toContain('repo');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('collapses and expands a project group from its header', () => {
    const { container, root } = renderPicker(
      <ExistingWorktreePicker
        groups={[
          makeGroup({
            workspaceId: 'ws-one',
            candidates: [
              makeCandidate({ workspaceId: 'ws-one', worktreeId: 'wt-alpha' }),
            ],
          }),
        ]}
        selected={null}
        onSelect={jest.fn()}
        searchQuery=""
        onSearchQueryChange={jest.fn()}
      />,
    );
    try {
      const header = getButton(
        container,
        'existing-worktree-picker-group-ws-one',
      );
      const optionTestId = 'existing-worktree-picker-option-ws-one-wt-alpha';
      // Groups start expanded.
      expect(header.getAttribute('aria-expanded')).toBe('true');
      expect(queryTestId(container, optionTestId)).not.toBeNull();
      // Collapse hides the worktree rows.
      act(() => {
        header.click();
      });
      expect(header.getAttribute('aria-expanded')).toBe('false');
      expect(queryTestId(container, optionTestId)).toBeNull();
      // Expand restores them.
      act(() => {
        header.click();
      });
      expect(header.getAttribute('aria-expanded')).toBe('true');
      expect(queryTestId(container, optionTestId)).not.toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('filters rows by search across branch, worktree id, and project name', () => {
    const { container, root } = renderPicker(
      <SearchHarness groups={makeTwoGroups()} />,
    );
    try {
      // Branch-name match keeps only the matching row.
      typeIntoSearch(container, 'alpha');
      expect(
        queryTestId(
          container,
          'existing-worktree-picker-option-ws-one-wt-alpha',
        ),
      ).not.toBeNull();
      expect(
        queryTestId(
          container,
          'existing-worktree-picker-option-ws-two-wt-beta',
        ),
      ).toBeNull();
      expect(
        queryTestId(container, 'existing-worktree-picker-group-ws-two'),
      ).toBeNull();

      // Worktree-id match.
      typeIntoSearch(container, 'wt-beta');
      expect(
        queryTestId(
          container,
          'existing-worktree-picker-option-ws-two-wt-beta',
        ),
      ).not.toBeNull();
      expect(
        queryTestId(
          container,
          'existing-worktree-picker-option-ws-one-wt-alpha',
        ),
      ).toBeNull();

      // Workspace-name match keeps the whole group.
      typeIntoSearch(container, 'workspace one');
      expect(
        queryTestId(container, 'existing-worktree-picker-group-ws-one'),
      ).not.toBeNull();
      expect(
        queryTestId(
          container,
          'existing-worktree-picker-option-ws-one-wt-alpha',
        ),
      ).not.toBeNull();
      expect(
        queryTestId(container, 'existing-worktree-picker-group-ws-two'),
      ).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('disables busy rows and selects exactly one enabled row', () => {
    const busyCandidate = makeCandidate({
      workspaceId: 'ws-one',
      worktreeId: 'wt-busy',
      branchName: 'feature/busy',
      busyReason: 'active-chat',
    });
    const enabledCandidate = makeCandidate({
      workspaceId: 'ws-one',
      worktreeId: 'wt-free',
      branchName: 'feature/free',
    });
    const otherCandidate = makeCandidate({
      workspaceId: 'ws-one',
      worktreeId: 'wt-other',
      branchName: 'feature/other',
    });
    const groups = [
      makeGroup({
        workspaceId: 'ws-one',
        workspaceName: 'Workspace One',
        candidates: [busyCandidate, enabledCandidate, otherCandidate],
      }),
    ];
    const onSelect = jest.fn();

    function render(selected: ExistingWorktreeSelection | null): JSX.Element {
      return (
        <ExistingWorktreePicker
          groups={groups}
          selected={selected}
          onSelect={onSelect}
          searchQuery=""
          onSearchQueryChange={jest.fn()}
        />
      );
    }

    const { container, root } = renderPicker(render(null));
    try {
      const busyButton = getButton(
        container,
        'existing-worktree-picker-option-ws-one-wt-busy',
      );
      expect(busyButton.disabled).toBe(true);
      act(() => {
        busyButton.click();
      });
      expect(onSelect).not.toHaveBeenCalled();

      const enabledButton = getButton(
        container,
        'existing-worktree-picker-option-ws-one-wt-free',
      );
      expect(enabledButton.disabled).toBe(false);
      act(() => {
        enabledButton.click();
      });
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith(enabledCandidate);

      // Selection is controlled: rerender with the selected prop set.
      act(() => {
        root.render(render({ workspaceId: 'ws-one', worktreeId: 'wt-free' }));
      });
      expect(
        getButton(
          container,
          'existing-worktree-picker-option-ws-one-wt-free',
        ).getAttribute('aria-pressed'),
      ).toBe('true');
      expect(
        getButton(
          container,
          'existing-worktree-picker-option-ws-one-wt-other',
        ).getAttribute('aria-pressed'),
      ).toBe('false');

      // Selecting another candidate moves the selection.
      act(() => {
        root.render(render({ workspaceId: 'ws-one', worktreeId: 'wt-other' }));
      });
      expect(
        getButton(
          container,
          'existing-worktree-picker-option-ws-one-wt-other',
        ).getAttribute('aria-pressed'),
      ).toBe('true');
      expect(
        getButton(
          container,
          'existing-worktree-picker-option-ws-one-wt-free',
        ).getAttribute('aria-pressed'),
      ).toBe('false');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('shows the conflict reason in a hover tooltip', () => {
    const groups = [
      makeGroup({
        workspaceId: 'ws-one',
        workspaceName: 'Workspace One',
        candidates: [
          makeCandidate({
            workspaceId: 'ws-one',
            worktreeId: 'wt-conflict',
            repoOverlaps: [
              makeOverlap({
                repoName: 'private-repo',
                sourceHasChanges: true,
                targetHasChanges: true,
              }),
            ],
          }),
        ],
      }),
    ];
    const { container, root } = renderPicker(
      <ExistingWorktreePicker
        groups={groups}
        selected={null}
        onSelect={jest.fn()}
        searchQuery=""
        onSearchQueryChange={jest.fn()}
      />,
    );
    function hoverTooltip(testId: string): Element | null {
      const button = getButton(container, testId);
      act(() => {
        button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
      const tooltip = document.body.querySelector('[role="tooltip"]');
      act(() => {
        button.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      });
      return tooltip;
    }
    try {
      const conflictTooltip = hoverTooltip(
        'existing-worktree-picker-option-ws-one-wt-conflict',
      );
      expect(conflictTooltip?.textContent).toBe(
        'Both worktrees have changes in private-repo. Commit or discard changes on one side first.',
      );
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('shows no-matches placeholder', () => {
    const { container, root } = renderPicker(
      <SearchHarness groups={makeTwoGroups()} />,
    );
    try {
      typeIntoSearch(container, 'zzz-no-such-worktree');
      expect(
        queryTestId(container, 'existing-worktree-picker-no-matches'),
      ).not.toBeNull();
      expect(container.textContent).toContain('No matching worktrees');
      expect(
        queryTestId(
          container,
          'existing-worktree-picker-option-ws-one-wt-alpha',
        ),
      ).toBeNull();
      expect(
        queryTestId(
          container,
          'existing-worktree-picker-option-ws-two-wt-beta',
        ),
      ).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });
});
