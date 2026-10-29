/**
 * @jest-environment jsdom
 *
 * Uses the repo's createRoot + act jsdom convention (see ModelPicker.test.tsx);
 * @testing-library/react is not installed. PageTitlebar is module-mocked so the
 * page renders without the sidebar store.
 */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

jest.mock('../../shared/PageTitlebar', () => ({
  PageTitlebar: (): null => null,
}));

import { WorktreeStateGalleryPage } from '../WorktreeStateGalleryPage';
import { resetExperimentalFeaturesStoreForTest } from '@/stores/experimentalFeaturesStore';
import {
  DEFAULT_LEADING_PRIORITY_ENTRIES,
  LEADING_PRIORITY_ITEMS,
  NOT_PROMOTED_DIVIDER_ID,
  WORKTREE_STATE_GALLERY_SECTIONS,
  parseStoredLeadingPriority,
} from '../worktreeStateGalleryData';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(createElement(WorktreeStateGalleryPage));
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  resetExperimentalFeaturesStoreForTest();
});

const allStates = WORKTREE_STATE_GALLERY_SECTIONS.flatMap((s) => s.states);

/**
 * States the gallery must cover. Includes states that have no E2E seeding
 * seam today (split PR phases, setup phases, discovery) — the whole point of
 * this page is that every state is renderable via direct props.
 */
const MUST_HAVE_STATE_IDS = [
  'idle',
  'working',
  'unread',
  'question',
  'question-while-working',
  'plan-review',
  'planning',
  'pipeline-running',
  'pipeline-paused',
  'pipeline-unseen',
  'pipeline-failed',
  'pipeline-failed-unread',
  'terminal-running',
  'terminal-unseen',
  'terminal-failed',
  'script-running',
  'hook-running',
  'graph-building',
  'watchers',
  'scheduled',
  'split-active',
  'split-review',
  'split-done',
  'setup-git-pending',
  'setup-running',
  'teardown',
  'discovery',
  'done',
  'done-unread',
  'done-active',
  'archived',
  'pr-open-passing',
  'pr-open-failing',
  'pr-draft',
  'pr-conflicts',
  'pr-merge-queue',
  'pr-creating',
  'shared-with-teammates',
  'shared-while-working',
  'depth-nested',
  'health-broken',
  'composite',
];

describe('leading-priority list', () => {
  it('default entries cover every subject with the divider between promoted and not-promoted', () => {
    const ids = DEFAULT_LEADING_PRIORITY_ENTRIES;
    expect(new Set(ids).size).toBe(ids.length);
    const dividerIndex = ids.indexOf(NOT_PROMOTED_DIVIDER_ID);
    expect(dividerIndex).toBeGreaterThan(0);
    // Finalized implemented chain above the divider, in priority order.
    // Done sits at the bottom: the checkmark is the fallback when nothing
    // else is active.
    expect(ids.slice(0, dividerIndex)).toEqual([
      'pipeline-paused',
      'pipeline-result',
      'pipeline-running',
      'question',
      'plan-review',
      'planning',
      'split',
      'watchers',
      'scheduled',
      'script',
      'hook',
      'terminal',
      'graph',
      'done',
    ]);
    // Every subject is promotable now — nothing below the divider by default.
    expect(ids.slice(dividerIndex + 1)).toEqual([]);
    for (const id of ids) {
      if (id === NOT_PROMOTED_DIVIDER_ID) continue;
      expect(LEADING_PRIORITY_ITEMS[id]).toBeDefined();
    }
  });

  it('parseStoredLeadingPriority reconciles stored orders against the known set', () => {
    // Invalid payloads fall back to the default.
    expect(parseStoredLeadingPriority(null)).toEqual(
      DEFAULT_LEADING_PRIORITY_ENTRIES,
    );
    expect(parseStoredLeadingPriority('not json')).toEqual(
      DEFAULT_LEADING_PRIORITY_ENTRIES,
    );
    expect(parseStoredLeadingPriority('{"nope":1}')).toEqual(
      DEFAULT_LEADING_PRIORITY_ENTRIES,
    );
    // A stored reorder is preserved; unknown ids drop; missing ids append on
    // the side of the divider they occupy by default.
    const stored = JSON.stringify([
      'question',
      'done',
      NOT_PROMOTED_DIVIDER_ID,
      'terminal',
      'bogus',
    ]);
    const parsed = parseStoredLeadingPriority(stored);
    expect(parsed.slice(0, 2)).toEqual(['question', 'done']);
    expect(parsed).not.toContain('bogus');
    expect(new Set(parsed).size).toBe(parsed.length);
    expect(parsed.length).toBe(DEFAULT_LEADING_PRIORITY_ENTRIES.length);
    const dividerIndex = parsed.indexOf(NOT_PROMOTED_DIVIDER_ID);
    // 'terminal' stays below the divider; repaired promoted ids land above it.
    expect(parsed.indexOf('terminal')).toBeGreaterThan(dividerIndex);
    expect(parsed.indexOf('script')).toBeLessThan(dividerIndex);
  });

  it('renders the interactive list with a row per subject and the divider', () => {
    expect(
      container.querySelector('[data-testid="leading-priority-list"]'),
    ).not.toBeNull();
    for (const id of DEFAULT_LEADING_PRIORITY_ENTRIES) {
      const testId =
        id === NOT_PROMOTED_DIVIDER_ID
          ? 'priority-not-promoted-divider'
          : `priority-row-${id}`;
      expect(
        container.querySelector(`[data-testid="${testId}"]`),
      ).not.toBeNull();
    }
  });
});

describe('WorktreeStateGalleryPage catalog', () => {
  it('has unique state ids', () => {
    const ids = allStates.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers every must-have state', () => {
    const ids = new Set(allStates.map((s) => s.id));
    for (const id of MUST_HAVE_STATE_IDS) {
      expect(ids).toContain(id);
    }
  });
});

describe('WorktreeStateGalleryPage render', () => {
  it('renders the page root', () => {
    expect(
      container.querySelector('[data-testid="page-worktree-states"]'),
    ).not.toBeNull();
  });

  it('wraps every row in the sidebar instant-interactions scope so hover is 0ms like the real sidebar', () => {
    for (const state of allStates) {
      const wrapper = container.querySelector(
        `[data-testid="gallery-row-${state.id}"]`,
      );
      expect(wrapper?.className ?? '').toContain(
        'sidebar-instant-interactions',
      );
    }
  });

  it('renders one real WorktreeRow per catalog state', () => {
    for (const state of allStates) {
      const wrapper = container.querySelector(
        `[data-testid="gallery-row-${state.id}"]`,
      );
      expect(wrapper).not.toBeNull();
      expect(
        wrapper?.querySelector(
          `[data-testid="gallery-worktree-row-${state.id}"]`,
        ),
      ).not.toBeNull();
    }
  });

  it('frames every row and its controls the way the sidebar does', () => {
    for (const state of allStates) {
      const wrapper = container.querySelector(
        `[data-testid="gallery-row-${state.id}"]`,
      );
      expect(
        wrapper?.querySelector('[data-sidebar-variant="bare"]'),
      ).not.toBeNull();
      const menu = wrapper?.querySelector(
        `[data-testid="gallery-row-menu-${state.id}"]`,
      );
      expect(menu?.getAttribute('aria-label')).toBe('More actions');
      expect(menu?.getAttribute('data-worktree-actions-trigger')).toBe('true');
    }
  });

  it('opens the sidebar row menu with its desktop commands', () => {
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="gallery-row-menu-idle"]',
    );
    act(() => trigger?.click());
    const labels = Array.from(
      document.querySelectorAll('[role="menuitem"]'),
      (item) => item.textContent?.trim(),
    );
    expect(labels).toEqual([
      'Pin to top',
      'Set label',
      'Branch info',
      'Launch',
      'Dispatch pipeline',
      'Branch from',
      'Hide',
      'Archive',
    ]);
  });

  it('reads "Rename" in the row menu with early access on', () => {
    act(() => {
      setTestEarlyAccessFeatures({ enabled: true });
    });
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="gallery-row-menu-idle"]',
    );
    act(() => trigger?.click());
    const labels = Array.from(
      document.querySelectorAll('[role="menuitem"]'),
      (item) => item.textContent?.trim(),
    );
    expect(labels).toContain('Rename');
    expect(labels).not.toContain('Set label');
  });

  it('shows the hover Archive button only on a done row, as the sidebar does', () => {
    const archiveIn = (id: string): Element | null | undefined =>
      container
        .querySelector(`[data-testid="gallery-row-${id}"]`)
        ?.querySelector('button[aria-label^="Archive "]');
    expect(archiveIn('done')?.getAttribute('aria-label')).toBe(
      'Archive Done (PR merged)',
    );
    expect(archiveIn('idle')).toBeNull();
  });

  it('selects a row on click', () => {
    const frame = container
      .querySelector('[data-testid="gallery-row-idle"]')
      ?.querySelector<HTMLElement>('[data-sidebar-variant="bare"]');
    expect(frame?.getAttribute('aria-current')).toBeNull();
    act(() => frame?.click());
    expect(frame?.getAttribute('aria-current')).toBe('true');
  });

  it('question state renders the real question glyph', () => {
    const row = container.querySelector('[data-testid="gallery-row-question"]');
    expect(
      row?.querySelector('[data-testid="worktree-row-question-glyph"]'),
    ).not.toBeNull();
  });

  it('failed pipeline state renders the red pipeline glyph', () => {
    const row = container.querySelector(
      '[data-testid="gallery-row-pipeline-failed"]',
    );
    const glyph = row?.querySelector(
      '[data-testid="worktree-row-pipeline-glyph"]',
    );
    expect(glyph).not.toBeNull();
    expect(glyph?.innerHTML ?? '').toContain('fg-destructive');
  });

  it('merge queue state renders the real queued PR glyph', () => {
    const row = container.querySelector(
      '[data-testid="gallery-row-pr-merge-queue"]',
    );
    const badge = row?.querySelector('[data-testid="worktree-row-pr-badge"]');
    expect(badge?.classList.contains('fg-warning')).toBe(true);
    const glyph = row?.querySelector(
      '[data-testid="worktree-row-pr-merge-queue"]',
    );
    expect(glyph?.getAttribute('aria-label')).toBe(
      'In merge queue, position 2',
    );
    expect(
      row?.querySelector('[data-testid="worktree-row-pr-approved"]'),
    ).toBeNull();
  });

  it('shared state renders the share badge on the title line', () => {
    const row = container.querySelector(
      '[data-testid="gallery-row-shared-with-teammates"]',
    );
    const badge = row?.querySelector(
      '[data-testid="worktree-row-shared-badge"]',
    );
    expect(badge).not.toBeNull();
    // Metadata, not an activity subject: the leading slot stays empty.
    const leadingSlot = row?.querySelector(
      '[data-testid="worktree-row-leading-slot"]',
    );
    expect(leadingSlot).not.toBeNull();
    expect(
      leadingSlot?.querySelector('[data-testid="worktree-row-shared-badge"]'),
    ).toBeNull();
    // It moved off the subtitle line to the trailing edge of the title line,
    // the same slot the Cowork row uses, so the two row types read alike.
    const subtitle = row?.querySelector(
      '[data-testid="worktree-row-subtitle"]',
    );
    expect(subtitle).not.toBeNull();
    expect(
      subtitle?.querySelector('[data-testid="worktree-row-shared-badge"]'),
    ).toBeNull();
    const title = row?.querySelector('[data-testid="worktree-row-title"]');
    expect(title).not.toBeNull();
    if (badge && title && subtitle) {
      expect(
        title.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeGreaterThan(0);
      expect(
        badge.compareDocumentPosition(subtitle) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeGreaterThan(0);
    }
    // Faded, not unmounted, while the row reveals its hover actions over that
    // slot, so the footprint is preserved and nothing on the row jumps.
    expect(badge?.className).toContain(
      'pointer-fine:group-hover/sidebar-item:opacity-0',
    );
  });

  it('shared state never steals the leading slot from a live subject', () => {
    const row = container.querySelector(
      '[data-testid="gallery-row-shared-while-working"]',
    );
    const badge = row?.querySelector(
      '[data-testid="worktree-row-shared-badge"]',
    );
    expect(badge).not.toBeNull();
    const leadingSlot = row?.querySelector(
      '[data-testid="worktree-row-leading-slot"]',
    );
    expect(
      leadingSlot?.querySelector(
        '[data-testid="worktree-row-working-pipeline"]',
      ),
    ).not.toBeNull();
    expect(
      leadingSlot?.querySelector('[data-testid="worktree-row-shared-badge"]'),
    ).toBeNull();
    // On a busy row the badge sits immediately left of the trailing status
    // cluster rather than under it.
    const trailingSlot = row?.querySelector(
      '[data-testid="worktree-row-trailing-slot"]',
    );
    expect(trailingSlot).not.toBeNull();
    expect(
      trailingSlot?.querySelector('[data-testid="worktree-row-shared-badge"]'),
    ).toBeNull();
    if (badge && trailingSlot) {
      expect(
        badge.compareDocumentPosition(trailingSlot) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeGreaterThan(0);
    }
  });

  it('terminal states carry their status tint attribute', () => {
    for (const [id, status] of [
      ['terminal-running', 'running'],
      ['terminal-unseen', 'unseen'],
      ['terminal-failed', 'unseen-failure'],
    ]) {
      const row = container.querySelector(`[data-testid="gallery-row-${id}"]`);
      expect(
        row?.querySelector(`[data-terminal-status="${status}"]`),
      ).not.toBeNull();
    }
  });

  it('running setup state shows the setup loader in the trailing slot', () => {
    const row = container.querySelector(
      '[data-testid="gallery-row-setup-running"]',
    );
    expect(row?.querySelector('[aria-label="Running setup…"]')).not.toBeNull();
  });

  it('question-while-working shows the spinner beside the warning dot', () => {
    const row = container.querySelector(
      '[data-testid="gallery-row-question-while-working"]',
    );
    expect(
      row?.querySelector(
        '[data-testid="worktree-row-classic-streaming-spinner"]',
      ),
    ).not.toBeNull();
    expect(row?.innerHTML ?? '').toContain('bg-fg-warning');
  });

  it('hovering the blue unread dot opens the real chat-preview popover', () => {
    const dot = container.querySelector(
      '[data-testid="gallery-row-unread"] [data-testid="worktree-row-unread"]',
    );
    expect(dot).not.toBeNull();
    act(() => {
      dot?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    // ChatPreviewPopover portals into document.body with the real heading.
    expect(document.body.textContent).toContain('Unread Chats');
    act(() => {
      dot?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
  });

  it('renders the color legend explaining cyan vs blue', () => {
    const legend = container.querySelector(
      '[data-testid="state-color-legend"]',
    );
    expect(legend).not.toBeNull();
    const text = legend?.textContent ?? '';
    expect(text).toMatch(/running/i);
    expect(text).toMatch(/seen/i);
  });
});
