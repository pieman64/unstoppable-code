/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * CAN-2836 reopen half — the hook's own responsibility only.
 *
 * Every layout precondition (hydration, maximize, the `auto` flag, focus,
 * persistence ordering) belongs to `expandActivityRailFromContent` and is
 * pinned in `persistence-bridge.test.ts`. What is pinned HERE is the content
 * signal — which sections may reopen a rail and which must never — plus the
 * placement plumbing, the revision-driven retry, and the CAN-4793 rule that a
 * Cowork rail never reopens itself on content.
 */

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as ZustandModule from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';
import type {
  ActivitySectionId,
  ActivitySurface,
} from '@canopy/desktop-shared/types';

jest.mock('@/lib/panels/persistence-bridge', () => ({
  expandActivityRailFromContent: jest.fn(() => true),
}));

jest.mock('@/lib/panels/panel-placement-context', () => ({
  usePanelPlacement: jest.fn(),
}));

interface FakeLayoutState {
  layouts: Record<string, { revision: number }>;
}

jest.mock('@/stores/panelLayoutStore', () => {
  const { create } = jest.requireActual<typeof ZustandModule>('zustand');
  return {
    usePanelLayoutStore: create<FakeLayoutState>(() => ({ layouts: {} })),
  };
});

import { expandActivityRailFromContent } from '@/lib/panels/persistence-bridge';
import { usePanelPlacement } from '@/lib/panels/panel-placement-context';
import { usePanelLayoutStore } from '@/stores/panelLayoutStore';
import { useAutoExpandActivityRail } from '../useAutoExpandActivityRail';

const LAYOUT_KEY = 'project-a/worktree-a';
const RAIL_GROUP_ID = 'group-activity';

const expandMock = jest.mocked(expandActivityRailFromContent);
const placementMock = jest.mocked(usePanelPlacement);
const layoutStore: UseBoundStore<StoreApi<FakeLayoutState>> =
  usePanelLayoutStore;

function setRevision(revision: number): void {
  act(() => {
    layoutStore.setState({ layouts: { [LAYOUT_KEY]: { revision } } });
  });
}

function Harness({
  sectionHasContent,
  surface,
}: {
  sectionHasContent: Partial<Record<ActivitySectionId, boolean>>;
  surface: ActivitySurface;
}): JSX.Element | null {
  useAutoExpandActivityRail({ surface, sectionHasContent });
  return null;
}

// Roots still mounted when a test ends. A failed expectation throws before the
// test's own `cleanup()`, and a leaked root would keep answering later tests'
// revision bumps and inflate their call counts.
const mountedCleanups = new Set<() => void>();

function render(
  sectionHasContent: Partial<Record<ActivitySectionId, boolean>>,
  surface: ActivitySurface = 'worktree',
): {
  rerender: (
    next: Partial<Record<ActivitySectionId, boolean>>,
    nextSurface?: ActivitySurface,
  ) => void;
  cleanup: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(
      <Harness sectionHasContent={sectionHasContent} surface={surface} />,
    );
  });
  const cleanup = (): void => {
    if (!mountedCleanups.delete(cleanup)) return;
    act(() => {
      root.unmount();
    });
    container.remove();
  };
  mountedCleanups.add(cleanup);
  return {
    rerender: (next, nextSurface): void => {
      act(() => {
        root.render(
          <Harness sectionHasContent={next} surface={nextSurface ?? surface} />,
        );
      });
    },
    cleanup,
  };
}

beforeEach(() => {
  expandMock.mockClear();
  expandMock.mockReturnValue(true);
  placementMock.mockReturnValue({
    layoutKey: LAYOUT_KEY,
    groupId: RAIL_GROUP_ID,
  });
  layoutStore.setState({ layouts: { [LAYOUT_KEY]: { revision: 1 } } });
});

afterEach(() => {
  mountedCleanups.forEach((cleanup) => {
    cleanup();
  });
});

describe('useAutoExpandActivityRail', () => {
  it('asks the bridge to reopen the rail when the worktree produces work', () => {
    const { rerender, cleanup } = render({ 'changed-files': false });
    expect(expandMock).not.toHaveBeenCalled();

    rerender({ 'changed-files': true });

    expect(expandMock).toHaveBeenCalledWith(LAYOUT_KEY, RAIL_GROUP_ID);
    cleanup();
  });

  it.each([
    'summary',
    'changed-files',
    'pull-request',
    'plans',
    'pipeline-runs',
    'background-processes',
    'todo',
    'attachments',
  ])('reopens the rail for %s', (sectionId) => {
    const { cleanup } = render({ [sectionId]: true });

    expect(expandMock).toHaveBeenCalledWith(LAYOUT_KEY, RAIL_GROUP_ID);
    cleanup();
  });

  it('never reopens the rail for ambient workspace configuration', () => {
    // Every one of these is already true on a brand-new worktree in a
    // configured workspace. Treating them as work would spring the rail open
    // on every new chat and neuter CAN-2836 outright.
    const { cleanup } = render({
      plugins: true,
      scripts: true,
      hooks: true,
      'mcp-servers': true,
      notes: true,
      prompts: true,
      memory: true,
      terminals: true,
    });

    expect(expandMock).not.toHaveBeenCalled();
    cleanup();
  });

  it('ignores a code-only section that this surface does not render', () => {
    // Cowork drops the repo-backed sections, so a stale `changed-files` flag
    // must not reopen a rail whose panel never shows that section.
    const { cleanup } = render({ 'changed-files': true }, 'cowork');

    expect(expandMock).not.toHaveBeenCalled();
    cleanup();
  });

  describe('cowork (CAN-4793)', () => {
    // Cowork keeps Canopy's seeded collapse: content never opens the rail, so
    // a finished reply cannot narrow the chat. The user opens it by hand.
    it.each([
      'summary',
      'changed-files',
      'pull-request',
      'plans',
      'pipeline-runs',
      'cost',
      'background-processes',
      'todo',
      'attachments',
    ])('does not reopen a cowork rail for %s', (sectionId) => {
      const { cleanup } = render({ [sectionId]: true }, 'cowork');

      expect(expandMock).not.toHaveBeenCalled();
      cleanup();
    });

    it('does not reopen a cowork rail with every work section present', () => {
      const { cleanup } = render(
        {
          summary: true,
          'changed-files': true,
          'pull-request': true,
          plans: true,
          'pipeline-runs': true,
          cost: true,
          'background-processes': true,
          todo: true,
          attachments: true,
        },
        'cowork',
      );

      expect(expandMock).not.toHaveBeenCalled();
      cleanup();
    });

    it('does not reopen a cowork rail when work arrives after mount', () => {
      const { rerender, cleanup } = render({ cost: false }, 'cowork');

      rerender({ cost: true, summary: true });

      expect(expandMock).not.toHaveBeenCalled();
      cleanup();
    });

    it('does not retry on layout revisions while cowork work is present', () => {
      const { cleanup } = render({ cost: true }, 'cowork');

      setRevision(2);
      setRevision(3);

      expect(expandMock).not.toHaveBeenCalled();
      cleanup();
    });

    it('applies the current surface when it changes', () => {
      const { rerender, cleanup } = render({ summary: true }, 'cowork');
      expect(expandMock).not.toHaveBeenCalled();

      rerender({ summary: true }, 'worktree');
      expect(expandMock).toHaveBeenCalledWith(LAYOUT_KEY, RAIL_GROUP_ID);

      rerender({ summary: true }, 'cowork');
      expandMock.mockClear();
      rerender({ summary: true, cost: true }, 'cowork');
      setRevision(2);

      expect(expandMock).not.toHaveBeenCalled();
      cleanup();
    });

    it('does not reopen a minimal-mode cowork rail', () => {
      placementMock.mockReturnValue({
        layoutKey: LAYOUT_KEY,
        groupId: 'group-extras',
      });

      const { cleanup } = render({ cost: true }, 'cowork');

      expect(expandMock).not.toHaveBeenCalled();
      cleanup();
    });
  });

  it('still reopens a code-workspace rail for attachments', () => {
    const { cleanup } = render({ attachments: true }, 'worktree');

    expect(expandMock).toHaveBeenCalledWith(LAYOUT_KEY, RAIL_GROUP_ID);
    cleanup();
  });

  it('retries on the next layout revision when the bridge declines', () => {
    // A pass the bridge skipped (a maximized group, an unhydrated layout) is
    // not lost: the `auto` flag survives and the next revision tries again.
    expandMock.mockReturnValue(false);
    const { cleanup } = render({ 'changed-files': true });
    expect(expandMock).toHaveBeenCalledTimes(1);

    setRevision(2);

    expect(expandMock).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it('does nothing without a panel placement', () => {
    placementMock.mockReturnValue(null);

    const { cleanup } = render({ 'changed-files': true });

    expect(expandMock).not.toHaveBeenCalled();
    cleanup();
  });

  it('does nothing before the layout record exists', () => {
    layoutStore.setState({ layouts: {} });

    const { cleanup } = render({ 'changed-files': true });

    expect(expandMock).not.toHaveBeenCalled();
    cleanup();
  });

  it('uses the placement group id, so Minimal mode needs no second path', () => {
    placementMock.mockReturnValue({
      layoutKey: LAYOUT_KEY,
      groupId: 'group-extras',
    });

    const { cleanup } = render({ summary: true });

    expect(expandMock).toHaveBeenCalledWith(LAYOUT_KEY, 'group-extras');
    cleanup();
  });

  it('does not re-ask while the content signal is unchanged', () => {
    const { rerender, cleanup } = render({ 'changed-files': true });
    expect(expandMock).toHaveBeenCalledTimes(1);

    // More work arriving is still just "has work" — the flag the bridge reads
    // is the latch, so the hook must not spam it on every store change.
    rerender({ 'changed-files': true, summary: true });

    expect(expandMock).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
