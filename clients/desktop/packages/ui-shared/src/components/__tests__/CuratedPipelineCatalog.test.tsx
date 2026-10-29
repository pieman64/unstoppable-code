/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
function click(selector: string): void {
  const element = container.querySelector<HTMLButtonElement>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  act(() => element.click());
}
function expectTokenRing(selector: string): void {
  const element = container.querySelector<HTMLElement>(selector);
  expect(element).not.toBeNull();
  expect(element?.className).toContain('ring-line-base');
  expect(element?.className).not.toContain('border-border');
}

import {
  CuratedPipelineCatalog,
  type CuratedPipelineCatalogProps,
} from '../CuratedPipelineCatalog';
import type { CuratedPipelineDetail } from '@canopy/protocol/pipeline-catalog';
const detail: CuratedPipelineDetail = {
  key: 'review',
  name: 'Review workflow',
  shortDescription: 'Review changes',
  version: '1',
  icon: '',
  triggerTypes: ['dispatch'],
  scopes: ['directory'],
  jobCount: 2,
  stepCount: 3,
  contentHash: 'a'.repeat(64),
  contentSizeBytes: 15,
  categories: ['quality'],
  popular: true,
  sortOrder: 0,
  revision: 1,
  authorName: null,
  authorUrl: null,
  docsUrl: null,
  createdAt: '2026-09-10',
  updatedAt: '2026-09-10',
  rawPipeline: 'name: Review',
};
function props(): CuratedPipelineCatalogProps {
  return {
    cloudDisplayName: 'Acme Cloud',
    rows: [detail],
    query: {},
    onQueryChange: jest.fn(),
    loading: false,
    onRefresh: jest.fn(),
    onLoadMore: jest.fn(),
    onSelect: jest.fn(),
    onBack: jest.fn(),
    onImport: jest.fn(),
  };
}
it('renders metadata and delegates selected preview without rendering definition text', () => {
  const input = props();
  act(() => root.render(<CuratedPipelineCatalog {...input} />));
  expect(
    container.querySelector('[data-testid="curated-pipeline-yaml"]'),
  ).toBeNull();
  expectTokenRing('[data-testid="curated-pipeline-refresh"]');
  expectTokenRing('[data-testid="curated-pipeline-search"]');
  expectTokenRing('[data-testid="curated-pipeline-rows"]');
  click('[data-testid="curated-pipeline-preview-review"]');
  expect(input.onSelect).toHaveBeenCalledWith(detail);
});
it('pins import to displayed detail and respects paired-device availability', () => {
  const input = props();
  act(() =>
    root.render(
      <CuratedPipelineCatalog
        {...input}
        selectedKey="review"
        detail={detail}
        importDisabledReason="Connect a desktop first."
      />,
    ),
  );
  expect(
    container
      .querySelector('[data-testid="curated-pipeline-add"]')
      ?.hasAttribute('disabled'),
  ).toBe(true);
  expectTokenRing('[data-testid="curated-pipeline-detail"]');
  expectTokenRing('[data-testid="curated-pipeline-yaml"]');
  expectTokenRing('[data-testid="curated-pipeline-add"]');
  act(() =>
    root.render(
      <CuratedPipelineCatalog
        {...input}
        selectedKey="review"
        detail={detail}
      />,
    ),
  );
  click('[data-testid="curated-pipeline-add"]');
  expect(input.onImport).toHaveBeenCalledWith(detail);
});
it('shows bounded error/stale state and delegates pagination', () => {
  const input = props();
  act(() =>
    root.render(
      <CuratedPipelineCatalog
        {...input}
        stale
        nextCursor="next"
        error="Offline"
      />,
    ),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    'Offline',
  );
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    'Connect to Acme Cloud',
  );
  click('[data-testid="curated-pipeline-load-more"]');
  expect(input.onLoadMore).toHaveBeenCalledTimes(1);
});
it('downloads only the selected detail through the injected callback', () => {
  const onDownload = jest.fn();
  act(() =>
    root.render(
      <CuratedPipelineCatalog
        {...props()}
        selectedKey="review"
        detail={detail}
        onDownload={onDownload}
      />,
    ),
  );
  click('[data-testid="curated-pipeline-download"]');
  expect(onDownload).toHaveBeenCalledWith(detail);
});
