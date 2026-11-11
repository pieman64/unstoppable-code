import type {
  AppAdvisorAction,
  AppAdvisorActionError,
  AppAdvisorJson,
} from '@canopy/desktop-shared/types';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type { LedgerTaskViewScope } from '@canopy/protocol/ledger-view';
import { isCoworkChatTarget } from '@/lib/cowork';
import { openLedgerPanel } from '@/lib/ledger/open-ledger-panel';
import { ledgerViewStoreFor } from '@/lib/ledger/ledger-view-stores';
import { useChatStore } from '@/stores/chatStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';

/*
 * App Advisor's Ledger panel action: opening shows the panel through the same
 * view stores as the person uses. It waits behind `canopy-ledger-enabled`.
 * Searching and adding entries run in main (CAN-6007).
 */

export type LedgerAdvisorOutcome =
  | { readonly ok: true; readonly result: AppAdvisorJson }
  | { readonly ok: false; readonly error: AppAdvisorActionError };

type LedgerOpenAction = Extract<AppAdvisorAction, { type: 'ledger.open' }>;

/** Frames to wait for a newly shown scope's panel layout. */
const LAYOUT_WAIT_FRAMES = 30;

function failure(
  code: AppAdvisorActionError['code'],
  message: string,
  retryable = false,
): LedgerAdvisorOutcome {
  return { ok: false, error: { code, message, retryable } };
}

function ledgerUnavailable(): LedgerAdvisorOutcome | null {
  return useFeatureFlagsStore
    .getState()
    .isEnabled(CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.key)
    ? null
    : failure('surface_unavailable', 'The Feed is not available.');
}

/** The action's scope, or the selected work when it names none. */
function resolveScope(action: {
  readonly projectId?: string;
  readonly worktreeId?: string;
}): LedgerTaskViewScope | null {
  if (action.projectId !== undefined && action.worktreeId !== undefined) {
    return { projectId: action.projectId, worktreeId: action.worktreeId };
  }
  const selected = useChatStore.getState().selectedWorktree;
  return selected === null
    ? null
    : { projectId: selected.projectId, worktreeId: selected.worktreeId };
}

function noScope(): LedgerAdvisorOutcome {
  return failure('surface_unavailable', 'No work is selected.', true);
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

/** Shows the scope, opening its Ledger panel once its layout is built. */
async function showLedger(scope: LedgerTaskViewScope): Promise<boolean> {
  const chat = useChatStore.getState();
  const selected = chat.selectedWorktree;
  const isSelected =
    selected !== null &&
    selected.projectId === scope.projectId &&
    selected.worktreeId === scope.worktreeId;
  const cowork = isCoworkChatTarget(scope.projectId);
  // A Cowork or App Advisor Work Entry is shown by selecting it first.
  if (!isSelected && cowork) return false;
  useNavigationStore.getState().navigate(cowork ? 'chat' : 'main');
  if (!isSelected) chat.selectWorktree(scope.projectId, scope.worktreeId);
  for (let frame = 0; frame < LAYOUT_WAIT_FRAMES; frame += 1) {
    if (openLedgerPanel(scope.projectId, scope.worktreeId)) return true;
    await nextFrame();
  }
  return false;
}

export async function runLedgerOpenAction(
  action: LedgerOpenAction,
): Promise<LedgerAdvisorOutcome> {
  const unavailable = ledgerUnavailable();
  if (unavailable !== null) return unavailable;
  const scope = resolveScope(action);
  if (scope === null) return noScope();
  if (!(await showLedger(scope))) {
    return failure(
      'surface_unavailable',
      'The Feed panel could not open. Select the work first.',
      true,
    );
  }
  if (action.entryId !== undefined) {
    const store = ledgerViewStoreFor(scope.projectId, scope.worktreeId);
    await store.getState().select(action.entryId);
    // Opened only once the panel shows the entry; a failed read says why.
    const { detail } = store.getState();
    if (detail.status !== 'ready' || detail.entryId !== action.entryId) {
      const problem = detail.entryId === action.entryId ? detail.problem : null;
      if (problem?.kind === 'error' && problem.reason === 'NOT_FOUND') {
        return failure('not_found', 'This work has no entry with that ID.');
      }
      if (problem?.kind === 'unavailable') {
        return failure(
          'surface_unavailable',
          'The Feed is not available.',
          problem.reason === 'runtime_unavailable',
        );
      }
      return failure(
        'execution_failed',
        "The entry couldn't be read. Try again.",
        true,
      );
    }
  }
  return {
    ok: true,
    result: {
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      ...(action.entryId === undefined ? {} : { entryId: action.entryId }),
    },
  };
}
