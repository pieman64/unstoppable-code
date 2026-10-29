import type { JSX } from 'react';
import { useShallow } from 'zustand/shallow';
import {
  LinkTargetChip,
  type LinkTargetChipAction,
} from '@canopy/ui-shared/components';
import { useHomeComposerStore } from '@/stores/homeComposerStore';
import { cancelHomeLinkSubmission } from './homeSend';
import {
  currentHomeLinkResolveContext,
  createHomeLinkResolveDeps,
} from './homeLinkTargetHost';
import {
  currentHomeLinkFingerprint,
  syncHomeLinkTarget,
} from './homeLinkTargetSync';
import { switchContextForWorkspace } from '@/lib/contextScope';
import {
  describeHomeLinkPlan,
  selectHomeLink,
  resolveHomeLink,
  type HomeLinkAction,
} from './homeLinkTarget';
import { openIntegrationSettings } from '@/lib/navigation/settings-destinations';
import { useGitHubConnectOfferStore } from '@/stores/githubConnectOfferStore';

interface HomeLinkTargetChipProps {
  /** Opens the Home project picker for a project choice. */
  onChooseProject: () => void;
}

function actionLabel(action: HomeLinkAction): string {
  switch (action.kind) {
    case 'retry':
      return 'Try again';
    case 'connect-github':
    case 'sign-in-github':
      return 'Connect GitHub';
    case 'connect-linear':
      return 'Connect Linear';
    case 'choose-project':
      return 'Choose project';
    case 'add-new-project':
      return 'Add as new project';
    case 'use-project':
    case 'choose-reference':
    case 'choose-attachment':
    case 'switch-context':
      return action.label;
  }
}

function actionId(action: HomeLinkAction): string {
  switch (action.kind) {
    case 'use-project':
      return `use-project-${action.workspaceId}`;
    case 'choose-reference':
    case 'choose-attachment':
      return `choose-reference-${action.key}`;
    case 'switch-context':
      return `switch-context-${action.workspaceId}`;
    default:
      return action.kind;
  }
}

/** Desktop host for the shared link destination chip (CAN-3606). */
export function HomeLinkTargetChip({
  onChooseProject,
}: HomeLinkTargetChipProps): JSX.Element | null {
  const { linkTarget, mode } = useHomeComposerStore(
    useShallow((s) => ({ linkTarget: s.linkTarget, mode: s.mode })),
  );
  if (
    mode !== 'chat' ||
    linkTarget.status === 'idle' ||
    linkTarget.status === 'inactive'
  ) {
    return null;
  }

  const runAction = async (action: HomeLinkAction): Promise<void> => {
    const store = useHomeComposerStore.getState();
    switch (action.kind) {
      case 'retry':
        store.retryLinkTarget();
        return;
      case 'sign-in-github':
        // After connecting, the connection change re-resolves the link.
        if (
          useGitHubConnectOfferStore.getState().requestOffer({
            kind: 'home-link-add-project',
            operationId: crypto.randomUUID(),
            resume: 'resolve',
          }) === 'busy'
        )
          store.retryLinkTarget();
        return;
      case 'connect-github':
      case 'connect-linear':
        openIntegrationSettings();
        return;
      case 'choose-project':
        onChooseProject();
        return;
      case 'use-project':
      case 'switch-context': {
        if (linkTarget.status !== 'blocked' || store.linkContextSwitchPending)
          return;
        const selection = selectHomeLink(
          store.text,
          store.dismissedLinkKeys,
          store.chosenLinkKey,
        );
        const context = currentHomeLinkResolveContext(action.workspaceId, true);
        const project = [
          ...context.projects,
          ...context.otherScopeProjects,
        ].find((candidate) => candidate.id === action.workspaceId);
        if (!project) {
          store.retryLinkTarget();
          return;
        }
        const resolution = await resolveHomeLink(
          selection,
          { ...context, projects: [project], otherScopeProjects: [] },
          createHomeLinkResolveDeps(),
        );
        if (
          currentHomeLinkFingerprint(linkTarget.key) !== linkTarget.fingerprint
        )
          return;
        if (
          resolution.status !== 'ready' ||
          resolution.plan.kind !== 'existing-project'
        ) {
          if (resolution.status === 'blocked')
            store.setLinkTarget({ ...linkTarget, ...resolution });
          return;
        }
        const current = useHomeComposerStore.getState();
        if (
          current.workspaceId !== action.workspaceId &&
          current.fileReferences.some(
            (reference) =>
              reference.kind === undefined ||
              reference.kind === 'file' ||
              reference.kind === 'folder' ||
              reference.kind === 'prompt',
          )
        ) {
          current.setSendError(
            current.fileReferences.some(
              (reference) => reference.kind === 'prompt',
            )
              ? 'Remove the saved prompt mentions before switching projects, or dismiss the link.'
              : 'Remove the file mentions before switching projects, or dismiss the link.',
          );
          return;
        }
        if (action.kind === 'switch-context') {
          useHomeComposerStore.setState({ linkContextSwitchPending: true });
          try {
            if (!(await switchContextForWorkspace(action.workspaceId))) return;
            const latest = useHomeComposerStore.getState();
            if (
              latest.draftGeneration !== current.draftGeneration ||
              latest.linkDraftRevision !== current.linkDraftRevision ||
              latest.workspaceId !== current.workspaceId ||
              latest.attachments !== current.attachments ||
              latest.fileReferences !== current.fileReferences ||
              latest.scheduledSendDraft !== current.scheduledSendDraft ||
              latest.dismissedLinkKeys !== current.dismissedLinkKeys ||
              latest.chosenLinkKey !== current.chosenLinkKey ||
              latest.chosenLinkAttachmentKey !==
                current.chosenLinkAttachmentKey ||
              latest.pluginSelections !== current.pluginSelections ||
              latest.executionHarness !== current.executionHarness
            )
              return;
            store.selectWorkspace(action.workspaceId, {
              explicit: true,
              preserveDraft: true,
            });
          } finally {
            useHomeComposerStore.setState({ linkContextSwitchPending: false });
          }
        } else
          store.selectWorkspace(action.workspaceId, {
            explicit: true,
            preserveDraft: true,
          });
        syncHomeLinkTarget();
        return;
      }
      case 'add-new-project':
        store.markWorkspaceSelectionInherited();
        return;
      case 'choose-reference':
        store.chooseLinkReference(action.key);
        return;
      case 'choose-attachment':
        if (linkTarget.status === 'blocked')
          store.chooseLinkAttachment(action.key, linkTarget.key);
        return;
    }
  };

  const dismiss = (): void => {
    const { text, dismissedLinkKeys, chosenLinkKey, dismissLinkReferences } =
      useHomeComposerStore.getState();
    dismissLinkReferences(
      selectHomeLink(text, dismissedLinkKeys, chosenLinkKey).referenceKeys,
    );
  };

  if (linkTarget.status === 'resolving') {
    return (
      <LinkTargetChip
        data-testid="home-link-target"
        status="resolving"
        label="Checking link…"
        onDismiss={dismiss}
      />
    );
  }
  if (linkTarget.status === 'blocked') {
    const actions: LinkTargetChipAction[] = linkTarget.actions.map(
      (action) => ({
        id: actionId(action),
        label: actionLabel(action),
        onSelect: (): void => {
          void runAction(action).catch((): void =>
            useHomeComposerStore.getState().retryLinkTarget(),
          );
        },
      }),
    );
    return (
      <LinkTargetChip
        data-testid="home-link-target"
        status="blocked"
        label={linkTarget.message}
        actions={actions}
        onDismiss={dismiss}
      />
    );
  }
  const description = describeHomeLinkPlan(linkTarget.plan);
  if (linkTarget.status === 'submitting') {
    return (
      <LinkTargetChip
        data-testid="home-link-target"
        status="submitting"
        label={linkTarget.progress}
        detail={description.label}
        actions={
          linkTarget.canCancel
            ? [
                {
                  id: 'cancel',
                  label: 'Cancel creation',
                  onSelect: cancelHomeLinkSubmission,
                },
              ]
            : []
        }
      />
    );
  }
  return (
    <LinkTargetChip
      data-testid="home-link-target"
      status="ready"
      label={description.label}
      detail={description.detail}
      onDismiss={dismiss}
    />
  );
}
