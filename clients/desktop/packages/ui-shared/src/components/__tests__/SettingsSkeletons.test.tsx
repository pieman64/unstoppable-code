/** @jest-environment jsdom */
import type { JSX } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CenteredLoadingSpinner } from '../CenteredLoadingSpinner';
import { LoadingIndicatorStyleProvider } from '../LoadingIndicatorStyle';
import {
  SettingsCardsSkeleton,
  SettingsChartSkeleton,
  SettingsFormSkeleton,
  SettingsListSkeleton,
  SettingsTableSkeleton,
} from '../SettingsSkeletons';
import { SkeletonBlock } from '../SkeletonBlock';
import { SpinnerStyleProvider } from '../spinner-style';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(element: JSX.Element): void {
  act(() => {
    root.render(element);
  });
}

/** Text a sighted user would see: everything outside `.sr-only`. */
function visibleText(element: Element): string {
  const clone = element.cloneNode(true);
  if (!(clone instanceof Element)) {
    return '';
  }
  clone.querySelectorAll('.sr-only').forEach((node) => node.remove());
  return clone.textContent ?? '';
}

function statusRegion(testId: string): HTMLElement {
  const region = container.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
  if (!region) {
    throw new Error(`missing ${testId}`);
  }
  return region;
}

const SKELETONS: ReadonlyArray<{
  readonly testId: string;
  readonly element: JSX.Element;
}> = [
  {
    testId: 'settings-skeleton-list',
    element: <SettingsListSkeleton className="mt-4" />,
  },
  {
    testId: 'settings-skeleton-form',
    element: <SettingsFormSkeleton className="mt-4" />,
  },
  {
    testId: 'settings-skeleton-table',
    element: <SettingsTableSkeleton className="mt-4" />,
  },
  {
    testId: 'settings-skeleton-cards',
    element: <SettingsCardsSkeleton className="mt-4" />,
  },
  {
    testId: 'settings-skeleton-chart-bars',
    element: <SettingsChartSkeleton variant="bars" className="mt-4" />,
  },
  {
    testId: 'settings-skeleton-chart-graph',
    element: <SettingsChartSkeleton variant="graph" className="mt-4" />,
  },
];

describe('settings skeletons', () => {
  it.each(SKELETONS)(
    '$testId is a text-free status region announcing Loading',
    ({ testId, element }) => {
      render(element);
      const region = statusRegion(testId);
      expect(region.getAttribute('role')).toBe('status');
      expect(region.querySelector('.sr-only')?.textContent).toBe('Loading');
      expect(visibleText(region).trim()).toBe('');
      expect(region.className).toContain('mt-4');
    },
  );

  it.each(SKELETONS)(
    '$testId stops every animation under reduced motion and has no entry animation',
    ({ testId, element }) => {
      render(element);
      const region = statusRegion(testId);
      const animated = Array.from(
        region.querySelectorAll('[class*="animate-"]'),
      ).filter((node) =>
        Array.from(node.classList).some(
          (name) => name.startsWith('animate-') && name !== 'animate-none',
        ),
      );
      expect(animated.length).toBeGreaterThan(0);
      for (const node of animated) {
        expect(node.classList.contains('motion-reduce:animate-none')).toBe(
          true,
        );
        expect(node.classList.contains('animate-pulse')).toBe(true);
      }
      expect(region.className).not.toMatch(/animate-|fade|transition/);
    },
  );

  it('draws the requested number of list rows with circle or square avatars', () => {
    render(<SettingsListSkeleton rows={5} />);
    const region = statusRegion('settings-skeleton-list');
    expect(region.children).toHaveLength(6); // sr-only label + 5 rows
    expect(region.querySelectorAll('.rounded-full.size-8')).toHaveLength(5);

    render(<SettingsListSkeleton rows={2} avatarShape="square" />);
    const square = statusRegion('settings-skeleton-list');
    expect(square.querySelectorAll('.rounded-md.size-8')).toHaveLength(2);
    expect(square.querySelectorAll('.rounded-full.size-8')).toHaveLength(0);
  });

  it('draws form rows and table body rows from the rows prop', () => {
    render(<SettingsFormSkeleton rows={4} />);
    expect(statusRegion('settings-skeleton-form').children).toHaveLength(5);

    render(<SettingsTableSkeleton rows={2} />);
    // sr-only label + tinted header + 2 body rows
    expect(statusRegion('settings-skeleton-table').children).toHaveLength(4);
  });

  it('draws the graph silhouette as seven nodes', () => {
    render(<SettingsChartSkeleton variant="graph" />);
    const region = statusRegion('settings-skeleton-chart-graph');
    expect(region.querySelectorAll('circle')).toHaveLength(7);
    expect(region.querySelector('svg')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
  });
});

describe('SkeletonBlock', () => {
  it('is a hidden, text-free muted bar sized by its typed props', () => {
    render(<SkeletonBlock height="title" width="1/3" className="mt-2" />);
    const block = container.firstElementChild;
    expect(block?.getAttribute('aria-hidden')).toBe('true');
    expect(block?.textContent).toBe('');
    for (const name of [
      'bg-muted',
      'animate-pulse',
      'motion-reduce:animate-none',
      'rounded-full',
      'h-3.5',
      'w-1/3',
      'mt-2',
    ]) {
      expect(block?.classList.contains(name)).toBe(true);
    }
  });

  it.each([
    ['circle', ['size-8', 'rounded-full']],
    ['square', ['size-8', 'rounded-md']],
    ['toggle', ['h-5', 'w-9', 'rounded-full']],
    ['dot', ['size-3.5', 'rounded-full']],
    ['badge', ['h-5', 'w-16', 'rounded-full']],
    ['control', ['h-7', 'w-20', 'rounded-full']],
  ] as const)('draws the %s shape at its own size', (shape, classes) => {
    render(<SkeletonBlock shape={shape} height="value" width="full" />);
    const block = container.firstElementChild;
    for (const name of classes) {
      expect(block?.classList.contains(name)).toBe(true);
    }
    expect(block?.classList.contains('w-full')).toBe(false);
    expect(block?.classList.contains('motion-reduce:animate-none')).toBe(true);
  });
});

describe('CenteredLoadingSpinner', () => {
  it('centers one spinner in a text-free status region', () => {
    render(<CenteredLoadingSpinner className="mt-4" />);
    const region = statusRegion('centered-loading-spinner');
    expect(region.getAttribute('role')).toBe('status');
    expect(region.querySelector('.sr-only')?.textContent).toBe('Loading');
    expect(visibleText(region).trim()).toBe('');
    for (const name of [
      'flex',
      'flex-1',
      'min-h-full',
      'items-center',
      'justify-center',
      'mt-4',
    ]) {
      expect(region.classList.contains(name)).toBe(true);
    }
    // The spinner is decorative: the region already says "Loading".
    expect(region.querySelectorAll('[aria-label="Loading"]')).toHaveLength(0);
    expect(region.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
  });

  it('never degrades to loading copy under the text indicator style', () => {
    render(
      <LoadingIndicatorStyleProvider value="text">
        <CenteredLoadingSpinner />
      </LoadingIndicatorStyleProvider>,
    );
    const region = statusRegion('centered-loading-spinner');
    expect(visibleText(region).trim()).toBe('');
    expect(region.querySelector('.animate-loading-dot')).not.toBeNull();
  });

  it('follows the host spinner style', () => {
    render(
      <SpinnerStyleProvider value="comet">
        <CenteredLoadingSpinner />
      </SpinnerStyleProvider>,
    );
    const region = statusRegion('centered-loading-spinner');
    expect(region.querySelector('.animate-loading-dot')).toBeNull();
    expect(
      region.querySelector('.animate-comet-spin.motion-reduce\\:animate-none'),
    ).not.toBeNull();
    expect(visibleText(region).trim()).toBe('');
  });
});
