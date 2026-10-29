/** @jest-environment jsdom */
import type * as SortableModule from '@dnd-kit/sortable';
import { useSortable } from '@dnd-kit/sortable';
import { SortableSection } from '../SortableSection';

import { act, useContext, useState } from 'react';
import {
  HeaderActionDefaultToneContext,
  useActivityItemDensity,
} from '@canopy/ui-shared/components';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import type { JSX } from 'react';
import type { CanopyCapabilities, SessionViewModel } from '@canopy/app-core';
import type { ActivityState } from '@canopy/app-state';
import { DEFAULT_ACTIVITY_SECTION_ORDER } from '@canopy/app-state';
import type {
  PortalChatTodoProjection,
  PortalHookRunProjection,
  PortalScriptDescriptor,
} from '@canopy/protocol/portal';
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

import type { BackgroundTask } from '@canopy/protocol/background-tasks';

jest.mock('@dnd-kit/sortable', () => {
  const actual = jest.requireActual<typeof SortableModule>('@dnd-kit/sortable');
  return { ...actual, useSortable: jest.fn(actual.useSortable) };
});

let mockActivity: ActivityState;
let mockCaps: CanopyCapabilities;
jest.mock('@canopy/app-state', () => {
  const real: Record<string, unknown> = jest.requireActual('@canopy/app-state');
  return {
    __esModule: true,
    ...real,
    useActivityStore: <T,>(selector: (state: ActivityState) => T): T =>
      selector(mockActivity),
    useCapabilities: (): CanopyCapabilities => mockCaps,
    useWorkspaceCapabilities: (): CanopyCapabilities => mockCaps,
  };
});

import {
  ACTIVITY_POINTER_DRAG_ACTIVATION_CONSTRAINT,
  ActivityPanel,
  ActivitySectionBody,
  activityPanelHasContent,
  activitySectionHasContent,
  activitySectionPresenceIds,
  activitySectionRenders,
  getActivitySectionDescriptor,
  type ActivitySectionPresenceInput,
} from '../ActivityPanel';

const CAPS: CanopyCapabilities = {
  localExecution: true,
  terminalPty: true,
  fileSystemAccess: 'read-write',
  voice: false,
  settingsScope: 'full',
  pipelines: 'execute',
  routing: 'in-memory',
  overviewNotifications: true,
};

function baseState(): ActivityState {
  return {
    snapshot: null,
    sectionOrderOverrides: {},
    hydrate: (): void => {},
    patch: (): void => {},
    setSectionOrder: (): void => {},
  };
}

/** Host signal that every built-in section holds content, so all render. */
const EVERY_SECTION_HAS_CONTENT = Object.fromEntries(
  DEFAULT_ACTIVITY_SECTION_ORDER.map((id) => [id, { hasContent: true }]),
);

/** A minimal-but-valid shell snapshot with data scoped to worktree `wt1`. */
function populatedSnapshot(): SessionViewModel {
  return {
    workspaces: [],
    worktrees: [],
    chatProjects: [],
    standaloneChats: [],
    scriptDescriptors: [],
    scriptRuns: [],
    hookDescriptors: [],
    hookRuns: [],
    plans: [
      {
        localId: 'p1',
        title: 'Plan A',
        status: 'draft',
        worktreeLocalId: 'wt1',
      },
      {
        localId: 'p2',
        title: 'Other wt',
        status: 'draft',
        worktreeLocalId: 'wt2',
      },
    ],
    pipelines: [],
    pipelineRuns: [],
    chatMessages: [],
    chatSummaries: [],
    terminalSessions: [],
    terminalBuffers: {},
    changedFiles: {
      wt1: {
        worktreeLocalId: 'wt1',
        uncommitted: [{ filePath: 'src/x.ts', status: 'M' }],
        committed: [],
      },
    },
    diffSnapshots: {},
    prStatuses: {
      wt1: { worktreeLocalId: 'wt1', number: 7, title: 'My PR', state: 'open' },
    },
    fileRoots: [],
    fileTree: {},
    filePreviews: {},
    refreshing: false,
    connectionStatus: 'active',
  };
}

const RUNNING_TASK: BackgroundTask = {
  id: 'bash-1',
  kind: 'bash',
  status: 'running',
  title: 'npm run dev',
  ownerToolUseId: 'bash-1',
  parentTaskId: null,
  startedAt: 1,
  settledAt: null,
  updatedAt: 2,
  lastDescription: null,
  summary: null,
  outputLines: [],
  canStop: true,
};
const COMPLETED_TASK: BackgroundTask = {
  ...RUNNING_TASK,
  id: 'bash-2',
  status: 'completed',
  title: 'Build project',
  settledAt: 2,
  canStop: false,
};

describe('ActivityPanel', () => {
  it('keeps the disabled Stopping control until setup confirms its exit', () => {
    mockCaps = CAPS;
    const snapshot = populatedSnapshot();
    snapshot.scriptDescriptors = [
      { name: 'Setup', scriptKey: 'project:setup', worktreeLocalId: 'wt1' },
    ];
    snapshot.scriptRuns = [
      {
        name: 'Setup',
        scriptKey: 'project:setup',
        worktreeLocalId: 'wt1',
        status: 'stopping',
        cancelable: false,
      },
    ];
    mockActivity = { ...baseState(), snapshot };
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() =>
      root.render(
        <ActivityPanel
          workspaceLocalId="ws1"
          worktreeLocalId="wt1"
          hostActions={{ onCancelScript: (): void => {} }}
        />,
      ),
    );
    const stop = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-scripts-stop"]',
    );
    expect(stop).not.toBeNull();
    expect(stop?.disabled).toBe(true);
    expect(stop?.textContent).toBe('Stopping…');
    act(() => root.unmount());
  });
  it('opens searchable process output and omits Stop when the host cannot cancel', () => {
    mockCaps = CAPS;
    const snapshot = populatedSnapshot();
    snapshot.scriptDescriptors = [
      {
        name: 'Setup',
        scriptKey: 'project:setup',
        scriptName: 'setup',
        target: 'project',
        worktreeLocalId: 'wt1',
        command: 'npm ci',
        lifecycle: 'setup',
      },
    ];
    snapshot.scriptRuns = [
      {
        name: 'Setup',
        scriptKey: 'project:setup',
        status: 'running',
        worktreeLocalId: 'wt1',
        outputTail: 'installing packages',
        cancelable: false,
      },
    ];
    mockActivity = { ...baseState(), snapshot };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <ActivityPanel
          workspaceLocalId="ws1"
          worktreeLocalId="wt1"
          hostActions={{ onCancelScript: (): void => {} }}
        />,
      ),
    );
    expect(
      container.querySelector('[data-testid="activity-scripts-stop"]'),
    ).toBeNull();
    const enlarge = container.querySelector<HTMLButtonElement>(
      '[aria-label="Enlarge output"]',
    );
    expect(enlarge).not.toBeNull();
    act(() => enlarge?.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'installing packages',
    );
    expect(document.querySelector('[data-search-bar]')).not.toBeNull();
    act(() => root.unmount());
    container.remove();
  });
  it('renders host background tasks with the shared rows', () => {
    mockActivity = { ...baseState(), snapshot: populatedSnapshot() };
    mockCaps = CAPS;
    const html = renderToString(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        backgroundTasksSection={{ tasks: [RUNNING_TASK, COMPLETED_TASK] }}
      />,
    );
    expect(html).toContain('activity-section-background-processes');
    expect(html).toContain('1 active, 1 stopped');
    expect(html).toContain('activity-bg-item');
  });
  it('activates pointer drag on movement without requiring a long press', () => {
    // A `delay` constraint makes dnd-kit cancel the drag outright when the
    // pointer travels past `tolerance` before the delay elapses, so a normal
    // press-and-drag never reorders a card. A small distance threshold is
    // enough to keep plain header clicks from starting a drag.
    expect(ACTIVITY_POINTER_DRAG_ACTIVATION_CONSTRAINT).toEqual({
      distance: 4,
    });
    expect(ACTIVITY_POINTER_DRAG_ACTIVATION_CONSTRAINT).not.toHaveProperty(
      'delay',
    );
  });

  it.each([
    'summary',
    'changed-files',
    'pull-request',
    'plans',
    'pipeline-runs',
    'scripts',
    'hooks',
    'mcp-servers',
    'terminals',
  ] as const)(
    'renders the %s body through the single-section seam',
    (sectionId) => {
      mockCaps = CAPS;
      const seamSnapshot = populatedSnapshot();
      // Adopted section bodies render nothing without data (desktop
      // parity), so the seam must seed the sections whose shared bodies
      // are truthful-empty: summary and scripts.
      seamSnapshot.worktreeSummaries = [
        {
          localId: 'wt1',
          worktreeLocalId: 'wt1',
          title: 'Seam summary',
          description: 'Seam summary description',
        },
      ];
      seamSnapshot.scriptDescriptors = [
        {
          localId: 'seam-script',
          name: 'Seam script',
          scriptKey: 'seam-script',
          worktreeLocalId: 'wt1',
        },
      ];
      mockActivity = { ...baseState(), snapshot: seamSnapshot };
      const out = renderToString(
        <ActivitySectionBody
          sectionId={sectionId}
          workspaceLocalId="ws1"
          worktreeLocalId="wt1"
          showTerminals
        />,
      );
      expect(out).not.toContain('data-testid="activity-list"');
      expect(out.length).toBeGreaterThan(0);
      expect(getActivitySectionDescriptor(sectionId)?.title).toBeTruthy();
    },
  );

  it('renders populated and empty view-only MCP server sections', () => {
    mockCaps = CAPS;
    const snapshot = populatedSnapshot();
    snapshot.mcpServers = [
      {
        localId: 'github',
        workspaceLocalId: 'ws1',
        worktreeLocalId: 'wt1',
        serverName: 'github',
        displayName: 'GitHub',
        source: 'standalone',
        type: 'http',
        enabled: true,
        authStatus: 'connected',
        authStatusLabel: 'Connected',
        configName: 'Default',
      },
      {
        localId: 'other',
        workspaceLocalId: 'ws1',
        worktreeLocalId: 'wt2',
        serverName: 'other',
        displayName: 'Other worktree',
        source: 'plugin',
        type: 'command',
        enabled: false,
        authStatus: 'not_configured',
        authStatusLabel: 'No auth',
      },
    ];
    mockActivity = { ...baseState(), snapshot };

    const populated = renderToString(
      <ActivitySectionBody
        sectionId="mcp-servers"
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
      />,
    );
    expect(populated).toContain('GitHub');
    expect(populated).toContain('Standalone · Default');
    expect(populated).not.toContain('· Enabled');
    expect(populated).toContain('Connected');
    expect(populated).not.toContain('Other worktree');
    expect(populated).not.toContain('<button');

    snapshot.mcpServers = [];
    const empty = renderToString(
      <ActivitySectionBody
        sectionId="mcp-servers"
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
      />,
    );
    expect(empty).toContain('No MCP servers.');
  });

  it('returns no descriptor for an unknown persisted section id', () => {
    expect(getActivitySectionDescriptor('notes')).toBeUndefined();
  });

  it('renders the tab bar and all default sections in order', () => {
    mockCaps = { ...CAPS, costInsights: true };
    mockActivity = baseState();
    const out = renderToString(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        sectionOverrides={EVERY_SECTION_HAS_CONTENT}
        showTerminals
      />,
    );
    expect(out).toContain('data-testid="activity-panel"');
    expect(out).toContain('data-testid="activity-tab-activity"');
    expect(out).toContain('data-testid="activity-tab-files"');
    expect(out).toContain('data-testid="activity-list"');
    for (const id of DEFAULT_ACTIVITY_SECTION_ORDER) {
      expect(out).toContain(`data-testid="activity-section-${id}"`);
    }
    const rendered = document.createElement('div');
    rendered.innerHTML = out;
    expect(
      rendered
        .querySelector('[data-testid="activity-section-summary"]')
        ?.classList.contains('relative'),
    ).toBe(true);
  });

  it('does not render phantom built-in sections while hydrating an empty snapshot', () => {
    mockCaps = CAPS;
    mockActivity = baseState();
    const out = renderToString(
      <ActivityPanel workspaceLocalId="ws1" worktreeLocalId="wt1" hydrating />,
    );

    for (const id of ['background-processes', 'pipeline-runs', 'todo']) {
      expect(out).not.toContain(`data-testid="activity-section-${id}"`);
    }
  });

  it('keeps empty snapshot section visibility stable during hydration', () => {
    mockCaps = CAPS;
    mockActivity = baseState();
    const render = (hydrating?: boolean): Set<string> => {
      const out = renderToString(
        <ActivityPanel
          workspaceLocalId="ws1"
          worktreeLocalId="wt1"
          hydrating={hydrating}
        />,
      );
      const rendered = document.createElement('div');
      rendered.innerHTML = out;
      return new Set(
        Array.from(
          rendered.querySelectorAll(
            '[data-testid^="activity-section-"]:not([data-testid="activity-section-loading"])',
          ),
          (element) => element.getAttribute('data-testid') ?? '',
        ),
      );
    };

    expect(render(true)).toEqual(render(false));
  });

  it('renders an empty summary refresh section without a blank body strip', () => {
    mockCaps = CAPS;
    mockActivity = baseState();
    const render = (hydrating?: boolean): string =>
      renderToString(
        <ActivityPanel
          workspaceLocalId="ws1"
          worktreeLocalId="wt1"
          hydrating={hydrating}
          hostActions={{ onRefreshSummary: jest.fn() }}
        />,
      );

    const settled = render();
    expect(settled).toContain('activity-section-summary');
    expect(settled).not.toContain('data-panel-section-body');
    expect(settled).not.toContain('activity-section-loading');

    const loading = render(true);
    expect(loading).toContain('activity-section-summary');
    expect(loading).toContain('activity-section-loading');
  });

  it("renders only the sections the workspace's client implements (REG-3022)", () => {
    const repositorySnapshot = populatedSnapshot();
    repositorySnapshot.workspaces = [
      { localId: 'ws1', name: 'Repo', type: 'single-repo', chatIds: [] },
    ];
    mockActivity = { ...baseState(), snapshot: repositorySnapshot };
    const render = (): string =>
      renderToString(
        <ActivityPanel
          workspaceLocalId="ws1"
          worktreeLocalId="wt1"
          sectionOverrides={EVERY_SECTION_HAS_CONTENT}
          showTerminals
        />,
      );

    // No allowlist: a repository project keeps every section, as before.
    // Cost also needs its own host capability.
    mockCaps = { ...CAPS, costInsights: true };
    const full = render();
    for (const id of DEFAULT_ACTIVITY_SECTION_ORDER) {
      expect(full).toContain(`data-testid="activity-section-${id}"`);
    }

    // An allowlist narrows the rail to the sections the client implements.
    mockCaps = {
      ...CAPS,
      costInsights: true,
      activitySectionIds: ['summary', 'mcp-servers', 'terminals', 'todo'],
    };
    const narrowed = render();
    for (const id of ['summary', 'mcp-servers', 'terminals']) {
      expect(narrowed).toContain(`data-testid="activity-section-${id}"`);
    }
    for (const id of [
      'changed-files',
      'pull-request',
      'plans',
      'pipeline-runs',
      'cost',
      'scripts',
      'hooks',
    ]) {
      expect(narrowed).not.toContain(`data-testid="activity-section-${id}"`);
    }
  });

  it('names built-in sections in sentence case on every host', () => {
    mockCaps = CAPS;
    mockActivity = baseState();
    const html = renderToString(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        sectionOverrides={EVERY_SECTION_HAS_CONTENT}
      />,
    );
    for (const title of [
      'Changed files',
      'Pull requests',
      'Agent background processes',
      'MCP servers',
      'Agent tasks',
    ]) {
      expect(html).toContain(title);
    }
    for (const title of ['Changed Files', 'Pull Requests', 'Agent Tasks']) {
      expect(html).not.toContain(title);
    }
  });

  it('hides empty built-in sections once hydration is complete', () => {
    mockCaps = CAPS;
    mockActivity = { ...baseState(), snapshot: populatedSnapshot() };

    const out = renderToString(
      <ActivityPanel workspaceLocalId="ws1" worktreeLocalId="wt1" />,
    );

    expect(out).toContain('activity-section-changed-files');
    expect(out).toContain('activity-section-pull-request');
    expect(out).toContain('activity-section-plans');
    expect(out).not.toContain('activity-section-summary');
    expect(out).not.toContain('activity-section-background-processes');
    expect(out).not.toContain('activity-section-mcp-servers');
    expect(out).not.toContain('activity-section-pipeline-runs');
    expect(out).not.toContain('activity-section-scripts');
    expect(out).not.toContain('activity-section-hooks');
    expect(out).not.toContain('activity-section-todo');
  });

  it('does not render an unknown persisted section id', () => {
    mockCaps = CAPS;
    const snapshot = populatedSnapshot();
    snapshot.workspaces = [
      {
        localId: 'ws1',
        name: 'Workspace',
        type: 'single-repo',
        activitySectionOrder: ['summary', 'notes', 'scripts'],
      },
    ];
    mockActivity = { ...baseState(), snapshot };

    const out = renderToString(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        sectionOverrides={EVERY_SECTION_HAS_CONTENT}
      />,
    );

    expect(out).not.toContain('activity-section-notes');
    expect(out).toContain('activity-section-summary');
    expect(out).toContain('activity-section-scripts');
  });

  it('shows the host summary refresh action only when supplied', () => {
    mockCaps = CAPS;
    const snapshot = populatedSnapshot();
    snapshot.worktreeSummaries = [
      {
        localId: 'wt1',
        worktreeLocalId: 'wt1',
        title: 'Summary',
        description: 'Details',
        generating: false,
      },
    ];
    mockActivity = { ...baseState(), snapshot };

    const withoutAction = renderToString(
      <ActivityPanel workspaceLocalId="ws1" worktreeLocalId="wt1" />,
    );
    const withAction = renderToString(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        hostActions={{ onRefreshSummary: jest.fn() }}
      />,
    );

    expect(withoutAction).not.toContain('aria-label="Refresh summary"');
    expect(withAction).toContain('aria-label="Refresh summary"');
  });

  it('renders the summary refresh action busy and disabled while generating', () => {
    mockCaps = CAPS;
    const snapshot = populatedSnapshot();
    snapshot.worktreeSummaries = [
      {
        localId: 'wt1',
        worktreeLocalId: 'wt1',
        title: 'Summary',
        description: 'Details',
        generating: true,
      },
    ];
    mockActivity = { ...baseState(), snapshot };

    const out = renderToString(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        hostActions={{ onRefreshSummary: jest.fn() }}
      />,
    );

    expect(out).toContain('aria-label="Refreshing summary (in progress)"');
    expect(out).toContain('disabled=""');
  });

  it('hides the summary refresh action when the host disables refresh and nothing is generating', () => {
    mockCaps = CAPS;
    const snapshot = populatedSnapshot();
    snapshot.worktreeSummaries = [
      {
        localId: 'wt1',
        worktreeLocalId: 'wt1',
        title: 'Summary',
        description: 'Details',
        generating: false,
      },
    ];
    mockActivity = { ...baseState(), snapshot };

    const disabledIdle = renderToString(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        summaryRefreshEnabled={false}
        hostActions={{ onRefreshSummary: jest.fn() }}
      />,
    );
    const disabledGenerating = renderToString(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        summaryRefreshEnabled={false}
        summaryGenerating
        hostActions={{ onRefreshSummary: jest.fn() }}
      />,
    );

    expect(disabledIdle).not.toContain('aria-label="Refresh summary"');
    expect(disabledIdle).not.toContain(
      'aria-label="Refreshing summary (in progress)"',
    );
    expect(disabledGenerating).toContain(
      'aria-label="Refreshing summary (in progress)"',
    );
  });

  it('disables both drag and drop registration for hidden mounted sections', () => {
    renderToString(
      <SortableSection
        id="memory"
        title="Memory"
        icon={null}
        hiddenWhileMounted
      />,
    );
    expect(useSortable).toHaveBeenLastCalledWith({
      id: 'memory',
      disabled: { draggable: true, droppable: true },
    });
    renderToString(<SortableSection id="memory" title="Memory" icon={null} />);
    expect(useSortable).toHaveBeenLastCalledWith({
      id: 'memory',
      disabled: { draggable: false, droppable: false },
    });
  });

  it('supports host chrome overrides and extra sections without rendering tabs', () => {
    mockCaps = CAPS;
    mockActivity = baseState();
    const out = renderToString(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        hideTabs
        sectionOrder={['notes', 'summary', 'changed-files']}
        sectionOverrides={{
          summary: {
            title: 'Desktop Summary',
            icon: <svg data-testid="desktop-summary-icon" />,
            subtitle: 'Desktop summary subtitle',
            body: <div data-testid="native-summary">Native summary</div>,
            dataTestId: 'desktop-summary-wrapper',
          },
          'changed-files': { hidden: true },
        }}
        extraSections={[
          {
            key: 'notes',
            title: 'Notes',
            body: (): JSX.Element => (
              <div data-testid="native-notes">Native notes</div>
            ),
          },
        ]}
      />,
    );

    expect(out).not.toContain('data-testid="activity-tab-activity"');
    expect(out).not.toContain('data-testid="activity-tab-files"');
    expect(out).toContain('data-testid="desktop-summary-wrapper"');
    expect(out).toContain('data-testid="native-summary"');
    expect(out).toContain('data-testid="desktop-summary-icon"');
    expect(out).toContain('Desktop summary subtitle');
    expect(out).not.toContain('Loading…');
    expect(out).toContain('data-testid="native-notes"');
    expect(out.match(/data-testid="activity-section-notes"/g)).toHaveLength(1);
    expect(out).not.toContain('data-testid="activity-section-changed-files"');
    expect(out.indexOf('native-notes')).toBeLessThan(
      out.indexOf('native-summary'),
    );
  });

  it('renders a persisted extra section once after it has been reordered', () => {
    mockCaps = CAPS;
    mockActivity = {
      ...baseState(),
      sectionOrderOverrides: { ws1: ['notes', 'summary'] },
    };

    const out = renderToString(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        hideTabs
        extraSections={[
          {
            key: 'notes',
            title: 'Notes',
            body: <div data-testid="native-notes">Native notes</div>,
          },
        ]}
      />,
    );

    expect(out.match(/data-testid="activity-section-notes"/g)).toHaveLength(1);
    expect(out.match(/data-testid="native-notes"/g)).toHaveLength(1);
  });

  it('renders an extra action card without duplicate section chrome', () => {
    mockCaps = CAPS;
    mockActivity = baseState();
    const out = renderToString(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        hideTabs
        sectionOrder={['notes']}
        extraSections={[
          {
            key: 'notes',
            title: 'Notes',
            actionCard: true,
            body: (
              <button type="button" data-testid="native-action-card">
                Add note
              </button>
            ),
          },
        ]}
      />,
    );

    expect(out).toContain('data-activity-action-card="true"');
    expect(out).toContain('data-testid="native-action-card"');
    expect(out).not.toContain('>Notes</h3>');
    const actionCardRoot = out.match(
      /<div[^>]*data-activity-action-card="true"[^>]*>/,
    )?.[0];
    expect(actionCardRoot).toBeDefined();
    expect(actionCardRoot).not.toContain('role="button"');
    expect(actionCardRoot).not.toContain('tabindex="0"');
    expect(out).toContain('aria-label="Reorder notes section"');
  });

  it('honors a persisted section-order override', () => {
    mockCaps = CAPS;
    mockActivity = {
      ...baseState(),
      sectionOrderOverrides: { ws1: ['pull-request', 'summary'] },
    };
    const out = renderToString(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        sectionOverrides={EVERY_SECTION_HAS_CONTENT}
      />,
    );
    // Override lists two ids first; the resolver appends the remaining defaults,
    // so pull-request must appear before summary in the rendered order.
    const prIndex = out.indexOf('activity-section-pull-request');
    const summaryIndex = out.indexOf('activity-section-summary');
    expect(prIndex).toBeGreaterThanOrEqual(0);
    expect(prIndex).toBeLessThan(summaryIndex);
  });

  it('omits read-only sections when the snapshot is empty', () => {
    mockCaps = CAPS;
    mockActivity = baseState();
    const out = renderToString(
      <ActivityPanel workspaceLocalId="ws1" worktreeLocalId="wt1" />,
    );
    expect(out).not.toContain('activity-section-changed-files');
    expect(out).not.toContain('activity-section-pull-request');
    expect(out).not.toContain('activity-section-plans');
    expect(out).not.toContain('activity-section-todo');
    expect(out).not.toContain('activity-todo-body');
  });

  it('matches Todo items by project, worktree, and selected chat and renders desktop-parity counts', () => {
    mockCaps = CAPS;
    const snapshot = populatedSnapshot();
    snapshot.todoLists = [
      {
        localId: 'chat-1',
        workspaceLocalId: 'ws2',
        worktreeLocalId: 'wt1',
        chatId: 'chat-1',
        items: [
          {
            id: 'wrong-workspace',
            content: 'Wrong project',
            status: 'pending',
          },
        ],
      },
      {
        localId: 'chat-2',
        workspaceLocalId: 'ws1',
        worktreeLocalId: 'wt1',
        chatId: 'chat-2',
        items: [{ id: 'wrong-chat', content: 'Wrong chat', status: 'pending' }],
      },
      {
        localId: 'chat-1',
        workspaceLocalId: 'ws1',
        worktreeLocalId: 'wt1',
        chatId: 'chat-1',
        items: [
          { id: 'active', content: 'Active task', status: 'in_progress' },
          { id: 'done', content: 'Done task', status: 'completed' },
        ],
      },
    ];
    mockActivity = { ...baseState(), snapshot };

    const out = renderToString(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        selectedChatId="chat-1"
      />,
    );

    expect(out).toContain('data-testid="activity-todo-body"');
    expect(out).toContain('data-testid="activity-todo-item"');
    expect(out).toContain('Active task');
    expect(out).not.toContain('Wrong project');
    expect(out).not.toContain('Wrong chat');
    expect(out).toContain('1 of 2 tasks completed');
    expect(out.replace(/<!-- -->/g, '')).toContain('1/2');
  });

  it('omits Todo when the selected chat is absent', () => {
    mockCaps = CAPS;
    const snapshot = populatedSnapshot();
    snapshot.todoLists = [];
    mockActivity = { ...baseState(), snapshot };

    const out = renderToString(
      <ActivityPanel workspaceLocalId="ws1" worktreeLocalId="wt1" />,
    );

    expect(out).not.toContain('activity-section-todo');
    expect(out).not.toContain('activity-todo-body');
  });

  it('uses directly projected todos only when selectedChatId identifies the active list', () => {
    mockCaps = CAPS;
    mockActivity = baseState();
    const todoLists: readonly PortalChatTodoProjection[] = [
      {
        localId: 'chat-1',
        workspaceLocalId: 'ws1',
        worktreeLocalId: 'wt1',
        chatId: 'chat-1',
        items: [
          {
            id: 'projected',
            content: 'Desktop projected task',
            status: 'pending',
          },
        ],
      },
    ];

    const withoutSelectedChat = renderToString(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        todoLists={todoLists}
      />,
    );
    const withSelectedChat = renderToString(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        selectedChatId="chat-1"
        todoLists={todoLists}
      />,
    );

    expect(withoutSelectedChat).not.toContain('Desktop projected task');
    expect(withSelectedChat).toContain('Desktop projected task');
    expect(withSelectedChat).toContain('data-testid="activity-todo-body"');
  });

  it('resets completed Todo disclosure when the selected chat changes', () => {
    mockCaps = CAPS;
    const snapshot = populatedSnapshot();
    snapshot.todoLists = [
      {
        localId: 'chat-1',
        workspaceLocalId: 'ws1',
        worktreeLocalId: 'wt1',
        chatId: 'chat-1',
        items: [{ id: 'done-1', content: 'First done', status: 'completed' }],
      },
      {
        localId: 'chat-2',
        workspaceLocalId: 'ws1',
        worktreeLocalId: 'wt1',
        chatId: 'chat-2',
        items: [{ id: 'done-2', content: 'Second done', status: 'completed' }],
      },
    ];
    mockActivity = { ...baseState(), snapshot };
    const container = document.createElement('div');
    const root = createRoot(container);

    act(() => {
      root.render(
        <ActivityPanel
          workspaceLocalId="ws1"
          worktreeLocalId="wt1"
          selectedChatId="chat-1"
        />,
      );
    });
    const firstToggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-todo-completed-toggle"]',
    );
    act(() => firstToggle?.click());
    expect(firstToggle?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('First done');

    act(() => {
      root.render(
        <ActivityPanel
          workspaceLocalId="ws1"
          worktreeLocalId="wt1"
          selectedChatId="chat-2"
        />,
      );
    });
    const secondToggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-todo-completed-toggle"]',
    );
    expect(secondToggle?.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('Second done');

    act(() => root.unmount());
  });

  it('plumbs worktree-keyed snapshot data into the sections', () => {
    mockCaps = CAPS;
    mockActivity = { ...baseState(), snapshot: populatedSnapshot() };
    const out = renderToString(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        onRevertFile={(): void => {}}
      />,
    ).replace(/<!-- -->/g, '');
    // Only wt1-scoped data appears (wt2's plan is filtered out).
    expect(out).toContain('src/x.ts');
    expect(out).toContain('Plan A');
    expect(out).not.toContain('Other wt');
    expect(out).toContain('#7');
    expect(out).toContain('My PR');
    // read-write host → the changed-file Revert affordance renders.
    expect(out).toContain('data-testid="activity-file-revert"');
  });

  it('hides the changed-file Revert on a read-only host', () => {
    mockCaps = { ...CAPS, fileSystemAccess: 'read' };
    mockActivity = { ...baseState(), snapshot: populatedSnapshot() };
    // Even with a revert handler injected, the read-only capability suppresses it.
    const out = renderToString(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        onRevertFile={(): void => {}}
      />,
    );
    expect(out).toContain('src/x.ts');
    expect(out).not.toContain('data-testid="activity-file-revert"');
  });

  it('renders active script and hook runs without matching descriptors', () => {
    mockCaps = CAPS;
    const snapshot = populatedSnapshot();
    snapshot.scriptRuns = [
      {
        localId: 'script-run-1',
        name: 'Orphan script',
        scriptKey: 'missing-script',
        status: 'running',
        worktreeLocalId: 'wt1',
      },
    ];
    snapshot.hookRuns = [
      {
        localId: 'hook-run-1',
        name: 'Orphan hook',
        hookKey: 'missing-hook',
        triggerName: 'on-save',
        status: 'pending',
        worktreeLocalId: 'wt1',
      },
    ];
    mockActivity = { ...baseState(), snapshot };

    const out = renderToString(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        hostActions={{
          onCancelScript: (): void => {},
          onCancelHook: (): void => {},
        }}
      />,
    );

    expect(out).toContain('Orphan script');
    expect(out).toContain('data-testid="activity-scripts-body"');
    expect(out).toContain('data-testid="activity-scripts-entry"');
    expect(out).toContain('Orphan hook');
    expect(out).toContain('data-testid="activity-hooks-body"');
    expect(out).toContain('data-testid="activity-hooks-entry"');
    expect(out.match(/>Stop<\/button>/g)).toHaveLength(2);
    const scriptsHeader = out.slice(
      out.indexOf('activity-section-scripts'),
      out.indexOf('activity-section-hooks'),
    );
    const hooksHeader = out.slice(
      out.indexOf('activity-section-hooks'),
      out.indexOf('activity-section-terminals'),
    );
    // Orphan runs render their rows but are excluded from the configured
    // count (unique descriptors only), so the subtitle reads "None configured".
    expect(scriptsHeader).toContain('None configured');
    expect(hooksHeader).toContain('None configured');
  });

  it('pairs script and hook descriptors with only their latest run in descriptor order', () => {
    mockCaps = CAPS;
    const snapshot = populatedSnapshot();
    snapshot.scriptDescriptors = [
      {
        localId: 'script-active',
        name: 'First script',
        scriptKey: 'first-script',
        worktreeLocalId: 'wt1',
      },
      {
        localId: 'script-completed',
        name: 'Second script',
        scriptKey: 'second-script',
        worktreeLocalId: 'wt1',
      },
      {
        localId: 'script-never-run',
        name: 'Third script',
        scriptKey: 'third-script',
        worktreeLocalId: 'wt1',
      },
    ];
    snapshot.scriptRuns = [
      {
        localId: 'script-old',
        name: 'First script',
        scriptKey: 'first-script',
        status: 'completed',
        startedAt: '2026-07-19T10:00:00Z',
        worktreeLocalId: 'wt1',
      },
      {
        localId: 'script-active-run',
        name: 'First script',
        scriptKey: 'first-script',
        status: 'running',
        startedAt: '2026-07-19T10:00:00Z',
        worktreeLocalId: 'wt1',
      },
      {
        localId: 'script-completed-old',
        name: 'Second script',
        scriptKey: 'second-script',
        status: 'failed',
        startedAt: '2026-07-19T09:00:00Z',
        worktreeLocalId: 'wt1',
      },
      {
        localId: 'script-completed-latest',
        name: 'Second script',
        scriptKey: 'second-script',
        status: 'completed',
        startedAt: '2026-07-19T11:00:00Z',
        worktreeLocalId: 'wt1',
      },
    ];
    snapshot.hookDescriptors = [
      {
        localId: 'hook-active',
        name: 'First hook',
        hookKey: 'first-hook',
        triggerName: 'on-first',
        worktreeLocalId: 'wt1',
      },
      {
        localId: 'hook-completed',
        name: 'Second hook',
        hookKey: 'second-hook',
        triggerName: 'on-second',
        worktreeLocalId: 'wt1',
      },
      {
        localId: 'hook-never-run',
        name: 'Third hook',
        hookKey: 'third-hook',
        triggerName: 'on-third',
        worktreeLocalId: 'wt1',
      },
    ];
    snapshot.hookRuns = [
      {
        localId: 'hook-old',
        name: 'First hook',
        hookKey: 'first-hook',
        triggerName: 'on-first',
        status: 'completed',
        startedAt: '2026-07-19T10:00:00Z',
        worktreeLocalId: 'wt1',
      },
      {
        localId: 'hook-active-run',
        name: 'First hook',
        hookKey: 'first-hook',
        triggerName: 'on-first',
        status: 'queued',
        startedAt: '2026-07-19T10:00:00Z',
        worktreeLocalId: 'wt1',
      },
      {
        localId: 'hook-completed-latest',
        name: 'Second hook',
        hookKey: 'second-hook',
        triggerName: 'on-second',
        status: 'completed',
        startedAt: '2026-07-19T11:00:00Z',
        worktreeLocalId: 'wt1',
      },
    ];
    mockActivity = { ...baseState(), snapshot };

    const out = renderToString(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        hostActions={{
          onRunScript: (): void => {},
          onCancelScript: (): void => {},
          onRunHook: (): void => {},
          onCancelHook: (): void => {},
        }}
      />,
    );
    const scripts = out.slice(
      out.indexOf('activity-section-scripts'),
      out.indexOf('activity-section-hooks'),
    );
    const hooks = out.slice(
      out.indexOf('activity-section-hooks'),
      out.indexOf('activity-section-terminals'),
    );

    expect(scripts.match(/data-testid="activity-scripts-entry"/g)).toHaveLength(
      3,
    );
    expect(scripts.match(/>Stop<\/button>/g)).toHaveLength(1);
    expect(
      scripts.match(/data-execution-action-label="true"[^>]*>Run<\/span>/g),
    ).toHaveLength(2);
    expect(scripts).toContain('activity-scripts-completed-toggle');
    expect(scripts.indexOf('First script')).toBeLessThan(
      scripts.indexOf('Second script'),
    );
    expect(scripts.indexOf('Second script')).toBeLessThan(
      scripts.indexOf('Third script'),
    );

    expect(hooks.match(/data-testid="activity-hooks-entry"/g)).toHaveLength(3);
    expect(hooks.match(/>Stop<\/button>/g)).toHaveLength(1);
    expect(
      hooks.match(/data-execution-action-label="true"[^>]*>Run<\/span>/g),
    ).toHaveLength(2);
    expect(hooks).toContain('activity-hooks-completed-toggle');
    expect(hooks.indexOf('First hook')).toBeLessThan(
      hooks.indexOf('Second hook'),
    );
    expect(hooks.indexOf('Second hook')).toBeLessThan(
      hooks.indexOf('Third hook'),
    );
  });

  it('hides Stop when a running script has no cancel handler', () => {
    mockCaps = CAPS;
    const snapshot = populatedSnapshot();
    snapshot.scriptDescriptors = [
      {
        localId: 'script-1',
        name: 'Build',
        scriptKey: 'build',
        worktreeLocalId: 'wt1',
      },
    ];
    snapshot.scriptRuns = [
      {
        localId: 'script-run-1',
        name: 'Build',
        scriptKey: 'build',
        status: 'running',
        worktreeLocalId: 'wt1',
      },
    ];
    mockActivity = { ...baseState(), snapshot };

    const out = renderToString(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        hostActions={{ onRunScript: (): void => {} }}
      />,
    );

    expect(out).toContain('Build');
    expect(out).not.toContain('>Stop</button>');
    expect(out).not.toContain('>Run</button>');
  });

  it('dispatches the original portal script descriptor after confirmation', async () => {
    mockCaps = CAPS;
    const snapshot = populatedSnapshot();
    const descriptor: PortalScriptDescriptor = {
      localId: 'script-1',
      name: 'Build',
      scriptKey: 'build',
      worktreeLocalId: 'wt1',
    };
    snapshot.scriptDescriptors = [descriptor];
    snapshot.scriptRuns = [];
    mockActivity = { ...baseState(), snapshot };
    const onRunScript = jest.fn<void, [PortalScriptDescriptor]>();
    const container = document.createElement('div');
    const root = createRoot(container);

    act(() => {
      root.render(
        <ActivityPanel
          workspaceLocalId="ws1"
          worktreeLocalId="wt1"
          hostActions={{ onRunScript }}
        />,
      );
    });
    const run = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-scripts-run"]',
    );
    act(() => run?.click());
    expect(container.querySelector('pre')).toBeNull();
    const confirm = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Confirm',
    );
    await act(async () => {
      confirm?.click();
      await Promise.resolve();
    });
    expect(onRunScript).toHaveBeenCalledWith(descriptor);

    act(() => root.unmount());
  });

  it('renders the rich scripts host model with grouped lifecycles, run state, and confirmation', async () => {
    mockCaps = CAPS;
    mockActivity = baseState();
    const onRun = jest.fn(() => Promise.resolve());
    const container = document.createElement('div');
    const root = createRoot(container);

    act(() => {
      root.render(
        <ActivityPanel
          workspaceLocalId="ws1"
          worktreeLocalId="wt1"
          scriptsSection={{
            identityKey: 'ws1/wt1',
            groupWorkspaceLifecycles: true,
            entries: [
              {
                script: {
                  scriptKey: 'workspace-setup',
                  scriptName: 'setup',
                  label: 'Workspace Setup',
                  displayName: 'Setup',
                  command: 'npm install',
                  lifecycle: 'setup',
                  target: 'workspace-root',
                },
                confirmBeforeRun: false,
                runDisabled: true,
              },
              {
                script: {
                  scriptKey: 'repo-setup',
                  scriptName: 'setup',
                  label: 'Repo Setup',
                  displayName: 'Setup',
                  command: 'npm ci',
                  lifecycle: 'setup',
                  target: 'workspace-repo',
                  repoId: 'repo-1',
                  repoName: 'Repo One',
                },
                confirmBeforeRun: false,
                runDisabled: true,
              },
              {
                script: {
                  scriptKey: 'deploy',
                  scriptName: 'deploy',
                  label: 'Deploy',
                  displayName: 'Deploy',
                  command: 'npm run deploy',
                  lifecycle: 'custom',
                  target: 'project',
                },
                confirmBeforeRun: true,
                runDisabled: false,
              },
            ],
            runs: {
              deploy: {
                scriptKey: 'deploy',
                label: 'Deploy',
                status: 'failed',
                outputLines: ['rich output'],
                exitCode: 17,
                timedOut: true,
                durationMs: 900,
                startedAt: 1,
                hasDevServerHits: true,
              },
            },
            onRun,
          }}
        />,
      );
    });

    expect(container.textContent).toContain('Workspace Setup');
    expect(container.textContent).toContain('Repo Setup');
    expect(
      container.querySelector(
        '[data-testid="activity-scripts-completed-toggle"]',
      ),
    ).not.toBeNull();
    const setupRow = Array.from(
      container.querySelectorAll('[data-testid="activity-scripts-entry"]'),
    ).find((row) => row.textContent?.includes('Workspace Setup'));
    expect(
      setupRow?.querySelector<HTMLButtonElement>(
        '[data-testid="activity-scripts-run"]',
      )?.disabled,
    ).toBe(true);

    const deployRow = Array.from(
      container.querySelectorAll('[data-testid="activity-scripts-entry"]'),
    ).find((row) => row.textContent?.includes('Deploy'));
    act(() => {
      deployRow
        ?.querySelector<HTMLButtonElement>(
          '[data-testid="activity-scripts-run"]',
        )
        ?.click();
    });
    const confirm = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Confirm',
    );
    expect(confirm).toBeDefined();
    await act(async () => {
      confirm?.click();
      await Promise.resolve();
    });
    expect(onRun).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });

  it('keeps Stop enabled for a running paused hook and dispatches cancel', () => {
    mockCaps = CAPS;
    const snapshot = populatedSnapshot();
    snapshot.hookDescriptors = [
      {
        localId: 'hook-1',
        name: 'Paused hook',
        hookKey: 'paused-hook',
        triggerName: 'on-save',
        paused: true,
        worktreeLocalId: 'wt1',
      },
    ];
    const run: PortalHookRunProjection = {
      localId: 'hook-run-1',
      name: 'Paused hook',
      hookKey: 'paused-hook',
      triggerName: 'on-save',
      status: 'running',
      worktreeLocalId: 'wt1',
    };
    snapshot.hookRuns = [run];
    mockActivity = { ...baseState(), snapshot };
    const onCancelHook = jest.fn<void, [PortalHookRunProjection]>();
    const container = document.createElement('div');
    const root = createRoot(container);

    act(() => {
      root.render(
        <ActivityPanel
          workspaceLocalId="ws1"
          worktreeLocalId="wt1"
          hostActions={{
            onRunHook: (): void => {},
            onCancelHook,
          }}
        />,
      );
    });
    const stop = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Stop',
    );
    expect(stop).toBeDefined();
    expect(stop?.disabled).toBe(false);

    act(() => {
      stop?.click();
    });
    expect(onCancelHook).toHaveBeenCalledWith(run);

    act(() => root.unmount());
  });

  it('hides portal hook Run when no run handler is available', () => {
    mockCaps = CAPS;
    const snapshot = populatedSnapshot();
    snapshot.hookDescriptors = [
      {
        localId: 'hook-1',
        name: 'Read-only hook',
        hookKey: 'read-only-hook',
        triggerName: 'on-save',
        worktreeLocalId: 'wt1',
      },
    ];
    snapshot.hookRuns = [];
    mockActivity = { ...baseState(), snapshot };

    const out = renderToString(
      <ActivityPanel workspaceLocalId="ws1" worktreeLocalId="wt1" />,
    );
    const hooks = out.slice(
      out.indexOf('activity-section-hooks'),
      out.indexOf('activity-section-terminals'),
    );

    expect(hooks).toContain('Read-only hook');
    expect(hooks).not.toContain('data-testid="activity-hooks-run"');
  });

  it('renders the rich hooks host model without the portal mapper losing action details', () => {
    mockCaps = CAPS;
    mockActivity = baseState();
    const onTogglePause = jest.fn();
    const container = document.createElement('div');
    const root = createRoot(container);

    act(() => {
      root.render(
        <ActivityPanel
          workspaceLocalId="ws1"
          worktreeLocalId="wt1"
          hooksSection={{
            identityKey: 'ws1/wt1',
            entries: [
              {
                hook: {
                  hookKey: 'project:pr:create',
                  triggerName: 'pr:create',
                  label: 'PR Created',
                  target: 'project',
                  actions: [
                    {
                      type: 'chat',
                      label: 'Chat: review the complete PR metadata',
                    },
                  ],
                },
                groupedLabel: 'PR Created',
                paused: true,
                runDisabled: false,
              },
            ],
            runs: {},
            unconfiguredWatchers: [],
            onRun: () => Promise.resolve(),
            onTogglePause,
            renderWatcherButton: (key) => (
              <button type="button" data-testid={`watcher-slot-${key}`}>
                Watch
              </button>
            ),
          }}
        />,
      );
    });

    expect(
      container.querySelector('[data-testid="activity-hooks-body"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="watcher-slot-project:pr:create"]'),
    ).not.toBeNull();
    const pause = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-hooks-pause-toggle"]',
    );
    expect(pause?.getAttribute('aria-label')).toBe('Resume PR Created');
    act(() => pause?.click());
    expect(onTogglePause).toHaveBeenCalledWith('project:pr:create');

    const run = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-hooks-run"]',
    );
    expect(run?.disabled).toBe(false);
    act(() => run?.click());
    expect(container.textContent).toContain(
      'Chat: review the complete PR metadata',
    );

    act(() => root.unmount());
  });

  it('dispatches per-row hook pause toggles by descriptor state', () => {
    mockCaps = CAPS;
    const snapshot = populatedSnapshot();
    snapshot.hookDescriptors = [
      {
        localId: 'hook-1',
        name: 'Paused hook',
        hookKey: 'paused-hook',
        triggerName: 'on-save',
        paused: true,
        worktreeLocalId: 'wt1',
      },
      {
        localId: 'hook-2',
        name: 'Active hook',
        hookKey: 'active-hook',
        triggerName: 'on-commit',
        paused: false,
        worktreeLocalId: 'wt1',
      },
    ];
    mockActivity = { ...baseState(), snapshot };
    const onToggleHookPause = jest.fn<
      void,
      [SessionViewModel['hookDescriptors'][number]]
    >();
    const container = document.createElement('div');
    const root = createRoot(container);

    act(() => {
      root.render(
        <ActivityPanel
          workspaceLocalId="ws1"
          worktreeLocalId="wt1"
          hostActions={{ onToggleHookPause }}
        />,
      );
    });

    // Rows sort in desktop trigger order, so resolve them by label rather
    // than by position.
    const entries = Array.from(
      container.querySelectorAll('[data-testid="activity-hooks-entry"]'),
    );
    const entryByLabel = (label: string): Element | undefined =>
      entries.find((entry) => entry.textContent?.includes(label));
    const pausedEntry = entryByLabel('Paused hook');
    const activeEntry = entryByLabel('Active hook');
    const pausedLabel = pausedEntry?.querySelector('span');
    const activeLabel = activeEntry?.querySelector('span');
    const pausedToggle = pausedEntry?.querySelector<HTMLButtonElement>(
      '[data-testid="activity-hooks-pause-toggle"]',
    );
    const activeToggle = activeEntry?.querySelector<HTMLButtonElement>(
      '[data-testid="activity-hooks-pause-toggle"]',
    );

    expect(pausedLabel?.classList.contains('fg-secondary')).toBe(true);
    expect(pausedLabel?.classList.contains('line-through')).toBe(true);
    expect(pausedLabel?.classList.contains('fg-primary/80')).toBe(false);
    expect(activeLabel?.classList.contains('fg-primary/80')).toBe(true);
    expect(activeLabel?.classList.contains('line-through')).toBe(false);
    expect(pausedToggle?.getAttribute('aria-label')).toBe('Resume Paused hook');
    expect(activeToggle?.getAttribute('aria-label')).toBe('Pause Active hook');

    act(() => pausedToggle?.click());
    act(() => activeToggle?.click());
    expect(onToggleHookPause).toHaveBeenNthCalledWith(
      1,
      snapshot.hookDescriptors[0],
    );
    expect(onToggleHookPause).toHaveBeenNthCalledWith(
      2,
      snapshot.hookDescriptors[1],
    );

    act(() => root.unmount());
  });

  it('toggles all hooks from header state and hides controls without host actions', () => {
    mockCaps = CAPS;
    const snapshot = populatedSnapshot();
    snapshot.hookDescriptors = [
      {
        localId: 'hook-1',
        name: 'Paused hook',
        hookKey: 'paused-hook',
        triggerName: 'on-save',
        paused: true,
        worktreeLocalId: 'wt1',
      },
      {
        localId: 'hook-2',
        name: 'Active hook',
        hookKey: 'active-hook',
        triggerName: 'on-commit',
        paused: false,
        worktreeLocalId: 'wt1',
      },
    ];
    mockActivity = { ...baseState(), snapshot };
    const onToggleAllHooksPause = jest.fn<void, [boolean]>();
    const container = document.createElement('div');
    const root = createRoot(container);

    act(() => {
      root.render(
        <ActivityPanel
          workspaceLocalId="ws1"
          worktreeLocalId="wt1"
          hostActions={{ onToggleAllHooksPause }}
        />,
      );
    });
    const pauseAll = container.querySelector<HTMLButtonElement>(
      '[aria-label="Pause all hooks"]',
    );
    act(() => pauseAll?.click());
    expect(onToggleAllHooksPause).toHaveBeenCalledWith(true);

    snapshot.hookDescriptors = snapshot.hookDescriptors.map((hook) => ({
      ...hook,
      paused: true,
    }));
    mockActivity = { ...baseState(), snapshot };
    act(() => {
      root.render(
        <ActivityPanel
          workspaceLocalId="ws1"
          worktreeLocalId="wt1"
          hostActions={{ onToggleAllHooksPause }}
        />,
      );
    });
    const resumeAll = container.querySelector<HTMLButtonElement>(
      '[aria-label="Resume all hooks"]',
    );
    act(() => resumeAll?.click());
    expect(onToggleAllHooksPause).toHaveBeenLastCalledWith(false);

    act(() => {
      root.render(
        <ActivityPanel workspaceLocalId="ws1" worktreeLocalId="wt1" />,
      );
    });
    expect(
      container.querySelector('[data-testid="activity-hooks-pause-toggle"]'),
    ).toBeNull();
    expect(container.querySelector('[aria-label$="all hooks"]')).toBeNull();
    act(() => root.unmount());
  });

  it('shows changed-files review only with changes and a host action', () => {
    mockCaps = CAPS;
    const snapshot = populatedSnapshot();
    snapshot.changedFiles.wt1 = {
      uncommitted: [{ filePath: 'src/app.ts', status: 'modified' }],
      committed: [],
    };
    mockActivity = { ...baseState(), snapshot };
    const onReviewChanges = jest.fn();
    const container = document.createElement('div');
    const root = createRoot(container);

    act(() => {
      root.render(
        <ActivityPanel
          workspaceLocalId="ws1"
          worktreeLocalId="wt1"
          hostActions={{ onReviewChanges }}
        />,
      );
    });
    const review = container.querySelector<HTMLButtonElement>(
      '[data-testid="review-changes-button"]',
    );
    expect(review?.textContent).toBe('');
    expect(review?.getAttribute('aria-label')).toBe('Review changes');
    expect(review?.getAttribute('data-header-action-button')).toBe('true');
    expect(review?.querySelector('svg')?.getAttribute('data-app-icon')).toBe(
      'true',
    );
    act(() => review?.click());
    expect(onReviewChanges).toHaveBeenCalledTimes(1);

    act(() => {
      root.render(
        <ActivityPanel workspaceLocalId="ws1" worktreeLocalId="wt1" />,
      );
    });
    expect(
      container.querySelector('[data-testid="review-changes-button"]'),
    ).toBeNull();
    act(() => root.unmount());
  });

  it('prefixes a changed path when only one multi-repo member changed', () => {
    mockCaps = CAPS;
    const snapshot = populatedSnapshot();
    snapshot.workspaces = [
      { localId: 'ws1', name: 'Workspace', type: 'multi-repo' },
    ];
    snapshot.changedFiles.wt1 = {
      worktreeLocalId: 'wt1',
      uncommitted: [
        {
          filePath: 'src/index.ts',
          status: 'modified',
          repoId: 'web',
          repoName: 'Web',
        },
      ],
      committed: [],
    };
    mockActivity = { ...baseState(), snapshot };
    expect(
      renderToString(
        <ActivityPanel workspaceLocalId="ws1" worktreeLocalId="wt1" />,
      ).replace(/<!-- -->/g, ''),
    ).toContain('Web/src/index.ts');
  });

  it('uses one semantic host action for plan implementation', () => {
    mockCaps = CAPS;
    const snapshot = populatedSnapshot();
    snapshot.plans[0] = { ...snapshot.plans[0], content: 'Do the work' };
    mockActivity = { ...baseState(), snapshot };

    const out = renderToString(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        hostActions={{ onImplementPlan: (): void => {} }}
      />,
    );

    expect(out).toContain('>Implement</button>');
  });

  /**
   * CAN-3019: the Plans card offers a third action that hands the finished plan
   * to a `plan_ready` pipeline. Gated on the host supplying the callback, which
   * is what keeps it off desktop (which overrides this section body entirely)
   * and off an unpaired portal (whose commands are disabled).
   */
  it('renders the plan Pipeline action only when the host supplies a handler', () => {
    mockCaps = CAPS;
    const snapshot = populatedSnapshot();
    snapshot.plans[0] = { ...snapshot.plans[0], content: 'Do the work' };
    mockActivity = { ...baseState(), snapshot };

    const withHandler = renderToString(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        hostActions={{ onRunPlanPipeline: (): void => {} }}
      />,
    );
    expect(withHandler).toContain(
      `activity-plan-pipeline-${snapshot.plans[0].localId ?? snapshot.plans[0].title}`,
    );
    expect(withHandler).toContain('>Pipeline</button>');

    const withoutHandler = renderToString(
      <ActivityPanel workspaceLocalId="ws1" worktreeLocalId="wt1" />,
    );
    expect(withoutHandler).not.toContain('activity-plan-pipeline-');
    expect(withoutHandler).not.toContain('>Pipeline</button>');
  });

  it('omits the plan Pipeline action for a plan with no loaded body', () => {
    mockCaps = CAPS;
    const snapshot = populatedSnapshot();
    snapshot.plans[0] = { ...snapshot.plans[0], content: undefined };
    mockActivity = { ...baseState(), snapshot };

    expect(
      renderToString(
        <ActivityPanel
          workspaceLocalId="ws1"
          worktreeLocalId="wt1"
          hostActions={{ onRunPlanPipeline: (): void => {} }}
        />,
      ),
    ).not.toContain('activity-plan-pipeline-');
  });

  it('treats a queued run as active: shows Stop, not Run', () => {
    mockCaps = CAPS;
    const snapshot = populatedSnapshot();
    snapshot.scriptDescriptors = [
      {
        localId: 'script-1',
        name: 'Build',
        scriptKey: 'build',
        worktreeLocalId: 'wt1',
      },
    ];
    snapshot.scriptRuns = [
      {
        localId: 'script-run-1',
        name: 'Build',
        scriptKey: 'build',
        status: 'queued',
        worktreeLocalId: 'wt1',
      },
    ];
    mockActivity = { ...baseState(), snapshot };

    const out = renderToString(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        hostActions={{
          onRunScript: (): void => {},
          onCancelScript: (): void => {},
        }}
      />,
    );

    expect(out).toContain('>Stop</button>');
    expect(out).not.toContain('>Run</button>');
  });

  it('shows loading placeholders instead of empty states while hydrating', () => {
    mockCaps = CAPS;
    mockActivity = baseState();

    const out = renderToString(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        hydrating
        sectionOverrides={EVERY_SECTION_HAS_CONTENT}
        showTerminals
      />,
    );

    expect(out).toContain('data-testid="activity-section-loading"');
    // Body-level empty states are replaced by the loading placeholder; the
    // header subtitle still shows the semantic (desktop-matched) copy.
    expect(out).not.toContain('data-testid="activity-changed-files-empty"');
    expect(out).not.toContain('No plans.');
  });

  it('renders populated sections normally while hydrating', () => {
    mockCaps = CAPS;
    mockActivity = { ...baseState(), snapshot: populatedSnapshot() };

    const out = renderToString(
      <ActivityPanel workspaceLocalId="ws1" worktreeLocalId="wt1" hydrating />,
    );

    expect(out).toContain('Plan A');
    expect(out).toContain('src/x.ts');
  });

  it('navigates the files tab: root switcher, breadcrumb, and joined paths', () => {
    mockCaps = CAPS;
    const snapshot = populatedSnapshot();
    snapshot.fileTree = {
      'r1:src': [
        { name: 'sub', isDir: true },
        { name: 'a.ts', isDir: false },
      ],
    };
    mockActivity = { ...baseState(), snapshot };
    const onListDirectory = jest.fn<void, [string]>();
    const onSelectFileRoot = jest.fn<void, [string]>();
    const onOpenCode = jest.fn();
    const onTabChange = jest.fn();
    const container = document.createElement('div');
    const root = createRoot(container);

    act(() => {
      root.render(
        <ActivityPanel
          workspaceLocalId="ws1"
          worktreeLocalId="wt1"
          fileTreeRootKey="r1:src"
          fileRootLocalId="r1"
          fileRoots={[
            { localId: 'r1', label: 'repo-one' },
            { localId: 'r2', label: 'repo-two' },
          ]}
          activeFileRootLocalId="r1"
          fileTreeDir="src"
          hostActions={{ onListDirectory, onSelectFileRoot, onOpenCode }}
          onTabChange={onTabChange}
        />,
      );
    });
    const filesTab = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-tab-files"]',
    );
    act(() => filesTab?.click());
    expect(onTabChange).toHaveBeenCalledWith('files');

    const switcher = container.querySelector(
      '[data-testid="activity-files-roots"]',
    );
    expect(switcher?.textContent).toContain('repo-one');
    expect(switcher?.textContent).toContain('repo-two');
    const otherRoot = Array.from(
      switcher?.querySelectorAll('button') ?? [],
    ).find((button) => button.textContent === 'repo-two');
    act(() => otherRoot?.click());
    expect(onSelectFileRoot).toHaveBeenCalledWith('r2');

    const breadcrumb = container.querySelector(
      '[data-testid="activity-files-breadcrumb"]',
    );
    expect(breadcrumb?.textContent).toContain('src');
    const up = breadcrumb?.querySelector('button');
    act(() => up?.click());
    expect(onListDirectory).toHaveBeenCalledWith('');

    const rows = Array.from(
      container.querySelectorAll<HTMLElement>('[data-path]'),
    );
    const folder = rows.find(
      (row) => row.getAttribute('data-path') === 'src/sub',
    );
    expect(folder).toBeDefined();
    act(() => folder?.click());
    expect(onListDirectory).toHaveBeenCalledWith('src/sub');

    const file = rows.find(
      (row) => row.getAttribute('data-path') === 'src/a.ts',
    );
    act(() => file?.click());
    expect(onOpenCode).toHaveBeenCalledWith({
      kind: 'file',
      title: 'a.ts',
      request: {
        projectId: 'ws1',
        worktreeId: 'wt1',
        fileRootLocalId: 'r1',
        relativePath: 'src/a.ts',
      },
    });

    act(() => root.unmount());
  });

  const SECTION_TITLES = [
    'Summary',
    'Changed files',
    'Pull requests',
    'Agent background processes',
    'MCP servers',
    'Plans',
    'Pipeline runs',
    'Cost',
    'Scripts',
    'Hooks',
    'Terminals',
    'Agent tasks',
  ];

  it('renders exact titles and non-dot SVG icons for all 12 sections', () => {
    mockCaps = { ...CAPS, costInsights: true };
    mockActivity = baseState();
    const out = renderToString(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        sectionOverrides={EVERY_SECTION_HAS_CONTENT}
        showTerminals
      />,
    );
    const rendered = document.createElement('div');
    rendered.innerHTML = out;
    DEFAULT_ACTIVITY_SECTION_ORDER.forEach((id, index) => {
      const section = rendered.querySelector(
        `[data-testid="activity-section-${id}"]`,
      );
      expect(section?.querySelector('h3')?.textContent).toBe(
        SECTION_TITLES[index],
      );
      const titleRow = section?.querySelector('[data-panel-section-title-row]');
      expect(titleRow?.className).toContain('items-center');
      expect(
        titleRow?.querySelector('[data-panel-section-leading-icon] svg'),
      ).not.toBeNull();
    });
    for (const title of SECTION_TITLES) {
      expect(out).toContain(`>${title}</span></button></h3>`);
    }
    // Every section header carries an SVG icon; none uses the shared DotIcon
    // marker (the stray-bullet regression this brick removes).
    expect(out).not.toContain('<circle cx="12" cy="12" r="2"');
  });

  it('renders semantic subtitles with correct pluralization', () => {
    mockCaps = CAPS;
    const snapshot = populatedSnapshot();
    snapshot.terminalSessions = [
      {
        localId: 't1',
        terminalLocalId: 'p1',
        worktreeLocalId: 'wt1',
        running: true,
      },
      {
        localId: 't2',
        terminalLocalId: 'p2',
        worktreeLocalId: 'wt1',
        running: false,
      },
    ];
    mockActivity = { ...baseState(), snapshot };
    const out = renderToString(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        showTerminals
      />,
    );
    // No generic item/items copy survives.
    expect(out).not.toContain('items</div>');
    expect(out).toContain('1 file');
    expect(out).toContain('1 pull request');
    expect(out).toContain('1 tracked');
    expect(out).toContain('2 terminals');
  });

  it('uses singular terminal copy for one session', () => {
    mockCaps = CAPS;
    const snapshot = populatedSnapshot();
    snapshot.terminalSessions = [
      {
        localId: 't1',
        terminalLocalId: 'p1',
        worktreeLocalId: 'wt1',
        running: true,
      },
    ];
    mockActivity = { ...baseState(), snapshot };
    const out = renderToString(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        showTerminals
      />,
    );
    const terminalsHeader = out.slice(
      out.indexOf('activity-section-terminals'),
      out.indexOf('activity-section-todo'),
    );
    expect(terminalsHeader).toContain('1 terminal');
    expect(terminalsHeader).not.toContain('1 terminals');
  });

  it('renders Plans hidden-count copy', () => {
    mockCaps = CAPS;
    const snapshot = populatedSnapshot();
    snapshot.plans = [
      {
        localId: 'p1',
        title: 'Visible plan',
        status: 'draft',
        worktreeLocalId: 'wt1',
      },
      {
        localId: 'p2',
        title: 'Hidden plan',
        status: 'draft',
        worktreeLocalId: 'wt1',
        hidden: true,
      },
    ];
    mockActivity = { ...baseState(), snapshot };
    const out = renderToString(
      <ActivityPanel workspaceLocalId="ws1" worktreeLocalId="wt1" />,
    );
    const plansHeader = out.slice(
      out.indexOf('activity-section-plans'),
      out.indexOf('activity-section-pipeline-runs'),
    );
    expect(plansHeader).toContain('1 tracked · 1 hidden');
  });

  it('renders pipeline active/completed subtitle copy', () => {
    mockCaps = CAPS;
    const snapshot = populatedSnapshot();
    snapshot.pipelineRuns = [
      {
        localId: 'r1',
        pipelineName: 'Active pipeline',
        status: 'running',
        worktreeLocalId: 'wt1',
      },
      {
        localId: 'r2',
        pipelineName: 'Done pipeline',
        status: 'completed',
        worktreeLocalId: 'wt1',
      },
    ];
    mockActivity = { ...baseState(), snapshot };
    const out = renderToString(
      <ActivityPanel workspaceLocalId="ws1" worktreeLocalId="wt1" />,
    );
    const pipelineHeader = out.slice(
      out.indexOf('activity-section-pipeline-runs'),
      out.indexOf('activity-section-scripts'),
    );
    expect(pipelineHeader).toContain('1 active, 1 completed');
  });

  it('renders the Summary Updated-relative subtitle from a timestamp', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-20T00:00:00.000Z'));
    try {
      mockCaps = CAPS;
      const snapshot = populatedSnapshot();
      snapshot.worktreeSummaries = [
        {
          localId: 'wt1',
          worktreeLocalId: 'wt1',
          title: 'Recent work',
          description: 'desc',
          generatedAt: '2026-07-19T22:00:00.000Z',
        },
      ];
      mockActivity = { ...baseState(), snapshot };
      const out = renderToString(
        <ActivityPanel workspaceLocalId="ws1" worktreeLocalId="wt1" />,
      );
      const summaryHeader = out.slice(
        out.indexOf('activity-section-summary'),
        out.indexOf('activity-section-changed-files'),
      );
      expect(summaryHeader).toContain('Updated 2h ago');
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['invalid', 'not-a-date', 'just now'],
    ['future', '2026-07-20T00:00:01.000Z', 'just now'],
    ['seconds', '2026-07-19T23:59:18.000Z', '42s ago'],
    ['minutes', '2026-07-19T23:42:01.000Z', '17m ago'],
    ['days', '2026-07-17T23:00:00.000Z', '2d ago'],
  ])(
    'renders the Summary %s relative-time state',
    (_state, generatedAt, expected) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-20T00:00:00.000Z'));
      try {
        mockCaps = CAPS;
        const snapshot = populatedSnapshot();
        snapshot.worktreeSummaries = [
          {
            localId: 'wt1',
            worktreeLocalId: 'wt1',
            title: 'Recent work',
            description: 'desc',
            generatedAt,
          },
        ];
        mockActivity = { ...baseState(), snapshot };
        const out = renderToString(
          <ActivityPanel workspaceLocalId="ws1" worktreeLocalId="wt1" />,
        );
        const summaryHeader = out.slice(
          out.indexOf('activity-section-summary'),
          out.indexOf('activity-section-changed-files'),
        );
        expect(summaryHeader).toContain(`Updated ${expected}`);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('renders generating and no-summary subtitle states', () => {
    mockCaps = CAPS;
    const generating = populatedSnapshot();
    generating.worktreeSummaries = [
      {
        localId: 'wt1',
        worktreeLocalId: 'wt1',
        title: 'Recent work',
        description: 'desc',
        generating: true,
      },
    ];
    mockActivity = { ...baseState(), snapshot: generating };
    expect(
      renderToString(
        <ActivityPanel workspaceLocalId="ws1" worktreeLocalId="wt1" />,
      ),
    ).toContain('Generating…');

    const empty = populatedSnapshot();
    empty.worktreeSummaries = [];
    mockActivity = { ...baseState(), snapshot: empty };
    expect(
      renderToString(
        <ActivityPanel workspaceLocalId="ws1" worktreeLocalId="wt1" />,
      ),
    ).not.toContain('activity-section-summary');
  });

  it('reserves collapsed descriptor color for warning states', () => {
    mockCaps = CAPS;
    const snapshot = populatedSnapshot();
    snapshot.pipelineRuns = [
      {
        localId: 'completed-run',
        pipelineName: 'Completed pipeline',
        status: 'completed',
        worktreeLocalId: 'wt1',
      },
    ];
    snapshot.scriptDescriptors = [
      {
        localId: 'script-1',
        name: 'Build',
        scriptKey: 'build',
        worktreeLocalId: 'wt1',
      },
    ];
    snapshot.hookRuns = [
      {
        localId: 'hook-run-1',
        name: 'Running hook',
        hookKey: 'hook',
        triggerName: 'on-save',
        status: 'running',
        worktreeLocalId: 'wt1',
      },
    ];
    mockActivity = { ...baseState(), snapshot };
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <ActivityPanel
          workspaceLocalId="ws1"
          worktreeLocalId="wt1"
          showTerminals
          sectionOverrides={Object.fromEntries(
            DEFAULT_ACTIVITY_SECTION_ORDER.map((id) => [
              id,
              { defaultCollapsed: true },
            ]),
          )}
        />,
      );
    });
    const iconClass = (id: string): string | null => {
      const icon = container.querySelector(
        `[data-testid="activity-section-${id}"] [data-panel-section-leading-icon]`,
      );
      return icon?.getAttribute('class') ?? null;
    };
    expect(iconClass('summary')).toBeNull();
    expect(iconClass('changed-files')).toContain('fg-warning');
    expect(iconClass('pull-request')).toContain('fg-warning');
    expect(iconClass('plans')).toContain('fg-secondary');
    expect(iconClass('pipeline-runs')).toContain('fg-secondary');
    expect(iconClass('scripts')).toContain('fg-secondary');
    expect(iconClass('hooks')).toContain('fg-warning');
    expect(iconClass('terminals')).toContain('fg-secondary');
    expect(iconClass('background-processes')).toBeNull();
    expect(iconClass('mcp-servers')).toBeNull();
    expect(iconClass('todo')).toBeNull();

    const alternate = populatedSnapshot();
    alternate.worktreeSummaries = [
      {
        localId: 'wt1',
        worktreeLocalId: 'wt1',
        title: 'Generating summary',
        description: '',
        generating: true,
      },
    ];
    alternate.changedFiles.wt1 = {
      worktreeLocalId: 'wt1',
      uncommitted: [],
      committed: [],
    };
    alternate.prStatuses = {};
    alternate.plans = [];
    alternate.pipelineRuns = [
      {
        localId: 'active-run',
        pipelineName: 'Active pipeline',
        status: 'running',
        worktreeLocalId: 'wt1',
      },
    ];
    alternate.scriptDescriptors = [];
    alternate.scriptRuns = [
      {
        localId: 'script-run',
        name: 'Active script',
        scriptKey: 'active-script',
        status: 'running',
        worktreeLocalId: 'wt1',
      },
    ];
    alternate.hookDescriptors = [
      {
        localId: 'hook-1',
        name: 'Configured hook',
        hookKey: 'configured-hook',
        triggerName: 'on-save',
        worktreeLocalId: 'wt1',
      },
    ];
    alternate.hookRuns = [];
    alternate.terminalSessions = [
      {
        localId: 'terminal-1',
        terminalLocalId: 'terminal-1',
        worktreeLocalId: 'wt1',
        running: true,
      },
    ];
    mockActivity = { ...baseState(), snapshot: alternate };
    act(() => {
      root.render(
        <ActivityPanel
          workspaceLocalId="ws1"
          worktreeLocalId="wt1"
          showTerminals
          sectionOverrides={Object.fromEntries(
            DEFAULT_ACTIVITY_SECTION_ORDER.map((id) => [
              id,
              { defaultCollapsed: true },
            ]),
          )}
        />,
      );
    });
    expect(iconClass('summary')).toContain('fg-secondary');
    expect(iconClass('changed-files')).toBeNull();
    expect(iconClass('pull-request')).toBeNull();
    expect(iconClass('plans')).toBeNull();
    expect(iconClass('pipeline-runs')).toContain('fg-warning');
    expect(iconClass('scripts')).toContain('fg-warning');
    expect(iconClass('hooks')).toContain('fg-secondary');
    expect(iconClass('terminals')).toContain('fg-secondary');
    act(() => root.unmount());
  });

  it('shows the portal-only Summary available subtitle when no timestamp exists', () => {
    mockCaps = CAPS;
    const snapshot = populatedSnapshot();
    snapshot.worktreeSummaries = [
      {
        localId: 'wt1',
        worktreeLocalId: 'wt1',
        title: 'Recent work',
        description: 'desc',
      },
    ];
    mockActivity = { ...baseState(), snapshot };
    const out = renderToString(
      <ActivityPanel workspaceLocalId="ws1" worktreeLocalId="wt1" />,
    );
    const summaryHeader = out.slice(
      out.indexOf('activity-section-summary'),
      out.indexOf('activity-section-changed-files'),
    );
    expect(summaryHeader).toContain('Summary available');
  });

  it('excludes orphan runs from the configured count and renders their rows during hydration', () => {
    mockCaps = CAPS;
    const snapshot = populatedSnapshot();
    snapshot.scriptDescriptors = [];
    snapshot.scriptRuns = [
      {
        localId: 'sr1',
        name: 'Orphan script',
        scriptKey: 'orphan',
        status: 'running',
        worktreeLocalId: 'wt1',
      },
    ];
    snapshot.hookDescriptors = [];
    snapshot.hookRuns = [];
    mockActivity = { ...baseState(), snapshot };
    const out = renderToString(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        hydrating
        sectionOverrides={EVERY_SECTION_HAS_CONTENT}
        hostActions={{ onCancelScript: (): void => {} }}
      />,
    );
    const scriptsHeader = out.slice(
      out.indexOf('activity-section-scripts'),
      out.indexOf('activity-section-hooks'),
    );
    const hooksHeader = out.slice(
      out.indexOf('activity-section-hooks'),
      out.indexOf('activity-section-terminals'),
    );
    // Orphan-run-only section: 0 configured, but the run row renders during
    // hydration (never Loading…).
    expect(scriptsHeader).toContain('None configured');
    expect(scriptsHeader).toContain('Orphan script');
    expect(scriptsHeader).not.toContain('activity-section-loading');
    // Genuinely empty hooks section still shows Loading… during hydration.
    expect(hooksHeader).toContain('activity-section-loading');
  });

  it('keeps built-in title, icon, and subtitle for an action-only override', () => {
    mockCaps = CAPS;
    mockActivity = { ...baseState(), snapshot: populatedSnapshot() };
    const out = renderToString(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        sectionOverrides={{
          scripts: {
            headerAction: <button data-testid="scripts-gear">gear</button>,
          },
        }}
      />,
    );
    const scriptsHeader = out.slice(
      out.indexOf('activity-section-scripts'),
      out.indexOf('activity-section-hooks'),
    );
    // Action-only override must not suppress the built-in metadata.
    expect(scriptsHeader).toContain('>Scripts</span></button></h3>');
    expect(scriptsHeader).toContain('None configured');
    expect(scriptsHeader).toContain('data-testid="scripts-gear"');
  });

  it('lets a null extra-section header action suppress the built-in default', () => {
    mockCaps = CAPS;
    mockActivity = { ...baseState(), snapshot: populatedSnapshot() };
    const out = renderToString(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        hostActions={{ onReviewChanges: (): void => {} }}
        extraSections={[
          {
            key: 'changed-files',
            title: 'Changed Files',
            headerAction: null,
            body: <div>Changed files body</div>,
          },
        ]}
      />,
    );
    const changedFilesHeader = out.slice(
      out.indexOf('activity-section-changed-files'),
      out.indexOf('activity-section-pull-request'),
    );
    expect(changedFilesHeader).not.toContain('review-changes-button');
  });

  it('expands a collapsed section when the host requests it', () => {
    mockCaps = CAPS;
    mockActivity = baseState();
    const container = document.createElement('div');
    const root = createRoot(container);
    const render = (expandRequest?: number): void => {
      act(() => {
        root.render(
          <ActivityPanel
            workspaceLocalId="ws1"
            worktreeLocalId="wt1"
            sectionOverrides={{
              'pipeline-runs': {
                hasContent: true,
                body: <div data-testid="runs-body">Runs</div>,
                expandRequest,
              },
            }}
          />,
        );
      });
    };
    const title = (): HTMLButtonElement | null =>
      container.querySelector<HTMLButtonElement>(
        '[data-testid="activity-section-pipeline-runs"] [data-panel-section-title-row]',
      );

    render();
    act(() => title()?.click());
    expect(title()?.getAttribute('aria-expanded')).toBe('false');

    render(1);
    expect(title()?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-testid="runs-body"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it('renders a header action in the section header without toggling collapse or initiating drag', () => {
    mockCaps = CAPS;
    const setSectionOrder = jest.fn<void, [string, string[]]>();
    mockActivity = { ...baseState(), setSectionOrder };
    const onAction = jest.fn();
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <ActivityPanel
          workspaceLocalId="ws1"
          worktreeLocalId="wt1"
          sectionOverrides={{
            scripts: {
              headerAction: (
                <button data-testid="gear" type="button" onClick={onAction}>
                  gear
                </button>
              ),
            },
          }}
        />,
      );
    });
    const section = container.querySelector(
      '[data-testid="activity-section-scripts"]',
    );
    const gear = section?.querySelector<HTMLButtonElement>(
      '[data-testid="gear"]',
    );
    expect(gear).not.toBeNull();
    act(() => {
      gear?.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, cancelable: true }),
      );
      document.dispatchEvent(
        new MouseEvent('pointermove', {
          bubbles: true,
          cancelable: true,
          clientY: 100,
        }),
      );
      document.dispatchEvent(
        new MouseEvent('pointerup', { bubbles: true, cancelable: true }),
      );
    });
    expect(section?.getAttribute('style')).toContain('opacity: 1');
    expect(setSectionOrder).not.toHaveBeenCalled();
    const expandedBefore = section
      ?.querySelector('[data-panel-section-title-row]')
      ?.getAttribute('aria-expanded');
    act(() => gear?.click());
    expect(onAction).toHaveBeenCalledTimes(1);
    const expandedAfter = section
      ?.querySelector('[data-panel-section-title-row]')
      ?.getAttribute('aria-expanded');
    // The header action click did not toggle the section's collapse state.
    expect(expandedAfter).toBe(expandedBefore);
    act(() => root.unmount());
  });
});

describe('activity section content predicate', () => {
  /** A snapshot whose every section is genuinely empty for `wt1`. */
  function emptySnapshot(): SessionViewModel {
    const snapshot = populatedSnapshot();
    snapshot.plans = [];
    snapshot.changedFiles = {};
    snapshot.prStatuses = {};
    return snapshot;
  }

  function input(
    overrides: Partial<ActivitySectionPresenceInput> = {},
  ): ActivitySectionPresenceInput {
    return {
      snapshot: emptySnapshot(),
      workspaceLocalId: 'ws1',
      worktreeLocalId: 'wt1',
      ...overrides,
    };
  }

  it('covers every default section plus host extras', () => {
    const ids = activitySectionPresenceIds(
      input({
        extraSections: [
          { key: 'attachments', title: 'Attachments', body: null },
        ],
      }),
    );
    for (const id of DEFAULT_ACTIVITY_SECTION_ORDER) {
      expect(ids).toContain(id);
    }
    expect(ids).toContain('attachments');
  });

  it('counts a changed-files notice as content even with no rows (REG-3024)', () => {
    const sleeping = input();
    if (sleeping.snapshot) {
      sleeping.snapshot.changedFiles = {
        wt1: {
          worktreeLocalId: 'wt1',
          uncommitted: [],
          committed: [],
          notices: [{ kind: 'sleeping' }],
        },
      };
    }
    expect(activitySectionHasContent('changed-files', sleeping)).toBe(true);
    expect(activitySectionRenders('changed-files', sleeping)).toBe(true);
  });

  it('does not count a forced-but-empty terminals section as content', () => {
    const forced = input({ showTerminals: true });
    // The card still renders, exactly as today — it just does not count.
    expect(activitySectionRenders('terminals', forced)).toBe(true);
    expect(activitySectionHasContent('terminals', forced)).toBe(false);
    expect(activityPanelHasContent(forced)).toBe(false);
  });

  it('counts a terminals section that actually has sessions', () => {
    const withSession = input();
    withSession.snapshot?.terminalSessions.push({
      localId: 't1',
      worktreeLocalId: 'wt1',
      title: 'zsh',
      status: 'running',
    });
    expect(activitySectionHasContent('terminals', withSession)).toBe(true);
    expect(activityPanelHasContent(withSession)).toBe(true);
  });

  it('shows the Pull Requests card when only a failed refresh is known', () => {
    const failed = input();
    const snapshot = failed.snapshot;
    if (snapshot === undefined || snapshot === null) throw new Error('none');
    snapshot.prStatuses.wt1 = {
      worktreeLocalId: 'wt1',
      refreshError: "Couldn't reach GitHub. Try again.",
    };
    expect(activitySectionRenders('pull-request', failed)).toBe(true);
    expect(activitySectionHasContent('pull-request', failed)).toBe(true);
    expect(activitySectionRenders('pull-request', input())).toBe(false);
  });

  it('does not count summary made visible only by its refresh action', () => {
    const refreshable = input({ summaryRefreshAvailable: true });
    expect(activitySectionRenders('summary', refreshable)).toBe(true);
    expect(activitySectionHasContent('summary', refreshable)).toBe(false);
    expect(activityPanelHasContent(refreshable)).toBe(false);
  });

  it('counts summary once a real summary exists', () => {
    const withSummary = input({
      summaryRefreshAvailable: true,
      worktreeSummaries: [
        {
          localId: 'wt1',
          worktreeLocalId: 'wt1',
          title: 'Real summary',
          description: 'Body',
        },
      ],
    });
    expect(activitySectionHasContent('summary', withSummary)).toBe(true);
  });

  it('treats hydrating as unresolved rather than as content', () => {
    const hydrating = input({ hydrating: true });
    // Hydration does not make an empty section visible, and is not data, so
    // nothing counts yet. Callers acting on
    // emptiness must hold their decision while `hydrating` is true.
    expect(activitySectionRenders('pull-request', hydrating)).toBe(false);
    expect(activitySectionHasContent('pull-request', hydrating)).toBe(false);
    expect(activityPanelHasContent(hydrating)).toBe(false);
  });

  it('default-denies Cost without the host costInsights capability', () => {
    const override = {
      sectionOverrides: { cost: { hasContent: true, body: <p>Cost</p> } },
      hydrating: true,
    };
    expect(activitySectionRenders('cost', input(override))).toBe(false);
    const enabled = input({
      ...override,
      costInsightsEnabled: true,
    });
    expect(activitySectionRenders('cost', enabled)).toBe(true);
    expect(activitySectionHasContent('cost', enabled)).toBe(true);
  });

  it('counts real snapshot data', () => {
    const populated = input({ snapshot: populatedSnapshot() });
    expect(activitySectionHasContent('changed-files', populated)).toBe(true);
    expect(activitySectionHasContent('pull-request', populated)).toBe(true);
    expect(activitySectionHasContent('plans', populated)).toBe(true);
    expect(activityPanelHasContent(populated)).toBe(true);
  });

  it('ignores an extra section that is visible only for its action', () => {
    const actionOnly = input({
      extraSections: [
        {
          key: 'attachments',
          title: 'Attachments',
          body: null,
          hasContent: false,
          hasAction: true,
        },
      ],
    });
    expect(activitySectionRenders('attachments', actionOnly)).toBe(true);
    expect(activitySectionHasContent('attachments', actionOnly)).toBe(false);
    expect(activityPanelHasContent(actionOnly)).toBe(false);
  });

  it('counts an extra section that reports content', () => {
    const withFiles = input({
      extraSections: [
        {
          key: 'attachments',
          title: 'Attachments',
          body: null,
          hasContent: true,
        },
      ],
    });
    expect(activitySectionHasContent('attachments', withFiles)).toBe(true);
    expect(activityPanelHasContent(withFiles)).toBe(true);
  });

  it('counts an opaque host body that supplies no content signal', () => {
    const opaque = input({
      extraSections: [{ key: 'notes', title: 'Notes', body: null }],
    });
    expect(activitySectionHasContent('notes', opaque)).toBe(true);
  });

  it('counts host background tasks as section content', () => {
    expect(
      activitySectionHasContent(
        'background-processes',
        input({
          snapshot: populatedSnapshot(),
          backgroundTasksSection: { tasks: [RUNNING_TASK] },
        }),
      ),
    ).toBe(true);
  });

  it('never lets background-processes hold the rail open', () => {
    expect(
      activitySectionHasContent(
        'background-processes',
        input({ snapshot: populatedSnapshot() }),
      ),
    ).toBe(false);
  });

  it('drops code-only sections for a repoless cowork project', () => {
    const snapshot = populatedSnapshot();
    snapshot.workspaces = [
      { localId: 'ws1', name: 'Cowork', type: 'cowork', chatIds: [] },
    ];
    const cowork = input({ snapshot });
    // `populatedSnapshot` seeds changed files, a PR, and plans — all code-only.
    expect(activitySectionHasContent('changed-files', cowork)).toBe(false);
    expect(activitySectionHasContent('pull-request', cowork)).toBe(false);
    expect(activitySectionHasContent('plans', cowork)).toBe(false);
    expect(activityPanelHasContent(cowork)).toBe(false);
  });

  describe('capability allowlist (REG-3022)', () => {
    // What the cloud repository adapter reports: only the sections it has
    // readers for.
    const REPOSITORY_SECTIONS = [
      'summary',
      'background-processes',
      'mcp-servers',
      'pipeline-runs',
      'terminals',
      'todo',
    ] as const;

    function repositorySnapshot(): SessionViewModel {
      const snapshot = populatedSnapshot();
      snapshot.workspaces = [
        { localId: 'ws1', name: 'Repo', type: 'single-repo', chatIds: [] },
      ];
      return snapshot;
    }

    it('hides the sections a repository client does not implement, whatever the snapshot holds', () => {
      const repository = input({
        snapshot: repositorySnapshot(),
        activitySectionIds: REPOSITORY_SECTIONS,
      });
      // `populatedSnapshot` seeds changed files, a PR and plans; none may
      // render or count while the client has no reader for them.
      for (const id of [
        'changed-files',
        'pull-request',
        'plans',
        'scripts',
        'hooks',
      ]) {
        expect(activitySectionRenders(id, repository)).toBe(false);
        expect(activitySectionHasContent(id, repository)).toBe(false);
      }
      expect(activityPanelHasContent(repository)).toBe(false);
      // The sections it does implement are untouched by the allowlist.
      expect(activitySectionRenders('terminals', repository)).toBe(false);
      expect(
        activitySectionRenders('terminals', {
          ...repository,
          showTerminals: true,
        }),
      ).toBe(true);
      expect(
        activitySectionRenders('summary', {
          ...repository,
          summaryGenerating: true,
        }),
      ).toBe(true);
    });

    it('keeps a repository project fully visible when its client reports no allowlist', () => {
      const repository = input({ snapshot: repositorySnapshot() });
      expect(activitySectionHasContent('changed-files', repository)).toBe(true);
      expect(activitySectionHasContent('pull-request', repository)).toBe(true);
      expect(activitySectionHasContent('plans', repository)).toBe(true);
    });

    it('does not let an allowlist reveal what the Cowork type hides', () => {
      const snapshot = populatedSnapshot();
      snapshot.workspaces = [
        { localId: 'ws1', name: 'Cowork', type: 'cowork', chatIds: [] },
      ];
      const cowork = input({
        snapshot,
        activitySectionIds: [...DEFAULT_ACTIVITY_SECTION_ORDER],
      });
      expect(activitySectionRenders('changed-files', cowork)).toBe(false);
      expect(activitySectionRenders('plans', cowork)).toBe(false);
    });

    it('lets a host-owned extra section through only when the allowlist names it', () => {
      const extraSections = [
        { key: 'attachments', title: 'Attachments', body: null },
      ];
      expect(
        activitySectionRenders(
          'attachments',
          input({ extraSections, activitySectionIds: REPOSITORY_SECTIONS }),
        ),
      ).toBe(false);
      expect(
        activitySectionRenders(
          'attachments',
          input({
            extraSections,
            activitySectionIds: [...REPOSITORY_SECTIONS, 'attachments'],
          }),
        ),
      ).toBe(true);
    });
  });

  it('ignores a hidden section even when it holds data', () => {
    const hidden = input({
      snapshot: populatedSnapshot(),
      sectionOverrides: { 'changed-files': { hidden: true } },
    });
    expect(activitySectionRenders('changed-files', hidden)).toBe(false);
    expect(activitySectionHasContent('changed-files', hidden)).toBe(false);
  });

  it('counts configured-but-never-run scripts and hooks', () => {
    const configured = input({
      scriptsSection: {
        entries: [
          {
            key: 'setup',
            kind: 'setup',
            label: 'Setup',
            command: 'npm i',
            status: 'idle',
          },
        ],
        unconfiguredKinds: [],
      },
    });
    expect(activitySectionHasContent('scripts', configured)).toBe(true);
  });
});

describe('ActivityPanel card layout', () => {
  function renderCard(element: JSX.Element): {
    container: HTMLDivElement;
    unmount: () => void;
  } {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => root.render(element));
    return { container, unmount: (): void => act(() => root.unmount()) };
  }

  function rowKeys(container: HTMLElement): string[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid^="activity-card-row-"]',
      ),
    ).map((row) =>
      (row.dataset.testid ?? '').replace('activity-card-row-', ''),
    );
  }

  it('lists each section as one row with its state, without the rail chrome', () => {
    mockCaps = CAPS;
    mockActivity = { ...baseState(), snapshot: populatedSnapshot() };
    const { container, unmount } = renderCard(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        layout="card"
      />,
    );
    expect(rowKeys(container)).toEqual(
      expect.arrayContaining(['changed-files', 'pull-request', 'plans']),
    );
    const changes = container.querySelector(
      '[data-testid="activity-card-row-changed-files"]',
    );
    expect(changes?.textContent).toContain('Changes');
    // The menu's 32px row and 16px icon, with small text.
    expect(changes?.className).toContain('h-8');
    expect(changes?.className).toContain('text-xs');
    // The sidebar rows' corner radius.
    expect(changes?.className).toContain('rounded-row');
    expect(changes?.className).not.toContain('rounded-md');
    expect(changes?.querySelector('[aria-hidden="true"]')?.className).toContain(
      'h-4 w-4',
    );
    // The state sits at the row's right end, and no row draws a disclosure
    // chevron.
    expect(
      changes?.querySelector(
        '[data-testid="activity-card-value-changed-files"]',
      )?.textContent,
    ).toBe('1 file');
    expect(changes?.querySelectorAll('svg')).toHaveLength(1);
    // No rail tabs, drag handles, or collapsible section cards.
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.querySelector('[aria-label^="Reorder"]')).toBeNull();
    expect(container.querySelector('[data-panel-section-header]')).toBeNull();
    unmount();
  });

  it('shows a priced Cost row in the work block and opens its own panel', () => {
    mockCaps = { ...CAPS, costInsights: true };
    mockActivity = { ...baseState(), snapshot: populatedSnapshot() };
    const opened: string[] = [];
    const { container, unmount } = renderCard(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        layout="card"
        onOpenCardSection={(sectionId): boolean => {
          opened.push(sectionId);
          return sectionId === 'cost';
        }}
        sectionOverrides={{
          cost: {
            title: 'Cost',
            icon: <span aria-hidden="true">cost-icon</span>,
            hasContent: true,
            cardValue: '$21.66',
            body: <div data-testid="activity-card-cost-expanded" />,
          },
        }}
      />,
    );
    const row = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-card-row-cost"]',
    );
    expect(row?.textContent).toContain('Cost');
    expect(
      row?.querySelector('[data-testid="activity-card-value-cost"]')
        ?.textContent,
    ).toBe('$21.66');
    expect(
      row?.closest('[data-testid="activity-card-overview"]'),
    ).not.toBeNull();

    act(() => row?.click());

    expect(opened).toEqual(['cost']);
    expect(row?.hasAttribute('aria-expanded')).toBe(false);
    expect(
      container.querySelector('[data-testid="activity-card-detail"]'),
    ).toBeNull();
    unmount();
  });

  it('keeps an empty Cost row behind Add until the scope has cost', () => {
    mockCaps = { ...CAPS, costInsights: true };
    mockActivity = { ...baseState(), snapshot: populatedSnapshot() };
    const { container, unmount } = renderCard(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        layout="card"
        sectionOverrides={{
          cost: {
            title: 'Cost',
            icon: <span aria-hidden="true">cost-icon</span>,
            hasContent: false,
            hasAction: true,
          },
        }}
      />,
    );
    expect(rowKeys(container)).not.toContain('cost');
    const add = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-card-add"]',
    );
    act(() => add?.click());
    const costItem = document.querySelector<HTMLButtonElement>(
      '[data-testid="activity-card-add-menu"] [data-testid="activity-card-row-cost"]',
    );
    expect(costItem?.textContent).toContain('Cost');
    unmount();
  });

  it('expands Cost in place with the five-row preview body when no panel opens', () => {
    mockCaps = { ...CAPS, costInsights: true };
    mockActivity = { ...baseState(), snapshot: populatedSnapshot() };
    const { container, unmount } = renderCard(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        layout="card"
        onOpenCardSection={() => false}
        sectionOverrides={{
          cost: {
            title: 'Cost',
            icon: <span aria-hidden="true">cost-icon</span>,
            hasContent: true,
            cardValue: '$21.66',
            body: (
              <div
                data-testid="activity-card-cost-expanded"
                data-max-rows="5"
              />
            ),
          },
        }}
      />,
    );
    const row = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-card-row-cost"]',
    );

    act(() => row?.click());

    expect(
      container.querySelector(
        '[data-testid="activity-card-cost-expanded"][data-max-rows="5"]',
      ),
    ).not.toBeNull();
    unmount();
  });

  it('omits Cost and its Add item without the costInsights capability', () => {
    mockCaps = CAPS;
    mockActivity = { ...baseState(), snapshot: populatedSnapshot() };
    const { container, unmount } = renderCard(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        layout="card"
        sectionOverrides={{
          cost: {
            title: 'Cost',
            icon: <span aria-hidden="true">cost-icon</span>,
            hasContent: true,
            cardValue: '$21.66',
          },
        }}
      />,
    );

    expect(rowKeys(container)).not.toContain('cost');
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="activity-card-add"]')
        ?.click(),
    );
    expect(
      document.querySelector(
        '[data-testid="activity-card-add-menu"] [data-testid="activity-card-row-cost"]',
      ),
    ).toBeNull();
    unmount();
  });

  it('opens a section in its own panel instead of expanding it, when the host can', () => {
    mockCaps = CAPS;
    mockActivity = { ...baseState(), snapshot: populatedSnapshot() };
    const opened: string[] = [];
    const { container, unmount } = renderCard(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        layout="card"
        onOpenCardSection={(sectionId): boolean => {
          opened.push(sectionId);
          // No panel for Plans here: that row expands in place instead.
          return sectionId !== 'plans';
        }}
      />,
    );
    const changes = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-card-row-changed-files"]',
    );
    // A row that opens elsewhere has no expanded state.
    expect(changes?.hasAttribute('aria-expanded')).toBe(false);
    act(() => changes?.click());
    expect(opened).toEqual(['changed-files']);
    expect(
      container.querySelector('[data-testid="activity-card-detail"]'),
    ).toBeNull();

    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="activity-card-row-plans"]',
        )
        ?.click(),
    );
    expect(opened).toEqual(['changed-files', 'plans']);
    expect(
      container.querySelector(
        '[data-testid="activity-card-section-plans"] [data-testid="activity-card-detail"]',
      ),
    ).not.toBeNull();
    unmount();
  });

  it('expands sections in place, several at once', () => {
    mockCaps = CAPS;
    mockActivity = { ...baseState(), snapshot: populatedSnapshot() };
    const { container, unmount } = renderCard(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        layout="card"
      />,
    );
    const changes = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-card-row-changed-files"]',
    );
    const pr = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-card-row-pull-request"]',
    );
    expect(changes?.getAttribute('aria-expanded')).toBe('false');
    act(() => changes?.click());
    expect(changes?.getAttribute('aria-expanded')).toBe('true');
    // The open row wears the selected surface.
    expect(changes?.className).toContain('bg-muted');
    // The content opens below its row; every other row stays.
    const detail = container.querySelector(
      '[data-testid="activity-card-section-changed-files"] [data-testid="activity-card-detail"]',
    );
    expect(detail?.textContent).toContain('x.ts');
    expect(rowKeys(container)).toEqual(
      expect.arrayContaining(['changed-files', 'pull-request', 'plans']),
    );
    act(() => pr?.click());
    expect(
      container.querySelectorAll('[data-testid="activity-card-detail"]'),
    ).toHaveLength(2);
    act(() => changes?.click());
    expect(changes?.getAttribute('aria-expanded')).toBe('false');
    expect(
      container.querySelectorAll('[data-testid="activity-card-detail"]'),
    ).toHaveLength(1);
    unmount();
  });

  it('lists work then setup rows with no headings or hide button', () => {
    mockCaps = CAPS;
    mockActivity = { ...baseState(), snapshot: populatedSnapshot() };
    const { container, unmount } = renderCard(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        layout="card"
        extraSections={[
          {
            key: 'notes',
            title: 'Notes',
            hasContent: true,
            body: <p>A note</p>,
          },
        ]}
      />,
    );
    const keys = rowKeys(container);
    expect(keys.indexOf('changed-files')).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf('notes')).toBeGreaterThan(
      keys.indexOf('changed-files'),
    );
    expect(container.querySelector('h2')).toBeNull();
    expect(
      container.querySelector('[data-testid="activity-card-close"]'),
    ).toBeNull();
    unmount();
  });

  it('puts empty sections behind the Add row, below a divider, whose items run their action', () => {
    mockCaps = CAPS;
    mockActivity = { ...baseState(), snapshot: populatedSnapshot() };
    const onAction = jest.fn();
    const { container, unmount } = renderCard(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        layout="card"
        extraSections={[]}
        sectionOverrides={{
          'mcp-servers': {
            hasContent: false,
            hasAction: true,
            actionLabel: 'Add MCP server',
            onAction,
          },
        }}
      />,
    );
    document.body.append(container);
    // The empty section is not a row of its own.
    expect(rowKeys(container)).not.toContain('mcp-servers');
    const add = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-card-add"]',
    );
    expect(add?.textContent).toBe('Add');
    // Add is the card's last row, after a divider below every item.
    const content = container.querySelector(
      '[data-testid="activity-card-content"]',
    );
    expect(content?.lastElementChild).toBe(add);
    expect(add?.previousElementSibling?.getAttribute('role')).toBe('separator');
    act(() => add?.click());
    const item = document.querySelector<HTMLButtonElement>(
      '[data-testid="activity-card-add-menu"] [data-testid="activity-card-row-mcp-servers"]',
    );
    expect(item?.textContent).toContain('Add MCP server');
    act(() => item?.click());
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('[data-testid="activity-card-detail"]'),
    ).toBeNull();
    unmount();
    container.remove();
  });

  it('keeps a hidden section mounted so it can report content', () => {
    mockCaps = CAPS;
    mockActivity = { ...baseState(), snapshot: populatedSnapshot() };
    const { container, unmount } = renderCard(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        layout="card"
        extraSections={[
          {
            key: 'memory',
            title: 'Memory',
            hiddenWhileMounted: true,
            body: <p data-testid="memory-probe">Memory body</p>,
          },
        ]}
      />,
    );
    // No row while it reports nothing, but its body is mounted, hidden.
    expect(rowKeys(container)).not.toContain('memory');
    const probe = container.querySelector('[data-testid="memory-probe"]');
    expect(probe).not.toBeNull();
    expect(probe?.closest('[hidden]')).not.toBeNull();
    unmount();
  });

  it("keeps a collapsed row's body mounted when its section asks to", () => {
    mockCaps = CAPS;
    mockActivity = { ...baseState(), snapshot: populatedSnapshot() };
    const { container, unmount } = renderCard(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        layout="card"
        extraSections={[
          {
            key: 'memory',
            title: 'Memory',
            hasContent: true,
            keepBodyMountedWhenCollapsed: true,
            body: <p data-testid="memory-probe">Memory body</p>,
          },
        ]}
      />,
    );
    // Memory has a row now, collapsed; its body stays mounted, hidden, so
    // it keeps following memory changes (the last one deleted, say).
    expect(rowKeys(container)).toContain('memory');
    const probes = container.querySelectorAll('[data-testid="memory-probe"]');
    expect(probes).toHaveLength(1);
    expect(probes[0]?.closest('[hidden]')).not.toBeNull();
    unmount();
  });

  it("keeps a retained section's local state across collapse and expand", () => {
    mockCaps = CAPS;
    mockActivity = { ...baseState(), snapshot: populatedSnapshot() };
    // Stands in for MemoryExplorer's local editing draft.
    function Draft(): JSX.Element {
      const [draft, setDraft] = useState('');
      return (
        <button
          type="button"
          data-testid="memory-draft"
          onClick={(): void => setDraft('edited')}
        >
          {draft}
        </button>
      );
    }
    const { container, unmount } = renderCard(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        layout="card"
        extraSections={[
          {
            key: 'memory',
            title: 'Memory',
            hasContent: true,
            keepBodyMountedWhenCollapsed: true,
            body: <Draft />,
          },
        ]}
      />,
    );
    const row = (): HTMLElement | null =>
      container.querySelector('[data-testid="activity-card-row-memory"]');
    const draft = (): HTMLElement | null =>
      container.querySelector('[data-testid="memory-draft"]');
    act(() => row()?.click());
    expect(draft()?.closest('[hidden]')).toBeNull();
    act(() => draft()?.click());
    expect(draft()?.textContent).toBe('edited');

    // Collapsed, the draft stays (hidden); expanded again, it is the same.
    act(() => row()?.click());
    expect(draft()?.closest('[hidden]')).not.toBeNull();
    act(() => row()?.click());
    expect(draft()?.closest('[hidden]')).toBeNull();
    expect(draft()?.textContent).toBe('edited');
    expect(
      container.querySelectorAll('[data-testid="memory-draft"]'),
    ).toHaveLength(1);
    unmount();
  });

  it("gives a retained section body the card's compact styling", () => {
    mockCaps = CAPS;
    mockActivity = { ...baseState(), snapshot: populatedSnapshot() };
    function Probe(): JSX.Element {
      const density = useActivityItemDensity();
      const tone = useContext(HeaderActionDefaultToneContext);
      return <p data-testid="retained-probe">{`${density} ${tone}`}</p>;
    }
    const { container, unmount } = renderCard(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        layout="card"
        extraSections={[
          {
            key: 'plugins',
            title: 'Plugins',
            hasContent: true,
            keepBodyMountedWhenCollapsed: true,
            body: <Probe />,
          },
        ]}
      />,
    );
    act(() =>
      container
        .querySelector<HTMLElement>('[data-testid="activity-card-row-plugins"]')
        ?.click(),
    );
    expect(
      container.querySelector('[data-testid="retained-probe"]')?.textContent,
    ).toBe('compact neutral');
    unmount();
  });

  it('states agent task progress as text instead of a progress bar', () => {
    mockCaps = CAPS;
    const todoLists: PortalChatTodoProjection[] = [
      {
        localId: 'chat1',
        workspaceLocalId: 'ws1',
        worktreeLocalId: 'wt1',
        chatId: 'chat1',
        items: [
          { id: 'a', content: 'One', status: 'completed' },
          { id: 'b', content: 'Two', status: 'in_progress' },
          { id: 'c', content: 'Three', status: 'pending' },
        ],
      },
    ];
    mockActivity = { ...baseState(), snapshot: populatedSnapshot() };
    const { container, unmount } = renderCard(
      <ActivityPanel
        workspaceLocalId="ws1"
        worktreeLocalId="wt1"
        selectedChatId="chat1"
        todoLists={todoLists}
        layout="card"
      />,
    );
    const row = container.querySelector(
      '[data-testid="activity-card-row-todo"]',
    );
    expect(row?.textContent).toContain('1/3');
    expect(row?.querySelector('[role="progressbar"]')).toBeNull();
    unmount();
  });
});

describe('ActivityPanel changed-files bounded answers (REG-3024)', () => {
  function withChangedFiles(
    changedFiles: SessionViewModel['changedFiles'][string],
  ): SessionViewModel {
    const snapshot = populatedSnapshot();
    snapshot.changedFiles = { wt1: changedFiles };
    return snapshot;
  }

  it.each([
    ['sleeping', 'Sleeping'],
    ['unavailable', 'Unavailable'],
    ['base_unavailable', 'Unavailable'],
    ['truncated', 'Incomplete'],
  ] as const)(
    'heads a %s answer with no rows as %s, never as no local changes',
    (kind, subtitle) => {
      mockCaps = CAPS;
      mockActivity = {
        ...baseState(),
        snapshot: withChangedFiles({
          worktreeLocalId: 'wt1',
          uncommitted: [],
          committed: [],
          notices: [{ kind }],
        }),
      };
      const out = renderToString(
        <ActivityPanel workspaceLocalId="ws1" worktreeLocalId="wt1" />,
      );
      expect(out).toContain('activity-section-changed-files');
      expect(out).toContain(subtitle);
      expect(out).not.toContain('No local changes');
    },
  );

  it('counts a truncated list as at least the files it shows', () => {
    mockCaps = CAPS;
    mockActivity = {
      ...baseState(),
      snapshot: withChangedFiles({
        worktreeLocalId: 'wt1',
        uncommitted: [{ filePath: 'a.ts', status: 'modified' }],
        committed: [],
        notices: [{ kind: 'truncated' }],
      }),
    };
    const out = renderToString(
      <ActivityPanel workspaceLocalId="ws1" worktreeLocalId="wt1" />,
    ).replace(/<!-- -->/g, '');
    expect(out).toContain('1+ files');
  });

  it('names each repository when the list spans several', () => {
    mockCaps = CAPS;
    const snapshot = withChangedFiles({
      worktreeLocalId: 'wt1',
      uncommitted: [
        {
          filePath: 'README.md',
          status: 'modified',
          repoId: 'r1',
          repoName: 'api',
        },
        {
          filePath: 'README.md',
          status: 'modified',
          repoId: 'r2',
          repoName: 'web',
        },
      ],
      committed: [],
    });
    snapshot.workspaces = [
      { localId: 'ws1', name: 'Repo', type: 'single-repo', layout: 'tree' },
    ];
    mockActivity = { ...baseState(), snapshot };
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <ActivityPanel workspaceLocalId="ws1" worktreeLocalId="wt1" />,
      );
    });
    const rows = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid="activity-changed-file"]',
      ),
      (row) => row.textContent,
    );
    expect(rows).toEqual(['api/README.md', 'web/README.md']);
    act(() => root.unmount());
  });
});
