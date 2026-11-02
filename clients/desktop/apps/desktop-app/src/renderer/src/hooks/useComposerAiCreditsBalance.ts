import { useEffect, useMemo, useRef, useState } from 'react';
import {
  APP_ADVISOR_PROJECT_ID,
  DEFAULT_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import type { CanopyCloudAiCreditsState } from '@canopy/desktop-shared/types';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { chatAiCreditsScope } from '@/lib/aiCreditsScope';
import { mayChangeCanopyCloudIdentity } from '@/lib/canopyCloudAccountChange';
import { useProjectsStore } from '@/stores/projectsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import {
  invalidateAiCreditsUsageCache,
  refreshAiCreditsAfterChargedTurn,
  useAiCreditsUsage,
} from './useAiCreditsUsage';

/** The chat whose composer may show its wallet balance. */
export interface ComposerAiCreditsTarget {
  /** Absent for a chat outside any project; its owner is the navigation context. */
  readonly projectId?: string;
  readonly worktreeId?: string;
  readonly chatId?: string;
}

/**
 * Projects with no sidebar entry whose work main attributes to the
 * navigation context, as it does a chat outside any project.
 */
const NAVIGATION_OWNED_PROJECT_IDS: ReadonlySet<string> = new Set([
  STANDALONE_CHAT_PROJECT_ID,
  DEFAULT_CHAT_PROJECT_ID,
]);

/**
 * Whether the chat's work is explicitly Personal, so the personal wallet is
 * the one paying. `false` covers organization work and every owner the
 * renderer cannot confirm (an unhydrated context, a project not listed yet).
 */
export function useComposerWorkIsPersonal(
  projectId: string | undefined,
): boolean {
  const navigationPersonal = useWorkspaceContextStore(
    (store) => store.hydrated && store.state.context.kind === 'personal',
  );
  const projectOwner = useProjectsStore((store) => {
    if (projectId === undefined) return 'navigation';
    const project = store.projects.find(
      (candidate) => candidate.id === projectId,
    );
    if (project) return project.owner === undefined ? 'personal' : 'org';
    return 'unknown';
  });
  // App Advisor is Personal work regardless of the navigation context.
  if (projectId === APP_ADVISOR_PROJECT_ID) return true;
  if (projectOwner === 'personal') return true;
  if (projectOwner === 'navigation') return navigationPersonal;
  if (
    projectOwner === 'unknown' &&
    projectId !== undefined &&
    NAVIGATION_OWNED_PROJECT_IDS.has(projectId)
  ) {
    return navigationPersonal;
  }
  return false;
}

/**
 * The personal wallet balance from a read, or null when the read cannot
 * vouch for it: no account, no wallet, a failed lookup, or a reply that names
 * an organization pool, which means the server attributed the work to an
 * organization after all.
 */
export function personalWalletCredits(
  state: CanopyCloudAiCreditsState | null,
): number | null {
  if (!state?.connected || state.noUdAccount || state.error) return null;
  const balance = state.balance;
  if (!balance || !Number.isFinite(balance.credits) || balance.credits < 0) {
    return null;
  }
  if (balance.orgPool || balance.orgFundingAvailable === true) return null;
  return balance.credits;
}

/** What the composer's usage meter shows for the chat's wallet. */
export interface ComposerAiCreditsBalance {
  /** The balance to show, or null when there is none to show. */
  readonly credits: number | null;
  /**
   * A figure this chat already showed was withdrawn by a same-account
   * re-read (a confirmed unlock or purchase, CAN-5026) that has not settled.
   * The meter holds the balance's place instead of collapsing; `credits` is
   * always null while this is true.
   */
  readonly pending: boolean;
}

/**
 * The whole personal-wallet balance a Personal chat billed to AI Credits
 * spends, for the composer's usage meter, or null when it should show none.
 * It follows the selected model's billing, not the route of the last turn:
 * a chat switched to the user's own subscription shows no balance.
 *
 * Reads go through the shared AI Credits usage cache, so the composer, the
 * sidebar and the Usage page share one read per scope and refresh together.
 * When a turn that AI Credits paid for ends (completed, failed or stopped),
 * every mounted balance re-reads on a short bounded schedule that catches the
 * debit settling after the stream.
 */
export function useComposerAiCreditsBalance({
  target,
  aiCreditsRouted,
  aiCreditsBilled,
  turnActive,
}: {
  readonly target: ComposerAiCreditsTarget;
  /** The live session's route, which decides whether a turn charged. */
  readonly aiCreditsRouted: boolean;
  /** Whether the selected model bills the chat's next turn to AI Credits. */
  readonly aiCreditsBilled: boolean;
  readonly turnActive: boolean;
}): ComposerAiCreditsBalance {
  const personal = useComposerWorkIsPersonal(target.projectId);
  const eligible = aiCreditsBilled && personal;
  const { projectId, worktreeId, chatId } = target;
  const scope = useMemo(
    () => chatAiCreditsScope(projectId, worktreeId, chatId),
    [projectId, worktreeId, chatId],
  );
  const { state, loading, refreshing } = useAiCreditsUsage(scope, {
    enabled: eligible,
    personalWallet: personal,
  });

  // The routing a turn started on decides whether its end can have charged
  // the wallet, so switching models or billing afterwards cannot skip or
  // invent a refresh. A turn that starts on a subscription and falls back to
  // AI Credits is credit-routed by the time it ends, so it counts too.
  const chargedTurn = useRef(turnActive && aiCreditsRouted);
  const wasActive = useRef(turnActive);
  const chatKey = `${projectId ?? ''}|${worktreeId ?? ''}|${chatId ?? ''}`;
  const previousReadScope = useRef(chatKey);
  useEffect(() => {
    const changed = previousReadScope.current !== chatKey;
    previousReadScope.current = chatKey;
    // Personal composers share the wallet cache, but a read started for the
    // previous chat must not become this chat's answer after a scope switch.
    // Supersede only an active read; settled wallet snapshots remain shared.
    if (changed && eligible && refreshing) invalidateAiCreditsUsageCache();
  }, [chatKey, eligible, refreshing]);
  const lastChatKey = useRef(chatKey);
  useEffect(() => {
    if (lastChatKey.current !== chatKey) {
      // Another chat's turn never charges this one.
      lastChatKey.current = chatKey;
      chargedTurn.current = false;
      wasActive.current = turnActive;
      return;
    }
    if (turnActive) {
      if (!wasActive.current) chargedTurn.current = aiCreditsRouted;
      else if (aiCreditsRouted) chargedTurn.current = true;
    } else if (wasActive.current && chargedTurn.current) {
      chargedTurn.current = false;
      refreshAiCreditsAfterChargedTurn();
    }
    wasActive.current = turnActive;
  }, [turnActive, aiCreditsRouted, chatKey]);

  const credits = eligible ? personalWalletCredits(state) : null;

  // The eligible scope that last showed a figure. Only a re-read of that same
  // scope holds the slot: a first load, another chat, an ineligible model or
  // owner, and another account all start with nothing shown. Recorded in
  // effects, so an abandoned render cannot leak into it.
  const displayScope = eligible ? chatKey : null;
  const [displayedScope, setDisplayedScope] = useState<string | null>(null);
  useEffect(() => {
    setDisplayedScope((previous) => {
      if (credits !== null && displayScope !== null) return displayScope;
      return previous === displayScope ? previous : null;
    });
  }, [credits, displayScope]);
  useEffect(() => {
    // Sign-in, sign-out, and an account switch announce a possible identity
    // change; nothing this account showed may hold a slot for the next.
    const onAccountChanged = (event: Event): void => {
      if (mayChangeCanopyCloudIdentity(event)) setDisplayedScope(null);
    };
    window.addEventListener(
      CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
      onAccountChanged,
    );
    return (): void => {
      window.removeEventListener(
        CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
        onAccountChanged,
      );
    };
  }, []);

  // `loading` means this scope has no snapshot and its read is in flight; a
  // settled read, failed or empty, ends it, so the slot never waits forever.
  // A post-turn settlement keeps its snapshot and so never shows as pending.
  const pending =
    credits === null &&
    displayScope !== null &&
    displayedScope === displayScope &&
    loading;
  return { credits, pending };
}
