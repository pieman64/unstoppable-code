/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  SplitPreflightModal,
  type SplitPreflightModalProps,
  type SplitPreflightRunningResources,
} from '../SplitPreflightModal';
import type { SplitPrReadiness } from '@/lib/splitPrEligibilityInputs';

jest.mock('@/components/shared/DialogModal', () => ({
  DialogModal: function MockDialogModal({
    children,
    dataTestId,
  }: {
    children: ReactNode;
    dataTestId?: string;
  }): JSX.Element {
    return <div data-testid={dataTestId}>{children}</div>;
  },
}));

const NO_RESOURCES: SplitPreflightRunningResources = {
  terminals: 0,
  browsers: 0,
  scripts: 0,
};

const READY: SplitPrReadiness = { eligible: true, blockers: [] };

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  jest.clearAllMocks();
});

async function render(
  overrides: Partial<SplitPreflightModalProps> = {},
): Promise<{
  onStart: jest.Mock;
  onCancel: jest.Mock;
}> {
  const onStart = jest.fn();
  const onCancel = jest.fn();
  await act(async () => {
    root.render(
      <SplitPreflightModal
        projectId="proj-1"
        worktreeId="wt-1"
        runningResources={NO_RESOURCES}
        readiness={READY}
        onStart={onStart}
        onCancel={onCancel}
        {...overrides}
      />,
    );
    await Promise.resolve();
  });
  return { onStart, onCancel };
}

function query(testId: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

describe('SplitPreflightModal', () => {
  it('renders the modal shell with the ordered step list', async () => {
    await render();

    expect(query('split-preflight-modal')).not.toBeNull();
    const steps = query('split-preflight-steps');
    expect(steps).not.toBeNull();
    const items = Array.from(steps?.querySelectorAll('li') ?? []).map(
      (li) => li.textContent,
    );
    expect(items).toHaveLength(5);
    expect(items[0]).toContain('Plan');
    expect(items[0]).toContain('analyze the PR diff');
    expect(items[1]).toContain('Review');
    expect(items[1]).toContain('approve or edit the proposed split');
    expect(items[2]).toContain('integration branch');
    expect(items[3]).toContain('Carve');
    expect(items[3]).toContain('verify');
    expect(items[3]).toContain('PR');
    expect(items[4]).toContain('Finalize');
    expect(items[4]).toContain('close the original PR');
  });

  it('always shows the lock notice', async () => {
    await render();

    const notice = query('split-preflight-lock-notice');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('locked while the split runs');
  });

  it('shows the lock notice even when the worktree is fully idle and ready', async () => {
    await render({ runningResources: NO_RESOURCES, readiness: READY });

    expect(query('split-preflight-lock-notice')).not.toBeNull();
  });

  it('omits the termination warning when no resources are running', async () => {
    await render({ runningResources: NO_RESOURCES });

    expect(query('split-preflight-termination-warning')).toBeNull();
  });

  it('shows the termination warning listing only nonzero resource kinds', async () => {
    await render({
      runningResources: { terminals: 2, browsers: 0, scripts: 1 },
    });

    const warning = query('split-preflight-termination-warning');
    expect(warning).not.toBeNull();
    expect(warning?.textContent).toContain('2');
    expect(warning?.textContent).toContain('terminals');
    expect(warning?.textContent).not.toContain('browser tab');
    expect(warning?.textContent).toContain('1');
    expect(warning?.textContent).toContain('running script');
  });

  it('singularizes counts of exactly one', async () => {
    await render({
      runningResources: { terminals: 1, browsers: 1, scripts: 1 },
    });

    const warning = query('split-preflight-termination-warning');
    expect(warning?.textContent).toContain('1 terminal');
    expect(warning?.textContent).not.toContain('1 terminals');
    expect(warning?.textContent).toContain('1 browser tab');
    expect(warning?.textContent).not.toContain('1 browser tabs');
    expect(warning?.textContent).toContain('1 running script');
    expect(warning?.textContent).not.toContain('1 running scripts');
    // The serial join reads as one sentence.
    expect(warning?.textContent).toBe(
      'Running work will be closed. Starting closes 1 terminal, 1 browser tab, and 1 running script.',
    );
  });

  it('enables Start and hides blocker copy when readiness has no blockers', async () => {
    await render({ readiness: READY });

    const start = query('split-preflight-start');
    expect(start).not.toBeNull();
    expect(start?.hasAttribute('disabled')).toBe(false);
    expect(query('split-preflight-blockers')).toBeNull();
  });

  it('disables Start and renders blocker copy when readiness drifts to blocked', async () => {
    await render({
      readiness: {
        eligible: true,
        blockers: ['uncommitted_changes', 'active_chats'],
      },
    });

    const start = query('split-preflight-start');
    expect(start?.hasAttribute('disabled')).toBe(true);
    const blockers = query('split-preflight-blockers');
    expect(blockers).not.toBeNull();
    // Prose, not bullets: each blocker is its own sentence after the title.
    expect(blockers?.textContent).toBe(
      'Not ready to start. Commit or discard local changes first. Wait for active agent chats to finish.',
    );
  });

  it('re-enables Start once blockers clear on rerender', async () => {
    const onStart = jest.fn();
    const onCancel = jest.fn();
    await act(async () => {
      root.render(
        <SplitPreflightModal
          projectId="proj-1"
          worktreeId="wt-1"
          runningResources={NO_RESOURCES}
          readiness={{ eligible: true, blockers: ['unpushed_commits'] }}
          onStart={onStart}
          onCancel={onCancel}
        />,
      );
      await Promise.resolve();
    });
    expect(query('split-preflight-start')?.hasAttribute('disabled')).toBe(true);

    await act(async () => {
      root.render(
        <SplitPreflightModal
          projectId="proj-1"
          worktreeId="wt-1"
          runningResources={NO_RESOURCES}
          readiness={READY}
          onStart={onStart}
          onCancel={onCancel}
        />,
      );
      await Promise.resolve();
    });

    expect(query('split-preflight-start')?.hasAttribute('disabled')).toBe(
      false,
    );
    expect(query('split-preflight-blockers')).toBeNull();
  });

  it('invokes onStart exactly once when Start is clicked while ready', async () => {
    const { onStart, onCancel } = await render({ readiness: READY });

    const start = query('split-preflight-start');
    await act(async () => {
      start?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('invokes onCancel without calling onStart when Cancel is clicked', async () => {
    const { onStart, onCancel } = await render();

    const cancel = query('split-preflight-cancel');
    await act(async () => {
      cancel?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
  });
});
