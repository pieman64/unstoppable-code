/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AutomationMutationResponse,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { ScheduledAutomationsNotice } from '../ScheduledAutomationsNotice';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const TARGET = { projectId: 'ws', worktreeId: 'wt', chatId: 'chat' };

function cronActivity(
  id: string,
  overrides: Partial<ScheduledActivity> = {},
): ScheduledActivity {
  return {
    version: 1,
    id,
    name: `Runner savings report ${id}`,
    enabled: true,
    schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
    action: {
      type: 'worktree_session_prompt',
      workspaceId: 'ws',
      worktreeId: 'wt',
      chatId: 'chat',
      prompt: 'Summarize the macOS runner savings\nInclude totals',
    },
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
    nextRunAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    failureCount: 0,
    ...overrides,
  } as ScheduledActivity;
}

function oneTimeActivity(id: string): ScheduledActivity {
  const runAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  return cronActivity(id, {
    schedule: { kind: 'one_time', runAt, timezone: 'local' },
    nextRunAt: runAt,
  });
}

const OK: AutomationMutationResponse = { ok: true };

describe('ScheduledAutomationsNotice', () => {
  let container: HTMLDivElement;
  let root: Root;
  let runNow: jest.Mock<Promise<AutomationMutationResponse>, [string]>;
  let updateActivity: jest.Mock<
    Promise<AutomationMutationResponse>,
    [{ id: string; enabled?: boolean }]
  >;
  let openAutomationEdit: jest.Mock;
  let navigate: jest.Mock;
  const initialAutomations = useAutomationsStore.getState();
  const initialNavigation = useNavigationStore.getState();

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    runNow = jest.fn(() => Promise.resolve(OK));
    updateActivity = jest.fn(() => Promise.resolve(OK));
    openAutomationEdit = jest.fn();
    navigate = jest.fn();
    useAutomationsStore.setState({ runNow, updateActivity });
    useNavigationStore.setState({ openAutomationEdit, navigate });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = '';
    useAutomationsStore.setState(initialAutomations, true);
    useNavigationStore.setState(initialNavigation, true);
  });

  function render(activities: ScheduledActivity[]): void {
    act(() => {
      useAutomationsStore.setState({ activities });
      root.render(<ScheduledAutomationsNotice target={TARGET} />);
    });
  }

  function notice(): HTMLElement | null {
    return document.body.querySelector(
      '[data-testid="chat-input-scheduled-automations-notice"]',
    );
  }

  function byTestId(id: string): HTMLElement {
    const element = document.body.querySelector<HTMLElement>(
      `[data-testid="${id}"]`,
    );
    if (!element) throw new Error(`Missing ${id}`);
    return element;
  }

  async function click(element: HTMLElement): Promise<void> {
    await act(async () => {
      element.click();
      await Promise.resolve();
    });
  }

  it('renders nothing without recurring automations and ignores one-time sends', () => {
    render([]);
    expect(notice()).toBeNull();
    render([oneTimeActivity('once')]);
    expect(notice()).toBeNull();
  });

  it('renders nothing without a target', () => {
    useAutomationsStore.setState({ activities: [cronActivity('a1')] });
    act(() => {
      root.render(<ScheduledAutomationsNotice target={null} />);
    });
    expect(notice()).toBeNull();
  });

  it('shows cadence, name, and next run for a single automation', () => {
    render([cronActivity('a1'), oneTimeActivity('once')]);
    const text = notice()?.textContent ?? '';
    expect(text).toContain('Every hour');
    expect(text).toContain('Runner savings report a1');
    expect(text).toContain('· next ');
    expect(byTestId('scheduled-automation-run-now').textContent).toBe(
      'Run now',
    );
    expect(
      document.body.querySelector(
        '[data-testid="scheduled-automations-manage"]',
      ),
    ).toBeNull();
  });

  it('blocks the prompt preview in the tooltip it portals to the document body, name recorded (CAN-3119)', () => {
    render([cronActivity('a1')]);
    const name = byTestId('scheduled-automation-name');
    act(() => {
      name.dispatchEvent(
        new MouseEvent('mouseover', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
    });
    const tooltip =
      document.body.querySelector<HTMLElement>('[role="tooltip"]');
    expect(tooltip).not.toBeNull();
    expect(container.contains(tooltip)).toBe(false);
    const blocks = tooltip?.querySelectorAll(`.${POSTHOG_REPLAY_BLOCK_CLASS}`);
    expect(blocks).toHaveLength(1);
    expect(blocks?.[0]?.textContent).toContain(
      'Summarize the macOS runner savings',
    );
    expect(blocks?.[0]?.textContent).not.toContain('Runner savings report a1');
    expect(tooltip?.textContent).toContain('Runner savings report a1');
  });

  it('summarizes several automations with a Manage action', async () => {
    render([cronActivity('a1'), cronActivity('a2')]);
    const text = notice()?.textContent ?? '';
    expect(text).toContain('2 recurring automations');
    expect(text).toContain('Next run ');
    expect(
      document.body.querySelector(
        '[data-testid="scheduled-automation-run-now"]',
      ),
    ).toBeNull();
    await click(byTestId('scheduled-automations-manage'));
    expect(navigate).toHaveBeenCalledWith('automations');
  });

  it('runs now without disabling the automation', async () => {
    render([cronActivity('a1')]);
    await click(byTestId('scheduled-automation-run-now'));
    expect(runNow).toHaveBeenCalledWith('a1');
    expect(updateActivity).not.toHaveBeenCalled();
  });

  it('reports the reason for a failed run inline and announces it', async () => {
    runNow.mockResolvedValueOnce({
      ok: false,
      error: 'Activity is already running.',
    });
    render([cronActivity('a1')]);
    await click(byTestId('scheduled-automation-run-now'));
    const alert = notice()?.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe('Activity is already running.');
    expect(notice()?.textContent ?? '').not.toContain(
      "Couldn't start the run.",
    );
  });

  it('falls back to generic run copy without a reason', async () => {
    runNow.mockResolvedValueOnce({ ok: false, error: '' });
    render([cronActivity('a1')]);
    await click(byTestId('scheduled-automation-run-now'));
    expect(notice()?.textContent ?? '').toContain("Couldn't start the run.");

    runNow.mockRejectedValueOnce(new Error('ipc closed'));
    await click(byTestId('scheduled-automation-run-now'));
    expect(notice()?.textContent ?? '').toContain("Couldn't start the run.");
  });

  it('shows the reason for a failed pause in the dialog', async () => {
    updateActivity.mockResolvedValueOnce({
      ok: false,
      error: 'This automation belongs to another context.',
    });
    render([cronActivity('a1')]);
    await click(byTestId('scheduled-automation-more'));
    await click(byTestId('scheduled-automation-pause'));
    await click(byTestId('scheduled-automation-pause-confirm'));
    const dialog = byTestId('scheduled-automation-pause-dialog').textContent;
    expect(dialog).toContain('This automation belongs to another context.');
    expect(dialog).not.toContain("Couldn't pause the automation.");
  });

  it('keeps the name focusable with the shared focus ring', () => {
    render([cronActivity('a1')]);
    const name = byTestId('scheduled-automation-name');
    expect(name.tabIndex).toBe(0);
    expect(name.classList.contains('focus-ring')).toBe(true);
  });

  it('leads every options row with an icon', async () => {
    render([cronActivity('a1')]);
    await click(byTestId('scheduled-automation-more'));
    for (const id of [
      'scheduled-automation-edit',
      'scheduled-automation-pause',
    ]) {
      const slot = byTestId(id).firstElementChild;
      expect(slot?.getAttribute('aria-hidden')).toBe('true');
      expect(slot?.querySelector('svg')).toBeInstanceOf(Element);
    }
  });

  it('opens the automation editor from the options menu', async () => {
    render([cronActivity('a1')]);
    await click(byTestId('scheduled-automation-more'));
    await click(byTestId('scheduled-automation-edit'));
    expect(openAutomationEdit).toHaveBeenCalledWith({ activityId: 'a1' });
  });

  it('asks before pausing; cancel does nothing and confirm disables', async () => {
    render([cronActivity('a1')]);
    await click(byTestId('scheduled-automation-more'));
    await click(byTestId('scheduled-automation-pause'));
    expect(byTestId('scheduled-automation-pause-dialog').textContent).toContain(
      'Pause this automation?',
    );

    const cancel = Array.from(
      byTestId('scheduled-automation-pause-dialog').querySelectorAll('button'),
    ).find((button) => button.textContent === 'Cancel');
    if (!cancel) throw new Error('Missing cancel');
    await click(cancel);
    expect(updateActivity).not.toHaveBeenCalled();
    expect(
      document.body.querySelector(
        '[data-testid="scheduled-automation-pause-dialog"]',
      ),
    ).toBeNull();

    await click(byTestId('scheduled-automation-more'));
    await click(byTestId('scheduled-automation-pause'));
    await click(byTestId('scheduled-automation-pause-confirm'));
    expect(updateActivity).toHaveBeenCalledWith({ id: 'a1', enabled: false });
    expect(runNow).not.toHaveBeenCalled();
  });

  it('drops an open Pause dialog when the recurring set changes', async () => {
    render([cronActivity('a1')]);
    await click(byTestId('scheduled-automation-more'));
    await click(byTestId('scheduled-automation-pause'));
    expect(
      document.body.querySelector(
        '[data-testid="scheduled-automation-pause-dialog"]',
      ),
    ).not.toBeNull();

    // A second automation arrives while the dialog is open, then goes away.
    render([cronActivity('a1'), cronActivity('a2')]);
    render([cronActivity('a1')]);

    expect(
      document.body.querySelector(
        '[data-testid="scheduled-automation-pause-dialog"]',
      ),
    ).toBeNull();
    expect(updateActivity).not.toHaveBeenCalled();
  });

  it('does not carry a run error over to a different automation', async () => {
    runNow.mockResolvedValueOnce({ ok: false, error: 'boom' });
    render([cronActivity('a1')]);
    await click(byTestId('scheduled-automation-run-now'));
    expect(notice()?.textContent ?? '').toContain('boom');

    render([cronActivity('b1')]);
    expect(notice()?.textContent ?? '').toContain('Runner savings report b1');
    expect(notice()?.textContent ?? '').not.toContain('boom');
  });
});
