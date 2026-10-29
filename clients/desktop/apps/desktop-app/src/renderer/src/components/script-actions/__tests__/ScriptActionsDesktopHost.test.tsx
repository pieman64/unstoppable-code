/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ScriptActionsAddReceipt } from '@canopy/protocol/script-actions';
import { ScriptActionsDesktopHost } from '../ScriptActionsDesktopHost';
import {
  scriptActionsReceiptTargetName,
  scriptActionsReviewWorktreeId,
} from '../desktopScriptActions';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const requestScriptActionsReview = jest.fn<boolean, [unknown]>(() => true);
jest.mock(
  '@canopy/ui-app/script-actions',
  (): Record<string, unknown> => ({
    ...jest.requireActual<Record<string, unknown>>(
      '@canopy/ui-app/script-actions',
    ),
    ScriptActionsReviewHost: (): null => null,
    requestScriptActionsReview: (request: unknown): boolean =>
      requestScriptActionsReview(request),
  }),
);

const projects = [
  {
    id: 'proj-multi',
    name: 'Platform',
    type: 'multi-repo',
    repos: [
      { id: 'repo-api', name: 'api' },
      { id: 'repo-web', name: 'web' },
    ],
    worktrees: [{ id: 'wt-1' }, { id: 'wt-2' }],
  },
  {
    id: 'proj-single',
    name: 'Docs',
    type: 'single-repo',
    worktrees: [{ id: 'wt-only' }],
  },
];
jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: {
    getState: (): { projects: typeof projects } => ({ projects }),
  },
}));

let selectedWorktree: { projectId: string; worktreeId: string } | null = null;
jest.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: (): { selectedWorktree: typeof selectedWorktree } => ({
      selectedWorktree,
    }),
  },
}));

interface ToastMetaLike {
  readonly action: { readonly label: string; readonly onClick: () => void };
}
const addToast = jest.fn<
  void,
  [string, string, (() => void) | undefined, ToastMetaLike]
>();
jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: {
    getState: (): { addToast: typeof addToast } => ({ addToast }),
  },
}));

jest.mock('@/stores/globalFocusShortcutStore', () => ({
  useGlobalFocusShortcutStore: <T,>(
    selector: (state: { status: null }) => T,
  ): T => selector({ status: null }),
}));

let foundListener: ((receipt: ScriptActionsAddReceipt) => void) | null = null;
const unsubscribe = jest.fn();
Reflect.set(window, 'api', {
  scriptActions: {
    onFound: (listener: (receipt: ScriptActionsAddReceipt) => void) => {
      foundListener = listener;
      return unsubscribe;
    },
  },
});

function receipt(
  overrides: Partial<ScriptActionsAddReceipt> = {},
): ScriptActionsAddReceipt {
  return {
    projectId: 'proj-multi',
    worktreeId: 'wt-2',
    operationId: 'op-1',
    repoIds: ['repo-api'],
    status: 'complete',
    pendingCount: 3,
    completedAt: '2026-10-21T00:00:00.000Z',
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  addToast.mockClear();
  requestScriptActionsReview.mockClear();
  selectedWorktree = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<ScriptActionsDesktopHost />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function emit(value: ScriptActionsAddReceipt): void {
  act(() => foundListener?.(value));
}

describe('ScriptActionsDesktopHost post-add toast', () => {
  it('shows one toast per operation with a Review action', () => {
    emit(receipt());
    emit(receipt());
    expect(addToast).toHaveBeenCalledTimes(1);
    const call = addToast.mock.calls[0];
    if (!call) throw new Error('no toast');
    const [message, type, onClick, meta] = call;
    expect(message).toBe('Found 3 scripts in api to review');
    expect(type).toBe('info');
    expect(onClick).toBeUndefined();
    expect(meta).toMatchObject({
      category: 'Script',
      projectId: 'proj-multi',
      suppressOsNotification: true,
      action: { label: 'Review' },
    });
    act(() => {
      meta.action.onClick();
    });
    expect(requestScriptActionsReview).toHaveBeenCalledWith({
      projectId: 'proj-multi',
      worktreeId: 'wt-2',
      source: 'toast',
    });
  });

  it('never toasts for scans without pending scripts or that failed', () => {
    emit(receipt({ operationId: 'a', pendingCount: 0 }));
    emit(receipt({ operationId: 'b', status: 'failed' }));
    emit(receipt({ operationId: 'c', status: 'scanning' }));
    expect(addToast).not.toHaveBeenCalled();
  });

  it('names the project when several repositories were added', () => {
    emit(
      receipt({
        operationId: 'multi',
        repoIds: ['repo-api', 'repo-web'],
        pendingCount: 1,
      }),
    );
    expect(addToast.mock.calls[0]?.[0]).toBe(
      'Found 1 script in Platform to review',
    );
  });

  it('unsubscribes on unmount', () => {
    act(() => root.unmount());
    expect(unsubscribe).toHaveBeenCalled();
    root = createRoot(container);
  });
});

describe('desktop notice helpers', () => {
  const sidebar = projects as unknown as Parameters<
    typeof scriptActionsReceiptTargetName
  >[0];

  it('resolves the review worktree without guessing among several', () => {
    expect(
      scriptActionsReviewWorktreeId(sidebar, null, {
        projectId: 'proj-multi',
        worktreeId: null,
      }),
    ).toBeNull();
    expect(
      scriptActionsReviewWorktreeId(
        sidebar,
        { projectId: 'proj-multi', worktreeId: 'wt-1' },
        { projectId: 'proj-multi', worktreeId: null },
      ),
    ).toBe('wt-1');
    expect(
      scriptActionsReviewWorktreeId(sidebar, null, {
        projectId: 'proj-single',
        worktreeId: null,
      }),
    ).toBe('wt-only');
  });

  it('falls back to this project for unknown targets', () => {
    expect(
      scriptActionsReceiptTargetName(sidebar, {
        projectId: 'gone',
        repoIds: [],
      }),
    ).toBeNull();
  });
});
