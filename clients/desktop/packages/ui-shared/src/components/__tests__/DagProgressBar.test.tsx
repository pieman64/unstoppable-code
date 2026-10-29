/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { DagProgressBar, type DagJobMeta } from '../DagProgressBar';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function renderJobs(jobs: DagJobMeta[]): string {
  return renderToString(
    <DagProgressBar
      tiers={[jobs.map((job) => job.jobId)]}
      jobs={Object.fromEntries(jobs.map((job) => [job.jobId, job]))}
    />,
  );
}

describe('DagProgressBar operational colors', () => {
  it.each(['running', 'restarting'] as const)(
    'uses the stable active blue for a %s job dot',
    (status) => {
      const html = renderJobs([
        { jobId: 'active', name: 'Active job', status },
      ]);

      expect(html).toContain('bg-fg-info');
      expect(html).not.toContain('bg-info');
      expect(html).not.toContain('purple');
      expect(html).not.toContain('violet');
    },
  );

  it('keeps completed and pending dots distinct from the active blue', () => {
    const html = renderJobs([
      { jobId: 'success', name: 'Successful job', status: 'success' },
      { jobId: 'pending', name: 'Pending job', status: 'pending' },
    ]);

    expect(html).toContain('bg-fg-success-strong');
    expect(html).toContain('bg-fg-secondary');
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
