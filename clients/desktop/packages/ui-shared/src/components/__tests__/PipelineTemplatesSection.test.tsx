/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PipelineTemplatesSection } from '../PipelineTemplatesSection';
import type { CuratedPipelineCatalogProps } from '../CuratedPipelineCatalog';
import type { CuratedPipelineDetail } from '@canopy/protocol/pipeline-catalog';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

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

function props(): CuratedPipelineCatalogProps {
  return {
    cloudDisplayName: 'Acme Cloud',
    rows: Array.from({ length: 5 }, (_, i) => ({
      ...detail,
      key: `review-${i}`,
      name: `Review ${i}`,
    })),
    query: {},
    onQueryChange: jest.fn(),
    loading: false,
    onRefresh: jest.fn(),
    onLoadMore: jest.fn(),
    onSelect: jest.fn(),
    onBack: jest.fn(),
    onImport: jest.fn(),
    onDownload: jest.fn(),
  };
}

function click(testId: string): void {
  const button = document.querySelector<HTMLButtonElement>(
    `[data-testid="${testId}"]`,
  );
  if (!button) throw new Error(`Missing ${testId}`);
  act(() => button.click());
}

it('shows only the first three real entries without catalog filters and delegates Use template', () => {
  const catalog = props();
  act(() => root.render(<PipelineTemplatesSection catalog={catalog} />));
  expect(container.querySelectorAll('li')).toHaveLength(3);
  expect(container.textContent).toContain('Review 0');
  expect(container.textContent).not.toContain('Review 3');
  expect(container.querySelector('input')).toBeNull();
  expect(container.querySelector('select')).toBeNull();
  click('pipeline-template-use-review-0');
  expect(catalog.onSelect).toHaveBeenCalledWith(catalog.rows[0]);
  expect(catalog.onImport).not.toHaveBeenCalled();
});

it('opens the complete searchable catalog and preserves pagination and selected-detail import', () => {
  const catalog = props();
  act(() => root.render(<PipelineTemplatesSection catalog={catalog} />));
  click('pipeline-templates-view-all');
  const dialog = document.querySelector(
    '[data-testid="pipeline-templates-dialog"]',
  );
  expect(
    dialog?.querySelectorAll('[data-testid="curated-pipeline-rows"] li'),
  ).toHaveLength(5);
  expect(
    dialog?.querySelector('[data-testid="curated-pipeline-search"]'),
  ).not.toBeNull();
  act(() =>
    root.render(
      <PipelineTemplatesSection catalog={{ ...catalog, nextCursor: 'next' }} />,
    ),
  );
  click('curated-pipeline-load-more');
  expect(catalog.onLoadMore).toHaveBeenCalledTimes(1);
  act(() =>
    root.render(
      <PipelineTemplatesSection
        catalog={{ ...catalog, selectedKey: detail.key, detail }}
      />,
    ),
  );
  click('curated-pipeline-add');
  expect(catalog.onImport).toHaveBeenCalledWith(detail);
  click('curated-pipeline-download');
  expect(catalog.onDownload).toHaveBeenCalledWith(detail);
});

it('hides an empty catalog but keeps no-match filters reachable in an already open catalog', () => {
  const catalog = props();
  act(() =>
    root.render(
      <PipelineTemplatesSection catalog={{ ...catalog, rows: [] }} />,
    ),
  );
  expect(container.textContent).toBe('');
  expect(
    document.querySelector('[data-testid="pipeline-templates-dialog"]'),
  ).toBeNull();
  act(() => root.render(<PipelineTemplatesSection catalog={catalog} />));
  click('pipeline-templates-view-all');
  act(() =>
    root.render(
      <PipelineTemplatesSection
        catalog={{ ...catalog, rows: [], query: { q: 'missing' } }}
      />,
    ),
  );
  expect(
    document.querySelector('[data-testid="curated-pipeline-search"]'),
  ).not.toBeNull();
  expect(document.body.textContent).toContain(
    'No pipeline templates match these filters.',
  );
});

it('opens deep-linked previews without needing any catalog cards', () => {
  const catalog = props();
  act(() =>
    root.render(
      <PipelineTemplatesSection
        catalog={{ ...catalog, rows: [], selectedKey: detail.key, detail }}
      />,
    ),
  );
  expect(
    container.querySelector('[data-testid="pipeline-templates-section"]'),
  ).toBeNull();
  expect(
    document.querySelector('[data-testid="curated-pipeline-detail"]'),
  ).not.toBeNull();
});

function closeDialog(): void {
  const close = document.querySelector<HTMLButtonElement>(
    '[data-testid="pipeline-templates-dialog"] button[aria-label="Close"]',
  );
  if (!close) throw new Error('Missing dialog close button');
  act(() => close.click());
}

it('keeps an unchanged query, and the pages it loaded, when the catalog closes', () => {
  const catalog = props();
  act(() => root.render(<PipelineTemplatesSection catalog={catalog} />));
  click('pipeline-templates-view-all');
  closeDialog();
  expect(catalog.onQueryChange).not.toHaveBeenCalled();
  expect(catalog.onBack).toHaveBeenCalledTimes(1);
  expect(container.querySelectorAll('li')).toHaveLength(3);

  // A search or filter is reset to the default first page on close.
  act(() =>
    root.render(
      <PipelineTemplatesSection
        catalog={{ ...catalog, query: { q: 'review', scope: 'directory' } }}
      />,
    ),
  );
  click('pipeline-templates-view-all');
  closeDialog();
  expect(catalog.onQueryChange).toHaveBeenCalledWith({ limit: 25 });
});

it('shows a first-page failure with a retry, then the templates once it succeeds', () => {
  const catalog = props();
  act(() =>
    root.render(
      <PipelineTemplatesSection
        catalog={{ ...catalog, rows: [], error: 'Catalog request failed' }}
      />,
    ),
  );
  const status = container.querySelector(
    '[data-testid="pipeline-templates-section-status"]',
  );
  expect(status?.querySelector('[role="alert"]')?.textContent).toBe(
    'Catalog request failed',
  );
  click('pipeline-templates-retry');
  expect(catalog.onRefresh).toHaveBeenCalledTimes(1);

  act(() =>
    root.render(
      <PipelineTemplatesSection
        catalog={{ ...catalog, rows: [], error: null, loading: true }}
      />,
    ),
  );
  expect(
    container.querySelector(
      '[data-testid="pipeline-templates-section-status"] [role="status"]',
    )?.textContent,
  ).toBe('Loading pipeline templates…');

  act(() => root.render(<PipelineTemplatesSection catalog={catalog} />));
  expect(
    container.querySelector(
      '[data-testid="pipeline-templates-section-status"]',
    ),
  ).toBeNull();
  expect(container.querySelectorAll('li')).toHaveLength(3);

  // A successful empty catalog still hides the section entirely.
  act(() =>
    root.render(
      <PipelineTemplatesSection catalog={{ ...catalog, rows: [] }} />,
    ),
  );
  expect(container.textContent).toBe('');
});

it('keeps keyboard focus inside the open catalog and returns it to the trigger', () => {
  const catalog = props();
  act(() => root.render(<PipelineTemplatesSection catalog={catalog} />));
  const trigger = document.querySelector<HTMLButtonElement>(
    '[data-testid="pipeline-templates-view-all"]',
  );
  if (!trigger) throw new Error('Missing view-all trigger');
  trigger.focus();
  act(() => trigger.click());
  const dialog = document.querySelector(
    '[data-testid="pipeline-templates-dialog"]',
  );
  expect(dialog?.contains(document.activeElement)).toBe(true);
  // Shift+Tab from the first control wraps inside the dialog instead of
  // reaching the page behind it.
  for (let step = 0; step < 3; step += 1) {
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
        }),
      );
    });
    expect(dialog?.contains(document.activeElement)).toBe(true);
  }
  closeDialog();
  expect(
    document.querySelector('[data-testid="pipeline-templates-dialog"]'),
  ).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('keeps the View all button, and returns focus to it, across a no-match search, Escape and the reload', () => {
  const catalog = props();
  const render = (next: Partial<CuratedPipelineCatalogProps>): void =>
    act(() =>
      root.render(
        <PipelineTemplatesSection catalog={{ ...catalog, ...next }} />,
      ),
    );
  render({});
  const trigger = document.querySelector<HTMLButtonElement>(
    '[data-testid="pipeline-templates-view-all"]',
  );
  if (!trigger) throw new Error('Missing view-all trigger');
  trigger.focus();
  act(() => trigger.click());

  // A search with no match: the host's rows are empty while the catalog is
  // open, and the button stays the same element.
  render({ rows: [], query: { q: 'missing' } });
  expect(
    document.querySelector('[data-testid="pipeline-templates-view-all"]'),
  ).toBe(trigger);

  act(() => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  });
  expect(
    document.querySelector('[data-testid="pipeline-templates-dialog"]'),
  ).toBeNull();
  expect(catalog.onQueryChange).toHaveBeenCalledWith({ limit: 25 });

  // The host reloads the reset query: still no rows, now loading.
  render({ rows: [], query: { limit: 25 }, loading: true });
  expect(
    document.querySelector('[data-testid="pipeline-templates-view-all"]'),
  ).toBe(trigger);
  expect(document.activeElement).toBe(trigger);
  expect(container.querySelectorAll('li')).toHaveLength(3);

  // The reloaded rows replace the kept cards around the same button.
  render({ query: { limit: 25 } });
  expect(
    document.querySelector('[data-testid="pipeline-templates-view-all"]'),
  ).toBe(trigger);
  expect(document.activeElement).toBe(trigger);
});

it('says when the reload after a reset fails, and hides a catalog that settled empty', () => {
  const catalog = props();
  const render = (next: Partial<CuratedPipelineCatalogProps>): void =>
    act(() =>
      root.render(
        <PipelineTemplatesSection catalog={{ ...catalog, ...next }} />,
      ),
    );
  render({});
  click('pipeline-templates-view-all');
  render({ rows: [], query: { q: 'missing' } });
  closeDialog();

  render({ rows: [], query: { limit: 25 }, error: 'Catalog request failed' });
  const section = container.querySelector(
    '[data-testid="pipeline-templates-section"]',
  );
  expect(section?.querySelector('[role="alert"]')?.textContent).toBe(
    'Catalog request failed',
  );
  expect(
    section?.querySelector('[data-testid="pipeline-templates-retry"]'),
  ).not.toBeNull();

  // A reload that succeeds with nothing in the catalog hides the section.
  render({ rows: [], query: { limit: 25 } });
  expect(container.textContent).toBe('');
});
