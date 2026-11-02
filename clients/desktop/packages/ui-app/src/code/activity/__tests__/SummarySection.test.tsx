/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import type { PortalWorktreeSummaryEntity } from '@canopy/protocol/portal';
import { SummarySectionBody } from '../SummarySectionBody';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { portalSummaryToSectionBodyProps } from '../portal-summary-section-mapper';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const SUMMARY: PortalWorktreeSummaryEntity = {
  localId: 'w',
  worktreeLocalId: 'w',
  title: 'Wire provider',
  description: 'Adds the shared client provider.',
  generatedAt: '2026-07-20T00:00:00.000Z',
  highlights: ['Shared the summary UI'],
  repos: [{ name: 'web', description: 'Added the portal adapter.' }],
  lastFullRefreshAt: '2026-07-19T00:00:00.000Z',
};

describe('portal SummarySectionBody adoption', () => {
  it('renders an empty body when the summary is absent', () => {
    const out = renderToString(
      <SummarySectionBody {...portalSummaryToSectionBodyProps(undefined)} />,
    );
    expect(out).toBe('');
  });

  it('renders the shared card treatment for a populated summary', () => {
    const out = renderToString(
      <SummarySectionBody {...portalSummaryToSectionBodyProps(SUMMARY)} />,
    );
    expect(out).toContain('font-semibold');
    expect(out).toContain('line-clamp-6');
    expect(out).toContain('Wire provider');
    expect(out).toContain('Adds the shared client provider.');
    expect(out).toContain('View more details');
  });

  it('opens the widened portal detail modal without unavailable controls', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <SummarySectionBody {...portalSummaryToSectionBodyProps(SUMMARY)} />,
      );
    });

    const detailsButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('View more details') === true,
    );
    expect(detailsButton).toBeDefined();
    act(() => detailsButton?.click());

    const modal = document.querySelector(
      '[data-testid="summary-detail-modal"]',
    );
    expect(modal?.textContent).toContain('Wire provider');
    expect(modal?.textContent).toContain('Highlights');
    expect(modal?.textContent).toContain('Shared the summary UI');
    expect(modal?.textContent).toContain('Repository summaries');
    expect(modal?.textContent).toContain('Added the portal adapter.');
    expect(modal?.textContent).toContain('Full refresh');
    expect(modal?.textContent).not.toContain('Refresh');
    expect(document.body.textContent).toContain('View more details');

    act(() => root.unmount());
    container.remove();
  });

  it('uses semantic accent colors for summary actions and highlights', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <SummarySectionBody
          summary={SUMMARY}
          generating={false}
          refreshEnabled
          onRefresh={jest.fn()}
        />,
      );
    });

    const detailsLink = Array.from(container.querySelectorAll('span')).find(
      (element) => element.textContent === 'View more details',
    );
    expect(detailsLink?.classList.contains('fg-accent')).toBe(true);
    expect(detailsLink?.className).not.toMatch(/(?:text|bg)-sky-/);

    act(() => container.querySelector('button')?.click());
    const modal = document.querySelector(
      '[data-testid="summary-detail-modal"]',
    );
    const refreshIcon = modal?.querySelector('button svg');
    const highlightDot = modal?.querySelector('span.rounded-full');
    expect(refreshIcon?.classList.contains('fg-accent')).toBe(true);
    expect(highlightDot?.classList.contains('bg-accent')).toBe(true);
    expect(modal?.innerHTML).not.toMatch(/(?:text|bg)-sky-/);

    act(() => root.unmount());
    container.remove();
  });

  it('keeps the generated summary out of session replay', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <SummarySectionBody {...portalSummaryToSectionBodyProps(SUMMARY)} />,
      );
    });
    const findText = (scope: ParentNode, text: string): Element | undefined =>
      Array.from(scope.querySelectorAll('*')).find(
        (element) =>
          element.children.length === 0 && element.textContent === text,
      );
    const blocked = `.${REPLAY_BLOCK_CLASS}`;
    expect(
      findText(container, SUMMARY.description)?.closest(blocked),
    ).not.toBeNull();

    act(() => container.querySelector('button')?.click());
    const modal = document.querySelector(
      '[data-testid="summary-detail-modal"]',
    );
    expect(modal).not.toBeNull();
    // The dialog chrome and static headings stay recorded.
    expect(modal?.closest(blocked)).toBeNull();
    expect(findText(document, 'Highlights')?.closest(blocked)).toBeNull();
    expect(
      findText(document, 'Repository summaries')?.closest(blocked),
    ).toBeNull();
    if (modal === null) throw new Error('summary detail modal missing');
    for (const text of [
      SUMMARY.description,
      'Shared the summary UI',
      'Added the portal adapter.',
    ]) {
      expect(findText(modal, text)?.closest(blocked)).not.toBeNull();
    }
    // The repository name is a title and stays recorded.
    const repoName = findText(modal, 'web');
    expect(repoName).toBeDefined();
    expect(repoName?.closest(blocked)).toBeNull();

    act(() => root.unmount());
    container.remove();
  });

  it('maps every widened field in the portal projection', () => {
    expect(portalSummaryToSectionBodyProps(SUMMARY)).toEqual({
      summary: {
        title: 'Wire provider',
        description: 'Adds the shared client provider.',
        highlights: ['Shared the summary UI'],
        repos: [{ name: 'web', description: 'Added the portal adapter.' }],
        generatedAt: '2026-07-20T00:00:00.000Z',
        lastFullRefreshAt: '2026-07-19T00:00:00.000Z',
      },
      generating: false,
      refreshEnabled: false,
    });
    expect(
      portalSummaryToSectionBodyProps({ ...SUMMARY, generating: true })
        .generating,
    ).toBe(true);
  });

  it('preserves the desktop empty-highlights group when the field is defined', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <SummarySectionBody
          summary={{
            title: SUMMARY.title,
            description: SUMMARY.description,
            highlights: [],
          }}
          generating={false}
          refreshEnabled={false}
        />,
      );
    });
    act(() => container.querySelector('button')?.click());
    expect(
      document.querySelector('[data-testid="summary-detail-modal"]')
        ?.textContent,
    ).toContain('Highlights');

    act(() => root.unmount());
    container.remove();
  });
});
