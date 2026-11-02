/**
 * @jest-environment jsdom
 */
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// The git-action rows are the real WorktreeTopBar, which needs the
// CanopyClientProvider harness — that is the Header States gallery's
// concern, not this page's. The message item drags the whole transcript
// renderer along; the surface it sits on is what this page adds.
jest.mock('@/components/panels/WorktreeTopBar', () => ({
  WorktreeTopBar: ({ worktreeId }: { worktreeId: string }): JSX.Element => (
    <div data-testid={`stub-top-bar-${worktreeId}`} />
  ),
}));
jest.mock('../../shared/PageTitlebar', () => ({
  PageTitlebar: (): null => null,
}));
jest.mock('../../chat/ChatMessageItem', () => ({
  ChatMessageItem: ({ message }: { message: { id: string } }): JSX.Element => (
    <div data-testid={`stub-message-${message.id}`} />
  ),
}));

import type { JSX } from 'react';
import { ChangeReviewPage } from '../ChangeReviewPage';
import {
  CHANGE_REVIEW_SECTION_IDS,
  CHANGE_REVIEW_SECTIONS,
  GIT_ACTION_ROWS,
  TOOLTIP_SIDEBAR_ROW,
  UNREAD_AFTER_ANSWER_ROWS,
} from '../changeReviewData';
import { HEADER_GALLERY_STATES } from '../headerStateGalleryData';
import { HEADER_STATE_GALLERY_PROJECT_ID } from '../headerStateGalleryData';
import { CHANGE_REVIEW_PAGE_STORAGE_KEY } from '@/components/sidebar/change-review-page-flag';
import { useProjectsStore } from '@/stores/projectsStore';

interface DevInfoWindow {
  devInfo?: { isDev: boolean };
  platform?: NodeJS.Platform;
}

const devInfoWindow: DevInfoWindow = window;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // The Sleep paused pill only renders on the platforms that support the
  // wake lock, like the shipping indicator.
  Object.defineProperty(window, 'platform', {
    configurable: true,
    value: 'darwin',
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  document
    .querySelectorAll('[role="tooltip"]')
    .forEach((tooltip) => tooltip.remove());
  delete devInfoWindow.devInfo;
  Reflect.deleteProperty(window, 'platform');
  window.localStorage.clear();
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(<ChangeReviewPage />);
    await Promise.resolve();
  });
}

function enableFlag(): void {
  devInfoWindow.devInfo = { isDev: true };
  window.localStorage.setItem(CHANGE_REVIEW_PAGE_STORAGE_KEY, '1');
}

describe('ChangeReviewPage flag gate', () => {
  it('seeds the conflicting worktree clean so the header offers Resolve conflicts', () => {
    // The header only shows Resolve conflicts on a clean worktree
    // (`worktreeCleanForMerge`); an uncommitted-changes seed silently turned
    // that gallery row into Commit & Push.
    const conflicts = HEADER_GALLERY_STATES.find(
      (state) => state.id === 'pr-conflicts',
    );
    expect(conflicts).toBeDefined();
    expect(conflicts?.projects?.uncommittedChanges).not.toBe(true);
  });

  it('renders a placeholder and seeds nothing when the flag is off', async () => {
    // Packaged-build shape: no devInfo, flag key irrelevant.
    await render();

    expect(
      container.querySelector('[data-testid="change-review-page-disabled"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="page-change-review"]'),
    ).toBeNull();
    expect(
      useProjectsStore
        .getState()
        .projects.some((p) => p.id === HEADER_STATE_GALLERY_PROJECT_ID),
    ).toBe(false);
  });

  it('stays disabled in dev without the localStorage opt-in', async () => {
    devInfoWindow.devInfo = { isDev: true };
    await render();

    expect(
      container.querySelector('[data-testid="change-review-page-disabled"]'),
    ).not.toBeNull();
  });

  it('renders the page when the dev opt-in is set', async () => {
    enableFlag();
    await render();

    expect(
      container.querySelector('[data-testid="page-change-review"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="change-review-page-disabled"]'),
    ).toBeNull();
  });
});

describe('ChangeReviewPage sections', () => {
  beforeEach(async () => {
    enableFlag();
    await render();
  });

  it('renders one section per fix, in catalog order, with before and after', () => {
    expect(CHANGE_REVIEW_SECTIONS.map((section) => section.id)).toEqual(
      CHANGE_REVIEW_SECTION_IDS,
    );
    const sections = Array.from(
      container.querySelectorAll('[data-testid^="change-review-section-"]'),
    );
    expect(
      sections.map((section) => section.getAttribute('data-testid')),
    ).toEqual(
      CHANGE_REVIEW_SECTION_IDS.map((id) => `change-review-section-${id}`),
    );
    for (const section of sections) {
      expect(section.textContent).toContain('Before');
      expect(section.textContent).toContain('After');
    }
  });

  it('renders the seeded worktree header rows for the git actions', () => {
    for (const row of GIT_ACTION_ROWS) {
      expect(
        HEADER_GALLERY_STATES.some((state) => state.id === row.worktreeId),
      ).toBe(true);
      expect(
        container.querySelector(
          `[data-testid="change-review-git-action-${row.worktreeId}"] [data-testid="stub-top-bar-${row.worktreeId}"]`,
        ),
      ).not.toBeNull();
    }
    expect(
      useProjectsStore
        .getState()
        .projects.some((p) => p.id === HEADER_STATE_GALLERY_PROJECT_ID),
    ).toBe(true);
  });

  it('renders the user and queued bubbles on the shared surface', () => {
    expect(
      container.querySelector(
        '[data-testid="change-review-bubble-surface"] [data-testid="stub-message-change-review-user-info"]',
      ),
    ).not.toBeNull();
    const queued = container.querySelector(
      '[data-testid="change-review-bubble-queued"] .bg-quaternary',
    );
    expect(queued).not.toBeNull();
    // The queued bubble now carries the inset hairline the sent bubble has.
    expect(queued?.className).toContain('inset-ring-line-secondary');
  });

  it('lifts every body-only card action into the shared title-row slot', () => {
    for (const id of ['notes', 'prompts', 'attachments', 'plans']) {
      const card = container.querySelector(
        `[data-testid="change-review-activity-card-${id}"]`,
      );
      const controls = card?.querySelector('[data-panel-section-controls]');
      const body = card?.querySelector('[data-panel-section-body]');
      const action = card?.querySelector(
        `[data-testid="change-review-activity-action-${id}"]`,
      );
      expect(action).not.toBeNull();
      expect(controls?.contains(action ?? null)).toBe(true);
      expect(body?.contains(action ?? null)).toBe(false);
    }
  });

  it('renders the labeled Sleep paused chip floating over the mock panel area', () => {
    const pill = container.querySelector(
      '[data-testid="change-review-panel-area"] [data-testid="sidebar-wake-lock-indicator"]',
    );
    expect(pill).not.toBeNull();
    expect(pill?.className).toContain('rounded-full');
    expect(pill?.textContent).toContain('Sleep paused');
  });

  it('floors the resizable leaf at the shared minimum width', () => {
    const leaf = container.querySelector<HTMLElement>(
      '[data-testid="change-review-resizable-leaf"]',
    );
    expect(leaf?.style.minWidth).toBe('320px');
    expect(
      container.querySelector<HTMLElement>(
        '[data-testid="change-review-leaf-before"]',
      )?.style.width,
    ).toBe('100px');
    expect(
      container.querySelector<HTMLElement>(
        '[data-testid="change-review-leaf-after"]',
      )?.style.width,
    ).toBe('320px');
  });

  it('renders the full standardized pipeline row chip set in one row', () => {
    const row = container.querySelector<HTMLElement>(
      '[data-testid="change-review-badge-row"]',
    );
    expect(row).not.toBeNull();
    for (const text of [
      'running',
      'success',
      'Plan updated',
      'Input required',
      'Advisor running',
      'Workflow',
      'Retry',
      'Start over',
    ]) {
      expect(row?.textContent).toContain(text);
    }
    expect(
      row?.querySelector('[data-testid="change-review-follow-up-chat"]'),
    ).not.toBeNull();

    // Every status badge is the shared 18px Badge capsule; every action
    // button shares the chip geometry. No border utilities or palette literals.
    const badges = Array.from(row?.querySelectorAll('span') ?? []).filter(
      (candidate) => /(^|\s)h-4\.5(\s|$)/.test(candidate.className),
    );
    expect(badges).toHaveLength(5);
    for (const badge of badges) {
      expect(badge.className).toContain('rounded-full');
      expect(badge.className).toContain('text-2xs');
      expect(badge.className).not.toContain('ring-');
    }
    const buttons = Array.from(row?.querySelectorAll('button') ?? []);
    expect(buttons).toHaveLength(4);
    for (const button of buttons) {
      expect(button.className).toContain('h-6');
      expect(button.className).toContain('rounded-md');
      expect(button.className).toContain('text-2xs');
      expect(button.className).toContain(
        'ring-[length:var(--border-hairline)]',
      );
      // Every action chip shares the `Open in` secondary surface; tones
      // differ by ink only.
      expect(button.className).toContain('bg-quaternary');
      expect(button.className).toContain('shadow-sm');
      expect(button.className).toContain('ring-line-secondary');
      expect(button.className).not.toMatch(/\bbg-[a-z]+-subtle\b/);
    }
    expect(
      row?.querySelector('[data-testid="change-review-retry"]')?.className,
    ).toContain('fg-warning');
    expect(
      row?.querySelector('[data-testid="change-review-rerun"]')?.className,
    ).toContain('fg-destructive');
    expect(row?.innerHTML).not.toMatch(/(^|\s|")border(-|\s|")/);
    expect(row?.innerHTML).not.toContain('violet-');
    expect(row?.innerHTML).not.toContain('sky-');
    expect(row?.innerHTML).not.toContain('amber-');
  });

  it('opens the empty context meter with the first-reply hint', async () => {
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="change-review-context-meter-empty"] button',
    );
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });
    expect(
      document.body.querySelector('[data-testid="usage-indicator-empty-hint"]')
        ?.textContent,
    ).toBe('Usage appears after the first reply.');
  });

  it('renders the migrated tooltip controls and the sidebar rows', () => {
    const row = container.querySelector(
      '[data-testid="change-review-tooltip-row"]',
    );
    expect(row?.querySelector('[aria-label="Plan mode"]')).not.toBeNull();
    // No native title tooltips remain on the migrated controls.
    expect(row?.querySelectorAll('[title]')).toHaveLength(0);
    expect(
      container.querySelector('[data-testid="change-review-row-tooltip-row"]'),
    ).not.toBeNull();
    for (const id of ['question-open', 'answered-now', 'answered-before']) {
      expect(
        container.querySelector(`[data-testid="change-review-row-${id}"]`),
      ).not.toBeNull();
    }
  });

  it('opens the sidebar unread preview popover from the tooltip-row dot, not the fallback tooltip', () => {
    const dot = container.querySelector<HTMLElement>(
      '[data-testid="change-review-row-tooltip-row"] [data-testid="worktree-row-unread"]',
    );
    expect(dot).not.toBeNull();
    const seededRows = TOOLTIP_SIDEBAR_ROW.unreadPreviewRows ?? [];
    expect(seededRows.length).toBeGreaterThanOrEqual(2);

    act(() => {
      dot?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    const tooltips = Array.from(
      document.body.querySelectorAll('[role="tooltip"]'),
    );
    expect(
      tooltips.some((tooltip) => tooltip.textContent === 'Unread messages'),
    ).toBe(false);
    const bodyText = document.body.textContent ?? '';
    expect(bodyText).toContain('Unread Chats');
    for (const row of seededRows) {
      expect(bodyText).toContain(row.title);
      expect(bodyText).toContain(row.preview ?? 'No response yet');
    }

    act(() => {
      dot?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(document.body.textContent ?? '').not.toContain('Unread Chats');
  });

  it('opens the unread preview from the answered-before dot on focus and closes on Escape', () => {
    const fixture = UNREAD_AFTER_ANSWER_ROWS.find(
      (row) => row.id === 'answered-before',
    );
    const seededRows = fixture?.unreadPreviewRows ?? [];
    expect(seededRows.length).toBeGreaterThanOrEqual(2);
    const dot = container.querySelector<HTMLElement>(
      '[data-testid="change-review-row-answered-before"] [data-testid="worktree-row-unread"]',
    );
    expect(dot).not.toBeNull();

    act(() => {
      dot?.focus();
    });
    const bodyText = document.body.textContent ?? '';
    expect(bodyText).toContain('Unread Chats');
    for (const row of seededRows) {
      expect(bodyText).toContain(row.title);
    }

    act(() => {
      dot?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(document.body.textContent ?? '').not.toContain('Unread Chats');
  });
});
