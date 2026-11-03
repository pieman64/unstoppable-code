/**
 * @jest-environment jsdom
 *
 * The run facts at the top of the Summary view reflow with the width the bar
 * is given (a container query, not the window's width): one column, two from
 * 20rem, four from 42rem. Values stay on one line (a timestamp never breaks
 * mid-token); long free text such as the working directory and event inputs
 * wraps at word boundaries, never per character.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ExecutionState } from '@canopy/desktop-shared/types/pipeline';
import { formatTimingTimestamp } from '@/lib/pipelineTiming';
import { PipelineSummaryBar } from '../details/PipelineSummaryBar';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const STARTED_AT = '2026-09-29T21:02:09.000Z';

const STATE: ExecutionState = {
  version: 8,
  id: 'exec-1',
  pipeline_id: 'pipeline-1',
  pipeline_snapshot: {
    name: 'Release check',
    scope: ['directory'],
    jobs: {},
  },
  status: 'running',
  jobs: {},
  job_definitions: {},
  job_groups: {},
  pending_pauses: [],
  status_reasons: [],
  started_at: STARTED_AT,
  cwd: '/Users/someone/work/a-very-long-repository-name/packages/app',
  env: {},
  inputs: { target_environment: 'production-eu-west-1' },
  event_name: 'dispatch',
};

describe('PipelineSummaryBar', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root.render(<PipelineSummaryBar state={STATE} />);
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

  function fieldValue(label: string): HTMLElement | null {
    return (
      byTestId(`pipeline-summary-field-${label}`)?.querySelector<HTMLElement>(
        '[data-testid="pipeline-summary-field-value"]',
      ) ?? null
    );
  }

  it('reflows its facts by its own width: one, two, then four columns', () => {
    expect(byTestId('pipeline-summary-bar')?.classList).toContain('@container');
    const fields = byTestId('pipeline-summary-fields');
    expect(Array.from(fields?.classList ?? [])).toEqual(
      expect.arrayContaining([
        'grid',
        'grid-cols-1',
        '@xs:grid-cols-2',
        '@2xl:grid-cols-4',
      ]),
    );
    // No window breakpoint decides the columns.
    expect(fields?.className).not.toMatch(/(^|\s)(sm|md|lg):grid-cols/);
  });

  it('keeps every value on one line, never breaking a timestamp mid-token', () => {
    const started = fieldValue('started');
    expect(started?.textContent).toBe(formatTimingTimestamp(STARTED_AT));
    expect(started?.classList).toContain('truncate');
    // A truncated value still offers its full text.
    expect(started?.title).toBe(formatTimingTimestamp(STARTED_AT));
    expect(fieldValue('completed')?.classList).toContain('truncate');
    // Element values (the status pill, the live timer) are never clipped.
    expect(fieldValue('status')?.classList).toContain('whitespace-nowrap');
    expect(fieldValue('duration')?.classList).toContain('whitespace-nowrap');
    const pill = fieldValue('status')?.querySelector('span span');
    expect(pill?.textContent).toBe('running');
    expect(pill?.classList).toContain('whitespace-nowrap');
    expect(container.innerHTML).not.toContain('break-all');
  });

  it('wraps long free text at word boundaries, not per character', () => {
    act(() => {
      byTestId('pipeline-summary-more')?.click();
    });
    const cwd = Array.from(container.querySelectorAll('dd')).find(
      (value) => value.textContent === STATE.cwd,
    );
    expect(cwd?.classList).toContain('break-words');
    // Event inputs use the shared key/value table, which stacks when narrow.
    const table = byTestId('pipeline-key-value-table');
    expect(table?.textContent).toContain('target_environment');
    expect(table?.textContent).toContain('production-eu-west-1');
    expect(container.innerHTML).not.toContain('break-all');
  });
});
