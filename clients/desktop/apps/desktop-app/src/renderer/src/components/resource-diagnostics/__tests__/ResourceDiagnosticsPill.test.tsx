/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { focusViaKeyboard } from '@/test-utils/dom';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  ResourceGroupId,
  ResourceMonitorSnapshot,
  ResourceProcessSnapshot,
  SidebarItem,
} from '@canopy/desktop-shared/types';
import { ResourceDiagnosticsPill } from '../ResourceDiagnosticsPill';
import {
  RESOURCE_TEXT_MIN_FORWARD_GAP_PX,
  selectCompactResourceLayout,
} from '../compact-resource-layout';
import { ResourceDiagnosticsPopover } from '../ResourceDiagnosticsPopover';
import { __resetResourceDiagnosticsSortForTests } from '../sortState';
import {
  __resetResourceMonitorStoreForTests,
  useResourceMonitorStore,
} from '@/stores/resourceMonitorStore';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { formatCpuPercent, formatMemoryBytes } from '../format';
import {
  TITLEBAR_BUTTON_CLASSNAME,
  TITLEBAR_CONTROL_FOREGROUND_CLASSNAME,
} from '../../sidebar/sidebar-styles';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function makeSnapshot(
  overrides: Partial<ResourceMonitorSnapshot> = {},
): ResourceMonitorSnapshot {
  return {
    version: 1,
    sampledAt: '2026-05-07T00:00:00.000Z',
    appPid: 1234,
    cpuPercent: 12,
    memoryRssBytes: 1024 * 1024 * 256,
    processCount: 4,
    pressure: {
      level: 'ok',
      reasons: [],
      warningMemoryBytes: 1024 * 1024 * 1024,
      criticalMemoryBytes: 1024 * 1024 * 1024 * 4,
    },
    groups: [],
    guards: {
      chatTurns: {
        activeTurns: 0,
        pendingMessages: 0,
        maxConcurrentTurns: 4,
        blocked: false,
      },
      pipelines: {
        activeExecutions: 0,
        maxConcurrentExecutions: 5,
        blocked: false,
      },
      codexPools: {
        activeConnections: 0,
        liveProcesses: 0,
        activeTurns: 0,
      },
    },
    ...overrides,
  };
}

function makeProcess(
  overrides: Pick<ResourceProcessSnapshot, 'id' | 'label'> &
    Partial<ResourceProcessSnapshot>,
): ResourceProcessSnapshot {
  const process: ResourceProcessSnapshot = {
    id: overrides.id,
    kind: 'other',
    groupId: 'other',
    label: overrides.label,
    cpuPercent: 0,
    memoryRssBytes: 0,
    processCount: 1,
    status: 'running',
  };
  return Object.assign(process, overrides);
}

function makeGroup(
  id: ResourceGroupId,
  items: ResourceProcessSnapshot[],
): ResourceMonitorSnapshot['groups'][number] {
  return {
    id,
    label: id,
    cpuPercent: items.reduce((total, item) => total + item.cpuPercent, 0),
    memoryRssBytes: items.reduce(
      (total, item) => total + item.memoryRssBytes,
      0,
    ),
    processCount: items.length,
    items,
  };
}

function makeSortableSnapshot(): ResourceMonitorSnapshot {
  return makeSnapshot({
    groups: [
      makeGroup('app', [
        makeProcess({
          id: 'app-alpha-small',
          groupId: 'app',
          label: 'Alpha',
          cpuPercent: 3,
          memoryRssBytes: 20,
        }),
        makeProcess({
          id: 'app-zeta',
          groupId: 'app',
          label: 'Zeta',
          cpuPercent: 1,
          memoryRssBytes: 30,
        }),
        makeProcess({
          id: 'app-alpha-large',
          groupId: 'app',
          label: 'Alpha',
          cpuPercent: 2,
          memoryRssBytes: 60,
        }),
      ]),
      makeGroup('codex', [
        makeProcess({
          id: 'codex-beta',
          groupId: 'codex',
          label: 'Beta',
          cpuPercent: 6,
          memoryRssBytes: 40,
        }),
      ]),
      makeGroup('chat', [
        makeProcess({
          id: 'chat-gamma',
          groupId: 'chat',
          label: 'Gamma',
          cpuPercent: 5,
          memoryRssBytes: 10,
        }),
      ]),
    ],
  });
}

function makeMixedGroupPrioritySnapshot(): ResourceMonitorSnapshot {
  return makeSnapshot({
    groups: [
      makeGroup('chat', [
        makeProcess({
          id: 'chat-row',
          groupId: 'chat',
          label: 'Chat row',
          cpuPercent: 1,
          memoryRssBytes: 10,
        }),
      ]),
      makeGroup('claude', [
        makeProcess({
          id: 'claude-row',
          groupId: 'claude',
          label: 'Claude row',
          cpuPercent: 1,
          memoryRssBytes: 10,
        }),
      ]),
      makeGroup('codex', [
        makeProcess({
          id: 'codex-row',
          groupId: 'codex',
          label: 'Codex row',
          cpuPercent: 1,
          memoryRssBytes: 10,
        }),
      ]),
      makeGroup('pipelines', [
        makeProcess({
          id: 'pipeline-row',
          groupId: 'pipelines',
          label: 'Pipeline row',
          cpuPercent: 1,
          memoryRssBytes: 10,
        }),
      ]),
      makeGroup('app', [
        makeProcess({
          id: 'app-row',
          groupId: 'app',
          label: 'App row',
          cpuPercent: 1,
          memoryRssBytes: 10,
        }),
      ]),
    ],
  });
}

function setStoreState(
  partial: Partial<ReturnType<typeof useResourceMonitorStore.getState>>,
): void {
  useResourceMonitorStore.setState(partial);
  // react-dom/server uses zustand's `getInitialState()` for the snapshot read
  // during SSR. Sync the current state into the initial slot so the rendered
  // markup reflects whatever the test just installed.
  Object.assign(
    useResourceMonitorStore.getInitialState(),
    useResourceMonitorStore.getState(),
  );
}

function makeProjectFixture(): SidebarItem {
  return {
    type: 'single-repo',
    id: 'project-1',
    name: 'Workspace One',
    repoPath: '/repo',
    color: 'blue',
    collapsed: false,
    order: 0,
    worktrees: [
      {
        id: 'worktree-1',
        branchName: 'feature/resource-monitor',
        createdAt: '2026-05-07T00:00:00.000Z',
      },
    ],
  };
}

function setProjectsState(projects: SidebarItem[]): void {
  useProjectsStore.setState({
    projects,
    hasHydratedProjects: true,
  });
  Object.assign(
    useProjectsStore.getInitialState(),
    useProjectsStore.getState(),
  );
}

describe('format helpers', () => {
  it('formatCpuPercent rounds and clamps non-finite values', () => {
    expect(formatCpuPercent(0)).toBe('0');
    expect(formatCpuPercent(12.4)).toBe('12');
    expect(formatCpuPercent(12.6)).toBe('13');
    expect(formatCpuPercent(NaN)).toBe('0');
    expect(formatCpuPercent(-5)).toBe('0');
    expect(formatCpuPercent(180)).toBe('100');
  });

  it('formatMemoryBytes renders bytes/KB/MB/GB with one decimal', () => {
    expect(formatMemoryBytes(0)).toBe('0 B');
    expect(formatMemoryBytes(512)).toBe('512 B');
    expect(formatMemoryBytes(1024)).toBe('1.0 KB');
    expect(formatMemoryBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatMemoryBytes(1024 * 1024 * 256)).toBe('256.0 MB');
    expect(formatMemoryBytes(1024 * 1024 * 1024 * 3)).toBe('3.0 GB');
  });
});

describe('ResourceDiagnosticsPill', () => {
  it.each([
    ['above the full boundary', 193.5, 'full'],
    ['at the full boundary', 194, 'full'],
    ['below the full boundary', 194.5, 'memory'],
    ['above the memory boundary', 223.5, 'memory'],
    ['at the memory boundary', 224, 'memory'],
    ['below the memory boundary', 224.5, 'icon'],
  ])(
    '%s selects the expected resource layout',
    (_position, forwardRight, expected) => {
      expect(
        selectCompactResourceLayout({
          buttonRight: 300,
          forwardRight,
          paddingRight: 6,
          iconWidth: 16,
          controlGap: 6,
          cpuSegmentWidth: 30,
          memoryWidth: 40,
        }),
      ).toBe(expected);
      expect(RESOURCE_TEXT_MIN_FORWARD_GAP_PX).toBe(8);
    },
  );

  beforeEach(() => {
    __resetResourceMonitorStoreForTests();
  });

  afterEach(() => {
    __resetResourceMonitorStoreForTests();
  });

  it('renders the loading state when ready=false regardless of store snapshot', () => {
    setStoreState({
      initialized: true,
      loading: false,
      snapshot: makeSnapshot(),
      error: null,
    });

    const html = renderToStaticMarkup(
      <ResourceDiagnosticsPill collapsed={false} ready={false} />,
    );

    expect(html).toContain('data-testid="sidebar-resource-diagnostics-pill"');
    expect(html).toContain('Measuring resources…');
    expect(html).toContain('data-tone="loading"');
    expect(html).toContain('h-8 w-full items-center gap-2');
    expect(html).toContain('rounded-row');
    expect(html).toContain('text-s font-normal');
  });

  it('renders ok tone with CPU and memory text when pressure is ok', () => {
    setStoreState({
      initialized: true,
      loading: false,
      snapshot: makeSnapshot({
        cpuPercent: 23,
        memoryRssBytes: 1024 * 1024 * 512,
      }),
      error: null,
    });

    const html = renderToStaticMarkup(
      <ResourceDiagnosticsPill collapsed={false} ready={true} />,
    );

    expect(html).toContain('data-tone="ok"');
    expect(html).toContain('fg-success-strong');
    expect(html).toContain('hover:bg-subtle');
    expect(html).toContain('data-testid="sidebar-resource-diagnostics-icon"');
    expect(html).toContain('data-app-icon="true"');
    expect(html).toContain('fg-success-strong');
    expect(html).not.toContain('bg-success');
    expect(html).not.toContain('text-green');
    expect(html).toContain('CPU 23%');
    expect(html).toContain('Mem. 0.5 GB');
    expect(html).not.toContain('font-mono');
    expect(html).toContain('tabular-nums');
    expect(html).toContain('text-s');
    expect(html).toContain('CPU 23%, memory 0.5 GB');
  });

  it('renders a compact label while preserving the full accessible name', () => {
    setStoreState({
      initialized: true,
      loading: false,
      snapshot: makeSnapshot({
        cpuPercent: 23,
        memoryRssBytes: 1024 * 1024 * 512,
      }),
      error: null,
    });

    const html = renderToStaticMarkup(
      <ResourceDiagnosticsPill
        collapsed={false}
        ready={true}
        statusBar
        compactLabel
      />,
    );

    expect(html).toMatch(/^<div class="shrink-0">/);
    expect(html).not.toContain('@min-[36px]/resource-monitor:block');
    expect(html).toContain('data-compact-layout="icon"');
    expect(html).toContain(
      'order-1 shrink-0 whitespace-nowrap pointer-events-none absolute invisible w-max',
    );
    expect(html).toContain('data-testid="sidebar-resource-diagnostics-cpu"');
    expect(html).not.toContain('@min-[112px]/resource-monitor:inline');
    expect(html).toContain(`>23%\u00a0·\u00a0</span>`);
    expect(html).toContain('data-testid="sidebar-resource-diagnostics-memory"');
    expect(html).toContain('>0.5 GB</span>');
    expect(html).not.toContain('>CPU 23% · Mem. 0.5 GB<');
    expect(html).toContain('data-glyph="cpu"');
    expect(html).toContain(
      'order-2 inline-flex h-4 w-4 shrink-0 items-center justify-center',
    );
    expect(html).not.toContain('order-1 flex-1 truncate');
    expect(html).toContain('width:14px;height:14px');
    expect(html).toContain(TITLEBAR_BUTTON_CLASSNAME);
    expect(TITLEBAR_BUTTON_CLASSNAME).toContain(
      TITLEBAR_CONTROL_FOREGROUND_CLASSNAME,
    );
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('relative gap-1.5');
    expect(html).toContain('aria-label="CPU 23%, memory 0.5 GB"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
  });

  it('keeps the resource icon visible when compact text is hidden', () => {
    setStoreState({
      initialized: true,
      loading: true,
      snapshot: null,
      error: null,
    });

    const html = renderToStaticMarkup(
      <ResourceDiagnosticsPill
        collapsed={false}
        ready={false}
        statusBar
        compactLabel
      />,
    );

    expect(html).toMatch(/^<div class="shrink-0">/);
    expect(html).toContain(TITLEBAR_BUTTON_CLASSNAME);
    expect(html).toContain('aria-label="Measuring resources…"');
    expect(html).toContain(
      'order-2 inline-flex h-4 w-4 shrink-0 items-center justify-center',
    );
    expect(html).toContain(
      'order-1 shrink-0 whitespace-nowrap pointer-events-none absolute invisible w-max',
    );
  });

  it('shows the full resource tooltip for the compact header control', () => {
    setStoreState({
      initialized: true,
      loading: false,
      snapshot: makeSnapshot({
        cpuPercent: 23,
        memoryRssBytes: 1024 * 1024 * 512,
      }),
      error: null,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      act(() => {
        root.render(
          <ResourceDiagnosticsPill
            collapsed={false}
            ready={true}
            statusBar
            compactLabel
          />,
        );
      });
      const button = container.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-resource-diagnostics-pill"]',
      );

      act(() => focusViaKeyboard(button));

      expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
        'CPU 23%, memory 0.5 GB',
      );
      expect(button?.getAttribute('type')).toBe('button');
      expect(button?.getAttribute('aria-label')).toBe('CPU 23%, memory 0.5 GB');
      expect(button?.getAttribute('aria-haspopup')).toBe('dialog');
      expect(button?.getAttribute('aria-expanded')).toBe('false');

      act(() => button?.click());

      expect(
        document.body.querySelector(
          '[data-testid="resource-diagnostics-popover"]',
        ),
      ).not.toBeNull();
      expect(button?.getAttribute('aria-expanded')).toBe('true');
      expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
      // The shared Popover moves focus into the panel it opens.
      expect(
        document.body
          .querySelector('[data-testid="resource-diagnostics-popover"]')
          ?.contains(document.activeElement),
      ).toBe(true);

      act(() => {
        button?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
      expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('does not present stale compact metrics while a refresh is loading', () => {
    setStoreState({
      initialized: true,
      loading: true,
      snapshot: makeSnapshot({
        cpuPercent: 23,
        memoryRssBytes: 1024 * 1024 * 512,
      }),
      error: null,
    });

    const html = renderToStaticMarkup(
      <ResourceDiagnosticsPill
        collapsed={false}
        ready={false}
        statusBar
        compactLabel
      />,
    );

    expect(html).toContain('Measuring resources…');
    expect(html).not.toContain(
      'data-testid="sidebar-resource-diagnostics-memory"',
    );
  });

  it('does not present stale compact metrics after a refresh error', () => {
    setStoreState({
      initialized: true,
      loading: false,
      snapshot: makeSnapshot({
        cpuPercent: 23,
        memoryRssBytes: 1024 * 1024 * 512,
      }),
      error: 'IPC bridge offline',
    });

    const html = renderToStaticMarkup(
      <ResourceDiagnosticsPill
        collapsed={false}
        ready={true}
        statusBar
        compactLabel
      />,
    );

    expect(html).toContain('Resource metrics unavailable');
    expect(html).not.toContain(
      'data-testid="sidebar-resource-diagnostics-memory"',
    );
  });

  it('renders warning tone when pressure level is warning', () => {
    setStoreState({
      initialized: true,
      loading: false,
      snapshot: makeSnapshot({
        cpuPercent: 60,
        memoryRssBytes: 1024 * 1024 * 1024 * 2,
        pressure: {
          level: 'warning',
          reasons: ['memory'],
          warningMemoryBytes: 1024 * 1024 * 1024,
          criticalMemoryBytes: 1024 * 1024 * 1024 * 4,
        },
      }),
      error: null,
    });

    const html = renderToStaticMarkup(
      <ResourceDiagnosticsPill collapsed={false} ready={true} />,
    );

    expect(html).toContain('data-tone="warning"');
    expect(html).toContain('fg-warning');
    expect(html).toContain('hover:bg-subtle');
    expect(html).not.toContain('text-amber-400');
  });

  it('renders critical tone when pressure level is critical', () => {
    setStoreState({
      initialized: true,
      loading: false,
      snapshot: makeSnapshot({
        cpuPercent: 95,
        memoryRssBytes: 1024 * 1024 * 1024 * 5,
        pressure: {
          level: 'critical',
          reasons: ['memory'],
          warningMemoryBytes: 1024 * 1024 * 1024,
          criticalMemoryBytes: 1024 * 1024 * 1024 * 4,
        },
      }),
      error: null,
    });

    const html = renderToStaticMarkup(
      <ResourceDiagnosticsPill collapsed={false} ready={true} />,
    );

    expect(html).toContain('data-tone="critical"');
    expect(html).toContain('fg-destructive-strong');
    expect(html).toContain('hover:bg-subtle');
    expect(html).not.toContain('text-red-400');
  });

  it('renders the error state when the snapshot reports an error and no prior snapshot exists', () => {
    setStoreState({
      initialized: true,
      loading: false,
      snapshot: null,
      error: 'IPC bridge offline',
    });

    const html = renderToStaticMarkup(
      <ResourceDiagnosticsPill collapsed={false} ready={true} />,
    );

    expect(html).toContain('data-tone="error"');
    expect(html).toContain('fg-destructive-strong');
    expect(html).toContain('hover:bg-subtle');
    expect(html).toContain('Resource metrics unavailable');
  });

  it('renders partial platform metrics when process pressure is unknown', () => {
    setStoreState({
      initialized: true,
      loading: false,
      snapshot: makeSnapshot({
        cpuPercent: 4,
        memoryRssBytes: 1024 * 1024 * 1024,
        pressure: {
          level: 'unknown',
          reasons: ['process-table sampling unavailable'],
          warningMemoryBytes: 1024 * 1024 * 1024,
          criticalMemoryBytes: 1024 * 1024 * 1024 * 4,
        },
      }),
      error: null,
    });

    const html = renderToStaticMarkup(
      <ResourceDiagnosticsPill collapsed={false} ready={true} />,
    );

    expect(html).toContain('CPU 4% · Mem. 1.0 GB');
    expect(html).not.toContain('Resource metrics unavailable');
  });

  it('renders the collapsed icon-only state with accessible label text', () => {
    setStoreState({
      initialized: true,
      loading: false,
      snapshot: makeSnapshot({
        cpuPercent: 7,
        memoryRssBytes: 1024 * 1024 * 128,
      }),
      error: null,
    });

    const html = renderToStaticMarkup(
      <ResourceDiagnosticsPill collapsed={true} ready={true} />,
    );

    // Collapsed state hides the label visually via opacity-0 / w-0.
    expect(html).toContain('w-0 opacity-0');
    // The label text must remain accessible regardless.
    expect(html).toContain('aria-label="CPU 7%, memory 0.1 GB"');
  });
});

describe('ResourceDiagnosticsPopover', () => {
  beforeEach(() => {
    __resetResourceDiagnosticsSortForTests();
    setProjectsState([]);
  });

  afterEach(() => {
    __resetResourceDiagnosticsSortForTests();
    setProjectsState([]);
  });

  it.each([
    ['sidebar footer', { statusBar: false, compactLabel: false }],
    ['compact header', { statusBar: true, compactLabel: true }],
  ])(
    'returns focus to the %s control when Escape closes the panel',
    (_name, layout) => {
      setStoreState({
        initialized: true,
        loading: false,
        snapshot: makeSnapshot(),
        error: null,
      });
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      try {
        act(() => {
          root.render(
            <ResourceDiagnosticsPill
              collapsed={false}
              ready={true}
              {...layout}
            />,
          );
        });
        const button = container.querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-resource-diagnostics-pill"]',
        );
        act(() => focusViaKeyboard(button));
        act(() => button?.click());
        const panel = document.body.querySelector(
          '[data-testid="resource-diagnostics-popover"]',
        );
        expect(panel?.contains(document.activeElement)).toBe(true);

        act(() => {
          document.activeElement?.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'Escape',
              bubbles: true,
              cancelable: true,
            }),
          );
        });

        expect(
          document.body.querySelector(
            '[data-testid="resource-diagnostics-popover"]',
          ),
        ).toBeNull();
        expect(document.activeElement).toBe(button);
      } finally {
        act(() => root.unmount());
        container.remove();
      }
    },
  );

  it('bounds the panel and scrolls the diagnostics body', () => {
    const html = renderToStaticMarkup(
      <ResourceDiagnosticsPopover
        snapshot={makeSnapshot()}
        error={null}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain('data-testid="resource-diagnostics-popover-scroll"');
    expect(html).toContain('max-h-80');
    expect(html).toContain('resource-diagnostics-popover-settings');
    // Thresholds live in Performance settings; the footer totals only the
    // processes the app runs for itself.
    expect(html).not.toContain('resource-diagnostics-popover-pressure');
    expect(html).toContain('resource-diagnostics-popover-app-totals');
  });

  it('opts the portaled panel out of window-drag regions beneath it', () => {
    const { container, cleanup } = renderPopover(makeSnapshot());
    try {
      expect(
        container
          .querySelector('[data-testid="resource-diagnostics-popover-content"]')
          ?.classList.contains('electron-no-drag'),
      ).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('renders nested pipeline subprocesses under the pipeline row', () => {
    const { container, cleanup } = renderPopover(
      makeSnapshot({
        groups: [
          {
            id: 'pipelines',
            label: 'Pipelines',
            cpuPercent: 3,
            memoryRssBytes: 3000,
            processCount: 2,
            items: [
              {
                id: 'pipeline-execution:exec-1',
                kind: 'pipeline-execution',
                groupId: 'pipelines',
                label: 'Review pipeline',
                cpuPercent: 3,
                memoryRssBytes: 3000,
                processCount: 2,
                status: 'running',
                metadata: {
                  type: 'pipeline',
                  pipeline: {
                    executionId: 'exec-1',
                    pipelineName: 'Review pipeline',
                  },
                },
                children: [
                  {
                    id: 'pipeline-step:exec-1:review',
                    kind: 'pipeline-step',
                    groupId: 'pipelines',
                    label: 'review / agent',
                    pid: 100,
                    cpuPercent: 3,
                    memoryRssBytes: 3000,
                    processCount: 2,
                    status: 'running',
                    metadata: {
                      type: 'pipeline',
                      pipeline: {
                        executionId: 'exec-1',
                        jobId: 'review',
                        stepId: 'agent',
                      },
                    },
                    children: [
                      {
                        id: 'process:101',
                        kind: 'other',
                        groupId: 'other',
                        label: 'claude',
                        pid: 101,
                        ppid: 100,
                        processGroupId: 100,
                        cpuPercent: 2,
                        memoryRssBytes: 2500,
                        processCount: 1,
                        status: 'running',
                        metadata: { type: 'generic' },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    expandAllRows(container);
    const html = container.innerHTML;
    cleanup();

    expect(html).toContain('Review pipeline');
    expect(html).toContain('review / agent');
    expect(html).toContain('claude');
    expect(html).toContain('PID 101');
    expect(html).toContain('padding-left: 24px');
    expect(html.indexOf('Review pipeline')).toBeLessThan(
      html.indexOf('review / agent'),
    );
    expect(html.indexOf('review / agent')).toBeLessThan(
      html.indexOf('PID 101'),
    );
  });

  it('nests unregistered processes under their spawning agent and totals only app processes', () => {
    const { container, cleanup } = renderPopover(
      makeSnapshot({
        groups: [
          makeGroup('app', [
            makeProcess({
              id: 'electron:1234',
              kind: 'electron-main',
              groupId: 'app',
              label: 'Electron main',
              pid: 1234,
              cpuPercent: 2,
              memoryRssBytes: 100,
            }),
          ]),
          makeGroup('claude', [
            makeProcess({
              id: 'claude:10',
              kind: 'chat-provider',
              groupId: 'claude',
              label: 'claude',
              pid: 10,
              ppid: 1234,
              cpuPercent: 4,
              memoryRssBytes: 400,
              metadata: { type: 'generic' },
            }),
          ]),
          makeGroup('other', [
            makeProcess({
              id: 'other:11',
              label: 'bash',
              pid: 11,
              ppid: 10,
              cpuPercent: 1,
              memoryRssBytes: 40,
              metadata: { type: 'generic' },
            }),
            makeProcess({
              id: 'other:12',
              label: 'rg',
              pid: 12,
              ppid: 11,
              cpuPercent: 3,
              memoryRssBytes: 30,
              metadata: { type: 'generic' },
            }),
            makeProcess({
              id: 'other:20',
              label: 'git',
              pid: 20,
              ppid: 1234,
              cpuPercent: 5,
              memoryRssBytes: 50,
              metadata: { type: 'generic' },
            }),
          ]),
        ],
      }),
    );

    try {
      // Trees start collapsed; the agent row carries its subtree's usage.
      expect(getRowSummaries(container)).toEqual([
        'claude|8%|470 B',
        'Main|2%|100 B',
        'git|5%|50 B',
      ]);
      const totals = container.querySelector(
        '[data-testid="resource-diagnostics-popover-app-totals"]',
      );
      expect(totals?.textContent).toContain('7% CPU');
      expect(totals?.textContent).toContain('150 B');

      const toggle = container.querySelector(
        '[data-testid="resource-row-toggle-claude:10"]',
      );
      if (!(toggle instanceof HTMLButtonElement)) {
        throw new Error('Agent row toggle not found');
      }
      expect(toggle.getAttribute('aria-label')).toBe('Expand claude');
      act(() => {
        toggle.click();
      });
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(getRowSummaries(container)).toEqual([
        'claude|8%|470 B',
        'bash|4%|70 B',
        'Main|2%|100 B',
        'git|5%|50 B',
      ]);

      expandAllRows(container);
      expect(getRowSummaries(container)).toContain('rg|3%|30 B');

      act(() => {
        toggle.click();
      });
      expect(getRowSummaries(container)).toHaveLength(3);
    } finally {
      cleanup();
    }
  });

  it('toggles a clickable row without opening its worktree', () => {
    setProjectsState([makeProjectFixture()]);
    const navigate = jest.fn();
    const originalNavigate = useNavigationStore.getState().navigate;
    useNavigationStore.setState({ navigate });
    const { container, cleanup } = renderPopover(
      makeSnapshot({
        groups: [
          makeGroup('scripts', [
            makeProcess({
              id: 'script:project-1:worktree-1:project:dev:333',
              kind: 'script',
              groupId: 'scripts',
              label: 'Dev',
              pid: 333,
              cpuPercent: 1,
              memoryRssBytes: 10,
              metadata: {
                type: 'script',
                script: {
                  projectId: 'project-1',
                  worktreeId: 'worktree-1',
                  scriptKey: 'project:dev',
                  scriptName: 'dev',
                  scriptLabel: 'Dev',
                  target: 'project',
                },
              },
              children: [
                makeProcess({
                  id: 'process:334',
                  label: 'node',
                  pid: 334,
                  ppid: 333,
                  metadata: { type: 'generic' },
                }),
              ],
            }),
          ]),
        ],
      }),
    );

    try {
      expect(getRowSummaries(container)).toHaveLength(1);
      expandAllRows(container);
      expect(getRowSummaries(container)).toHaveLength(2);
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      cleanup();
      useNavigationStore.setState({ navigate: originalNavigate });
    }
  });

  it('strips Electron prefixes only from App process display names', () => {
    const html = renderToStaticMarkup(
      <ResourceDiagnosticsPopover
        snapshot={makeSnapshot({
          groups: [
            makeGroup('app', [
              makeProcess({
                id: 'electron-main',
                kind: 'electron-main',
                groupId: 'app',
                label: 'Electron main',
                cpuPercent: 1,
                memoryRssBytes: 10,
              }),
              makeProcess({
                id: 'electron-utility',
                kind: 'electron-utility',
                groupId: 'app',
                label: 'Electron utility',
                cpuPercent: 1,
                memoryRssBytes: 10,
              }),
              makeProcess({
                id: 'electronic-main',
                kind: 'electron-main',
                groupId: 'app',
                label: 'Electronic main',
                cpuPercent: 1,
                memoryRssBytes: 10,
              }),
            ]),
            makeGroup('other', [
              makeProcess({
                id: 'other-electron',
                groupId: 'other',
                label: 'Electron helper',
                cpuPercent: 1,
                memoryRssBytes: 10,
              }),
            ]),
          ],
        })}
        error={null}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain('>Main</span>');
    expect(html).toContain('>Utility</span>');
    expect(html).toContain('>Electronic main</span>');
    expect(html).toContain('>Electron helper</span>');
    expect(html).not.toContain('>Electron main</span>');
    expect(html).not.toContain('>Electron utility</span>');
  });

  it('renders Codex pool metadata using the approved pool labels', () => {
    const html = renderToStaticMarkup(
      <ResourceDiagnosticsPopover
        snapshot={makeSnapshot({
          groups: [
            {
              id: 'codex',
              label: 'Codex',
              cpuPercent: 1,
              memoryRssBytes: 4096,
              processCount: 2,
              items: [
                {
                  id: 'codex-app-server-pool:default',
                  kind: 'codex-app-server-pool',
                  groupId: 'codex',
                  label: 'Codex app-server',
                  pid: 111,
                  cpuPercent: 1,
                  memoryRssBytes: 2048,
                  processCount: 1,
                  status: 'running',
                  metadata: {
                    type: 'codex-pool',
                    codexPool: {
                      poolKeyLabel: 'Default pool',
                      pooled: true,
                      clientCount: 2,
                      activeTurnCount: 1,
                      initialized: true,
                    },
                  },
                },
                {
                  id: 'codex-app-server-pool:env:abcdef123456',
                  kind: 'codex-app-server-pool',
                  groupId: 'codex',
                  label: 'Codex app-server (env pool abcdef12)',
                  cpuPercent: 0,
                  memoryRssBytes: 1024,
                  processCount: 1,
                  status: 'idle',
                  metadata: {
                    type: 'codex-pool',
                    codexPool: {
                      poolKeyLabel: 'Env pool abcdef12',
                      pooled: true,
                      clientCount: 1,
                      activeTurnCount: 0,
                      initialized: false,
                    },
                  },
                },
              ],
            },
          ],
        })}
        error={null}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain('>12% CPU<');
    expect(html).toContain('>256.0 MB<');
    expect(html).toContain('Default pool / 2 clients / PID 111');
    expect(html).not.toContain('Env pool abcdef12 / 1 clients / not running');
    expect(html).not.toContain('Codex app-server (env pool abcdef12)');
    expect(html).not.toContain('Env pool Default pool');
  });

  it('renders Claude process classification', () => {
    const html = renderToStaticMarkup(
      <ResourceDiagnosticsPopover
        snapshot={makeSnapshot({
          groups: [
            {
              id: 'claude',
              label: 'Claude',
              cpuPercent: 2,
              memoryRssBytes: 2048,
              processCount: 1,
              items: [
                {
                  id: 'claude:222',
                  kind: 'chat-provider',
                  groupId: 'claude',
                  label: 'claude',
                  pid: 222,
                  cpuPercent: 2,
                  memoryRssBytes: 2048,
                  processCount: 1,
                  status: 'running',
                  metadata: { type: 'generic' },
                },
              ],
            },
          ],
        })}
        error={null}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain('claude');
    expect(html).toContain('Claude · PID 222');
  });

  it('renders browser resource metadata', () => {
    setProjectsState([makeProjectFixture()]);

    const html = renderToStaticMarkup(
      <ResourceDiagnosticsPopover
        snapshot={makeSnapshot({
          groups: [
            {
              id: 'browser',
              label: 'Browser',
              cpuPercent: 4,
              memoryRssBytes: 2048,
              processCount: 1,
              items: [
                {
                  id: 'browser:browser-1',
                  kind: 'in-app-browser',
                  groupId: 'browser',
                  label: 'Local app',
                  pid: 333,
                  cpuPercent: 4,
                  memoryRssBytes: 2048,
                  processCount: 1,
                  status: 'running',
                  metadata: {
                    type: 'browser',
                    browser: {
                      projectId: 'project-1',
                      worktreeId: 'worktree-1',
                      browserId: 'browser-1',
                      title: 'Local app',
                      displayUrl: 'localhost:3000/path',
                      visible: true,
                      status: 'ready',
                    },
                  },
                },
              ],
            },
          ],
        })}
        error={null}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain('Local app');
    expect(html).toContain(
      'Browser · Workspace One / feature/resource-monitor / PID 333 / visible / ready / localhost:3000/path',
    );
  });

  it('renders script resource metadata on parent and child rows', () => {
    setProjectsState([makeProjectFixture()]);

    const { container, cleanup } = renderPopover(
      makeSnapshot({
        groups: [
          {
            id: 'scripts',
            label: 'Script',
            cpuPercent: 4,
            memoryRssBytes: 4096,
            processCount: 2,
            items: [
              {
                id: 'script:project-1:worktree-1:workspace-repo:dev:333',
                kind: 'script',
                groupId: 'scripts',
                label: 'Web - Dev',
                pid: 333,
                processGroupId: 333,
                cpuPercent: 4,
                memoryRssBytes: 4096,
                processCount: 2,
                status: 'running',
                metadata: {
                  type: 'script',
                  script: {
                    projectId: 'project-1',
                    worktreeId: 'worktree-1',
                    scriptKey: 'workspace-repo:dev:web',
                    scriptName: 'dev',
                    scriptLabel: 'Web - Dev',
                    target: 'workspace-repo',
                    repoId: 'web',
                    repoName: 'Web',
                    invocation: 'manual-run',
                  },
                },
                children: [
                  {
                    id: 'process:334',
                    kind: 'other',
                    groupId: 'other',
                    label: 'node',
                    pid: 334,
                    ppid: 333,
                    processGroupId: 333,
                    cpuPercent: 2,
                    memoryRssBytes: 2048,
                    processCount: 1,
                    status: 'running',
                    metadata: { type: 'generic' },
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    expandAllRows(container);
    const html = container.innerHTML;
    cleanup();

    expect(html).toContain('Web - Dev');
    expect(html).toContain(
      'Script · Workspace One / feature/resource-monitor / PID 333 / Web / manual-run',
    );
    expect(html).toContain('node');
    expect(html).toContain(
      'Script · Workspace One / feature/resource-monitor / PID 334',
    );
  });

  it('navigates to the owning worktree when a browser or script row is clicked', () => {
    setProjectsState([makeProjectFixture()]);
    const navigate = jest.fn();
    const selectWorktree = jest.fn();
    const originalNavigate = useNavigationStore.getState().navigate;
    const originalSelectWorktree = useChatStore.getState().selectWorktree;
    useNavigationStore.setState({ navigate });
    useChatStore.setState({ selectWorktree });
    const { container, cleanup } = renderPopover(
      makeSnapshot({
        groups: [
          {
            id: 'scripts',
            label: 'Script',
            cpuPercent: 1,
            memoryRssBytes: 1024,
            processCount: 1,
            items: [
              makeProcess({
                id: 'script:project-1:worktree-1:project:dev:333',
                kind: 'script',
                groupId: 'scripts',
                label: 'Dev',
                pid: 333,
                processGroupId: 333,
                cpuPercent: 1,
                memoryRssBytes: 1024,
                metadata: {
                  type: 'script',
                  script: {
                    projectId: 'project-1',
                    worktreeId: 'worktree-1',
                    scriptKey: 'project:dev',
                    scriptName: 'dev',
                    scriptLabel: 'Dev',
                    target: 'project',
                    invocation: 'manual-run',
                  },
                },
              }),
            ],
          },
        ],
      }),
    );

    try {
      const row = container.querySelector('tbody tr[role="button"]');
      if (!(row instanceof HTMLTableRowElement)) {
        throw new Error('Clickable resource row not found');
      }

      act(() => {
        row.click();
      });

      expect(navigate).toHaveBeenCalledWith('main');
      expect(selectWorktree).toHaveBeenCalledWith('project-1', 'worktree-1');
    } finally {
      cleanup();
      useNavigationStore.setState({ navigate: originalNavigate });
      useChatStore.setState({ selectWorktree: originalSelectWorktree });
    }
  });

  it('sorts by memory descending by default and marks only that header active', () => {
    const { container, cleanup } = renderPopover(makeSortableSnapshot());

    try {
      expect(getRowSummaries(container)).toEqual([
        'Alpha|2%|60 B',
        'Beta|6%|40 B',
        'Zeta|1%|30 B',
        'Alpha|3%|20 B',
        'Gamma|5%|10 B',
      ]);
      expect(getSortHeader(container, 'memory').getAttribute('aria-sort')).toBe(
        'descending',
      );
      expect(getSortHeader(container, 'name').getAttribute('aria-sort')).toBe(
        'none',
      );
      expect(getSortHeader(container, 'cpu').getAttribute('aria-sort')).toBe(
        'none',
      );
      expect(getHeaderButton(container, 'memory').textContent).toBe('Memory');
      expect(getHeaderButton(container, 'name').textContent).toBe('Name');
    } finally {
      cleanup();
    }
  });

  it("shows a row's details in the shared tooltip, never a native title", () => {
    const { container, cleanup } = renderPopover(makeSortableSnapshot());

    jest.useFakeTimers();
    try {
      const row = container.querySelector('tbody tr');
      expect(row?.hasAttribute('title')).toBe(false);
      const name = row?.querySelectorAll('td')[1]?.querySelector('div');
      act(() => {
        name?.parentElement?.dispatchEvent(
          new MouseEvent('mouseover', { bubbles: true }),
        );
      });
      // A long hover: passing down the list does not flash every row's tip.
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
      act(() => {
        jest.advanceTimersByTime(500);
      });
      expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
        'Alpha',
      );
      expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
        'App',
      );
    } finally {
      jest.useRealTimers();
      cleanup();
    }
  });

  it('toggles name sort direction while keeping group priority fixed', () => {
    const { container, cleanup } = renderPopover(makeSortableSnapshot());

    try {
      act(() => {
        getHeaderButton(container, 'name').click();
      });

      expect(getSortHeader(container, 'name').getAttribute('aria-sort')).toBe(
        'ascending',
      );
      expect(getRowSummaries(container)).toEqual([
        'Alpha|2%|60 B',
        'Alpha|3%|20 B',
        'Zeta|1%|30 B',
        'Beta|6%|40 B',
        'Gamma|5%|10 B',
      ]);

      act(() => {
        getHeaderButton(container, 'name').click();
      });

      expect(getSortHeader(container, 'name').getAttribute('aria-sort')).toBe(
        'descending',
      );
      expect(getRowSummaries(container)).toEqual([
        'Zeta|1%|30 B',
        'Alpha|2%|60 B',
        'Alpha|3%|20 B',
        'Beta|6%|40 B',
        'Gamma|5%|10 B',
      ]);
    } finally {
      cleanup();
    }
  });

  it('orders Claude between Codex and Chat in mixed group sorting', () => {
    const { container, cleanup } = renderPopover(
      makeMixedGroupPrioritySnapshot(),
    );

    try {
      act(() => {
        getHeaderButton(container, 'name').click();
      });

      expect(getRowSummaries(container)).toEqual([
        'App row|1%|10 B',
        'Pipeline row|1%|10 B',
        'Codex row|1%|10 B',
        'Claude row|1%|10 B',
        'Chat row|1%|10 B',
      ]);
    } finally {
      cleanup();
    }
  });

  it('keeps the selected sort sticky across popover remounts', () => {
    const first = renderPopover(makeSortableSnapshot());

    try {
      act(() => {
        getHeaderButton(first.container, 'cpu').click();
      });
    } finally {
      first.cleanup();
    }

    const second = renderPopover(makeSortableSnapshot());

    try {
      expect(
        getSortHeader(second.container, 'cpu').getAttribute('aria-sort'),
      ).toBe('descending');
      expect(getRowSummaries(second.container)).toEqual([
        'Beta|6%|40 B',
        'Gamma|5%|10 B',
        'Alpha|3%|20 B',
        'Alpha|2%|60 B',
        'Zeta|1%|30 B',
      ]);
    } finally {
      second.cleanup();
    }
  });
});

function renderPopover(snapshot: ResourceMonitorSnapshot): {
  container: HTMLElement;
  cleanup: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  act(() => {
    root.render(
      <ResourceDiagnosticsPopover
        snapshot={snapshot}
        error={null}
        onClose={() => undefined}
      />,
    );
  });

  return {
    container,
    cleanup: (): void => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function getSortHeader(
  container: HTMLElement,
  column: 'name' | 'cpu' | 'memory',
): HTMLTableCellElement {
  const element = container.querySelector(
    `[data-testid="resource-diagnostics-popover-sort-${column}"]`,
  );
  if (!(element instanceof HTMLTableCellElement)) {
    throw new Error(`Sort header not found: ${column}`);
  }
  return element;
}

function getHeaderButton(
  container: HTMLElement,
  column: 'name' | 'cpu' | 'memory',
): HTMLButtonElement {
  const element = getSortHeader(container, column).querySelector('button');
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`Sort button not found: ${column}`);
  }
  return element;
}

function getRowSummaries(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('tbody tr')).map((row) => {
    const cells = row.querySelectorAll('td');
    // The visible name; its details sit in a screen-reader-only span.
    const label = cells[1]?.querySelector('span.fg-primary')?.textContent ?? '';
    const cpu = cells[2]?.textContent ?? '';
    const memory = cells[3]?.textContent ?? '';
    return `${label}|${cpu}|${memory}`;
  });
}

function expandAllRows(container: HTMLElement): void {
  for (;;) {
    const toggle = container.querySelector(
      'button[data-testid^="resource-row-toggle-"][aria-expanded="false"]',
    );
    if (!(toggle instanceof HTMLButtonElement)) return;
    act(() => {
      toggle.click();
    });
  }
}
