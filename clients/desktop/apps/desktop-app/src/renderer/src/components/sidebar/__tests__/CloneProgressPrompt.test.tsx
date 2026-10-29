/** @jest-environment jsdom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useCloneJobsStore } from '@/stores/cloneJobsStore';
import { makeCloneJob } from '@/test-utils/cloneJobs';
import { CloneProgressPrompt } from '../CloneProgressPrompt';

describe('CloneProgressPrompt', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    useCloneJobsStore.setState({ jobs: [], received: false, isOpen: false });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(): void {
    act(() => root.render(createElement(CloneProgressPrompt)));
  }

  function pill(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(
      '[data-testid="clone-progress-sidebar"]',
    );
  }

  it('stays hidden while the Add project dialog still owns the clone', () => {
    useCloneJobsStore.setState({
      jobs: [makeCloneJob({ background: false })],
    });
    render();
    expect(pill()).toBeNull();
  });

  it('shows the clone and its progress, and opens the progress dialog', () => {
    useCloneJobsStore.setState({ jobs: [makeCloneJob({ percent: 42.7 })] });
    render();

    expect(pill()?.textContent).toContain('Cloning big-repo');
    expect(pill()?.textContent).toContain('42%');
    // One line, no bar: the percent is the progress, and the accessible name
    // carries it.
    expect(pill()?.getAttribute('aria-label')).toBe(
      'Open clone progress: Cloning big-repo, 42%',
    );
    expect(container.querySelector('[role="progressbar"]')).toBeNull();

    act(() => pill()?.click());
    expect(useCloneJobsStore.getState().isOpen).toBe(true);
  });

  it("shares the status banners' surface, hover wash, icon slot, and numerals", () => {
    useCloneJobsStore.setState({ jobs: [makeCloneJob({ percent: 42.7 })] });
    render();
    const banner = pill();
    // The update and sign-in banners keep their raised card under the
    // pointer and wash it; replacing the card with `bg-subtle` dropped it.
    expect(banner?.className).toContain('bg-quaternary');
    expect(banner?.className).not.toContain('hover:bg-subtle');
    expect(banner?.className).toContain(
      'hover:[background-image:linear-gradient(var(--bg-subtle),var(--bg-subtle))]',
    );
    // The same 20px leading slot as the update banner, so labels share an edge.
    expect(
      banner?.querySelector('[data-testid="sidebar-footer-banner-icon"]')
        ?.className,
    ).toContain('ml-0.5 inline-flex h-5 w-5');
    expect(
      banner?.querySelector('[data-testid="clone-progress-percent"]')
        ?.className,
    ).toContain('tabular-nums');
  });

  it('carries a failure on the leading glyph, not the label', () => {
    useCloneJobsStore.setState({
      jobs: [
        makeCloneJob({
          status: 'failed',
          error: 'fatal: repository not found',
          cancellable: false,
        }),
      ],
    });
    render();
    expect(
      pill()?.querySelector('[data-testid="sidebar-footer-banner-icon"]')
        ?.className,
    ).toContain('fg-destructive');
    expect(pill()?.querySelector('.truncate')?.className).not.toContain(
      'fg-destructive',
    );
  });

  it('summarizes several clones', () => {
    useCloneJobsStore.setState({
      jobs: [
        makeCloneJob({ id: 'a', percent: 20 }),
        makeCloneJob({ id: 'b', repoName: 'other', percent: 60 }),
      ],
    });
    render();
    expect(pill()?.textContent).toContain('Cloning 2 projects');
    expect(pill()?.textContent).toContain('40%');
  });

  it('leads with a failure until it is dismissed', () => {
    useCloneJobsStore.setState({
      jobs: [
        makeCloneJob({
          status: 'failed',
          error: 'fatal: repository not found',
          cancellable: false,
        }),
      ],
    });
    render();
    expect(pill()?.textContent).toContain("Couldn't clone big-repo");
    expect(pill()?.textContent).not.toContain('%');
  });

  it('shows a finished clone until main removes it', () => {
    useCloneJobsStore.setState({
      jobs: [makeCloneJob({ status: 'succeeded', percent: 100 })],
    });
    render();
    expect(pill()?.textContent).toContain('Added big-repo');

    act(() => useCloneJobsStore.getState().apply([]));
    expect(pill()).toBeNull();
  });

  it.each([
    ['running', makeCloneJob({ id: 'job-2', repoName: 'other' })],
    [
      'failed',
      makeCloneJob({
        id: 'job-2',
        repoName: 'other',
        status: 'failed',
        cancellable: false,
        error: 'fatal: repository not found',
      }),
    ],
  ])(
    'keeps the pill for a %s clone after a successful one leaves',
    (_status, remaining) => {
      useCloneJobsStore.setState({
        jobs: [makeCloneJob({ status: 'succeeded', percent: 100 }), remaining],
      });
      render();

      act(() => useCloneJobsStore.getState().apply([remaining]));
      expect(pill()).not.toBeNull();
      expect(pill()?.textContent).toContain(remaining.repoName);
      expect(pill()?.textContent).not.toContain('big-repo');
    },
  );
});
