/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DiffHunk,
  PrDiffSnapshot,
  SplitPlan,
  SplitPrPlanResponse,
} from '@canopy/desktop-shared/types/github';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { SplitPlanReviewPanel } from '../SplitPlanReviewPanel';

// jsdom's test global scope does not expose Node's structuredClone; the
// component uses it to deep-clone the incoming plan on mount.
if (typeof globalThis.structuredClone === 'undefined') {
  Object.defineProperty(globalThis, 'structuredClone', {
    configurable: true,
    value: (value: unknown): unknown => JSON.parse(JSON.stringify(value)),
  });
}

function makeHunk(overrides: Partial<DiffHunk> = {}): DiffHunk {
  return {
    file: 'client.ts',
    hunkIndex: 0,
    header: '@@ -1,3 +1,4 @@',
    contentHash: 'hash-0',
    coreLines: ['+added line'],
    occurrenceIndex: 0,
    additions: 1,
    deletions: 0,
    preview: '+added line',
    ...overrides,
  };
}

function makeSnapshot(): PrDiffSnapshot {
  return {
    baseRef: 'base-sha',
    headRef: 'head-sha',
    files: [
      {
        path: 'client.ts',
        kind: 'modified',
        isBinary: false,
        additions: 3,
        deletions: 0,
        hunks: [
          makeHunk({ hunkIndex: 0, additions: 1, deletions: 0 }),
          makeHunk({
            hunkIndex: 1,
            additions: 2,
            deletions: 0,
            header: '@@ -10,3 +11,5 @@',
            preview: '+more lines',
          }),
        ],
      },
    ],
    totalAdditions: 3,
    totalDeletions: 0,
  };
}

function makeValidPlan(): SplitPlan {
  return {
    finalGoal: 'Split the PR into two reviewable pieces',
    concerns: [],
    children: [
      {
        index: 1,
        title: 'refactor: extract helper',
        type: 'refactor',
        dependsOn: [],
        changes: [{ file: 'client.ts', hunks: [0] }],
        renames: [],
        testProof: 'npm test -- helper',
        risk: 'low',
        rationale: 'Pure extraction',
      },
      {
        index: 2,
        title: 'feat: use helper',
        type: 'feature',
        dependsOn: [1],
        changes: [{ file: 'client.ts', hunks: [1] }],
        renames: [],
        testProof: 'npm test -- usage',
        risk: 'low',
        rationale: 'Wires up new helper',
      },
    ],
    parallelizable: 'No',
    landOrder: '1, 2',
    buildTestCommand: 'npm test',
    unassignedHunks: [],
  };
}

function makePlanResponse(plan: SplitPlan): SplitPrPlanResponse {
  return {
    plan,
    snapshot: makeSnapshot(),
    originalPr: {
      prNumber: 42,
      prUrl: 'https://github.com/example/repo/pull/42',
      baseBranch: 'main',
      headBranch: 'feature-branch',
      headSha: 'head-sha',
    },
  };
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  jest.clearAllMocks();
});

function render(props: {
  planResponse: SplitPrPlanResponse;
  onApprove?: (edited: SplitPlan) => void;
  onRegenerate?: () => void;
  onCancel?: () => void;
}): void {
  act(() => {
    root.render(
      <SplitPlanReviewPanel
        projectId="proj-1"
        worktreeId="wt-1"
        planResponse={props.planResponse}
        onApprove={props.onApprove ?? jest.fn()}
        onRegenerate={props.onRegenerate ?? jest.fn()}
        onCancel={props.onCancel ?? jest.fn()}
      />,
    );
  });
}

function approveButton(): HTMLButtonElement {
  const btn = container.querySelector<HTMLButtonElement>(
    '[data-testid="split-plan-approve"]',
  );
  if (!btn) throw new Error('approve button not found');
  return btn;
}

/** Opens a reassignment dropdown and picks `Child <index>`. */
function chooseChild(trigger: HTMLButtonElement, index: string): void {
  act(() => trigger.click());
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((candidate) => candidate.textContent === `Child ${index}`);
  if (!option) throw new Error(`Missing option Child ${index}`);
  act(() => option.click());
}

describe('SplitPlanReviewPanel', () => {
  it('records the plan review and blocks only the hunk previews from session replay', () => {
    render({ planResponse: makePlanResponse(makeValidPlan()) });

    const panel = container.querySelector('[data-testid="split-plan-panel"]');
    expect(panel).toBe(container.firstElementChild);
    expect(panel?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);
    expect(
      container
        .querySelector('[data-testid="split-plan-final-goal"]')
        ?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`),
    ).toBeNull();

    const fileToggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="split-plan-changes-file-1-client.ts"] button',
    );
    if (!fileToggle) throw new Error('file toggle not found');
    act(() => {
      fileToggle.click();
    });
    expect(fileToggle.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
    const previews = Array.from(
      container.querySelectorAll(
        '[data-testid="split-plan-changes-file-1-client.ts"] pre',
      ),
    );
    expect(previews.length).toBeGreaterThan(0);
    for (const preview of previews) {
      expect(preview.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(true);
    }
  });

  it('disables Approve when a hunk is unassigned, enables it for a valid plan', () => {
    const validPlan = makeValidPlan();
    render({ planResponse: makePlanResponse(validPlan) });
    expect(approveButton().disabled).toBe(false);

    act(() => {
      root.unmount();
    });
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    const invalidPlan = makeValidPlan();
    // Drop hunk 1 from child 2 so it's unassigned entirely.
    invalidPlan.children[1].changes = [];
    render({ planResponse: makePlanResponse(invalidPlan) });
    expect(approveButton().disabled).toBe(true);
    expect(
      container.querySelector('[data-testid="split-plan-error-banner"]'),
    ).not.toBeNull();
  });

  it('reassigning a hunk between children updates line counts and clears the error', () => {
    const invalidPlan = makeValidPlan();
    invalidPlan.children[1].changes = [];
    render({ planResponse: makePlanResponse(invalidPlan) });

    expect(approveButton().disabled).toBe(true);

    // Expand child 1's client.ts file to reveal the hunk reassignment selects.
    const child1FileToggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="split-plan-changes-file-1-client.ts"] button',
    );
    if (!child1FileToggle) throw new Error('file toggle not found');
    act(() => {
      child1FileToggle.click();
    });

    // Hunk 1 (index 1) select should exist inside child 1's expanded row
    // (child 1 currently owns only hunk 0, but hunk 1 shows as unowned via
    // ownership map -1, so we drive the reassignment from wherever it's
    // rendered). Reassignment selects for a given file appear once per hunk,
    // scoped by data-testid on the file container. Find all selects in that
    // container and pick the one for hunk 1 by its aria-label.
    const selects = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="split-plan-changes-file-1-client.ts"] [role="combobox"]',
    );
    const hunk1Select = Array.from(selects).find((select) =>
      select.getAttribute('aria-label')?.includes('hunk 1'),
    );
    if (!hunk1Select) throw new Error('hunk 1 reassignment select not found');

    chooseChild(hunk1Select, '2');

    expect(approveButton().disabled).toBe(false);
    expect(
      container.querySelector('[data-testid="split-plan-error-banner"]'),
    ).toBeNull();

    const row2 = container.querySelector('[data-testid="split-plan-row-2"]');
    expect(row2?.textContent).toContain('+2');
  });

  it('merges a reassigned hunk into a target child that already owns another hunk of the same file without mutating the source plan', () => {
    const plan = makeValidPlan();
    // Give child 2 a second, unrelated file so we can later assert its
    // original `changes` array entry object was not mutated in place.
    plan.children[1].changes = [{ file: 'client.ts', hunks: [1] }];
    const originalChild2Changes = plan.children[1].changes;
    const originalHunk1Change = plan.children[1].changes[0];

    let approved: SplitPlan | null = null;
    render({
      planResponse: makePlanResponse(plan),
      onApprove: (edited) => {
        approved = edited;
      },
    });

    // Expand child 1's client.ts file and reassign hunk 0 to child 2, which
    // already owns hunk 1 of the same file — this exercises the merge branch.
    const child1FileToggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="split-plan-changes-file-1-client.ts"] button',
    );
    if (!child1FileToggle) throw new Error('file toggle not found');
    act(() => {
      child1FileToggle.click();
    });

    const selects = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="split-plan-changes-file-1-client.ts"] [role="combobox"]',
    );
    const hunk0Select = Array.from(selects).find((select) =>
      select.getAttribute('aria-label')?.includes('hunk 0'),
    );
    if (!hunk0Select) throw new Error('hunk 0 reassignment select not found');

    chooseChild(hunk0Select, '2');

    // The original plan object passed in via props must not have been
    // mutated by the reassignment (component clones on mount, and the
    // reassignment logic must not mutate array elements in place either).
    expect(plan.children[1].changes).toBe(originalChild2Changes);
    expect(plan.children[1].changes[0]).toBe(originalHunk1Change);
    expect(plan.children[1].changes[0].hunks).toEqual([1]);

    act(() => {
      approveButton().click();
    });

    expect(approved).not.toBeNull();
    const approvedPlan = approved as unknown as SplitPlan;
    const child2 = approvedPlan.children.find((c) => c.index === 2);
    if (!child2) throw new Error('child 2 not found in approved plan');
    const clientChange = child2.changes.find((c) => c.file === 'client.ts');
    if (!clientChange) throw new Error('client.ts change not found');
    // The snapshot fixture has exactly 2 hunks for client.ts (0 and 1); once
    // child 2 owns both, the reassignment logic collapses this to whole-file
    // ownership rather than leaving an explicit [0, 1] index list.
    expect(clientChange.hunks).toBe('all');

    const child1 = approvedPlan.children.find((c) => c.index === 1);
    if (!child1) throw new Error('child 1 not found in approved plan');
    expect(child1.changes.some((c) => c.file === 'client.ts')).toBe(false);
  });

  it('reassigning a binary (zero-hunk) file between children keeps whole-file ownership and the plan valid', () => {
    // A binary file has `hunks: []`; reassigning it must move whole-file
    // ownership (`hunks: 'all'`) to the target, not leave it `hunks: []` (which
    // would trip `unassigned-hunk` + `binary-not-whole` and disable Approve).
    const binarySnapshot: PrDiffSnapshot = {
      baseRef: 'base-sha',
      headRef: 'head-sha',
      files: [
        {
          path: 'logo.png',
          kind: 'modified',
          isBinary: true,
          additions: 0,
          deletions: 0,
          hunks: [],
        },
      ],
      totalAdditions: 0,
      totalDeletions: 0,
    };
    const binaryPlan: SplitPlan = {
      finalGoal: 'Move the binary asset to a second child',
      concerns: [],
      children: [
        {
          index: 1,
          title: 'refactor: own the logo',
          type: 'refactor',
          dependsOn: [],
          changes: [{ file: 'logo.png', hunks: 'all' }],
          renames: [],
          testProof: 'npm test',
          risk: 'low',
          rationale: 'Owns the binary asset',
        },
        {
          index: 2,
          title: 'feat: empty target',
          type: 'feature',
          dependsOn: [1],
          changes: [],
          renames: [],
          testProof: 'npm test',
          risk: 'low',
          rationale: 'Will receive the binary asset',
        },
      ],
      parallelizable: 'No',
      landOrder: '1, 2',
      buildTestCommand: 'npm test',
      unassignedHunks: [],
    };
    const response: SplitPrPlanResponse = {
      plan: binaryPlan,
      snapshot: binarySnapshot,
      originalPr: {
        prNumber: 42,
        prUrl: 'https://github.com/example/repo/pull/42',
        baseBranch: 'main',
        headBranch: 'feature-branch',
        headSha: 'head-sha',
      },
    };

    let approved: SplitPlan | null = null;
    render({
      planResponse: response,
      onApprove: (edited) => {
        approved = edited;
      },
    });

    // Plan is valid to begin with (child 1 owns the whole binary file).
    expect(approveButton().disabled).toBe(false);

    // Expand child 1's binary file and reassign it whole to child 2.
    const child1FileToggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="split-plan-changes-file-1-logo.png"] button',
    );
    if (!child1FileToggle) throw new Error('binary file toggle not found');
    act(() => {
      child1FileToggle.click();
    });

    const selects = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="split-plan-changes-file-1-logo.png"] [role="combobox"]',
    );
    // Zero-hunk files render a single whole-file reassign select with no hunk
    // suffix in the aria-label.
    const wholeFileSelect = Array.from(selects).find(
      (select) => select.getAttribute('aria-label') === 'Reassign logo.png',
    );
    if (!wholeFileSelect) {
      throw new Error('whole-file reassignment select not found');
    }

    chooseChild(wholeFileSelect, '2');

    // Validation stays valid and Approve stays enabled after the move.
    expect(approveButton().disabled).toBe(false);
    expect(
      container.querySelector('[data-testid="split-plan-error-banner"]'),
    ).toBeNull();

    act(() => {
      approveButton().click();
    });

    expect(approved).not.toBeNull();
    const approvedPlan = approved as unknown as SplitPlan;
    const child2 = approvedPlan.children.find((c) => c.index === 2);
    if (!child2) throw new Error('child 2 not found in approved plan');
    const logoChange = child2.changes.find((c) => c.file === 'logo.png');
    if (!logoChange) throw new Error('logo.png change not found on child 2');
    // The target owns the binary file WHOLE, not as an empty index list.
    expect(logoChange.hunks).toBe('all');

    // Source child no longer owns the file.
    const child1 = approvedPlan.children.find((c) => c.index === 1);
    if (!child1) throw new Error('child 1 not found in approved plan');
    expect(child1.changes.some((c) => c.file === 'logo.png')).toBe(false);
  });

  it('onApprove receives the edited plan', () => {
    const validPlan = makeValidPlan();
    let approved: SplitPlan | null = null;
    render({
      planResponse: makePlanResponse(validPlan),
      onApprove: (edited) => {
        approved = edited;
      },
    });

    const titleInput = container.querySelector<HTMLInputElement>(
      '[data-testid="split-plan-title-1"]',
    );
    if (!titleInput) throw new Error('title input not found');

    act(() => {
      // React tracks the controlled value via a private setter, so set
      // through the native prototype setter before dispatching `input`.
      // eslint-disable-next-line @typescript-eslint/unbound-method -- invoked via .call, not stored as a method reference
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      nativeSetter?.call(titleInput, 'refactor: renamed title');
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    act(() => {
      approveButton().click();
    });

    expect(approved).not.toBeNull();
    const approvedPlan = approved as unknown as SplitPlan;
    expect(approvedPlan.children[0].title).toBe('refactor: renamed title');
  });

  it('re-seeds local plan state when a new planResponse is passed (Regenerate flow)', () => {
    const planA = makeValidPlan();
    const responseA = makePlanResponse(planA);
    render({ planResponse: responseA });

    // Edit child 1's title against planResponse A.
    const titleInput = container.querySelector<HTMLInputElement>(
      '[data-testid="split-plan-title-1"]',
    );
    if (!titleInput) throw new Error('title input not found');
    act(() => {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- invoked via .call, not stored as a method reference
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      nativeSetter?.call(titleInput, 'refactor: edited title for A');
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(
      container.querySelector<HTMLInputElement>(
        '[data-testid="split-plan-title-1"]',
      )?.value,
    ).toBe('refactor: edited title for A');

    // Simulate the Regenerate flow: parent passes a brand-new planResponse
    // object (different plan content, and specifically an invalid plan so we
    // can assert Approve gating reflects B, not the previously-valid A).
    const planB = makeValidPlan();
    planB.children[0].title = 'refactor: plan B title';
    planB.children[1].changes = []; // make B invalid (unassigned hunk)
    const responseB = makePlanResponse(planB);

    act(() => {
      root.render(
        <SplitPlanReviewPanel
          projectId="proj-1"
          worktreeId="wt-1"
          planResponse={responseB}
          onApprove={jest.fn()}
          onRegenerate={jest.fn()}
          onCancel={jest.fn()}
        />,
      );
    });

    // The modal must show B's title, not the stale edited A title.
    expect(
      container.querySelector<HTMLInputElement>(
        '[data-testid="split-plan-title-1"]',
      )?.value,
    ).toBe('refactor: plan B title');

    // Approve gating must reflect B's validity (invalid -> disabled).
    expect(approveButton().disabled).toBe(true);
    expect(
      container.querySelector('[data-testid="split-plan-error-banner"]'),
    ).not.toBeNull();
  });
});
