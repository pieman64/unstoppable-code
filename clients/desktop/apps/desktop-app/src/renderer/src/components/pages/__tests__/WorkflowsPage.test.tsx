/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, useEffect, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WorkflowsTabId } from '@canopy/ui-shared/lib';
import type { WorkflowEditTarget } from '@/lib/workflows/edit-target';
import { useNavigationStore } from '@/stores/navigationStore';
import type * as NavigationStoreModule from '@/stores/navigationStore';
import { WorkflowsPageHeader } from '@/components/workflows/WorkflowsPageHeader';
import { WorkflowsTabPanel } from '@/components/workflows/WorkflowsTabPanel';
import { useClearWorkflowsKeyboardTarget } from '@/components/workflows/workflowsTabContext';
import { AUTOMATIONS_OPEN_TAB_EVENT } from '@/lib/navigation/workflows-navigation';
import { WorkflowsPage } from '../WorkflowsPage';

const WORKFLOWS_SUBTITLE =
  'Chain prompts and scripts, and run them by hand, on a schedule, or when something happens.';

let mockHostMounts = 0;
let mockPipelinesProps: {
  assistantEnabled?: boolean;
} = {};

jest.mock('../AutomationsPage', (): unknown => ({
  // Mirrors AutomationsPage in body mode: it draws what `renderBody` returns.
  AutomationsPage: ({
    renderBody,
  }: {
    renderBody: (api: object) => ReactNode;
  }): JSX.Element => <div data-testid="mock-automations">{renderBody({})}</div>,
}));

jest.mock('../PipelinesPage', (): unknown => ({
  // Mirrors PipelinesPage: it draws the list it was handed, and stops a
  // keyboard tab change from taking focus while the edit shell is open.
  PipelinesPage: (props: {
    renderList: (api: object) => ReactNode;
    assistantEnabled?: boolean;
  }): JSX.Element => {
    useEffect(() => {
      mockHostMounts += 1;
    }, []);
    mockPipelinesProps = { assistantEnabled: props.assistantEnabled };
    const editing = jest
      .requireActual<typeof NavigationStoreModule>('@/stores/navigationStore')
      .useNavigationStore((state) => state.workflowEdit !== undefined);
    useClearWorkflowsKeyboardTarget(editing);
    return <div data-testid="mock-pipelines">{props.renderList({})}</div>;
  },
}));

jest.mock('../../workflows/WorkflowsTabs', (): unknown => ({
  WorkflowsTabs: ({ tab }: { tab: string }): JSX.Element => (
    <div data-testid="mock-tabs" data-tab={tab}>
      <WorkflowsPageHeader />
      <WorkflowsTabPanel>{tab} body</WorkflowsTabPanel>
    </div>
  ),
}));

jest.mock('../../workflows/edit/WorkflowEditHost', (): unknown => ({
  WorkflowEditHost: ({
    target,
  }: {
    target: WorkflowEditTarget;
  }): JSX.Element => (
    <div data-testid="mock-edit-host" data-kind={target.kind} />
  ),
}));

const PIPELINE: WorkflowEditTarget = { kind: 'pipeline', pipelineId: 'review' };

describe('WorkflowsPage (CAN-3981)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mockHostMounts = 0;
    mockPipelinesProps = {};
    useNavigationStore.setState({
      activePage: 'workflows',
      pendingPluginsNavigation: undefined,
      workflowEdit: undefined,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function byTestId(testId: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${testId}"]`);
  }

  async function renderTab(tab: WorkflowsTabId): Promise<void> {
    await act(async () => {
      root.render(<WorkflowsPage tab={tab} />);
      // Let the lazily loaded hosts resolve.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it.each([
    ['workflows', 'Runs'],
    ['workflows-schedule', 'Schedule'],
    ['workflows-library', 'Library'],
  ] as const)(
    'shows the %s tab under one Workflows heading',
    async (tab, label) => {
      await renderTab(tab);

      expect(byTestId('page-workflows')).not.toBeNull();
      expect(byTestId('mock-tabs')?.dataset.tab).toBe(tab);
      expect(container.querySelector('h1')?.textContent).toBe('Workflows');
      const subtitles = byTestId('page-header')?.querySelectorAll(
        '[data-testid="page-header-description"]',
      );
      expect(subtitles).toHaveLength(1);
      expect(subtitles?.[0]?.textContent).toBe(WORKFLOWS_SUBTITLE);
      const selected = byTestId(`workflows-tab-${tab}`);
      expect(selected?.getAttribute('aria-selected')).toBe('true');
      expect(selected?.textContent).toContain(label);
    },
  );

  it('lists the tabs as Runs, Schedule, Library', async () => {
    await renderTab('workflows');

    expect(
      Array.from(container.querySelectorAll('[role="tab"]')).map(
        (tab) => tab.textContent,
      ),
    ).toEqual(['Runs', 'Schedule', 'Library']);
  });

  it('keeps one host across all three tabs', async () => {
    await renderTab('workflows');
    await renderTab('workflows-schedule');
    await renderTab('workflows-library');
    await renderTab('workflows');

    expect(mockHostMounts).toBe(1);
    expect(byTestId('mock-tabs')?.dataset.tab).toBe('workflows');
  });

  it('offers the pipeline assistant on Library only', async () => {
    await renderTab('workflows');
    expect(mockPipelinesProps).toEqual({ assistantEnabled: false });

    await renderTab('workflows-library');
    expect(mockPipelinesProps).toEqual({ assistantEnabled: true });
  });

  it('shows the edit shell in place of the tabs while an item is open', async () => {
    act(() => {
      useNavigationStore.getState().openWorkflowEdit(PIPELINE);
    });
    await renderTab('workflows-library');

    expect(byTestId('mock-edit-host')?.dataset.kind).toBe('pipeline');
    expect(byTestId('mock-tabs')).toBeNull();
    // Both hosts stay mounted around the shell.
    expect(byTestId('mock-pipelines')).not.toBeNull();
    expect(byTestId('mock-automations')).not.toBeNull();
  });

  it('closes the shell on a tab change and shows that tab', async () => {
    act(() => {
      useNavigationStore.getState().openWorkflowEdit(PIPELINE);
    });
    await renderTab('workflows-library');

    act(() => {
      useNavigationStore.getState().navigate('workflows');
    });
    expect(useNavigationStore.getState().workflowEdit).toBeUndefined();
    await renderTab('workflows');

    expect(byTestId('mock-edit-host')).toBeNull();
    expect(byTestId('mock-tabs')?.dataset.tab).toBe('workflows');
    expect(mockHostMounts).toBe(1);
  });

  it('navigates to the clicked tab page', async () => {
    await renderTab('workflows');

    act(() => {
      byTestId('workflows-tab-workflows-library')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });

    expect(useNavigationStore.getState().activePage).toBe('workflows-library');
  });

  it('keeps keyboard focus on the selected tab when the panel changes', async () => {
    await renderTab('workflows');

    act(() => {
      byTestId('workflows-tab-workflows')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
    });
    expect(useNavigationStore.getState().activePage).toBe('workflows-schedule');
    await renderTab('workflows-schedule');

    expect(document.activeElement).toBe(
      byTestId('workflows-tab-workflows-schedule'),
    );
  });

  it('labels the panel after the tab list with the selected tab', async () => {
    await renderTab('workflows-library');

    const panel = container.querySelector('[role="tabpanel"]');
    expect(panel?.id).toBe('workflows-tab-panel');
    expect(panel?.getAttribute('aria-labelledby')).toBe(
      'workflows-tab-workflows-library',
    );
    // The tab list and its panel are siblings, not nested.
    expect(panel?.querySelector('[role="tablist"]')).toBeNull();
    expect(byTestId('page-workflows')?.getAttribute('role')).toBeNull();
  });

  it('shows neither tabs nor a tab panel in the edit shell', async () => {
    act(() => {
      useNavigationStore.getState().openWorkflowEdit(PIPELINE);
    });
    await renderTab('workflows-library');

    expect(byTestId('mock-edit-host')).not.toBeNull();
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.querySelector('[role="tabpanel"]')).toBeNull();
  });

  it('spends a keyboard change that lands in the edit shell', async () => {
    await renderTab('workflows-schedule');
    act(() => {
      byTestId('workflows-tab-workflows-schedule')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
    });
    act(() => {
      useNavigationStore.getState().openWorkflowEdit(PIPELINE);
    });
    await renderTab('workflows-library');
    act(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });

    // Back to the list: its header must not take focus for the old change.
    act(() => {
      useNavigationStore.getState().closeWorkflowEdit();
    });
    await renderTab('workflows-library');

    expect(byTestId('workflows-tab-workflows-library')).not.toBeNull();
    expect(document.activeElement).not.toBe(
      byTestId('workflows-tab-workflows-library'),
    );
  });

  it('forgets a keyboard change once another tab shows first', async () => {
    await renderTab('workflows');

    act(() => {
      byTestId('workflows-tab-workflows')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
    });
    // Other navigation wins before the Schedule panel shows.
    await renderTab('workflows-library');
    act(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });
    await renderTab('workflows-schedule');

    expect(document.activeElement).not.toBe(
      byTestId('workflows-tab-workflows-schedule'),
    );
  });

  it('does not steal focus when a tab opens without the keyboard', async () => {
    await renderTab('workflows');

    act(() => {
      byTestId('workflows-tab-workflows-library')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    await renderTab('workflows-library');

    expect(document.activeElement).not.toBe(
      byTestId('workflows-tab-workflows-library'),
    );
  });

  it.each([
    ['scheduled', 'workflows-library'],
    ['watchers', 'workflows'],
  ] as const)(
    'opens what the legacy %s tab became for the old tab event',
    async (tab, page) => {
      await renderTab('workflows-schedule');
      useNavigationStore.setState({ activePage: 'workflows-schedule' });

      act(() => {
        window.dispatchEvent(
          new CustomEvent(AUTOMATIONS_OPEN_TAB_EVENT, { detail: { tab } }),
        );
      });

      expect(useNavigationStore.getState().activePage).toBe(page);
    },
  );

  it('sends the retired Shared tab event to Marketplace › Shared by me', async () => {
    await renderTab('workflows');

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AUTOMATIONS_OPEN_TAB_EVENT, {
          detail: { tab: 'shared' },
        }),
      );
    });

    const state = useNavigationStore.getState();
    expect(state.activePage).toBe('plugins');
    // Customize normalizes the retired tab and facet (CAN-4261): the
    // Workflows tab, focused on its Shared by me section.
    expect(state.pendingPluginsNavigation).toEqual({
      kind: 'marketplace-browse',
      query: '',
      tab: 'workflow',
      focusSection: 'shared-by-me',
    });
  });

  it('ignores a malformed tab event', async () => {
    await renderTab('workflows');

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AUTOMATIONS_OPEN_TAB_EVENT, {
          detail: { tab: 'calendar' },
        }),
      );
    });

    expect(useNavigationStore.getState().activePage).toBe('workflows');
  });
});
