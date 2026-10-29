/**
 * @jest-environment jsdom
 *
 * Step and job detail building blocks at panel widths: timing grids take
 * their columns from their own container (never the window), keep labels and
 * values on one line, and fill a row they share with a label; key/value
 * tables stack each value under its key when narrow instead of squeezing the
 * value column until `timeout_minutes 30` breaks into `3` / `0`.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { formatTimingTimestamp } from '@/lib/pipelineTiming';
import {
  KeyValueTable,
  TimingSummaryCard,
  TimingSummaryGrid,
} from '../details/PipelineStepDetailParts';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const STARTED_AT = '2026-09-29T21:02:02.000Z';

describe('PipelineStepDetailParts', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function all(testId: string): HTMLElement[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
    );
  }

  describe('TimingSummaryGrid', () => {
    it('takes one, two, then three columns from its own container', () => {
      act(() => {
        root.render(
          <TimingSummaryGrid
            identity="step:exec-1:build:compile"
            kind="step"
            status="running"
            startedAt={STARTED_AT}
          />,
        );
      });
      const [grid] = all('pipeline-timing-grid');
      expect(grid.parentElement?.classList).toContain('@container');
      expect(Array.from(grid.classList)).toEqual(
        expect.arrayContaining([
          'grid-cols-1',
          '@xs:grid-cols-2',
          '@lg:grid-cols-3',
        ]),
      );
      // The old window breakpoint gave three columns in any panel.
      expect(grid.className).not.toContain('sm:grid-cols-3');
    });

    it('uses tighter column steps when compact', () => {
      act(() => {
        root.render(
          <TimingSummaryGrid
            identity="job:exec-1:build"
            kind="job"
            status="running"
            startedAt={STARTED_AT}
            compact
          />,
        );
      });
      const [grid] = all('pipeline-timing-grid');
      expect(Array.from(grid.classList)).toEqual(
        expect.arrayContaining([
          'grid-cols-1',
          '@3xs:grid-cols-2',
          '@sm:grid-cols-3',
        ]),
      );
      // A fixed three columns squeezed timestamps in a narrow panel.
      expect(grid.classList).not.toContain('grid-cols-3');
    });

    it('keeps labels and values on one line and fills a row it shares', () => {
      act(() => {
        root.render(
          <div className="flex">
            <span>Attempt 2</span>
            <TimingSummaryGrid
              identity="attempt:exec-1:build:retry:2"
              kind="job"
              status="success"
              startedAt={STARTED_AT}
              completedAt={STARTED_AT}
              compact
            />
          </div>,
        );
      });
      const [grid] = all('pipeline-timing-grid');
      expect(Array.from(grid.parentElement?.classList ?? [])).toEqual(
        expect.arrayContaining(['min-w-0', 'flex-1']),
      );
      const values = all('pipeline-timing-field-value');
      expect(values).toHaveLength(3);
      const [started, completed, duration] = values;
      expect(started.textContent).toBe(formatTimingTimestamp(STARTED_AT));
      expect(started.classList).toContain('truncate');
      expect(started.title).toBe(formatTimingTimestamp(STARTED_AT));
      expect(completed.classList).toContain('truncate');
      expect(duration.classList).toContain('whitespace-nowrap');
      expect(container.innerHTML).not.toContain('break-all');
    });

    it('is the grid of the step Timing card', () => {
      act(() => {
        root.render(
          <TimingSummaryCard
            title="Step"
            identity="step:exec-1:build:compile"
            kind="step"
            status="running"
            startedAt={STARTED_AT}
          />,
        );
      });
      expect(all('pipeline-timing-grid')).toHaveLength(1);
    });
  });

  describe('KeyValueTable', () => {
    it('stacks narrow and shares a row from 20rem, wrapping values at words', () => {
      act(() => {
        root.render(
          <KeyValueTable
            values={{
              timeout_minutes: 30,
              working_directory: '/Users/someone/work/repo/packages/app',
            }}
          />,
        );
      });
      const [table] = all('pipeline-key-value-table');
      expect(table.classList).toContain('@container');
      const rows = all('pipeline-key-value-row');
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(Array.from(row.classList)).toEqual(
          expect.arrayContaining([
            'grid-cols-1',
            '@xs:grid-cols-[minmax(120px,180px)_minmax(0,1fr)]',
          ]),
        );
      }
      const [timeoutKey, timeoutValue] = Array.from(rows[0].children);
      expect(timeoutKey.textContent).toBe('timeout_minutes');
      expect(timeoutKey.getAttribute('title')).toBe('timeout_minutes');
      expect(timeoutValue.textContent).toBe('30');
      expect(timeoutValue.classList).toContain('break-words');
      expect(container.innerHTML).not.toContain('break-all');
    });

    it('renders nothing for no values', () => {
      act(() => {
        root.render(<KeyValueTable values={{}} />);
      });
      expect(container.innerHTML).toBe('');
    });
  });
});
