/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import {
  DagProgressBar,
  DagProgressDots,
  type DagJobMeta,
} from '../DagProgressBar';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function renderJobs(jobs: DagJobMeta[]): string {
  return renderToString(
    <DagProgressBar
      tiers={[jobs.map((job) => job.jobId)]}
      jobs={Object.fromEntries(jobs.map((job) => [job.jobId, job]))}
    />,
  );
}

describe('DagProgressBar status glyphs', () => {
  it.each(['running', 'restarting'] as const)(
    'draws a %s job as the neutral spinner, not a pulsing blue dot',
    (status) => {
      const html = renderJobs([
        { jobId: 'active', name: 'Active job', status },
      ]);

      expect(html).toContain('data-status-glyph="running"');
      expect(html).not.toContain('animate-pulse');
      expect(html).not.toMatch(/fg-info|fg-accent/);
    },
  );

  it.each([
    ['success', 'done'],
    ['failure', 'failed'],
    ['paused', 'paused'],
    ['cancelled', 'cancelled'],
    ['skipped', 'cancelled'],
    ['pending', 'queued'],
    [undefined, 'queued'],
  ] as const)('draws a %s job with the %s glyph', (status, glyph) => {
    const html = renderJobs([{ jobId: 'job', name: 'Job', status }]);
    expect(html).toContain(`data-status-glyph="${glyph}"`);
  });

  it('gives a cancelled job its own stop glyph, apart from a finished one', () => {
    const cancelled = renderJobs([
      { jobId: 'job', name: 'Job', status: 'cancelled' },
    ]);
    const done = renderJobs([{ jobId: 'job', name: 'Job', status: 'success' }]);
    expect(cancelled).toContain('fg-tertiary');
    expect(done).toContain('fg-success-strong');
    expect(cancelled).not.toContain('fg-success-strong');
  });
});

describe('DagProgressDots', () => {
  const STATUSES = [
    'running',
    'restarting',
    'success',
    'failure',
    'paused',
    'cancelled',
    'skipped',
    'pending',
    undefined,
  ] as const;
  const JOBS = STATUSES.map(
    (status, index): DagJobMeta => ({
      jobId: `job-${String(index)}`,
      name: `Job ${String(index)}`,
      status,
    }),
  );
  const glyphs = (html: string): string[] =>
    Array.from(
      html.matchAll(/data-status-glyph-state="([a-z]+)"/g),
      (match) => match[1] ?? '',
    );

  it("draws each job with the full bar's glyph state, in tier order", () => {
    const tiers = [JOBS.slice(0, 4), JOBS.slice(4)].map((tier) =>
      tier.map((job) => job.jobId),
    );
    const jobs = Object.fromEntries(JOBS.map((job) => [job.jobId, job]));
    const full = renderToString(<DagProgressBar tiers={tiers} jobs={jobs} />);
    const compact = renderToString(
      <DagProgressDots tiers={tiers} jobs={jobs} />,
    );
    expect(glyphs(compact)).toHaveLength(STATUSES.length);
    expect(glyphs(compact)).toEqual(glyphs(full));
    // Static: no job buttons, no popovers; a hairline between tiers.
    expect(compact).not.toContain('<button');
    expect(compact.match(/data-progress-stage-separator/g)).toHaveLength(1);
  });

  it.each(['running', 'restarting'] as const)(
    'uses the shared rotating comet for a %s job',
    (status) => {
      const html = renderToString(
        <DagProgressDots
          tiers={[['active']]}
          jobs={{ active: { jobId: 'active', name: 'Active', status } }}
        />,
      );
      expect(html).toContain('data-spinner="comet"');
    },
  );

  it('draws nothing without jobs', () => {
    expect(renderToString(<DagProgressDots tiers={[]} jobs={{}} />)).toBe('');
  });
});

describe('DagProgressBar overflow measurement', () => {
  it('batches initial overflow reads across animation frames', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const clientWidth = jest
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(100);
    const scrollWidth = jest
      .spyOn(HTMLElement.prototype, 'scrollWidth', 'get')
      .mockReturnValue(200);
    const frames: FrameRequestCallback[] = [];
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = (callback): number => {
      frames.push(callback);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = jest.fn();
    const jobs: Record<string, DagJobMeta> = {
      build: { jobId: 'build', name: 'Build', status: 'pending' },
    };

    try {
      act(() => {
        root.render(
          <>
            {Array.from({ length: 20 }, (_, index) => (
              <DagProgressBar
                key={index}
                tiers={[[`build-${index}`]]}
                jobs={{
                  [`build-${index}`]: {
                    ...jobs.build,
                    jobId: `build-${index}`,
                  },
                }}
              />
            ))}
          </>,
        );
      });

      expect(clientWidth).not.toHaveBeenCalled();
      expect(scrollWidth).not.toHaveBeenCalled();
      act(() => frames.shift()?.(0));
      expect(clientWidth.mock.calls.length).toBeGreaterThan(0);
      expect(clientWidth.mock.calls.length).toBeLessThan(20);
      while (frames.length > 0) {
        act(() => frames.shift()?.(0));
      }
      expect(clientWidth).toHaveBeenCalledTimes(20);
    } finally {
      act(() => root.unmount());
      while (frames.length > 0) {
        act(() => frames.shift()?.(0));
      }
      container.remove();
      clientWidth.mockRestore();
      scrollWidth.mockRestore();
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    }
  });

  it('does not force another layout read for value-equal DAG tiers', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const clientWidth = jest
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(100);
    const scrollWidth = jest
      .spyOn(HTMLElement.prototype, 'scrollWidth', 'get')
      .mockReturnValue(200);
    const jobs: Record<string, DagJobMeta> = {
      build: { jobId: 'build', name: 'Build', status: 'pending' },
      test: { jobId: 'test', name: 'Test', status: 'pending' },
    };

    try {
      act(() => {
        root.render(<DagProgressBar tiers={[['build', 'test']]} jobs={jobs} />);
      });
      const initialClientWidthReads = clientWidth.mock.calls.length;
      const initialScrollWidthReads = scrollWidth.mock.calls.length;

      act(() => {
        root.render(
          <DagProgressBar tiers={[['build', 'test']]} jobs={{ ...jobs }} />,
        );
      });

      expect(clientWidth).toHaveBeenCalledTimes(initialClientWidthReads);
      expect(scrollWidth).toHaveBeenCalledTimes(initialScrollWidthReads);
    } finally {
      act(() => root.unmount());
      container.remove();
      clientWidth.mockRestore();
      scrollWidth.mockRestore();
    }
  });
});

describe('DagProgressBar job card', () => {
  it('shows a job card on the shared hover tooltip', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() => {
        root.render(
          <DagProgressBar
            tiers={[['build']]}
            jobs={{
              build: {
                jobId: 'build',
                name: 'Build',
                status: 'success',
                stepProgress: '2/5',
              },
            }}
          />,
        );
      });
      const dot = container.querySelector<HTMLElement>('[data-job-id="build"]');
      expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
      act(() => {
        dot?.parentElement?.dispatchEvent(
          new MouseEvent('mouseover', {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
      });
      const card = document.body.querySelector(
        '[data-testid="dag-job-detail-build"]',
      );
      expect(card?.getAttribute('role')).toBe('tooltip');
      expect(container.contains(card)).toBe(false);
      expect(card?.textContent).toContain('Build');
      expect(card?.textContent).toContain('2/5');
      expect(dot?.getAttribute('aria-describedby')).toBe(card?.id);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
