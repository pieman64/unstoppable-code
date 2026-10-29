/**
 * Fork a shared container into a private local copy (CAN-2552).
 *
 * Two steps in one dialog, deliberately not one:
 *
 * 1. **Destination.** Where the copy lands. A code share needs a git-backed
 *    workspace, a Cowork share needs a Cowork workspace, and neither can be
 *    inferred, so the choice is explicit rather than defaulted-and-explained.
 * 2. **Disclosures.** Three things a recipient cannot discover afterwards and
 *    would reasonably assume the opposite of: the copy never synchronizes
 *    again, revocation cannot recall it, and agent history arrives readable
 *    but not resumable.
 *
 * The disclosures come second on purpose. Reading "this never syncs again"
 * before knowing where it lands is abstract; reading it with a named
 * destination on screen is a decision.
 *
 * A finished copy opens straight away and the dialog closes (CAN-3710); the
 * copy's own "forked from" notice carries its provenance from there.
 *
 * Compatibility is main's call, not this dialog's. There is no
 * "list compatible workspaces" query, and inventing a renderer-side remote-URL
 * match would be a second, weaker copy of `matchExistingWorkspace()` that
 * could disagree with it. Every workspace of the right kind is offered and a
 * mismatch comes back as main's own message.
 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import type {
  SharedContainerAccess,
  SharedContainerForkDestination,
  SharedContainerForkResponse,
} from '@canopy/desktop-shared/types';
import type { SharedContainerType } from '@canopy/protocol/shared-containers';
import { Button } from '@/components/shared/Button';
import { DialogModal } from '@/components/shared/DialogModal';
import { brandText } from '@/lib/brand';
import { openForkedContainer } from '@/lib/shared-containers/open-forked-container';
import { useGitHubStore } from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useLinkedPersonalWorkspacesStore } from '@/stores/linkedPersonalWorkspacesStore';
import { isWorkspaceInContext } from '@/lib/automationContextScope';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { useSharedContainerRecipientActions } from './useSharedContainerRecipientActions';

export interface SharedContainerForkModalProps {
  containerId: string;
  /** Absent for a personal container shared directly. */
  organizationId?: string;
  access: SharedContainerAccess;
  /** The pinned revision being copied; only a readable replica has one. */
  revisionId: string;
  containerType: SharedContainerType;
  title: string;
  /**
   * Publisher display name. Optional because the members-directory lookup that
   * resolves it is lazy and can still be in flight; the request requires a
   * non-empty name, so an unresolved one falls back rather than blocking the
   * fork behind a directory read.
   */
  ownerName?: string;
  onClose: () => void;
}

type DestinationKind = 'new' | 'existing';
type Step = 'destination' | 'confirm';

export function SharedContainerForkModal({
  containerId,
  organizationId,
  access,
  revisionId,
  containerType,
  title,
  ownerName: rawOwnerName,
  onClose,
}: SharedContainerForkModalProps): JSX.Element {
  const ownerName = rawOwnerName?.trim() || 'a teammate';
  // A real owner name is a person's identity: replay records a box for it.
  // The generic fallback stays recorded.
  const ownerLabel =
    ownerName === rawOwnerName?.trim() ? (
      <span className={POSTHOG_REPLAY_BLOCK_CLASS}>{ownerName}</span>
    ) : (
      ownerName
    );
  const isCowork = containerType === 'COWORK_WORK_ENTRY';
  const projects = useProjectsStore((state) => state.projects);
  const linkedPersonalWorkspaceIds = useLinkedPersonalWorkspacesStore(
    (state) => state.ids,
  );
  const actions = useSharedContainerRecipientActions(
    containerId,
    organizationId,
  );

  const candidates = useMemo(() => {
    const owningContext =
      access === 'direct'
        ? ({ kind: 'personal' } as const)
        : organizationId
          ? ({ kind: 'organization', organizationId } as const)
          : undefined;
    const linkedPersonalIds = new Set(linkedPersonalWorkspaceIds);
    return projects.filter(
      (item) =>
        (isCowork ? item.type === 'cowork' : item.type !== 'cowork') &&
        isWorkspaceInContext(item, owningContext, linkedPersonalIds),
    );
  }, [access, isCowork, linkedPersonalWorkspaceIds, organizationId, projects]);

  const [step, setStep] = useState<Step>('destination');
  const [kind, setKind] = useState<DestinationKind>('new');
  const [workspaceId, setWorkspaceId] = useState('');
  const [parentDirectory, setParentDirectory] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // The clone directory is only meaningful when main has to promote the
    // replica's checkouts, which is the new-workspace code path alone.
    if (isCowork || kind !== 'new' || parentDirectory) return;
    let canceled = false;
    void window.api
      .getDefaultCloneDirectory()
      .then((directory) => {
        if (!canceled) setParentDirectory(directory);
      })
      .catch(() => {
        // Leaving the field blank is safe: main falls back to the same default
        // when `parentDirectory` is omitted.
      });
    return (): void => {
      canceled = true;
    };
  }, [isCowork, kind, parentDirectory]);

  const destination: SharedContainerForkDestination =
    kind === 'existing'
      ? { kind: 'existing-workspace', workspaceId }
      : {
          kind: 'new-workspace',
          ...(isCowork || !parentDirectory.trim()
            ? {}
            : { parentDirectory: parentDirectory.trim() }),
        };

  const canContinue = kind === 'new' || workspaceId !== '';

  const handleBrowse = async (): Promise<void> => {
    const selection = await window.api.browseForCloneDirectory();
    if (!selection.canceled && selection.directoryPath) {
      setParentDirectory(selection.directoryPath);
    }
  };

  const handleFork = (): void => {
    setError(null);
    void actions
      .fork({ revisionId, sourceOwnerDisplayName: ownerName, destination })
      .then((outcome) => {
        if (outcome.status === 'in-flight') return;
        if (outcome.status === 'failed') {
          setError(outcome.message);
          // Back to the destination step: every refusal main can return is
          // about the destination, so leaving the user on the disclosures
          // would hide the only control that fixes it.
          setStep('destination');
          return;
        }
        openCopy(outcome.response);
      });
  };

  const openCopy = (response: SharedContainerForkResponse): void => {
    void openForkedContainer(response)
      .then(() => {
        useGitHubStore
          .getState()
          .addToast(
            response.warnings.length > 0
              ? `Copy made. ${brandText.appName} could not bring everything across.`
              : 'Copy made.',
            response.warnings.length > 0 ? 'warning' : 'success',
          );
      })
      .catch(() => {
        useGitHubStore
          .getState()
          .addToast(
            "Copy made, but it couldn't be opened. Open it from the sidebar.",
            'error',
          );
      })
      // The fork succeeded and the copy exists, so pinning the dialog open
      // would misrepresent the outcome; the now-live sidebar row is the
      // recovery path.
      .finally(() => onClose());
  };

  return (
    <DialogModal
      onClose={actions.forking ? (): void => {} : onClose}
      title="Make a copy of this share"
      maxWidth="md"
      headerBorder={false}
      closeOnBackdrop={!actions.forking}
      dataTestId="shared-container-fork-modal"
    >
      <div className="flex flex-col gap-4 px-5 pb-5">
        {step === 'destination' && (
          <div
            className="flex flex-col gap-3"
            data-testid="shared-container-fork-destination"
          >
            <p className="text-s fg-secondary">
              Make your own copy of{' '}
              <span className="font-medium fg-primary">{title}</span> that you
              can edit and run.
            </p>

            <label className="flex items-start gap-2 text-s fg-secondary">
              <input
                type="radio"
                name="shared-container-fork-destination-kind"
                data-testid="shared-container-fork-destination-new"
                checked={kind === 'new'}
                onChange={(): void => setKind('new')}
                className="mt-1"
              />
              <span className="flex flex-col">
                <span className="fg-primary">
                  {isCowork ? 'New Cowork project' : 'New workspace'}
                </span>
                <span className="text-xs fg-quaternary">
                  {isCowork
                    ? 'Creates a project just for this copy.'
                    : 'Copies the repositories to this computer and sets up a workspace around them.'}
                </span>
              </span>
            </label>

            {kind === 'new' && !isCowork && (
              <div className="flex flex-col gap-1 pl-6">
                <span className="text-xs fg-quaternary">Save the code in</span>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    data-testid="shared-container-fork-location"
                    value={parentDirectory}
                    onChange={(event): void =>
                      setParentDirectory(event.currentTarget.value)
                    }
                    className="min-w-0 flex-1 rounded border bg-base px-2 py-1 text-xs fg-primary"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="shared-container-fork-browse"
                    onClick={(): void => void handleBrowse()}
                  >
                    Browse
                  </Button>
                </div>
              </div>
            )}

            <label className="flex items-start gap-2 text-s fg-secondary">
              <input
                type="radio"
                name="shared-container-fork-destination-kind"
                data-testid="shared-container-fork-destination-existing"
                checked={kind === 'existing'}
                disabled={candidates.length === 0}
                onChange={(): void => setKind('existing')}
                className="mt-1"
              />
              <span className="flex flex-col">
                <span className="fg-primary">
                  {isCowork
                    ? 'An existing Cowork project'
                    : 'An existing workspace'}
                </span>
                <span className="text-xs fg-quaternary">
                  {candidates.length === 0
                    ? isCowork
                      ? 'You do not have a Cowork project yet.'
                      : 'You do not have a workspace yet.'
                    : isCowork
                      ? 'Adds the copy as a new entry in a project you already have.'
                      : 'Only works in a workspace that already has the same repositories.'}
                </span>
              </span>
            </label>

            {kind === 'existing' && candidates.length > 0 && (
              <select
                data-testid="shared-container-fork-workspace"
                value={workspaceId}
                onChange={(event): void =>
                  setWorkspaceId(event.currentTarget.value)
                }
                className="ml-6 rounded border bg-base px-2 py-1 text-s fg-primary"
              >
                <option value="" disabled>
                  Choose a project
                </option>
                {candidates.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        {step === 'confirm' && (
          <div
            className="flex flex-col gap-3"
            data-testid="shared-container-fork-disclosures"
          >
            <p className="text-s fg-secondary">
              Before you copy, three things to know.
            </p>
            <ul className="flex list-disc flex-col gap-2 pl-5 text-s fg-secondary">
              <li>
                The copy is yours and stands on its own. It never picks up
                changes {ownerLabel} makes later, and nothing you do to it goes
                back to them.
              </li>
              <li>
                {ownerLabel} cannot take the copy back. Removing your access to
                the share leaves your copy exactly where it is. The data key
                already released for this revision remains a permanent way to
                decrypt that revision.
              </li>
              <li>
                Chats come across as a readable record, not a conversation you
                can pick back up. Shares never carry the agent session itself,
                so you can read the history but not continue it.
              </li>
            </ul>
          </div>
        )}

        {error !== null && (
          <p
            className="text-xs fg-destructive"
            data-testid="shared-container-fork-error"
          >
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          {step === 'destination' && (
            <Button
              variant="primary"
              size="lg"
              disabled={!canContinue}
              data-testid="shared-container-fork-continue"
              onClick={(): void => {
                setError(null);
                setStep('confirm');
              }}
            >
              Continue
            </Button>
          )}
          {step === 'confirm' && (
            <>
              <Button
                variant="outline"
                size="lg"
                disabled={actions.forking}
                onClick={(): void => setStep('destination')}
              >
                Back
              </Button>
              <Button
                variant="primary"
                size="lg"
                disabled={actions.forking}
                data-testid="shared-container-fork-confirm"
                onClick={handleFork}
              >
                {actions.forking ? 'Copying…' : 'Make a copy'}
              </Button>
            </>
          )}
        </div>
      </div>
    </DialogModal>
  );
}
