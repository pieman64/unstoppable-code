/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyCapabilities } from '@canopy/app-core';
import type {
  PortalScriptDescriptor,
  PortalScriptRunProjection,
} from '@canopy/protocol/portal';

let mockCaps: CanopyCapabilities;
jest.mock('@canopy/app-state', () => {
  const real: Record<string, unknown> = jest.requireActual('@canopy/app-state');
  return {
    __esModule: true,
    ...real,
    useCapabilities: (): CanopyCapabilities => mockCaps,
  };
});

import {
  WorktreeTopBar,
  type WorktreeTopBarPinnedAction,
  type WorktreeTopBarProps,
} from '../WorktreeTopBar';
import { HEADER_PRIORITY } from '../../pull-requests/PullRequestActions';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// Portal host: neither native Open nor panel-layout controls are available.
const PORTAL_CAPS: CanopyCapabilities = {
  localExecution: false,
  terminalPty: false,
  fileSystemAccess: 'read',
  voice: false,
  settingsScope: 'api-keys-only',
  pipelines: 'crud-only',
  routing: 'url',
  overviewNotifications: false,
  nativeWorktreeOpen: false,
  panelLayoutControls: false,
};

// Desktop-like host: both capability surfaces are available so the gated
// controls render (given their handlers).
const DESKTOP_CAPS: CanopyCapabilities = {
  localExecution: true,
  terminalPty: true,
  fileSystemAccess: 'read-write',
  voice: false,
  settingsScope: 'full',
  pipelines: 'execute',
  routing: 'in-memory',
  overviewNotifications: true,
  nativeWorktreeOpen: true,
  panelLayoutControls: true,
};

const LAUNCH_SCRIPT: PortalScriptDescriptor = {
  localId: 'sd-launch',
  name: 'Launch',
  scriptKey: 'launch',
  scriptName: 'launch',
  target: 'project',
  worktreeLocalId: 't1',
};

function run(status: string): PortalScriptRunProjection {
  return {
    localId: 'sr-launch',
    name: 'Launch',
    scriptKey: 'launch',
    status,
    worktreeLocalId: 't1',
  };
}

describe('WorktreeTopBar', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mockCaps = PORTAL_CAPS;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(props: Partial<WorktreeTopBarProps> = {}): void {
    act(() => {
      root.render(<WorktreeTopBar branchLabel="feature/topbar" {...props} />);
    });
  }

  function q(testId: string): HTMLElement | null {
    return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  }

  /** Query a control that must be a rendered `<button>`, without `as` casts. */
  function qButton(testId: string): HTMLButtonElement {
    const el = q(testId);
    if (!(el instanceof HTMLButtonElement)) {
      throw new Error(`expected a button for testid "${testId}"`);
    }
    return el;
  }

  function click(el: Element | null): void {
    if (!(el instanceof HTMLElement)) throw new Error('element not found');
    act(() => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  it('renders the root, branch summary, and stable branch test id', () => {
    render();
    expect(q('worktree-top-bar')).not.toBeNull();
    // Desktop-frame parity: the root stretches its sections; the 46px height
    // comes from the built-in status region, exactly like desktop's
    // PrStatusBar-driven height (9px breathing room around the 28px titlebar
    // icon buttons, centers level with the titlebar corner controls).
    const topBarClassName = q('worktree-top-bar')?.className;
    expect(topBarClassName).toContain('items-stretch');
    // The full-width separator must not add a 47th pixel to the 46px frame.
    expect(topBarClassName).not.toContain('border-b');
    expect(topBarClassName).toContain('after:h-[var(--default-border-width)]');
    expect(topBarClassName).not.toContain('after:h-px');
    expect(q('worktree-top-status')?.className).toContain('min-h-11.5');
    const branch = q('worktree-top-branch');
    expect(branch).not.toBeNull();
    // The RTL tail-truncation guard prepends an LRM mark (desktop parity).
    expect(branch?.textContent).toContain('feature/topbar');
    // Branch is truncated without wrapping.
    expect(branch?.className).toContain('truncate');
    // No base branch supplied → no breadcrumb.
    expect(q('worktree-top-base-branch')).toBeNull();
    // No slots/handlers → no leading section (New Chat left the top bar; it
    // is moving to another surface on this branch).
    expect(q('worktree-top-new-chat')).toBeNull();
  });

  it('renders host slots in the frame and lets statusContent replace the built-in summary', () => {
    render({
      leadingAccessory: <div data-testid="slot-leading" />,
      statusContent: <div data-testid="slot-status" />,
      launchControl: <div data-testid="slot-launch" />,
      trailingAccessory: <div data-testid="slot-trailing" />,
      launchScript: LAUNCH_SCRIPT,
    });
    expect(q('slot-leading')).not.toBeNull();
    expect(q('slot-status')).not.toBeNull();
    expect(q('slot-launch')).not.toBeNull();
    expect(q('slot-trailing')).not.toBeNull();
    // statusContent replaces the built-in branch summary…
    expect(q('worktree-top-status')).toBeNull();
    expect(q('worktree-top-branch')).toBeNull();
    // …and launchControl replaces the built-in Launch even with a descriptor.
    expect(q('worktree-top-launch')).toBeNull();
  });

  it('places the PR status run and its primary action beside the built-in summary', () => {
    render({
      branchLabel: 'feature/login',
      statusActions: <span data-testid="status-run">run</span>,
      primaryAction: <button type="button">Create PR</button>,
    });
    const run = container.querySelector(
      '[data-testid="worktree-top-status-actions"]',
    );
    expect(run?.textContent).toBe('run');
    // The run packs right on desktop's 4px rhythm.
    expect(run?.className).toContain('ml-auto');
    expect(run?.className).toContain('gap-1');
    expect(container.textContent).toContain('Create PR');
  });

  it('keeps the status run out when statusContent replaces the summary', () => {
    render({
      statusContent: <span>desktop bar</span>,
      statusActions: <span data-testid="status-run">run</span>,
    });
    expect(
      container.querySelector('[data-testid="worktree-top-status-actions"]'),
    ).toBeNull();
  });

  it('renders the optional base branch breadcrumb when provided', () => {
    render({ baseBranchLabel: 'develop' });
    const base = q('worktree-top-base-branch');
    expect(base).not.toBeNull();
    expect(base?.textContent).toContain('develop');
    // The label truncates inside the breadcrumb. It carries NO caret: this
    // summary is read-only, and the caret advertised a menu that could not
    // open (CAN-2522).
    expect(base?.querySelector('.truncate')).not.toBeNull();
    expect(base?.querySelector('svg')).toBeNull();
  });

  it('omits the branch summary entirely when the host withholds a branch label', () => {
    // A repoless (cowork) host supplies no branch: the chip must disappear
    // rather than render an empty icon-only label (CAN-2337). The status
    // region itself stays so the bar keeps its frame and `Open` slot.
    render({ branchLabel: undefined, baseBranchLabel: 'develop' });
    expect(q('worktree-top-status')).not.toBeNull();
    expect(q('worktree-top-branch')).toBeNull();
    expect(q('worktree-top-base-branch')).toBeNull();
  });

  it('omits the branch summary for an empty branch label', () => {
    render({ branchLabel: '' });
    expect(q('worktree-top-branch')).toBeNull();
  });

  it('hides Open and layout controls on portal capabilities', () => {
    render({
      onOpenWorktreeMenu: (): void => {},
      onTogglePanelLayout: (): void => {},
    });
    expect(q('worktree-top-open')).toBeNull();
    expect(q('worktree-top-layout-toggle')).toBeNull();
  });

  it('renders Open and layout controls for desktop capabilities plus handlers', () => {
    mockCaps = DESKTOP_CAPS;
    render({
      openMenuExpanded: true,
      onOpenWorktreeMenu: (): void => {},
      panelLayoutActive: true,
      onTogglePanelLayout: (): void => {},
    });
    const open = q('worktree-top-open');
    expect(open).not.toBeNull();
    expect(open?.getAttribute('aria-haspopup')).toBe('menu');
    expect(open?.getAttribute('aria-expanded')).toBe('true');
    expect(open?.textContent).toContain('Open');
    const layout = q('worktree-top-layout-toggle');
    expect(layout).not.toBeNull();
    expect(layout?.getAttribute('aria-label')).toBe('Toggle panel layout');
    expect(layout?.getAttribute('aria-pressed')).toBe('true');
  });

  it('hides gated controls when capability is available but the handler is missing', () => {
    mockCaps = DESKTOP_CAPS;
    render();
    expect(q('worktree-top-open')).toBeNull();
    expect(q('worktree-top-layout-toggle')).toBeNull();
  });

  it('renders no launch control without a descriptor or active run', () => {
    render();
    expect(q('worktree-top-launch')).toBeNull();
    expect(q('worktree-top-stop')).toBeNull();
  });

  it('invokes onRunScript exactly once with the descriptor when idle', () => {
    const onRunScript = jest.fn();
    render({ launchScript: LAUNCH_SCRIPT, hostActions: { onRunScript } });
    const launch = q('worktree-top-launch');
    expect(launch).not.toBeNull();
    expect(launch?.getAttribute('aria-label')).toBe('Launch scripts');
    expect(launch?.getAttribute('data-execution-action-button')).toBe('true');
    expect(qButton('worktree-top-launch').disabled).toBe(false);
    click(launch);
    expect(onRunScript).toHaveBeenCalledTimes(1);
    expect(onRunScript).toHaveBeenCalledWith(LAUNCH_SCRIPT);
  });

  it('disables Launch and does not invoke while pending', () => {
    const onRunScript = jest.fn();
    render({
      launchScript: LAUNCH_SCRIPT,
      launchPending: true,
      hostActions: { onRunScript },
    });
    const launch = qButton('worktree-top-launch');
    expect(launch.disabled).toBe(true);
    click(launch);
    expect(onRunScript).not.toHaveBeenCalled();
  });

  it('disables Launch and does not invoke when commands are disabled', () => {
    const onRunScript = jest.fn();
    render({
      launchScript: LAUNCH_SCRIPT,
      commandsDisabled: true,
      hostActions: { onRunScript },
    });
    const launch = qButton('worktree-top-launch');
    expect(launch.disabled).toBe(true);
    click(launch);
    expect(onRunScript).not.toHaveBeenCalled();
  });

  it.each(['queued', 'running'])(
    'shows Stop and invokes onCancelScript with the run for a %s run',
    (status) => {
      const onCancelScript = jest.fn();
      const activeRun = run(status);
      render({
        launchScript: LAUNCH_SCRIPT,
        launchRun: activeRun,
        hostActions: { onCancelScript },
      });
      expect(q('worktree-top-launch')).toBeNull();
      const stop = qButton('worktree-top-stop');
      expect(stop).not.toBeNull();
      expect(stop.getAttribute('aria-label')).toBe('Stop scripts');
      expect(stop.disabled).toBe(false);
      expect(stop.textContent).toContain('Stop');
      click(stop);
      expect(onCancelScript).toHaveBeenCalledTimes(1);
      expect(onCancelScript).toHaveBeenCalledWith(activeRun);
    },
  );

  it('explains Stop with a rich tooltip instead of a native title (CAN-2799)', () => {
    render({
      launchScript: LAUNCH_SCRIPT,
      launchRun: run('running'),
      hostActions: { onCancelScript: jest.fn() },
    });
    const stop = qButton('worktree-top-stop');
    expect(stop.hasAttribute('title')).toBe(false);
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    act(() => {
      stop.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Stop scripts',
    );
  });

  it('shows a disabled Stopping control while a cancel is pending', () => {
    const onCancelScript = jest.fn();
    render({
      launchScript: LAUNCH_SCRIPT,
      launchRun: run('running'),
      launchStopping: true,
      hostActions: { onCancelScript },
    });
    const stop = qButton('worktree-top-stop');
    expect(stop).not.toBeNull();
    expect(stop.disabled).toBe(true);
    expect(stop.getAttribute('aria-label')).toBe('Stopping scripts');
    expect(stop.textContent).toContain('Stopping');
    click(stop);
    expect(onCancelScript).not.toHaveBeenCalled();
  });

  it.each(['completed', 'success', 'failed', 'cancelled', 'timed_out'])(
    'returns to Launch for the terminal %s status while a descriptor remains',
    (status) => {
      render({
        launchScript: LAUNCH_SCRIPT,
        launchRun: run(status),
        hostActions: { onRunScript: (): void => {} },
      });
      expect(q('worktree-top-launch')).not.toBeNull();
      expect(q('worktree-top-stop')).toBeNull();
    },
  );

  describe('base-branch affordance (CAN-2522)', () => {
    it('renders the base branch as plain text, with no disclosure caret', () => {
      // The built-in summary is documented read-only — desktop swaps in
      // PrStatusBar for the real selector. A caret here advertised a menu that
      // could not open.
      render({ baseBranchLabel: 'master' });

      const base = container.querySelector(
        '[data-testid="worktree-top-base-branch"]',
      );
      expect(base?.textContent).toContain('master');
      expect(base?.querySelector('svg')).toBeNull();
    });

    it('keeps the caret on the Open menu, which does open', () => {
      // The bar already applies this rule to Open: a capability without a
      // handler renders nothing, "no dead UI". The base-branch caret was the
      // one place that broke it.
      mockCaps = DESKTOP_CAPS;
      render({
        baseBranchLabel: 'master',
        onOpenWorktreeMenu: (): void => {},
      });

      const open = container.querySelector('[data-testid="worktree-top-open"]');
      expect(open).not.toBeNull();
      expect(open?.querySelector('svg')).not.toBeNull();
    });
  });

  describe('project badge (CAN-2520)', () => {
    it('renders a supplied badge in place of the git glyph', () => {
      render({
        workspaceBadge: <span data-testid="probe-badge">badge</span>,
      });

      // Assert on the badge SLOT, not the whole bar: `data-icon` was never
      // rendered by anything (AppIcons emit `data-app-icon`), so
      // the previous selector matched nothing and passed even with the glyph
      // still in place.
      const slot = container.querySelector(
        '[data-testid="worktree-top-badge-slot"]',
      );
      expect(slot?.querySelector('[data-testid="probe-badge"]')).not.toBeNull();
      expect(slot?.querySelector('svg[data-app-icon]')).toBeNull();
    });

    it('falls back to the git glyph when no badge is supplied', () => {
      render();

      const slot = container.querySelector(
        '[data-testid="worktree-top-badge-slot"]',
      );
      expect(slot?.querySelector('[data-testid="probe-badge"]')).toBeNull();
      // The real fallback marker: an AppIcons glyph inside the slot.
      expect(slot?.querySelector('svg[data-app-icon]')).not.toBeNull();
    });

    it('withholds the whole summary — badge included — when there is no branch', () => {
      // A repoless (cowork) host has no branch; the summary drops out rather
      // than rendering a lone badge next to an empty label.
      render({
        branchLabel: '',
        workspaceBadge: <span data-testid="probe-badge">badge</span>,
      });

      expect(container.querySelector('[data-testid="probe-badge"]')).toBeNull();
    });
  });

  describe('pinned scripts', () => {
    const SCRIPT_CAPS: CanopyCapabilities = {
      ...DESKTOP_CAPS,
      scriptActions: true,
    };

    function pin(
      overrides: Partial<WorktreeTopBarPinnedAction> = {},
    ): WorktreeTopBarPinnedAction {
      return {
        id: 'dev',
        label: 'dev',
        command: 'pnpm run dev',
        target: 'canopy/apps/web',
        shortcut: '⌘⇧Y',
        running: false,
        onRun: jest.fn(),
        ...overrides,
      };
    }

    function pinButtons(): HTMLButtonElement[] {
      return Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          '[data-testid="worktree-top-pin"] button',
        ),
      );
    }

    it('renders a labelled and a compact play button per pin before the launch cluster', () => {
      mockCaps = SCRIPT_CAPS;
      render({
        pinnedActions: [pin()],
        launchControl: <span data-testid="probe-launch" />,
      });
      const group = q('worktree-top-pins');
      expect(group).not.toBeNull();
      const labelled = qButton('worktree-top-pin-labelled');
      const compact = qButton('worktree-top-pin-compact');
      expect(labelled.textContent).toBe('dev');
      expect(labelled.getAttribute('aria-label')).toBe('Run dev');
      expect(compact.getAttribute('aria-label')).toBe('Run dev');
      // Pins precede the launch control in the cluster.
      const launch = q('probe-launch');
      expect(
        group !== null &&
          launch !== null &&
          (group.compareDocumentPosition(launch) &
            Node.DOCUMENT_POSITION_FOLLOWING) !==
            0,
      ).toBe(true);
    });

    it('collapses labels first, then hides the whole run, by header priority', () => {
      mockCaps = SCRIPT_CAPS;
      render({ pinnedActions: [pin()] });
      expect(q('worktree-top-pins')?.className).toContain(HEADER_PRIORITY.pins);
      expect(
        qButton('worktree-top-pin-labelled').closest('[data-pin-variant]')
          ?.className,
      ).toBe(HEADER_PRIORITY.pinLabels);
      expect(
        qButton('worktree-top-pin-compact').closest('[data-pin-variant]')
          ?.className,
      ).toBe(HEADER_PRIORITY.pinCompact);
    });

    it('keeps every pin control out of the window drag region', () => {
      mockCaps = SCRIPT_CAPS;
      render({ pinnedActions: [pin(), pin({ id: 'lint', label: 'lint' })] });
      expect(q('worktree-top-pins')?.className).toContain('electron-no-drag');
      const buttons = pinButtons();
      expect(buttons).toHaveLength(4);
      for (const button of buttons) {
        expect(button.className).toContain('electron-no-drag');
        expect(
          button.closest('[data-testid="worktree-top-pin"]')?.className,
        ).toContain('electron-no-drag');
      }
    });

    it('runs from either variant on click', () => {
      // Drag regions swallow clicks in Electron; the no-drag test above is what
      // keeps these reachable, and here both buttons must dispatch.
      mockCaps = SCRIPT_CAPS;
      const onRun = jest.fn();
      render({ pinnedActions: [pin({ onRun })] });
      click(qButton('worktree-top-pin-compact'));
      click(qButton('worktree-top-pin-labelled'));
      expect(onRun).toHaveBeenCalledTimes(2);
    });

    it('shows a running indicator and names the reuse action', () => {
      mockCaps = SCRIPT_CAPS;
      render({ pinnedActions: [pin({ running: true })] });
      const row = q('worktree-top-pin');
      expect(row?.getAttribute('data-state')).toBe('running');
      expect(
        qButton('worktree-top-pin-compact').getAttribute('aria-label'),
      ).toBe('Show running dev');
      expect(row?.querySelector('svg[data-app-icon]')).toBeNull();
    });

    it('ignores clicks while a run is starting', () => {
      mockCaps = SCRIPT_CAPS;
      const onRun = jest.fn();
      render({ pinnedActions: [pin({ pending: true, onRun })] });
      expect(q('worktree-top-pin')?.getAttribute('data-state')).toBe('pending');
      click(qButton('worktree-top-pin-compact'));
      expect(onRun).not.toHaveBeenCalled();
    });

    it('renders no pins on a host without a terminal, whatever it passes', () => {
      // Portal: review API without a PTY.
      mockCaps = { ...PORTAL_CAPS, scriptActions: true };
      render({ pinnedActions: [pin()] });
      expect(q('worktree-top-pins')).toBeNull();
      // Cloud: PTY-less and no review API.
      mockCaps = PORTAL_CAPS;
      render({ pinnedActions: [pin()] });
      expect(q('worktree-top-pins')).toBeNull();
      // Desktop without the feature.
      mockCaps = DESKTOP_CAPS;
      render({ pinnedActions: [pin()] });
      expect(q('worktree-top-pins')).toBeNull();
    });

    it('renders nothing for an empty pin list', () => {
      mockCaps = SCRIPT_CAPS;
      render({ pinnedActions: [] });
      expect(q('worktree-top-pins')).toBeNull();
    });
  });
});
