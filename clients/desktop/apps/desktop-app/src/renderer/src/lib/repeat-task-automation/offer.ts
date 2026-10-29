import type { CanopyCloudAccountPublicState } from '@canopy/desktop-shared/types';
import { useNavigationStore } from '@/stores/navigationStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { automationSeedFromTask, isEligibleHomeTask } from './draft';
import {
  recordRepeatTask,
  repeatTaskScope,
  resolveRepeatTask,
  type RepeatTaskStorage,
} from './history';
import { useRepeatTaskOfferStore } from './offerStore';
import {
  loadRepeatTaskSuggestionsEnabled,
  repeatTaskSuggestionsStopCount,
  stopRepeatTaskSuggestions,
} from './settings';
import { isCoveredByExistingAutomation } from './suppression';
import { REPEAT_TASK_MIN_TOKENS, taskSignature } from './similarity';
import type { HomeTaskSnapshot } from './types';

export interface RepeatTaskOfferDeps {
  now: () => number;
  loadAccountKey: () => Promise<string | null>;
  loadSuggestionsEnabled: () => Promise<boolean | null>;
  storage?: RepeatTaskStorage;
}

export async function loadRepeatTaskAccountKey(): Promise<string | null> {
  try {
    const api = typeof window === 'undefined' ? undefined : window.api;
    if (!api || typeof api.loadCanopyCloudAccount !== 'function') return null;

    const account: CanopyCloudAccountPublicState =
      await api.loadCanopyCloudAccount();
    if (account.read !== undefined && account.read !== 'ok') return null;
    return account.account?.id ?? 'signed-out';
  } catch {
    return null;
  }
}

// Offers run one at a time in send order: each reads and writes history and
// the shown offer across awaits, so overlapping runs could record tasks out
// of order or both pass the one-offer check.
let offerQueue: Promise<void> = Promise.resolve();

export function maybeOfferRepeatTaskAutomation(
  snapshot: HomeTaskSnapshot,
  deps?: Partial<RepeatTaskOfferDeps>,
): Promise<void> {
  const submittedAt = (deps?.now ?? Date.now)();
  const run = offerQueue.then(() =>
    offerRepeatTaskAutomation(snapshot, submittedAt, deps),
  );
  offerQueue = run;
  return run;
}

async function offerRepeatTaskAutomation(
  snapshot: HomeTaskSnapshot,
  submittedAt: number,
  deps?: Partial<RepeatTaskOfferDeps>,
): Promise<void> {
  try {
    const workspaceId = snapshot.workspaceId;
    if (!isEligibleHomeTask(snapshot) || workspaceId === null) return;

    // Off means no prompt is compared or recorded at all.
    const loadSuggestionsEnabled =
      deps?.loadSuggestionsEnabled ?? loadRepeatTaskSuggestionsEnabled;
    const stopCount = repeatTaskSuggestionsStopCount();
    const enabled = await loadSuggestionsEnabled();
    if (enabled === false) stopRepeatTaskSuggestions(deps?.storage);
    if (enabled !== true) return;
    // The account epoch is unchanged and suggestions were not turned off.
    const stillCurrent = (): boolean =>
      useWorkspaceContextStore.getState().accountEpoch ===
        snapshot.accountEpoch && repeatTaskSuggestionsStopCount() === stopCount;

    const tokens = taskSignature(snapshot.text);
    if (tokens.length < REPEAT_TASK_MIN_TOKENS) return;

    const loadAccountKey = deps?.loadAccountKey ?? loadRepeatTaskAccountKey;
    const accountKey = await loadAccountKey();
    if (accountKey === null || !stillCurrent()) return;

    const offer = recordRepeatTask(
      {
        scope: repeatTaskScope(accountKey, workspaceId),
        tokens,
      },
      submittedAt,
      deps?.storage,
    );
    // A repeat while its offer is still on screen adds nothing; an offer from
    // an earlier account epoch is hidden, so it doesn't count.
    const shown = useRepeatTaskOfferStore.getState().offer;
    if (
      offer === null ||
      (shown?.entryId === offer.entryId &&
        shown.accountEpoch === snapshot.accountEpoch)
    ) {
      return;
    }

    if (await isCoveredByExistingAutomation(workspaceId, tokens)) return;
    if (!stillCurrent()) return;

    // A newer repeat replaces another task's unanswered offer, which stays
    // unresolved and is offered again on its next repeat.
    useRepeatTaskOfferStore.setState({
      offer: {
        entryId: offer.entryId,
        accountEpoch: snapshot.accountEpoch,
        seed: automationSeedFromTask(snapshot.text, workspaceId),
      },
    });
  } catch {
    return;
  }
}

export type RepeatTaskOfferAnswer = 'create' | 'dismiss';

/**
 * Either answer resolves the task so it is not offered again; Create also
 * opens the prefilled draft. After an account switch the answer only hides
 * the offer.
 */
export function answerRepeatTaskOffer(
  answer: RepeatTaskOfferAnswer,
  deps?: Partial<Pick<RepeatTaskOfferDeps, 'now' | 'storage'>>,
): void {
  const offer = useRepeatTaskOfferStore.getState().offer;
  if (offer === null) return;
  useRepeatTaskOfferStore.setState({ offer: null });
  if (useWorkspaceContextStore.getState().accountEpoch !== offer.accountEpoch) {
    return;
  }
  resolveRepeatTask(offer.entryId, (deps?.now ?? Date.now)(), deps?.storage);
  if (answer === 'create') {
    useNavigationStore.getState().openAutomationDraft(offer.seed);
  }
}
