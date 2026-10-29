/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CanopyClientProvider } from '@canopy/app-state';
import { requestScriptActionsReview } from '../../review-requests';
import { ScriptActionsReviewHost } from '../ScriptActionsReviewDialog';
import { ScriptActionsReviewEntry } from '../ScriptActionsReviewEntry';
import {
  action,
  createFakeScriptActionsClient,
  snapshotOf,
  type FakeScriptActionsClient,
} from './fake-script-actions-client';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}

function byTestId(testId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function render(
  fake: FakeScriptActionsClient,
  worktreeId: string | null = 'wt',
): void {
  act(() => {
    root.render(
      <CanopyClientProvider client={fake.client}>
        <ScriptActionsReviewEntry projectId="proj" worktreeId={worktreeId} />
        <ScriptActionsReviewHost shortcutPlatform="darwin" />
      </CanopyClientProvider>,
    );
  });
}

describe('ScriptActionsReviewHost', () => {
  it('opens from the entry, rescans, contains focus and returns it on close', async () => {
    const fake = createFakeScriptActionsClient(
      snapshotOf([action({ name: 'build' })]),
    );
    render(fake);
    await flush();
    const open = byTestId('script-actions-review-entry-open');
    if (!(open instanceof HTMLButtonElement)) throw new Error('missing entry');
    open.focus();
    act(() => open.click());
    await flush();
    const dialog = byTestId('script-actions-review-dialog');
    expect(dialog).not.toBeNull();
    expect(dialog?.contains(document.activeElement)).toBe(true);
    expect(
      fake.calls.filter((call) => call.name === 'scriptActions.rescan'),
    ).toEqual([
      {
        name: 'scriptActions.rescan',
        args: { projectId: 'proj', worktreeId: 'wt' },
      },
    ]);
    expect(byTestId('script-actions-approve')).not.toBeNull();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    await flush();
    expect(byTestId('script-actions-review-dialog')).toBeNull();
    expect(document.activeElement).toBe(open);
  });

  it('opens for toast and composer requests', async () => {
    const fake = createFakeScriptActionsClient(snapshotOf([]));
    render(fake);
    let accepted = false;
    act(() => {
      accepted = requestScriptActionsReview({
        projectId: 'proj',
        worktreeId: 'wt',
        source: 'toast',
      });
    });
    await flush();
    expect(accepted).toBe(true);
    expect(byTestId('script-actions-review-dialog')).not.toBeNull();
  });
});

describe('ScriptActionsReviewEntry', () => {
  it('renders nothing without the capability (cloud chats)', async () => {
    const fake = createFakeScriptActionsClient(snapshotOf([]), {});
    render(fake);
    await flush();
    expect(byTestId('script-actions-review-entry')).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });

  it('explains a missing worktree and stays disabled', async () => {
    const fake = createFakeScriptActionsClient(snapshotOf([]));
    render(fake, null);
    await flush();
    const open = byTestId('script-actions-review-entry-open');
    expect(open instanceof HTMLButtonElement && open.disabled).toBe(true);
    expect(byTestId('script-actions-review-entry')?.textContent).toContain(
      'Open a worktree in this project',
    );
  });
});
