/** @jest-environment jsdom */

import { PANEL_KINDS } from '@canopy/protocol';
import {
  isActivitySectionAllowedForAccess,
  isSharedContainerPanelKind,
  sharedContainerActivitySectionIds,
  sharedContainerCanView,
  sharedContainerExcludedPanelKinds,
  sharedContainerPanelKinds,
  SHARED_CONTAINER_PANEL_KINDS,
  SHARED_CONTAINER_RUN_PANEL_KINDS,
} from '../panel-allowlist';
import { usePanelLayoutStore } from '@/stores/panelLayoutStore';
import {
  repairSharedContainerPanelLayout,
  shouldCloseSharedContainerTerminalLayout,
} from '../panel-layout';
import {
  READ_WRITE_WORKSPACE_ACCESS,
  type WorkspaceAccess,
} from '@/lib/workspace-access';

afterEach(() => {
  usePanelLayoutStore.setState({ layouts: {}, layoutSizeRevisions: {} });
});

function layoutKinds(key: string): string[] {
  return Object.values(
    usePanelLayoutStore.getState().layouts[key]?.groups ?? {},
  ).flatMap((group) => group.tabs.map((tab) => tab.kind));
}

function readOnlyAccess(
  containerType: 'CODE_WORKTREE' | 'COWORK_WORK_ENTRY',
  runAllowed: boolean,
): WorkspaceAccess {
  return {
    mode: 'read-only',
    reason: 'shared-container',
    containerType,
    runAllowed,
  };
}

describe('shared-container panel allowlist', () => {
  it('preserves terminal layout only while the run status is unresolved', () => {
    // Main has not answered yet, so purging here would destroy a legitimately
    // restored terminal every time an allowed share is opened.
    expect(shouldCloseSharedContainerTerminalLayout('loading', false)).toBe(
      false,
    );
    expect(shouldCloseSharedContainerTerminalLayout('available', true)).toBe(
      false,
    );
  });

  it('purges a stale terminal tab in every resolved non-consented state', () => {
    expect(shouldCloseSharedContainerTerminalLayout('unsupported', false)).toBe(
      true,
    );
    expect(shouldCloseSharedContainerTerminalLayout('unpublished', false)).toBe(
      true,
    );
    expect(shouldCloseSharedContainerTerminalLayout('available', false)).toBe(
      true,
    );
  });

  it('mounts the standard read-only kinds, including explorer and browser', () => {
    expect([...SHARED_CONTAINER_PANEL_KINDS].sort()).toEqual(
      [
        'activity-card',
        'activity-section',
        'browser',
        'chat',
        'file-diff',
        'file-explorer',
        'plan',
      ].sort(),
    );
  });

  // Q1: recipients read a plan in a read-only Plan panel; the diagram split
  // is a writer affordance and stays refused whatever the run consent.
  it('admits the read-only Plan panel but never the plan diagram', () => {
    for (const runEnabled of [false, true]) {
      expect(isSharedContainerPanelKind('plan', runEnabled)).toBe(true);
      expect(isSharedContainerPanelKind('plan-diagram', runEnabled)).toBe(
        false,
      );
      const excludedKinds = sharedContainerExcludedPanelKinds(runEnabled);
      expect(excludedKinds).not.toContain('plan');
      expect(excludedKinds).toContain('plan-diagram');
    }
  });

  it('closes a persisted plan diagram tab but keeps the Plan panel', () => {
    const key = 'shared-container-viewer/container-plan';
    usePanelLayoutStore.getState().initializeLayout(key, {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'plan',
          groupId: 'plan-group',
          panelId: 'panel-plan-plan-1',
          instance: { planId: 'plan-1' },
        },
        {
          kind: 'plan-diagram',
          groupId: 'plan-diagram-group',
          panelId: 'panel-plan-diagram-plan-1',
          instance: { planId: 'plan-1' },
        },
        {
          kind: 'activity-section',
          groupId: 'activity-group',
          panelId: 'activity-panel',
        },
      ],
    });

    repairSharedContainerPanelLayout(key, true);

    const kinds = layoutKinds(key);
    expect(kinds).toContain('plan');
    expect(kinds).not.toContain('plan-diagram');
    expect(kinds).toContain('activity-section');
  });

  // The file explorer and browser only read the sealed replica, so they are
  // never gated on run consent. Only what executes code is.
  it('never gates the file explorer or browser on run consent', () => {
    for (const runEnabled of [false, true]) {
      expect(isSharedContainerPanelKind('file-explorer', runEnabled)).toBe(
        true,
      );
      expect(isSharedContainerPanelKind('browser', runEnabled)).toBe(true);
    }
  });

  it('admits the terminal only once run consent is granted', () => {
    expect(isSharedContainerPanelKind('terminal', false)).toBe(false);
    expect(isSharedContainerPanelKind('terminal', true)).toBe(true);
    expect([...SHARED_CONTAINER_RUN_PANEL_KINDS]).toEqual(['terminal']);
  });

  it('fails closed for unknown kinds, including future ones', () => {
    for (const runEnabled of [false, true]) {
      expect(isSharedContainerPanelKind('not-a-panel', runEnabled)).toBe(false);
      expect(isSharedContainerPanelKind('', runEnabled)).toBe(false);
      expect(isSharedContainerPanelKind('CHAT', runEnabled)).toBe(false);
    }
  });

  it('hides every non-mountable kind from the add menu', () => {
    for (const runEnabled of [false, true]) {
      const allowedKinds = sharedContainerPanelKinds(runEnabled);
      const excludedKinds = sharedContainerExcludedPanelKinds(runEnabled);
      for (const kind of PANEL_KINDS) {
        if (!allowedKinds.includes(kind)) {
          expect(excludedKinds).toContain(kind);
        }
      }
    }
  });

  // A recipient cannot start a chat, and diffs open from Changes and file
  // links; `+` offers only the read-safe kinds (plus terminal with consent).
  it('offers no chat or diff creation from the add menu', () => {
    for (const runEnabled of [false, true]) {
      const excludedKinds = sharedContainerExcludedPanelKinds(runEnabled);
      expect(excludedKinds).toContain('chat');
      expect(excludedKinds).toContain('file-diff');
      expect(excludedKinds).not.toContain('file-explorer');
      expect(excludedKinds).not.toContain('browser');
    }
    expect(sharedContainerExcludedPanelKinds(false)).toContain('terminal');
    expect(sharedContainerExcludedPanelKinds(true)).not.toContain('terminal');
  });

  // A run panel reads step logs from the host that executed the run, which a
  // recipient replica never carries: never mounted, never offered.
  it('never mounts or offers pipeline run panels', () => {
    for (const runEnabled of [false, true]) {
      expect(isSharedContainerPanelKind('pipeline-execution', runEnabled)).toBe(
        false,
      );
      expect(sharedContainerPanelKinds(runEnabled)).not.toContain(
        'pipeline-execution',
      );
      expect(sharedContainerExcludedPanelKinds(runEnabled)).toContain(
        'pipeline-execution',
      );
    }
    expect(SHARED_CONTAINER_PANEL_KINDS).not.toContain('pipeline-execution');
    expect(SHARED_CONTAINER_RUN_PANEL_KINDS).not.toContain(
      'pipeline-execution',
    );
  });

  it('never mounts or offers subagent panels to a shared-container recipient', () => {
    for (const runEnabled of [false, true]) {
      for (const kind of ['subagents', 'subagent-chat']) {
        expect(isSharedContainerPanelKind(kind, runEnabled)).toBe(false);
        expect(sharedContainerPanelKinds(runEnabled)).not.toContain(kind);
        expect(sharedContainerExcludedPanelKinds(runEnabled)).toContain(kind);
        expect(SHARED_CONTAINER_PANEL_KINDS).not.toContain(kind);
        expect(SHARED_CONTAINER_RUN_PANEL_KINDS).not.toContain(kind);
      }
    }
  });

  it('closes persisted subagent panels in recipient layouts', () => {
    const key = 'shared-container-viewer/container-subagents';
    usePanelLayoutStore.getState().initializeLayout(key, {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'subagents',
          groupId: 'subagents-group',
          panelId: 'panel-subagents',
        },
        {
          kind: 'subagent-chat',
          groupId: 'subagent-chat-group',
          panelId: 'panel-subagent-chat',
          instance: {
            rootChatId: 'chat-1',
            subagentId: 'agent-1',
            subagentKind: 'managed',
          },
        },
        {
          kind: 'activity-section',
          groupId: 'activity-group',
          panelId: 'activity-panel',
        },
      ],
    });

    repairSharedContainerPanelLayout(key, true);

    expect(layoutKinds(key)).toEqual(['activity-section']);
  });

  it('closes a pipeline run tab found in a recipient layout', () => {
    const key = 'shared-container-viewer/container-runs';
    usePanelLayoutStore.getState().initializeLayout(key, {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'pipeline-execution',
          groupId: 'runs-group',
          panelId: 'panel-pipeline-run-1',
          instance: { executionId: 'run-1' },
        },
        {
          kind: 'activity-section',
          groupId: 'activity-group',
          panelId: 'activity-panel',
        },
      ],
    });

    repairSharedContainerPanelLayout(key, true);

    expect(layoutKinds(key)).not.toContain('pipeline-execution');
    expect(layoutKinds(key)).toContain('activity-section');
  });

  it('shows the publisher sections for each share type minus write-only ones', () => {
    expect(sharedContainerActivitySectionIds('CODE_WORKTREE', false)).toEqual([
      'changed-files',
      'plans',
      'notes',
      'prompts',
      'attachments',
    ]);
    expect(sharedContainerActivitySectionIds('CODE_WORKTREE', true)).toContain(
      'scripts',
    );
    expect(
      sharedContainerActivitySectionIds('COWORK_WORK_ENTRY', true),
    ).toEqual(['notes', 'prompts', 'attachments']);
  });

  it('filters activity sections only for read-only access', () => {
    expect(
      isActivitySectionAllowedForAccess(
        'pull-request',
        READ_WRITE_WORKSPACE_ACCESS,
      ),
    ).toBe(true);
    expect(
      isActivitySectionAllowedForAccess(
        'pull-request',
        readOnlyAccess('CODE_WORKTREE', true),
      ),
    ).toBe(false);
    expect(
      isActivitySectionAllowedForAccess(
        'scripts',
        readOnlyAccess('CODE_WORKTREE', false),
      ),
    ).toBe(false);
    expect(
      isActivitySectionAllowedForAccess(
        'changed-files',
        readOnlyAccess('COWORK_WORK_ENTRY', false),
      ),
    ).toBe(false);
    expect(
      isActivitySectionAllowedForAccess(
        'not-a-section',
        readOnlyAccess('CODE_WORKTREE', true),
      ),
    ).toBe(false);
  });

  it('fails the recipient surface closed without an explicit VIEW grant', () => {
    expect(sharedContainerCanView(['VIEW'])).toBe(true);
    expect(sharedContainerCanView([])).toBe(false);
    expect(sharedContainerCanView(['EDIT'])).toBe(false);
    expect(sharedContainerCanView(undefined)).toBe(false);
  });

  // The layout is the standard one (or the publisher's sanitized layout);
  // the repair only drops refused kinds and never injects recipient-only tabs.
  it('keeps the standard layout and drops only refused kinds', () => {
    const key = 'shared-container-viewer/container-1';
    usePanelLayoutStore.getState().initializeLayout(key, {
      orientation: 'horizontal',
      groups: [
        { kind: 'terminal', groupId: 'terminal-group', panelId: 'terminal' },
        {
          kind: 'file-explorer',
          groupId: 'files-group',
          panelId: 'files-panel',
        },
        {
          kind: 'activity-section',
          groupId: 'activity-group',
          panelId: 'activity-panel',
        },
      ],
    });

    repairSharedContainerPanelLayout(key, false);

    const kinds = layoutKinds(key);
    expect(kinds).not.toContain('terminal');
    expect(kinds).toContain('file-explorer');
    expect(kinds).toContain('activity-section');
    expect(kinds).not.toContain('chat');
    expect(kinds).not.toContain('file-diff');
  });

  // CAN-2831: revoking run consent has to reach a layout that is already on
  // screen. Main stops the container's processes first; this repair is what
  // then closes the tab they were attached to.
  it('closes a terminal tab when run consent is revoked', () => {
    const key = 'shared-container-viewer/container-run';
    usePanelLayoutStore.getState().initializeLayout(key, {
      orientation: 'horizontal',
      groups: [
        { kind: 'terminal', groupId: 'terminal-group', panelId: 'terminal' },
        {
          kind: 'activity-section',
          groupId: 'activity-group',
          panelId: 'activity-panel',
        },
      ],
    });

    repairSharedContainerPanelLayout(key, true);
    expect(layoutKinds(key)).toContain('terminal');

    repairSharedContainerPanelLayout(key, false);
    expect(layoutKinds(key)).not.toContain('terminal');
  });

  it('keeps only terminal tabs backed by live sessions after remount', () => {
    const key = 'shared-container-viewer/container-live-run';
    usePanelLayoutStore.getState().initializeLayout(key, {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'terminal',
          groupId: 'live-group',
          panelId: 'live-terminal',
          instance: { terminalId: 'terminal-live' },
        },
        {
          kind: 'terminal',
          groupId: 'stale-group',
          panelId: 'stale-terminal',
          instance: { terminalId: 'terminal-stale' },
        },
        {
          kind: 'activity-section',
          groupId: 'activity-group',
          panelId: 'activity-panel',
        },
      ],
    });

    repairSharedContainerPanelLayout(key, true, new Set(['terminal-live']));

    const panels = Object.values(
      usePanelLayoutStore.getState().layouts[key]?.groups ?? {},
    ).flatMap((group) => group.tabs.map((tab) => tab.panelId));
    expect(panels).toContain('live-terminal');
    expect(panels).not.toContain('stale-terminal');
    expect(panels).toContain('activity-panel');
  });
});
