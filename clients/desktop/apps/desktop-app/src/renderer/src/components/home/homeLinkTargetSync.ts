import { useEffect } from 'react';
import { useShallow } from 'zustand/shallow';
import { useSidebarScopingContext } from '@/components/sidebar/useSidebarScopingContext';
import {
  GITHUB_CONNECTION_CHANGED_EVENT,
  LINEAR_CONNECTION_CHANGED_EVENT,
  subscribeToConnectionChange,
} from '@/lib/integrationConnectionEvents';
import { useHomeComposerStore } from '@/stores/homeComposerStore';
import {
  HOME_LINK_RESOLVE_DEBOUNCE_MS,
  IDLE_HOME_LINK_TARGET,
  ambiguousHomeLinkResolution,
  homeLinkFingerprint,
  homeLinkProjectsSignature,
  pruneDismissedHomeLinkKeys,
  resolveHomeLink,
  selectHomeLink,
  type HomeLinkPlan,
  type HomeLinkResolution,
  type HomeLinkSelection,
} from './homeLinkTarget';
import {
  createHomeLinkResolveDeps,
  currentHomeLinkResolveContext,
  homeLinkScopeKey,
  splitHomeLinkProjects,
} from './homeLinkTargetHost';
import { useHomeScope } from './homeScope';

/**
 * Keeps `homeComposerStore.linkTarget` in step with the draft. Module-level so
 * the page and embedded Home surfaces share one debounce and one in-flight
 * resolution: a surface unmounting never strands a `resolving` preview.
 */

let connectionGeneration = 0;
let requestGeneration = 0;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

export function currentHomeLinkFingerprint(key: string): string {
  const state = useHomeComposerStore.getState();
  return homeLinkFingerprint({
    key,
    mode: state.mode,
    workspaceId: state.workspaceId,
    workspaceSelectionExplicit: state.workspaceSelectionExplicit,
    scopeKey: homeLinkScopeKey(),
    projectsSignature: homeLinkProjectsSignature([
      ...splitHomeLinkProjects().projects,
      ...splitHomeLinkProjects().otherScopeProjects,
    ]),
    connectionGeneration,
    retryGeneration: state.linkRetryGeneration,
    draftRevision: JSON.stringify([
      state.draftGeneration,
      state.linkDraftRevision,
      state.text,
      state.chosenLinkAttachmentKey,
      state.chosenLinkAttachmentReferenceKey,
    ]),
  });
}

function applyResolution(
  key: string,
  fingerprint: string,
  resolution: HomeLinkResolution,
): void {
  const { setLinkTarget } = useHomeComposerStore.getState();
  switch (resolution.status) {
    case 'ready':
      setLinkTarget({
        status: 'ready',
        key,
        fingerprint,
        plan: resolution.plan,
      });
      return;
    case 'inactive':
      setLinkTarget({ status: 'inactive', key, fingerprint });
      return;
    case 'blocked':
      setLinkTarget({
        status: 'blocked',
        key,
        fingerprint,
        message: resolution.message,
        actions: resolution.actions,
      });
      return;
  }
}

function isStillResolving(fingerprint: string): boolean {
  const { linkTarget } = useHomeComposerStore.getState();
  return (
    linkTarget.status === 'resolving' && linkTarget.fingerprint === fingerprint
  );
}

async function runResolution(
  selection: Extract<HomeLinkSelection, { kind: 'single' }>,
  fingerprint: string,
): Promise<void> {
  if (
    !isStillResolving(fingerprint) ||
    currentHomeLinkFingerprint(selection.key) !== fingerprint
  ) {
    return;
  }
  const state = useHomeComposerStore.getState();
  const generation = ++requestGeneration;
  let resolution: HomeLinkResolution;
  try {
    resolution = await resolveHomeLink(
      selection,
      currentHomeLinkResolveContext(
        state.workspaceId,
        state.workspaceSelectionExplicit,
      ),
      createHomeLinkResolveDeps(),
    );
  } catch {
    resolution = {
      status: 'blocked',
      message: 'Couldn’t check this link.',
      actions: [{ kind: 'retry' }],
    };
  }
  // Only the latest compatible request may update the preview.
  const currentState = useHomeComposerStore.getState();
  const currentSelection = selectHomeLink(
    currentState.text,
    currentState.dismissedLinkKeys,
    currentState.chosenLinkKey,
  );
  if (
    generation !== requestGeneration ||
    !isStillResolving(fingerprint) ||
    currentHomeLinkFingerprint(selection.key) !== fingerprint ||
    currentSelection.kind !== 'single' ||
    currentSelection.key !== selection.key
  )
    return;
  applyResolution(selection.key, fingerprint, resolution);
}

/**
 * Synchronizes the preview with the current draft and returns the selection.
 * Never selects a workspace, changes a branch target, or switches context.
 */
export function syncHomeLinkTarget(): HomeLinkSelection {
  const store = useHomeComposerStore.getState();
  if (store.mode !== 'chat') {
    requestGeneration += 1;
    if (store.linkTarget.status !== 'idle') {
      store.setLinkTarget(IDLE_HOME_LINK_TARGET);
    }
    return { kind: 'none', referenceKeys: [] };
  }

  const initial = selectHomeLink(
    store.text,
    store.dismissedLinkKeys,
    store.chosenLinkKey,
  );
  if (
    store.chosenLinkAttachmentReferenceKey !== null &&
    !initial.referenceKeys.includes(store.chosenLinkAttachmentReferenceKey)
  ) {
    useHomeComposerStore.setState({
      chosenLinkAttachmentKey: null,
      chosenLinkAttachmentReferenceKey: null,
    });
  }
  const pruned = pruneDismissedHomeLinkKeys(
    store.dismissedLinkKeys,
    initial.referenceKeys,
  );
  if (pruned.length !== store.dismissedLinkKeys.length) {
    store.setDismissedLinkKeys(pruned);
  }
  if (
    store.chosenLinkKey !== null &&
    !initial.referenceKeys.includes(store.chosenLinkKey)
  ) {
    store.chooseLinkReference(null);
  }
  const selection = selectHomeLink(
    store.text,
    pruned,
    initial.referenceKeys.includes(store.chosenLinkKey ?? '')
      ? store.chosenLinkKey
      : null,
  );

  const { linkTarget } = useHomeComposerStore.getState();
  if (linkTarget.status === 'submitting') return selection;
  if (selection.kind === 'none') {
    requestGeneration += 1;
    if (linkTarget.status !== 'idle') {
      store.setLinkTarget(IDLE_HOME_LINK_TARGET);
    }
    return selection;
  }

  const fingerprint = currentHomeLinkFingerprint(selection.key);
  if (linkTarget.status !== 'idle' && linkTarget.fingerprint === fingerprint) {
    return selection;
  }
  if (selection.kind === 'ambiguous') {
    applyResolution(
      selection.key,
      fingerprint,
      ambiguousHomeLinkResolution(selection),
    );
    return selection;
  }

  const previousPlan =
    linkTarget.status === 'idle' || linkTarget.key !== selection.key
      ? undefined
      : linkTarget.status === 'resolving'
        ? linkTarget.previousPlan
        : linkTarget.status === 'ready'
          ? linkTarget.plan
          : undefined;
  store.setLinkTarget({
    status: 'resolving',
    key: selection.key,
    fingerprint,
    ...(previousPlan ? { previousPlan } : {}),
  });
  requestGeneration += 1;
  if (pendingTimer !== null) clearTimeout(pendingTimer);
  pendingTimer = setTimeout((): void => {
    pendingTimer = null;
    void runResolution(selection, fingerprint);
  }, HOME_LINK_RESOLVE_DEBOUNCE_MS);
  return selection;
}

export type HomeLinkSendGate =
  | { kind: 'none' }
  | { kind: 'stop'; message: string }
  | { kind: 'ready'; key: string; fingerprint: string; plan: HomeLinkPlan };

function evaluateHomeLinkSend(selection: HomeLinkSelection): HomeLinkSendGate {
  if (selection.kind === 'none') return { kind: 'none' };
  const { linkTarget } = useHomeComposerStore.getState();
  const current =
    linkTarget.status !== 'idle' &&
    linkTarget.key === selection.key &&
    linkTarget.fingerprint === currentHomeLinkFingerprint(selection.key);
  if (current && linkTarget.status === 'inactive') return { kind: 'none' };
  if (current && linkTarget.status === 'ready') {
    return {
      kind: 'ready',
      key: linkTarget.key,
      fingerprint: linkTarget.fingerprint,
      plan: linkTarget.plan,
    };
  }
  if (linkTarget.status === 'blocked') {
    return {
      kind: 'stop',
      message: 'Resolve the link above, or dismiss it to send this as a chat.',
    };
  }
  return {
    kind: 'stop',
    message:
      'Checking the link above. Send again once its destination appears, or dismiss it to send this as a chat.',
  };
}

/**
 * Detects from the submitted text itself, so a send before the debounce
 * cannot bypass a link. Only a visible, current, ready preview proceeds.
 *
 * Synchronous unless the draft holds a still-resolving bare identifier:
 * `settle` resolves it immediately so the user sees either its destination
 * or its blocker before accepting or dismissing it. Callers take their send lock
 * before awaiting `settle`.
 */
export function gateHomeLinkSend():
  | HomeLinkSendGate
  | { kind: 'settle'; settle: () => Promise<HomeLinkSendGate> } {
  const selection = syncHomeLinkTarget();
  const pending = useHomeComposerStore.getState().linkTarget;
  if (
    selection.kind === 'single' &&
    selection.bareIdentifier &&
    pending.status === 'resolving'
  ) {
    return {
      kind: 'settle',
      settle: async (): Promise<HomeLinkSendGate> => {
        if (pendingTimer !== null) clearTimeout(pendingTimer);
        pendingTimer = null;
        await runResolution(selection, pending.fingerprint);
        const result = evaluateHomeLinkSend(syncHomeLinkTarget());
        return result.kind === 'ready'
          ? {
              kind: 'stop',
              message:
                'Check the destination above, then send again to create the worktree.',
            }
          : result;
      },
    };
  }
  return evaluateHomeLinkSend(selection);
}

/** Test seam: drop module scheduling state between cases. */
export function resetHomeLinkTargetSyncForTests(): void {
  if (pendingTimer !== null) clearTimeout(pendingTimer);
  pendingTimer = null;
  connectionGeneration = 0;
  requestGeneration += 1;
}

/** Mount once per Home surface; any number of mounts share one scheduler. */
export function useHomeLinkTargetSync(): void {
  const {
    text,
    mode,
    workspaceId,
    workspaceSelectionExplicit,
    dismissedLinkKeys,
    chosenLinkKey,
    linkRetryGeneration,
  } = useHomeComposerStore(
    useShallow((s) => ({
      text: s.text,
      mode: s.mode,
      workspaceId: s.workspaceId,
      workspaceSelectionExplicit: s.workspaceSelectionExplicit,
      dismissedLinkKeys: s.dismissedLinkKeys,
      chosenLinkKey: s.chosenLinkKey,
      linkRetryGeneration: s.linkRetryGeneration,
    })),
  );
  const homeScope = useHomeScope();
  const scopingContext = useSidebarScopingContext();

  useEffect(() => {
    const onConnectionChange = (): void => {
      connectionGeneration += 1;
      syncHomeLinkTarget();
    };
    const unsubscribeGitHub = subscribeToConnectionChange(
      GITHUB_CONNECTION_CHANGED_EVENT,
      onConnectionChange,
    );
    const unsubscribeLinear = subscribeToConnectionChange(
      LINEAR_CONNECTION_CHANGED_EVENT,
      onConnectionChange,
    );
    return (): void => {
      unsubscribeGitHub();
      unsubscribeLinear();
    };
  }, []);

  useEffect(() => {
    syncHomeLinkTarget();
  }, [
    text,
    mode,
    workspaceId,
    workspaceSelectionExplicit,
    dismissedLinkKeys,
    chosenLinkKey,
    linkRetryGeneration,
    homeScope,
    scopingContext,
  ]);
}
