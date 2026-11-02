/**
 * @jest-environment jsdom
 *
 * The run's job list: its status filter menu closes on Escape (without the
 * key reaching an enclosing preview) and on a press outside it, the list
 * carries the id a panel's toggle names in `aria-controls`, every row draws
 * the shared focus ring inside its edges, and status dots use the solid
 * status roles.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ExecutionState,
  MaterializedJob,
} from '@canopy/desktop-shared/types/pipeline';
import { PipelineDetailsNav } from '../details/PipelineDetailsNav';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const STATE: ExecutionState = {
  version: 8,
  id: 'exec-1',
  pipeline_id: 'pipeline-1',
  pipeline_snapshot: {
    name: 'Build pipeline',
    scope: ['directory'],
    jobs: {
      build: {
        name: 'Build',
        needs: [],
        timeout_minutes: 60,
        max_retries: 0,
        continue_on_error: false,
        steps: [],
      },
    },
  },
  status: 'running',
  jobs: {
    build: {
      status: 'running',
      steps: {},
      outputs: {},
      iteration_count: 1,
    },
  },
  job_definitions: {},
  job_groups: {},
  pending_pauses: [],
  status_reasons: [],
  started_at: '2026-05-19T00:00:00.000Z',
  cwd: '/repo',
  env: {},
  inputs: {},
  event_name: 'dispatch',
};

function variant(
  index: number,
  values: Record<string, string>,
): MaterializedJob {
  return {
    name: `Test (${Object.values(values).join(', ')})`,
    needs: [],
    timeout_minutes: 60,
    max_retries: 0,
    continue_on_error: false,
    steps: [],
    physical_job_id: `test-${index}`,
    logical_job_id: 'test',
    matrix: { index, total: 2, values },
  };
}

/** `STATE` plus a failed matrix job with two variants. */
const MATRIX_STATE: ExecutionState = {
  ...STATE,
  pipeline_snapshot: {
    ...STATE.pipeline_snapshot,
    jobs: {
      ...STATE.pipeline_snapshot.jobs,
      test: {
        name: 'Test',
        needs: [],
        timeout_minutes: 60,
        max_retries: 0,
        continue_on_error: false,
        steps: [],
      },
    },
  },
  jobs: {
    ...STATE.jobs,
    'test-0': { status: 'success', steps: {}, outputs: {}, iteration_count: 1 },
    'test-1': { status: 'failure', steps: {}, outputs: {}, iteration_count: 1 },
  },
  job_definitions: {
    'test-0': variant(0, { os: 'mac' }),
    'test-1': variant(1, { os: 'linux' }),
  },
  job_groups: {
    test: {
      job_id: 'test',
      kind: 'matrix',
      expansion: 'expanded',
      variant_job_ids: ['test-0', 'test-1'],
      status: 'failure',
    },
  },
};

describe('PipelineDetailsNav', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onSelect = jest.fn();

  beforeEach(() => {
    onSelect.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <PipelineDetailsNav
          id="panel-1-pipeline-jobs"
          state={STATE}
          jobOrder={['build']}
          selected={null}
          statusFilter="all"
          onSelect={onSelect}
          onStatusFilter={jest.fn()}
          onOpenDefinition={jest.fn()}
        />,
      );
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function byTestId(testId: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${testId}"]`);
  }

  function openFilter(): HTMLElement {
    const button = byTestId('pipeline-details-filter-button');
    if (button === null) throw new Error('missing filter button');
    act(() => {
      button.click();
    });
    expect(byTestId('pipeline-details-filter-popover')).not.toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    return button;
  }

  it('draws the shared focus ring inside every full-bleed row', () => {
    for (const testId of [
      'pipeline-details-nav-summary',
      'pipeline-details-nav-job-build',
      'pipeline-job-list-definition',
      'pipeline-details-open-definition',
    ]) {
      const classes = byTestId(testId)?.classList;
      expect(classes?.contains('focus-ring')).toBe(true);
      expect(classes?.contains('focus-ring-inset')).toBe(true);
    }
    openFilter();
    const menuRows = byTestId(
      'pipeline-details-filter-popover',
    )?.querySelectorAll('button');
    expect(menuRows?.length).toBeGreaterThan(0);
    for (const row of Array.from(menuRows ?? [])) {
      expect(row.classList.contains('focus-ring')).toBe(true);
    }
  });

  it('fills status dots with the solid status role, not a badge tint', () => {
    // No group yet: the job is pending, drawn like the run card's pending
    // dot (a solid neutral fill that reads in dark mode).
    const dot = byTestId('pipeline-details-nav-job-build')?.querySelector(
      'span[aria-hidden="true"]',
    );
    expect(dot?.classList.contains('bg-fg-secondary')).toBe(true);
    expect(dot?.className).not.toContain('subtle');
    expect(dot?.className).not.toContain('/');
  });

  it('draws the ring inside matrix toggles and variant rows too', () => {
    act(() => {
      root.render(
        <PipelineDetailsNav
          state={MATRIX_STATE}
          jobOrder={['build', 'test']}
          selected={{ jobId: 'test', variantJobId: 'test-1' }}
          statusFilter="all"
          onSelect={onSelect}
          onStatusFilter={jest.fn()}
          onOpenDefinition={jest.fn()}
        />,
      );
    });
    const toggle = byTestId('pipeline-details-nav-job-toggle-test');
    const variantRow = byTestId('pipeline-details-nav-child-test-test-1');
    for (const element of [toggle, variantRow]) {
      expect(element?.classList.contains('focus-ring')).toBe(true);
      expect(element?.classList.contains('focus-ring-inset')).toBe(true);
    }
    const groupDot = byTestId('pipeline-details-nav-job-test')?.querySelector(
      'span[aria-hidden="true"]',
    );
    expect(groupDot?.classList.contains('bg-fg-destructive-strong')).toBe(true);
    const variantDot = variantRow?.querySelector('span[aria-hidden="true"]');
    expect(variantDot?.classList.contains('bg-fg-destructive-strong')).toBe(
      true,
    );
    const passedDot = byTestId(
      'pipeline-details-nav-child-test-test-0',
    )?.querySelector('span[aria-hidden="true"]');
    expect(passedDot?.classList.contains('bg-fg-success-strong')).toBe(true);
  });

  /**
   * The selection marker is a painted element, not a border color: the
   * unlayered `* { border-color }` base rule beats every `border-<color>`
   * utility (CAN-2734), so a border-based marker looks identical selected
   * and unselected.
   */
  function selectionMarker(row: HTMLElement | null): Element | null {
    return (
      row?.querySelector(
        '[data-testid="pipeline-details-nav-selection-marker"]',
      ) ?? null
    );
  }

  function expectNoBorderMarker(row: HTMLElement | null): void {
    const classes = Array.from(row?.classList ?? []);
    expect(classes.filter((name) => name.startsWith('border-l'))).toEqual([]);
    expect(classes).not.toContain('border-line-accent');
    expect(classes).not.toContain('border-transparent');
  }

  it('marks the selected matrix variant with a painted accent line', () => {
    act(() => {
      root.render(
        <PipelineDetailsNav
          state={MATRIX_STATE}
          jobOrder={['build', 'test']}
          selected={{ jobId: 'test', variantJobId: 'test-1' }}
          statusFilter="all"
          onSelect={onSelect}
          onStatusFilter={jest.fn()}
          onOpenDefinition={jest.fn()}
        />,
      );
    });
    const selectedRow = byTestId('pipeline-details-nav-child-test-test-1');
    const otherRow = byTestId('pipeline-details-nav-child-test-test-0');

    const marker = selectionMarker(selectedRow);
    expect(marker?.classList.contains('line-accent')).toBe(true);
    expect(marker?.getAttribute('aria-hidden')).toBe('true');
    expect(selectedRow?.classList.contains('relative')).toBe(true);
    expect(selectionMarker(otherRow)).toBeNull();
    for (const row of [selectedRow, otherRow]) expectNoBorderMarker(row);
    // Selecting a variant does not also mark its group or the summary.
    expect(
      selectionMarker(
        byTestId('pipeline-details-nav-job-test')?.parentElement ?? null,
      ),
    ).toBeNull();
    expect(
      selectionMarker(byTestId('pipeline-details-nav-summary')),
    ).toBeNull();
  });

  it('marks the selected summary and job rows the same way', () => {
    const summary = byTestId('pipeline-details-nav-summary');
    const jobRow =
      byTestId('pipeline-details-nav-job-build')?.parentElement ?? null;
    expect(selectionMarker(summary)?.classList.contains('line-accent')).toBe(
      true,
    );
    expect(selectionMarker(jobRow)).toBeNull();
    for (const row of [summary, jobRow]) expectNoBorderMarker(row);

    act(() => {
      root.render(
        <PipelineDetailsNav
          state={STATE}
          jobOrder={['build']}
          selected={{ jobId: 'build' }}
          statusFilter="all"
          onSelect={onSelect}
          onStatusFilter={jest.fn()}
          onOpenDefinition={jest.fn()}
        />,
      );
    });
    expect(
      selectionMarker(byTestId('pipeline-details-nav-summary')),
    ).toBeNull();
    const selectedJobRow =
      byTestId('pipeline-details-nav-job-build')?.parentElement ?? null;
    expect(
      selectionMarker(selectedJobRow)?.classList.contains('line-accent'),
    ).toBe(true);
  });

  it('lists Definition used after the run entries and selects it', () => {
    const entry = byTestId('pipeline-job-list-definition');
    expect(entry?.textContent).toBe('Definition used');
    expect(entry?.getAttribute('aria-current')).toBeNull();
    expect(selectionMarker(entry)).toBeNull();
    // Between Summary (and Cost, when the run has one) and the job list.
    const nav = byTestId('pipeline-details-nav');
    const order = Array.from(nav?.querySelectorAll('[data-testid]') ?? []).map(
      (element) => element.getAttribute('data-testid'),
    );
    expect(order.indexOf('pipeline-job-list-definition')).toBeGreaterThan(
      order.indexOf('pipeline-details-nav-summary'),
    );
    expect(order.indexOf('pipeline-job-list-definition')).toBeLessThan(
      order.indexOf('pipeline-details-nav-job-build'),
    );
    act(() => {
      entry?.click();
    });
    expect(onSelect).toHaveBeenCalledWith({ entry: 'definition' });

    act(() => {
      root.render(
        <PipelineDetailsNav
          state={STATE}
          jobOrder={['build']}
          selected={{ entry: 'definition' }}
          costEntry={{ amount: '$1.20' }}
          statusFilter="all"
          onSelect={onSelect}
          onStatusFilter={jest.fn()}
          onOpenDefinition={jest.fn()}
        />,
      );
    });
    const selected = byTestId('pipeline-job-list-definition');
    expect(selected?.getAttribute('aria-current')).toBe('true');
    expect(selectionMarker(selected)?.classList.contains('line-accent')).toBe(
      true,
    );
    expect(
      selectionMarker(byTestId('pipeline-details-nav-summary')),
    ).toBeNull();
    expect(selectionMarker(byTestId('pipeline-job-list-cost'))).toBeNull();
    const withCost = Array.from(
      byTestId('pipeline-details-nav')?.querySelectorAll('[data-testid]') ?? [],
    ).map((element) => element.getAttribute('data-testid'));
    expect(withCost.indexOf('pipeline-job-list-definition')).toBe(
      withCost.indexOf('pipeline-job-list-cost') + 1,
    );
  });

  it('labels the editor link as the current definition', () => {
    const onOpenDefinition = jest.fn();
    act(() => {
      root.render(
        <PipelineDetailsNav
          state={STATE}
          jobOrder={['build']}
          selected={null}
          statusFilter="all"
          onSelect={onSelect}
          onStatusFilter={jest.fn()}
          onOpenDefinition={onOpenDefinition}
        />,
      );
    });
    const link = byTestId('pipeline-details-open-definition');
    expect(link?.textContent).toBe('Open current definition ↗');
    act(() => {
      link?.click();
    });
    expect(onOpenDefinition).toHaveBeenCalledWith({
      pipelineId: 'pipeline-1',
      cwd: '/repo',
    });
  });

  it('names itself for a toggle’s aria-controls', () => {
    const nav = byTestId('pipeline-details-nav');
    expect(nav?.id).toBe('panel-1-pipeline-jobs');
    expect(nav?.getAttribute('aria-label')).toBe('Jobs');
  });

  it('closes the filter menu on Escape and keeps focus on its button', () => {
    const button = openFilter();
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      button.dispatchEvent(event);
    });
    expect(byTestId('pipeline-details-filter-popover')).toBeNull();
    expect(document.activeElement).toBe(button);
    // An enclosing preview or dialog sees the key as already handled.
    expect(event.defaultPrevented).toBe(true);
  });

  it('closes the filter menu on a press outside it, not inside it', () => {
    openFilter();
    const popover = byTestId('pipeline-details-filter-popover');
    act(() => {
      popover?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(byTestId('pipeline-details-filter-popover')).not.toBeNull();
    act(() => {
      document.body.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true }),
      );
    });
    expect(byTestId('pipeline-details-filter-popover')).toBeNull();
  });
});
